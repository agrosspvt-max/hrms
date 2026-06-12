/**
 * dailyReviewController.js
 *
 * Phase 5 grouped-review backend.
 *
 *   - GET  /api/daily-review/grouped?date=YYYY-MM-DD&status=
 *           HR / SA / HOD feed.  Returns one card per (employee, date)
 *           with every submission + the day's reflection + review state.
 *
 *   - GET  /api/daily-review/day?employeeId=...&date=YYYY-MM-DD
 *           Full payload for one employee-day: every submission with
 *           its templateType-specific data, the reflection, the review.
 *
 *   - POST /api/daily-reflection
 *           Employee saves / updates their own day's reflection.
 *           Body: { date, selfRating, selfNote, idea }
 *
 *   - POST /api/daily-review/finalize
 *           HR / SA / HOD writes discipline + idea + notes for a day
 *           and flips every same-day submission to reviewStatus=reviewed.
 *           Body: { employeeId, date, disciplineMarks, ideaMarks,
 *                   maxDisciplineMarks?, maxIdeaMarks?,
 *                   disciplineNote?, ideaFeedback? }
 */

const asyncHandler   = require('express-async-handler');
const mongoose       = require('mongoose');
const Submission     = require('../models/Submission');
const User           = require('../models/User');
const DailyReflection= require('../models/DailyReflection');
const DailyReview    = require('../models/DailyReview');
const { startOfDay } = require('../utils/dateHelpers');
const { liveSubmissionFilter } = require('../utils/submissionFilter');
const { logAudit }   = require('../utils/audit');
const notify         = require('../services/notifyEvents');

const _resolveDay = (raw) => startOfDay(raw ? new Date(raw) : new Date());

/* ------------------------------------------------------------------ */
/* Grouped review feed                                                 */
/* ------------------------------------------------------------------ */
/**
 * GET /api/daily-review/grouped
 *
 * Returns one card per (employee, date) for the chosen day.  Each
 * card holds every live submission for that employee, their daily
 * reflection (if any), and the daily review (if any).  HR sees
 * employee + HR submissions; SA sees everything; HOD sees their
 * own department.
 */
const listGrouped = asyncHandler(async (req, res) => {
  const day = _resolveDay(req.query.date);
  const status = req.query.status; // 'pending' | 'reviewed'

  // ----- Employee scope (role-aware) -----
  const empWhere = { status: 'active' };
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role === 'super_admin') {
    // full org
  } else if (role === 'hr') {
    // full org (HR may filter via query.department)
    if (req.query.department && mongoose.Types.ObjectId.isValid(req.query.department)) {
      empWhere.department = req.query.department;
    }
  } else if (isHOD) {
    empWhere.department = req.user.hodDepartment;
  } else {
    res.status(403);
    throw new Error('Grouped review is restricted to HR / Super Admin / HOD.');
  }

  // ----- Submissions for the day -----
  const subWhere = {
    submitted: true,
    date: day,
    ...liveSubmissionFilter({}),
  };

  // Pull employee list first so we can scope the submission query.
  const employees = await User.find(empWhere).select('_id name employeeId role department')
    .populate('department', 'name').lean();
  const empMap = new Map(employees.map((e) => [String(e._id), e]));
  subWhere.employee = { $in: employees.map((e) => e._id) };

  // Role visibility: HR shouldn't see other HR's review queue, etc.
  // Mirror the existing listForReview role gates.
  const allowedOwnerRoles = role === 'super_admin' ? ['employee', 'hr'] : (role === 'hr' ? ['employee'] : ['employee']);

  const subs = await Submission.find(subWhere)
    .populate('template', 'title templateType customKind customSections customFields')
    .populate('assignment', 'frequency scheduleLabel')
    // Phase 16: surface the HOD reviewer's identity so HR sees who
    // approved / returned each submission without an extra round-trip.
    .populate('hodReview.reviewedBy', 'name role')
    .sort({ employee: 1, submittedAt: 1, _id: 1 })
    .lean();

  // Pre-fetch reflections + reviews for the day for the scoped employees.
  const empIds = [...new Set(subs.map((s) => String(s.employee)))];
  const [reflections, reviews] = await Promise.all([
    DailyReflection.find({ employee: { $in: empIds }, date: day }).lean(),
    DailyReview.find({ employee: { $in: empIds }, date: day })
      .populate('reviewedBy', 'name role').lean(),
  ]);
  const refMap = new Map(reflections.map((r) => [String(r.employee), r]));
  const revMap = new Map(reviews.map((r)     => [String(r.employee), r]));

  // Group by employee.
  const cards = new Map();
  for (const s of subs) {
    const e = empMap.get(String(s.employee));
    if (!e || !allowedOwnerRoles.includes(e.role)) continue;
    if (String(e._id) === String(req.user._id)) continue; // never review yourself
    if (!cards.has(String(e._id))) {
      cards.set(String(e._id), {
        employee: { _id: e._id, name: e.name, employeeId: e.employeeId, department: e.department?.name || '' },
        date: day,
        submissions: [],
        reflection: refMap.get(String(e._id)) || null,
        review:     revMap.get(String(e._id)) || null,
      });
    }
    cards.get(String(e._id)).submissions.push(s);
  }

  let out = [...cards.values()];
  if (status === 'pending')  out = out.filter((c) => !c.review || c.review.reviewStatus !== 'reviewed');
  if (status === 'reviewed') out = out.filter((c) =>  c.review && c.review.reviewStatus === 'reviewed');

  res.json(out);
});

/* ------------------------------------------------------------------ */
/* Full payload for one (employee, date)                               */
/* ------------------------------------------------------------------ */
const getDay = asyncHandler(async (req, res) => {
  const { employeeId, date } = req.query;
  if (!mongoose.Types.ObjectId.isValid(employeeId)) {
    res.status(400); throw new Error('Valid employeeId is required.');
  }
  const day = _resolveDay(date);

  const employee = await User.findById(employeeId).populate('department', 'name').lean();
  if (!employee) { res.status(404); throw new Error('Employee not found.'); }

  // HOD clamp: HOD can only fetch their own department.
  if (req.user.role !== 'hr' && req.user.role !== 'super_admin') {
    if (!req.user.isHOD || String(employee.department?._id || employee.department) !== String(req.user.hodDepartment)) {
      res.status(403); throw new Error('You may not view this employee.');
    }
  }

  const [submissions, reflection, review] = await Promise.all([
    Submission.find({ employee: employee._id, date: day, ...liveSubmissionFilter({}) })
      .populate('template', 'title templateType customKind customSections customFields')
      .populate('assignment', 'frequency scheduleLabel')
      .populate('hodReview.reviewedBy', 'name role')
      .sort({ submittedAt: 1, _id: 1 }).lean(),
    DailyReflection.findOne({ employee: employee._id, date: day }).lean(),
    DailyReview.findOne({ employee: employee._id, date: day }).populate('reviewedBy', 'name role').lean(),
  ]);

  res.json({ employee, date: day, submissions, reflection: reflection || null, review: review || null });
});

/* ------------------------------------------------------------------ */
/* Employee saves their own day's reflection                           */
/* ------------------------------------------------------------------ */
const saveReflection = asyncHandler(async (req, res) => {
  const { date, selfRating, selfNote, idea } = req.body || {};
  const day = _resolveDay(date);
  const $set = { lastEditedBy: req.user._id };
  if (selfRating !== undefined) $set.selfRating = selfRating === '' ? undefined : Number(selfRating);
  if (selfNote   !== undefined) $set.selfNote   = String(selfNote || '');
  if (idea       !== undefined) $set.idea       = String(idea || '');
  const doc = await DailyReflection.findOneAndUpdate(
    { employee: req.user._id, date: day },
    { $set, $setOnInsert: { employee: req.user._id, date: day } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  res.json(doc);
});

/* ------------------------------------------------------------------ */
/* HR finalises a day's discipline + idea                              */
/* ------------------------------------------------------------------ */
const finalizeDay = asyncHandler(async (req, res) => {
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin' && !isHOD) {
    res.status(403); throw new Error('Only HR / Super Admin / HOD may finalise a daily review.');
  }
  const { employeeId, date } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(employeeId)) {
    res.status(400); throw new Error('Valid employeeId is required.');
  }
  const day = _resolveDay(date);
  if (String(employeeId) === String(req.user._id)) {
    res.status(403); throw new Error('You cannot finalise your own review.');
  }
  const employee = await User.findById(employeeId).select('department role').lean();
  if (!employee) { res.status(404); throw new Error('Employee not found.'); }

  // HOD clamp + role gates (mirror existing reviewSubmission semantics).
  if (isHOD && role !== 'hr' && role !== 'super_admin') {
    if (String(employee.department) !== String(req.user.hodDepartment)) {
      res.status(403); throw new Error('Department clamp: not your department.');
    }
  }
  if (role === 'hr' && employee.role === 'hr') {
    res.status(403); throw new Error('Only a Super Admin can finalise HR reviews.');
  }
  if (employee.role === 'super_admin') {
    res.status(403); throw new Error('Super Admin submissions are auto-finalised.');
  }

  const subs = await Submission.find({
    employee: employee._id, date: day, submitted: true, ...liveSubmissionFilter({}),
  }).sort({ submittedAt: 1, _id: 1 });
  if (subs.length === 0) {
    res.status(400); throw new Error('No submissions found for this employee on the given day.');
  }

  // Clamp the awarded marks to the configured maxima.
  const maxDisc = Number(req.body.maxDisciplineMarks ?? 3);
  const maxIdea = Number(req.body.maxIdeaMarks ?? 2);
  const disc    = Math.max(0, Math.min(Number(req.body.disciplineMarks) || 0, maxDisc));
  const idea    = Math.max(0, Math.min(Number(req.body.ideaMarks)       || 0, maxIdea));
  const discNote     = String(req.body.disciplineNote || '').trim();
  const ideaFeedback = String(req.body.ideaFeedback   || '').trim();

  // Primary submission = first chronological (already sorted).
  const primary = subs[0];

  // Persist the DailyReview doc.  This is the SINGLE SOURCE OF TRUTH
  // for the day's discipline + innovation marks.  Per-submission rows
  // are NEVER touched -- they carry only their own work scoring.
  // Analytics, salary, employee history all read DailyReview directly
  // for the day-level marks (see analyticsController.completion,
  // salaryController.computeSlip, dashboardController.employeeSummary).
  const review = await DailyReview.findOneAndUpdate(
    { employee: employee._id, date: day },
    {
      $set: {
        disciplineMarks: disc, maxDisciplineMarks: maxDisc, disciplineNote: discNote,
        ideaMarks: idea,       maxIdeaMarks: maxIdea,       ideaFeedback: ideaFeedback,
        reviewedBy: req.user._id, reviewedAt: new Date(),
        reviewStatus: 'reviewed',
        // Kept for the rare audit-trail use case; not used by any
        // analytics path anymore.
        primarySubmissionId: primary._id,
      },
      $setOnInsert: { employee: employee._id, date: day },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // Flip every same-day submission to reviewed so the existing review
  // pipeline + Submission Control's reviewStatus filters reflect the
  // finalised day.  IMPORTANT: we no longer touch disciplineMarks /
  // ideaMarks / earnedPoints on any submission -- those live solely
  // on DailyReview now.  earnedPoints stays = workEarnedPoints, which
  // analytics joins to DailyReview to surface the true day total.
  for (const s of subs) {
    s.reviewStatus = 'reviewed';
    s.currentReviewStage = 'finalized';
    s.reviewedBy = req.user._id;
    s.reviewedAt = new Date();
    // Re-derive cached scores as work-only so re-finalising stays
    // idempotent even if a prior version of the code wrote daily
    // marks into per-sub fields.  The migration backfill (pass 3)
    // does the same collapse for historical rows.
    s.earnedPoints = Number(s.workEarnedPoints) || 0;
    s.totalPoints  = Number(s.workTotalPoints)  || 0;
    s.completionPercentage = s.totalPoints > 0 ? (s.earnedPoints / s.totalPoints) * 100 : 0;
    s.reviewHistory = s.reviewHistory || [];
    s.reviewHistory.push({
      reviewedBy: req.user._id,
      reviewerName: req.user.name,
      role: role,
      stage: 'finalized',
      action: 'daily_finalize',
      // Marks audit field captures the DAY-LEVEL total, not per-sub.
      marks: disc + idea,
      remarks: discNote || '',
      timestamp: new Date(),
    });
    await s.save();
  }

  // One day-level notification, not N per-sub notifications.
  try {
    notify.notifySubmissionReviewed({
      employeeId: employee._id,
      submission: { date: day },
      reviewedBy: req.user,
    });
  } catch (_) { /* notify never blocks */ }

  logAudit(req, {
    action: 'daily-review.finalize',
    targetType: 'DailyReview',
    targetId: review._id,
    targetLabel: `${employee._id} · ${day.toISOString().slice(0, 10)}`,
    meta: { disciplineMarks: disc, ideaMarks: idea, submissionCount: subs.length, primarySubmissionId: primary._id },
  });

  res.json({ ok: true, review, submissionCount: subs.length, primarySubmissionId: primary._id });
});

/* ------------------------------------------------------------------ */
/* Per-task status edit (HR / SA / HOD)                                */
/*                                                                     */
/* Phase 10: reviewers need to flip a single task's status (e.g. an   */
/* employee marked "Done" on a task they didn't actually complete).    */
/* This endpoint patches the row, optionally captures a pending        */
/* reason, recomputes workEarnedPoints + workTotalPoints + cached      */
/* earnedPoints / completionPercentage, and audits the change.         */
/*                                                                     */
/* Marks pipeline preserved:                                           */
/*   - Same scoring formula the existing reviewSubmission uses:        */
/*     done/ongoing earn points + count toward total; pending counts   */
/*     toward total only; work_not_available counts neither.           */
/*   - HR-defined rows use their template `points`; employee-added     */
/*     rows use `awardedMarks`.                                        */
/*                                                                     */
/* Discipline + idea live exclusively on DailyReview, so this endpoint */
/* never touches them.                                                 */
/* ------------------------------------------------------------------ */
const ALLOWED_TASK_STATUSES = ['done', 'ongoing', 'pending', 'work_not_available', 'pending_submit'];

const editTaskStatus = asyncHandler(async (req, res) => {
  const { submissionId, taskId, status, pendingReason } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    res.status(400); throw new Error('Valid submissionId is required.');
  }
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    res.status(400); throw new Error('Valid taskId is required.');
  }
  if (!ALLOWED_TASK_STATUSES.includes(status)) {
    res.status(400); throw new Error(`status must be one of: ${ALLOWED_TASK_STATUSES.join(', ')}`);
  }
  const sub = await Submission.findById(submissionId);
  if (!sub) { res.status(404); throw new Error('Submission not found.'); }
  if (sub.templateType !== 'task') {
    res.status(400); throw new Error('This endpoint only edits task-template submissions.');
  }

  // Role gate -- mirror the finalizeDay rules so HOD can only edit
  // their own department's submissions.
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin' && !isHOD) {
    res.status(403); throw new Error('Only HR / Super Admin / HOD may edit task status.');
  }
  if (String(sub.employee) === String(req.user._id)) {
    res.status(403); throw new Error('You cannot edit your own submission.');
  }
  const owner = await User.findById(sub.employee).select('role department').lean();
  if (!owner) { res.status(404); throw new Error('Submission owner not found.'); }
  if (role === 'hr' && (owner.role === 'hr' || owner.role === 'super_admin')) {
    res.status(403); throw new Error('Only Super Admin can edit HR submissions.');
  }
  if (isHOD && role !== 'hr' && role !== 'super_admin') {
    if (String(owner.department) !== String(req.user.hodDepartment)) {
      res.status(403); throw new Error('Department clamp: not your department.');
    }
  }

  const task = (sub.tasks || []).id(taskId);
  if (!task) { res.status(404); throw new Error('Task row not found on this submission.'); }

  const oldStatus = task.status;
  const oldReason = task.pendingReason || '';

  // Pending-since stamping: if we're flipping INTO pending, set
  // pendingSince now (matches the daily engine's first-seen semantic).
  if (status === 'pending' && oldStatus !== 'pending') {
    task.pendingSince = task.pendingSince || new Date();
  }
  // Clear completedAt when moving out of done/ongoing back to pending.
  if (status !== 'done' && status !== 'ongoing') {
    task.completedAt = undefined;
  } else if (!task.completedAt && (status === 'done' || status === 'ongoing')) {
    task.completedAt = new Date();
  }
  task.status = status;
  task.pendingReason = status === 'pending'
    ? String(pendingReason || oldReason || '').trim()
    : '';

  sub.markModified('tasks');

  // Recompute work scoring -- same formula reviewSubmission uses.
  let earned = 0, total = 0;
  for (const t of sub.tasks) {
    if (t.addedByEmployee) {
      const awarded = Number(t.awardedMarks) || 0;
      earned += awarded;
      total  += awarded;
    } else {
      if (t.status === 'done' || t.status === 'ongoing') earned += Number(t.points) || 0;
      if (t.status === 'done' || t.status === 'ongoing' || t.status === 'pending') {
        total += Number(t.points) || 0;
      }
    }
  }
  sub.workEarnedPoints = earned;
  sub.workTotalPoints  = total;
  // Cached earned/total are WORK-ONLY (Phase 6 -- discipline + idea
  // live on DailyReview).  Daily totals fold in at analytics time.
  sub.earnedPoints = earned;
  sub.totalPoints  = total;
  sub.completionPercentage = total > 0 ? (earned / total) * 100 : 0;

  // Edit history -- captures who/what/when so HR audit log + edit
  // history surface the change.
  sub.editHistory = sub.editHistory || [];
  sub.editHistory.push({
    editedBy: req.user._id,
    editorName: req.user.name,
    role,
    fields: [`tasks.${taskId}.status`],
    note: `${oldStatus} → ${status}${status === 'pending' && task.pendingReason ? ` · reason: ${task.pendingReason}` : ''}`,
    timestamp: new Date(),
  });

  await sub.save();

  logAudit(req, {
    action: 'submission.task-status-edit',
    targetType: 'Submission',
    targetId: sub._id,
    targetLabel: `${owner._id} · ${String(sub.date).slice(0, 10)}`,
    meta: { taskId: String(taskId), from: oldStatus, to: status, pendingReason: task.pendingReason || '' },
  });

  res.json({ ok: true, submission: sub });
});

module.exports = { listGrouped, getDay, saveReflection, finalizeDay, editTaskStatus };
