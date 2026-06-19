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
const DependencyTask = require('../models/DependencyTask');
const Leave          = require('../models/Leave');
const Attendance     = require('../models/Attendance');
const Assignment     = require('../models/Assignment');
const Holiday        = require('../models/Holiday');
const { startOfDay } = require('../utils/dateHelpers');
const { liveSubmissionFilter } = require('../utils/submissionFilter');
const { isScheduledOn } = require('../utils/scheduleHelpers');
const { logAudit }   = require('../utils/audit');
const notify         = require('../services/notifyEvents');

/**
 * Phase 23.3 — Attach dependent-task hand-offs to each submission so the
 * Submission Reviews UI can render "transferred to / on / status" inline
 * under the relevant task section.  Mirrors submissionController
 * .attachDependencies but keeps the keys the grouped review UI expects
 * (sourceTaskId, originalTaskName, assignedToName, transferredAt,
 * resolvedAt, currentStatus).  Read-only enrichment — never touches
 * scoring or the review pipeline.
 */
const _attachDependencies = async (submissions) => {
  if (!submissions.length) return;
  const subIds = submissions.map((s) => s._id);
  const deps = await DependencyTask.find({ sourceSubmissionId: { $in: subIds } })
    .populate('assignedTo', 'name employeeId')
    .populate('assignedBy', 'name employeeId')
    .sort({ createdAt: 1 })
    .lean();
  const bySub = new Map();
  for (const d of deps) {
    const k = String(d.sourceSubmissionId);
    if (!bySub.has(k)) bySub.set(k, []);
    bySub.get(k).push({
      _id: d._id,
      sourceTaskId: d.sourceTaskId,
      sourceKind: d.sourceKind,
      originalTaskName: d.originalTaskName || '',
      assignedToName: d.assignedTo?.name || d.assignedToName || '',
      assignedToEmployeeId: d.assignedTo?.employeeId || '',
      assignedByName: d.assignedBy?.name || d.assignedByName || '',
      assignedByEmployeeId: d.assignedBy?.employeeId || '',
      currentStatus: d.currentStatus,
      remark: d.remark || '',
      transferredAt: d.createdAt,
      resolvedAt: d.resolvedAt || null,
      resolutionHours: d.resolvedAt
        ? Math.round((new Date(d.resolvedAt) - new Date(d.waitingSince || d.createdAt)) / 36e5 * 10) / 10
        : null,
      chainId: d.chainId,
    });
  }
  submissions.forEach((s) => { s.dependencies = bySub.get(String(s._id)) || []; });
};

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

  // Phase 23.3: enrich each submission with its dependent-task hand-offs.
  await _attachDependencies(subs);

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

  /* ====================================================================
   * Phase 28 -- Not Submitted filter
   *
   * Surface employees who were expected to submit work on this day but
   * didn't, with leave-aware exclusion and HOD scope respect.  An
   * employee qualifies as "Not Submitted" when ALL of these hold for the
   * selected date:
   *   - Active (already enforced by empWhere).
   *   - role !== 'super_admin' (filtered below).
   *   - Has at least one active assignment scheduled for the day.
   *   - Did NOT submit anything for the day.
   *   - Has NO approved leave (full OR half day) covering the day.
   *   - The day isn't a weekly off + has no holiday override (skipped by
   *     the assignment scheduling check via dailyEngine semantics).
   *
   * The response shape is intentionally an object { cards, summary } for
   * this status only -- other statuses still return a plain array for
   * backward compatibility with the existing frontend.
   * ================================================================== */
  if (status === 'not_submitted') {
    // Pull employees again with the fields the per-day check needs
    // (designation + weeklyOff), within the same role-scoped where.
    const empWhereNS = { ...empWhere, role: { $ne: 'super_admin' } };
    const fullEmployees = await User.find(empWhereNS)
      .select('_id name employeeId role department designation weeklyOff')
      .populate('department', 'name')
      .lean();

    // Employees with at least one submission today (any status).
    const submittedEmpIds = new Set(
      (await Submission.find({
        employee: { $in: fullEmployees.map((e) => e._id) },
        date: day,
        submitted: true,
        ...liveSubmissionFilter({}),
      }).select('employee').lean()).map((s) => String(s.employee))
    );

    // Approved leaves covering this day for the scoped employee set.
    // Includes both full-day and half-day -- per spec, ANY approved
    // leave excludes the employee from the Not Submitted list.
    const leavesToday = await Leave.find({
      employee: { $in: fullEmployees.map((e) => e._id) },
      status: 'approved',
      fromDate: { $lte: day },
      toDate:   { $gte: day },
    }).lean();
    const leaveByEmp = new Map();
    for (const lv of leavesToday) {
      // Keep first / longest leave per employee for display labelling.
      const k = String(lv.employee);
      if (!leaveByEmp.has(k)) leaveByEmp.set(k, lv);
    }

    // Attendance records on this date (manual overrides).  Used purely
    // for display so HR sees the latest attendance state.
    const attRecords = await Attendance.find({
      employee: { $in: fullEmployees.map((e) => e._id) },
      date: day,
    }).lean();
    const attByEmp = new Map(attRecords.map((a) => [String(a.employee), a]));

    // Holiday lookup -- same gate the dailyEngine uses to decide whether
    // a day even expects work without holidayOverride assignments.
    const holiday = await Holiday.findOne({ date: day });

    // Pre-load assignments once per employee.  Uses the same set the
    // dailyEngine builds (direct / department / designation orList).
    const notSubmittedCards = [];
    const summary = { expectedToSubmit: 0, submitted: 0, notSubmitted: 0, onApprovedLeave: 0 };

    for (const e of fullEmployees) {
      if (String(e._id) === String(req.user._id)) continue;
      const leave = leaveByEmp.get(String(e._id));
      const isOnLeave = !!leave;
      const isWeeklyOff = (e.weeklyOff || [0]).includes(day.getUTCDay());

      // Build orList per dailyEngine.assignmentsForEmployee semantics.
      const orList = [{ targetType: 'employee', targetRef: e._id }];
      if (e.department) orList.push({ targetType: 'department', targetRef: e.department._id || e.department });
      if (e.designation) orList.push({ targetType: 'designation', targetRef: e.designation });
      const assignments = await Assignment.find({ active: true, $or: orList })
        .populate('template', 'title customKind templateType').lean();

      // Filter to those scheduled today (recurrence + start/end window).
      // On weekly-off / holiday days, only holidayOverride assignments
      // count -- this matches the dailyEngine "nonWorking" gate.
      const nonWorking = isWeeklyOff || !!holiday;
      const scheduledToday = assignments.filter((a) => {
        if (!a.template) return false;
        if (nonWorking) {
          if (a.holidayOverride !== true) return false;
          if (a.overrideScope !== 'all') {
            const start = a.startDate ? startOfDay(a.startDate) : null;
            if (!start || start.getTime() !== day.getTime()) return false;
          }
        }
        return isScheduledOn(a, day);
      });

      const submittedToday = submittedEmpIds.has(String(e._id));
      const hasAssignments = scheduledToday.length > 0;

      // Summary buckets reflect the full role-scoped employee universe,
      // not just the not-submitted list -- so HR sees how many people
      // were on the hook vs. how many actually delivered.
      if (isOnLeave) summary.onApprovedLeave += 1;
      if (!isOnLeave && hasAssignments) {
        summary.expectedToSubmit += 1;
        if (submittedToday) summary.submitted += 1;
        else summary.notSubmitted += 1;
      }

      // Card eligibility -- the four ALL-of conditions from the spec.
      if (isOnLeave) continue;
      if (submittedToday) continue;
      if (!hasAssignments) continue;

      const att = attByEmp.get(String(e._id));
      notSubmittedCards.push({
        notSubmitted: true,
        employee: {
          _id: e._id,
          name: e.name,
          employeeId: e.employeeId,
          department: e.department?.name || '',
        },
        date: day,
        assignments: scheduledToday.map((a) => ({
          _id: a._id,
          title: a.template?.title || '(untitled)',
          templateType: a.template?.templateType || '',
          customKind: a.template?.customKind || '',
          scheduleLabel: a.scheduleLabel || '',
        })),
        attendance: att ? att.status : (isWeeklyOff ? 'weekly_off' : (holiday ? 'holiday' : 'absent')),
        leave: null,
      });
    }

    return res.json({ cards: notSubmittedCards, summary });
  }

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

  // Phase 23.3: enrich submissions with dependent-task hand-offs.
  await _attachDependencies(submissions);

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

  // Phase 26 — workflow gating.  A "pure HOD" is a HOD account that is
  // NOT also HR or Super Admin.  Their finalisation is a recommendation
  // step (hodReview), not the real HR finalisation: it must NOT flip the
  // submission to reviewStatus='reviewed' or stage='finalized', because
  // doing so would surface the day as "HR Reviewed" on HR / SA accounts
  // before HR has actually acted.  HR + SA paths keep the existing
  // finalisation behaviour exactly as it was.
  const isPureHOD = isHOD && role !== 'hr' && role !== 'super_admin';

  // Persist the DailyReview doc.  This is the SINGLE SOURCE OF TRUTH
  // for the day's discipline + innovation marks.  Per-submission rows
  // are NEVER touched -- they carry only their own work scoring.
  // Analytics, salary, employee history all read DailyReview directly
  // for the day-level marks (see analyticsController.completion,
  // salaryController.computeSlip, dashboardController.employeeSummary).
  // For HOD recommendations we save the marks (so HR can see what was
  // proposed and override if needed) but keep reviewStatus='pending'
  // so analytics / dashboards don't treat the day as finalised.
  const review = await DailyReview.findOneAndUpdate(
    { employee: employee._id, date: day },
    {
      $set: {
        disciplineMarks: disc, maxDisciplineMarks: maxDisc, disciplineNote: discNote,
        ideaMarks: idea,       maxIdeaMarks: maxIdea,       ideaFeedback: ideaFeedback,
        reviewedBy: req.user._id, reviewedAt: new Date(),
        reviewStatus: isPureHOD ? 'pending' : 'reviewed',
        // Kept for the rare audit-trail use case; not used by any
        // analytics path anymore.
        primarySubmissionId: primary._id,
      },
      $setOnInsert: { employee: employee._id, date: day },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // ---- Per-submission updates -------------------------------------
  // HR / SA path (unchanged): flip to reviewed + finalized so the
  // existing review pipeline + Submission Control's reviewStatus
  // filters reflect the finalised day.
  //
  // HOD path (Phase 26): write hodReview block + set stage to
  // 'hod_reviewed' so HR / SA see "HOD Approved — Awaiting HR".  Leave
  // reviewStatus untouched (stays pending) and never write to the
  // top-level reviewedBy / reviewedAt — those are HR-only audit fields.
  for (const s of subs) {
    if (isPureHOD) {
      s.hodReview = {
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        recommend:  'approve',
        marksGiven: true,
        remarks:    discNote || s.hodReview?.remarks || '',
      };
      s.currentReviewStage = 'hod_reviewed';
      // Do NOT touch reviewStatus / reviewedBy / reviewedAt / earned -
      // those reflect HR finalisation only.
      s.reviewHistory = s.reviewHistory || [];
      s.reviewHistory.push({
        reviewedBy: req.user._id,
        reviewerName: req.user.name,
        role,
        stage: 'hod_reviewed',
        action: 'daily_hod_review',
        marks: disc + idea,
        remarks: discNote || '',
        timestamp: new Date(),
      });
      await s.save();
      continue;
    }
    // HR / SA path -- existing behaviour.
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

  // Notify the employee ONLY when HR / SA truly finalises the day.
  // HOD action is a recommendation -- firing a "review complete"
  // notification at that point would misrepresent the workflow stage.
  if (!isPureHOD) {
    try {
      notify.notifySubmissionReviewed({
        employeeId: employee._id,
        submission: { date: day },
        reviewedBy: req.user,
      });
    } catch (_) { /* notify never blocks */ }
  }

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

/* ------------------------------------------------------------------ */
/* Phase 23.7 — Extra work scoring                                      */
/*                                                                      */
/* Lets HR / SA / HOD assign / edit `awardedMarks` on an employee-added */
/* task row.  Mirrors editTaskStatus's role gates + audit logging.  The */
/* points flow through the same scoring pipeline:                       */
/*   - employee-added rows: total += awardedMarks; earned += awardedMarks*/
/*   - HR-defined rows are untouched (this endpoint refuses to touch    */
/*     `points` on system-generated rows).                              */
/*                                                                      */
/* Body shape:                                                          */
/*   { submissionId, taskId, awardedMarks }                              */
/* ------------------------------------------------------------------ */
const editTaskMarks = asyncHandler(async (req, res) => {
  const { submissionId, taskId, awardedMarks } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    res.status(400); throw new Error('Valid submissionId is required.');
  }
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    res.status(400); throw new Error('Valid taskId is required.');
  }
  const marksNum = Number(awardedMarks);
  if (!Number.isFinite(marksNum) || marksNum < 0) {
    res.status(400); throw new Error('awardedMarks must be a number >= 0.');
  }

  const sub = await Submission.findById(submissionId);
  if (!sub) { res.status(404); throw new Error('Submission not found.'); }
  if (sub.templateType !== 'task') {
    res.status(400); throw new Error('Marks edit currently supports task-template submissions only.');
  }

  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin' && !isHOD) {
    res.status(403); throw new Error('Only HR / Super Admin / HOD may edit task marks.');
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
  if (!task.addedByEmployee) {
    res.status(400); throw new Error('Marks can only be edited on employee-added extra work rows.');
  }

  const oldMarks = Number(task.awardedMarks) || 0;
  task.awardedMarks = marksNum;
  sub.markModified('tasks');

  // Recompute work scoring -- same formula reviewSubmission / editTaskStatus uses.
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
  sub.earnedPoints = earned;
  sub.totalPoints  = total;
  sub.completionPercentage = total > 0 ? (earned / total) * 100 : 0;

  sub.editHistory = sub.editHistory || [];
  sub.editHistory.push({
    editedBy: req.user._id,
    editorName: req.user.name,
    role,
    fields: [`tasks.${taskId}.awardedMarks`],
    note: `extra-work marks ${oldMarks} → ${marksNum}`,
    timestamp: new Date(),
  });

  await sub.save();

  logAudit(req, {
    action: 'submission.task-marks-edit',
    targetType: 'Submission',
    targetId: sub._id,
    targetLabel: `${owner._id} · ${String(sub.date).slice(0, 10)}`,
    meta: { taskId: String(taskId), from: oldMarks, to: marksNum, title: task.title || '' },
  });

  res.json({ ok: true, submission: sub });
});

/* ------------------------------------------------------------------ */
/* Phase 23.6 — Bulk discipline + innovation scoring                   */
/*                                                                     */
/* Lets HR / SA / HOD apply the SAME discipline + idea marks to a set  */
/* of (employee, date) pairs in one round-trip.  Internally just loops */
/* the per-day finalise pipeline -- nothing about the business rules,  */
/* role gates, audit logging, scoring formula or notification flow     */
/* changes.  Items that fail validation (forbidden / missing) are      */
/* skipped and reported back to the UI; successful items finalise.    */
/*                                                                     */
/* Body shape:                                                         */
/*   {                                                                 */
/*     items: [{ employeeId, date }, ...],                              */
/*     disciplineMarks, maxDisciplineMarks?,                            */
/*     ideaMarks,       maxIdeaMarks?,                                  */
/*     disciplineNote?, ideaFeedback?,                                  */
/*   }                                                                  */
/* ------------------------------------------------------------------ */
const bulkFinalize = asyncHandler(async (req, res) => {
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin' && !isHOD) {
    res.status(403); throw new Error('Only HR / Super Admin / HOD may finalise daily reviews.');
  }

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (items.length === 0) {
    res.status(400); throw new Error('items[] is required.');
  }

  // Phase 26 — same workflow gating as finalizeDay.  HOD-only callers
  // recommend; HR / SA finalise.
  const isPureHOD = isHOD && role !== 'hr' && role !== 'super_admin';

  const maxDisc = Number(req.body.maxDisciplineMarks ?? 3);
  const maxIdea = Number(req.body.maxIdeaMarks ?? 2);
  const disc    = Math.max(0, Math.min(Number(req.body.disciplineMarks) || 0, maxDisc));
  const idea    = Math.max(0, Math.min(Number(req.body.ideaMarks)       || 0, maxIdea));
  const discNote     = String(req.body.disciplineNote || '').trim();
  const ideaFeedback = String(req.body.ideaFeedback   || '').trim();

  const out = { ok: 0, failed: [], reviews: [] };

  for (const it of items) {
    const employeeId = it.employeeId;
    const dayRaw = it.date;
    try {
      if (!mongoose.Types.ObjectId.isValid(employeeId)) {
        out.failed.push({ employeeId, date: dayRaw, error: 'Invalid employeeId' });
        continue;
      }
      const day = _resolveDay(dayRaw);
      if (String(employeeId) === String(req.user._id)) {
        out.failed.push({ employeeId, date: dayRaw, error: 'Cannot finalise your own review.' });
        continue;
      }
      const employee = await User.findById(employeeId).select('department role').lean();
      if (!employee) {
        out.failed.push({ employeeId, date: dayRaw, error: 'Employee not found.' });
        continue;
      }
      if (isHOD && role !== 'hr' && role !== 'super_admin') {
        if (String(employee.department) !== String(req.user.hodDepartment)) {
          out.failed.push({ employeeId, date: dayRaw, error: 'Department clamp: not your department.' });
          continue;
        }
      }
      if (role === 'hr' && employee.role === 'hr') {
        out.failed.push({ employeeId, date: dayRaw, error: 'Only a Super Admin can finalise HR reviews.' });
        continue;
      }
      if (employee.role === 'super_admin') {
        out.failed.push({ employeeId, date: dayRaw, error: 'Super Admin submissions are auto-finalised.' });
        continue;
      }
      const subs = await Submission.find({
        employee: employee._id, date: day, submitted: true, ...liveSubmissionFilter({}),
      }).sort({ submittedAt: 1, _id: 1 });
      if (subs.length === 0) {
        out.failed.push({ employeeId, date: dayRaw, error: 'No submissions for that day.' });
        continue;
      }
      const primary = subs[0];

      const review = await DailyReview.findOneAndUpdate(
        { employee: employee._id, date: day },
        {
          $set: {
            disciplineMarks: disc, maxDisciplineMarks: maxDisc, disciplineNote: discNote,
            ideaMarks: idea,       maxIdeaMarks: maxIdea,       ideaFeedback,
            reviewedBy: req.user._id, reviewedAt: new Date(),
            // Phase 26 — HOD bulk recommendation stays 'pending' on the
            // DailyReview so analytics + dashboards continue treating the
            // day as "not yet finalised by HR".
            reviewStatus: isPureHOD ? 'pending' : 'reviewed',
            primarySubmissionId: primary._id,
          },
          $setOnInsert: { employee: employee._id, date: day },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      // Phase 26 — same workflow gating as finalizeDay.  HOD path writes
      // the per-submission hodReview block + stage='hod_reviewed' only;
      // HR / SA path keeps the existing reviewed + finalized flip.
      for (const s of subs) {
        if (isPureHOD) {
          s.hodReview = {
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
            recommend:  'approve',
            marksGiven: true,
            remarks:    discNote || s.hodReview?.remarks || '',
          };
          s.currentReviewStage = 'hod_reviewed';
          s.reviewHistory = s.reviewHistory || [];
          s.reviewHistory.push({
            reviewedBy: req.user._id, reviewerName: req.user.name, role,
            stage: 'hod_reviewed', action: 'daily_hod_review_bulk',
            marks: disc + idea, remarks: discNote || '',
            timestamp: new Date(),
          });
          await s.save();
          continue;
        }
        s.reviewStatus = 'reviewed';
        s.currentReviewStage = 'finalized';
        s.reviewedBy = req.user._id;
        s.reviewedAt = new Date();
        s.earnedPoints = Number(s.workEarnedPoints) || 0;
        s.totalPoints  = Number(s.workTotalPoints)  || 0;
        s.completionPercentage = s.totalPoints > 0 ? (s.earnedPoints / s.totalPoints) * 100 : 0;
        s.reviewHistory = s.reviewHistory || [];
        s.reviewHistory.push({
          reviewedBy: req.user._id, reviewerName: req.user.name, role,
          stage: 'finalized', action: 'daily_finalize_bulk',
          marks: disc + idea, remarks: discNote || '',
          timestamp: new Date(),
        });
        await s.save();
      }

      // Phase 26 — only notify the employee on real HR / SA finalisation.
      if (!isPureHOD) {
        try {
          notify.notifySubmissionReviewed({
            employeeId: employee._id, submission: { date: day }, reviewedBy: req.user,
          });
        } catch (_) { /* notify never blocks */ }
      }

      logAudit(req, {
        action: 'daily-review.bulk-finalize',
        targetType: 'DailyReview',
        targetId: review._id,
        targetLabel: `${employee._id} · ${day.toISOString().slice(0, 10)}`,
        meta: { disciplineMarks: disc, ideaMarks: idea, submissionCount: subs.length, bulk: true },
      });
      out.ok += 1;
      out.reviews.push({ employeeId: String(employee._id), date: day, reviewId: review._id });
    } catch (err) {
      out.failed.push({ employeeId, date: dayRaw, error: err.message || 'Unknown error' });
    }
  }

  res.json(out);
});

module.exports = { listGrouped, getDay, saveReflection, finalizeDay, bulkFinalize, editTaskStatus, editTaskMarks };
