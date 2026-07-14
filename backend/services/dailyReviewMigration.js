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
  // the backfill needs.
  const subs = await Submission.find({ deleted: { $ne: true } })
    .select('employee date submittedAt selfRating selfNote idea ideaMarks maxIdeaMarks ideaFeedback reviewStatus reviewedBy reviewedAt')
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
      // Daily idea marks = sum of per-sub values that were already
      // awarded on the day's subs.  Max values come from the highest-
      // cap sub so we don't lose info if HR customised per-sub caps.
      let idea = 0, maxIdea = 0;
      let ideaFeedback = '';
      let reviewedBy, reviewedAt, anyReviewed = false;
      for (const s of g.items) {
        idea += Number(s.ideaMarks) || 0;
        maxIdea = Math.max(maxIdea, Number(s.maxIdeaMarks) || 0);
        if (!ideaFeedback && s.ideaFeedback) ideaFeedback = s.ideaFeedback;
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

  console.log(`[migrate] daily-review: walked ${groups.size} (employee, date) bucket(s), inserted ${reflectionsCreated} reflection(s), ${reviewsCreated} review(s)`);
  return { daysWalked: groups.size, reflectionsCreated, reviewsCreated };
};

module.exports = { migrateDailyReviews };
