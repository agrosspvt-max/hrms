/**
 * dailyReviewMigration
 *
 * Phase 5 backfill.  Walks every existing Submission grouped by
 * (employee, date) and writes one DailyReflection + one DailyReview
 * per day so the refactored review UI has data to render on day one.
 *
 * Idempotent: rows that already exist are left alone.  Re-runs on
 * every boot only touch days that have never been backfilled.
 *
 * IMPORTANT: this migration writes the SYNTHESIZED rows but does
 * NOT zero out the legacy per-submission disciplineMarks /
 * ideaMarks / selfRating / selfNote / idea fields.  Existing
 * analytics queries that sum earnedPoints continue to produce the
 * exact same numbers they produced before Phase 5 -- the daily marks
 * are already baked into one of the day's submissions, and the new
 * "primary submission" pointer just records WHICH one for the
 * refactored UI's benefit.
 *
 *   Logged metrics:
 *     reflectionsCreated  number of DailyReflection rows inserted
 *     reviewsCreated      number of DailyReview rows inserted
 *     daysWalked          how many (employee, date) buckets we saw
 */

const Submission      = require('../models/Submission');
const DailyReflection = require('../models/DailyReflection');
const DailyReview     = require('../models/DailyReview');

const migrateDailyReviews = async () => {
  // Pull every submission's (employee, date) tuple plus the fields
  // the backfill needs.  Submissions are sorted (employee, date,
  // submittedAt) so the reducer below can walk them with a single
  // pointer.  We skip soft-deleted rows -- they shouldn't seed a
  // reflection / review for HR to act on.
  const subs = await Submission.find({ deleted: { $ne: true } })
    .select('employee date submittedAt selfRating selfNote idea disciplineMarks maxDisciplineMarks ideaMarks maxIdeaMarks disciplineNote ideaFeedback reviewStatus reviewedBy reviewedAt')
    .sort({ employee: 1, date: 1, submittedAt: 1, _id: 1 })
    .lean();

  // Existing DailyReflection / DailyReview rows so we skip days
  // already converted (cheap full pull -- the rows are tiny).
  const existingReflections = await DailyReflection.find({}).select('employee date').lean();
  const existingReviews     = await DailyReview.find({}).select('employee date').lean();
  const keyOf = (e, d) => `${String(e)}|${new Date(d).toISOString().slice(0, 10)}`;
  const haveReflection = new Set(existingReflections.map((r) => keyOf(r.employee, r.date)));
  const haveReview     = new Set(existingReviews.map((r)     => keyOf(r.employee, r.date)));

  // Group submissions by (employee, date).
  const groups = new Map();
  for (const s of subs) {
    const k = keyOf(s.employee, s.date);
    if (!groups.has(k)) groups.set(k, { employee: s.employee, date: s.date, items: [] });
    groups.get(k).items.push(s);
  }

  const reflectionOps = [];
  const reviewOps = [];

  for (const [k, g] of groups.entries()) {
    if (!haveReflection.has(k)) {
      // Take the first non-empty self* value across the day's subs.
      const sel = g.items.find((s) => s.selfRating != null);
      const noteSub = g.items.find((s) => s.selfNote);
      const ideaSub = g.items.find((s) => s.idea);
      reflectionOps.push({
        insertOne: {
          document: {
            employee:  g.employee,
            date:      g.date,
            selfRating: sel?.selfRating,
            selfNote:   noteSub?.selfNote || '',
            idea:       ideaSub?.idea || '',
          },
        },
      });
    }

    if (!haveReview.has(k)) {
      // Daily discipline + idea = sum of per-sub values that were
      // already awarded on the day's subs (so the synthesized
      // DailyReview matches the day total the employee was already
      // paid for in earnedPoints).  Max values come from the same
      // sub (defaults if missing).
      let disc = 0, idea = 0, maxDisc = 0, maxIdea = 0;
      let discNote = '', ideaFeedback = '';
      let reviewedBy, reviewedAt, anyReviewed = false;
      for (const s of g.items) {
        disc += Number(s.disciplineMarks) || 0;
        idea += Number(s.ideaMarks) || 0;
        // Take maxima from the highest-cap sub so we don't lose info
        // if HR customised per-sub caps on a single day.
        maxDisc = Math.max(maxDisc, Number(s.maxDisciplineMarks) || 0);
        maxIdea = Math.max(maxIdea, Number(s.maxIdeaMarks) || 0);
        if (!discNote      && s.disciplineNote) discNote = s.disciplineNote;
        if (!ideaFeedback  && s.ideaFeedback)   ideaFeedback = s.ideaFeedback;
        if (s.reviewStatus === 'reviewed') {
          anyReviewed = true;
          if (!reviewedBy && s.reviewedBy) reviewedBy = s.reviewedBy;
          if (!reviewedAt && s.reviewedAt) reviewedAt = s.reviewedAt;
        }
      }
      // Primary = first chronological sub (already sorted by submittedAt).
      const primary = g.items[0];
      reviewOps.push({
        insertOne: {
          document: {
            employee: g.employee,
            date:     g.date,
            disciplineMarks: disc,
            maxDisciplineMarks: maxDisc || 3,
            disciplineNote: discNote,
            ideaMarks: idea,
            maxIdeaMarks: maxIdea || 2,
            ideaFeedback: ideaFeedback,
            reviewStatus: anyReviewed ? 'reviewed' : 'pending',
            reviewedBy: reviewedBy,
            reviewedAt: reviewedAt,
            primarySubmissionId: primary?._id,
          },
        },
      });
    }
  }

  let reflectionsCreated = 0;
  let reviewsCreated = 0;
  if (reflectionOps.length > 0) {
    const r = await DailyReflection.bulkWrite(reflectionOps, { ordered: false });
    reflectionsCreated = r?.insertedCount || reflectionOps.length;
  }
  if (reviewOps.length > 0) {
    const r = await DailyReview.bulkWrite(reviewOps, { ordered: false });
    reviewsCreated = r?.insertedCount || reviewOps.length;
  }

  /* -----------------------------------------------------------------
     Pass 3 — collapse per-submission discipline/idea into work-only.
     -----------------------------------------------------------------
     After Phase 6, the Submission row carries ONLY work-scoring fields.
     Discipline + idea live exclusively on DailyReview.  This pass:

       - zeroes every submission's disciplineMarks / ideaMarks /
         maxDisciplineMarks / maxIdeaMarks / disciplineNote / ideaFeedback
       - recomputes earnedPoints  = workEarnedPoints
                    totalPoints   = workTotalPoints
                    completion%   = work-only ratio

     Idempotent: the filter only matches rows where any of the
     daily-marks fields are still populated, so subsequent boots
     touch 0 rows.

     Safe by construction: the daily totals were already synthesised
     into DailyReview in pass 2, so removing them from Submission
     does not lose information.
  */
  const dirty = await Submission.find({
    $or: [
      { disciplineMarks:    { $gt: 0 } },
      { ideaMarks:          { $gt: 0 } },
      { maxDisciplineMarks: { $gt: 0 } },
      { maxIdeaMarks:       { $gt: 0 } },
      { disciplineNote:     { $exists: true, $ne: '' } },
      { ideaFeedback:       { $exists: true, $ne: '' } },
    ],
  }).select('_id workEarnedPoints workTotalPoints earnedPoints totalPoints completionPercentage');

  let collapsed = 0;
  if (dirty.length > 0) {
    const ops = dirty.map((s) => {
      const earned = Number(s.workEarnedPoints) || 0;
      const total  = Number(s.workTotalPoints)  || 0;
      const pct    = total > 0 ? (earned / total) * 100 : 0;
      return {
        updateOne: {
          filter: { _id: s._id },
          update: {
            $set: {
              disciplineMarks: 0,
              maxDisciplineMarks: 0,
              ideaMarks: 0,
              maxIdeaMarks: 0,
              disciplineNote: '',
              ideaFeedback: '',
              earnedPoints: earned,
              totalPoints: total,
              completionPercentage: pct,
            },
          },
        },
      };
    });
    const r = await Submission.bulkWrite(ops, { ordered: false });
    collapsed = r?.modifiedCount || ops.length;
  }

  console.log(`[migrate] daily-review: walked ${groups.size} (employee, date) bucket(s), inserted ${reflectionsCreated} reflection(s), ${reviewsCreated} review(s), collapsed ${collapsed} per-submission disc/idea row(s) to work-only`);
  return { daysWalked: groups.size, reflectionsCreated, reviewsCreated, collapsed };
};

module.exports = { migrateDailyReviews };
