/**
 * penaltyController.js  --  Phase 61 Fines & Penalties module.
 *
 * REST surface:
 *
 *   GET  /api/penalties/dashboard?employee=&from=&to=
 *        -> { active[], probable[], resolved[] }  for the caller
 *           when role === 'employee', or filterable by employee
 *           when role === 'hr' / 'super_admin' / permitted HOD.
 *
 *   GET  /api/penalties/mine
 *        -> convenience shim for the employee dashboard warning card.
 *
 *   POST /api/penalties/manual
 *        -> Create a manual penalty (HR / Super Admin).
 *           { employee, type: 'marks' | 'completion',
 *             marks?, completionPercent?, reason,
 *             graceHours?, durationDays? }
 *
 *   POST /api/penalties/:id/cancel
 *        -> Cancel (only pending/scheduled/active can be cancelled).
 *
 *   POST /api/penalties/:id/acknowledge
 *        -> Employee opened the dashboard warning card.
 *
 *   GET  /api/penalties/analytics/summary?from=&to=&department=
 *        -> Aggregations for Performance Analytics.
 */
const asyncHandler = require('express-async-handler');
const Penalty = require('../models/Penalty');
const User    = require('../models/User');
const { logAudit } = require('../utils/audit');
const { startOfDay } = require('../utils/dateHelpers');
const notify = require('../services/notifyEvents');
// Verification-audit fix -- state-transition sweep (scheduled ->
// active, active -> expired) on every dashboard/mine read so the
// UI never shows a stale bucket.
const { _sweepStateTransitions } = require('../services/penaltyMath');
const rt = require('../services/realtime');
// Phase 65.1 -- Missed Submission rollout cutoff.  Every user-facing
// read of the Penalty collection applies this filter so legacy
// pre-rollout compliance rows disappear from dashboards / F&P /
// notifications without deleting the records themselves.
const { excludeLegacyClause } = require('../config/complianceRollout');

const _isAdmin = (u) => u?.role === 'hr' || u?.role === 'super_admin';
const _isHOD   = (u) => u?.role === 'hod' || u?.isHOD === true;

/**
 * Phase 64.4 Gap 4 -- fan a realtime event out to every active
 * HR + Super Admin session so their Fines & Penalties feed / HR
 * dashboards refresh live when the EMPLOYEE performs an action HR
 * monitors (Request Reopening, Cancel, Dismiss, Acknowledge...).
 *
 * Reuses the existing rt.publishMany helper -- no new realtime
 * infrastructure is introduced.  Silent on failure -- never blocks
 * the response path.  Cache the id list briefly so a burst of
 * employee-side actions doesn't hammer the User collection.
 */
let _hrIdsCache = null;
let _hrIdsCacheAt = 0;
const HR_CACHE_MS = 30 * 1000;
const _publishToHR = async (event, payload) => {
  try {
    const now = Date.now();
    if (!_hrIdsCache || (now - _hrIdsCacheAt) > HR_CACHE_MS) {
      const rows = await User.find({ role: { $in: ['hr', 'super_admin'] }, status: 'active' })
        .select('_id').lean();
      _hrIdsCache = rows.map((r) => r._id);
      _hrIdsCacheAt = now;
    }
    if (_hrIdsCache.length > 0) rt.publishMany(_hrIdsCache, event, payload || {});
  } catch (_) { /* silent */ }
};

/** HR/SA see everything; HOD sees only their department if permitted;
 *  employees see only their own penalties. */
const _scopeToUser = async (req) => {
  if (_isAdmin(req.user)) {
    const filter = {};
    if (req.query.employee) filter.employee = req.query.employee;
    if (req.query.department) {
      const emps = await User.find({ department: req.query.department }).select('_id').lean();
      filter.employee = { $in: emps.map((e) => e._id) };
    }
    return filter;
  }
  if (_isHOD(req.user) && req.user.hodDepartment) {
    // HOD-level access requires HR to explicitly grant it via
    // FeaturePermissions -- the route gate handles that check.  Scope
    // is always the HOD's own department.
    const emps = await User.find({ department: req.user.hodDepartment }).select('_id').lean();
    return { employee: { $in: emps.map((e) => e._id) } };
  }
  return { employee: req.user._id };
};

const _dateWindow = (req) => {
  const w = {};
  if (req.query.from) w.$gte = startOfDay(new Date(req.query.from));
  if (req.query.to)   w.$lte = startOfDay(new Date(req.query.to));
  return Object.keys(w).length ? w : null;
};

/**
 * GET /api/penalties/dashboard
 */
const dashboard = asyncHandler(async (req, res) => {
  const scope = await _scopeToUser(req);
  const window = _dateWindow(req);
  const where = { ...scope, ...excludeLegacyClause() };
  if (window) where.targetDate = window;
  const rows = await Penalty.find(where)
    .populate('employee', 'name employeeId role department')
    .sort({ effectiveDate: -1, createdAt: -1 })
    .lean();
  // Verification-audit fix -- flush stale grace-period + expiry
  // transitions so buckets always match reality.
  await _sweepStateTransitions(rows);
  const out = { active: [], probable: [], resolved: [] };
  for (const p of rows) {
    if (p.probable && p.status === 'active') out.probable.push(p);
    else if (p.status === 'active' || p.status === 'pending' || p.status === 'scheduled') out.active.push(p);
    else if (p.status === 'resolved' || p.status === 'cancelled' || p.status === 'expired') out.resolved.push(p);
  }
  res.json(out);
});

/**
 * GET /api/penalties/mine  -- employee shortcut.
 */
const mine = asyncHandler(async (req, res) => {
  const rows = await Penalty.find({
    employee: req.user._id,
    ...excludeLegacyClause(),
  })
    .sort({ effectiveDate: -1, createdAt: -1 })
    .lean();
  // Verification-audit fix -- same sweep as /dashboard so a
  // grace-period penalty auto-activates the moment the employee
  // reloads their dashboard after expiry.
  await _sweepStateTransitions(rows);
  const out = { active: [], probable: [], resolved: [] };
  for (const p of rows) {
    if (p.probable && p.status === 'active') out.probable.push(p);
    else if (p.status === 'active' || p.status === 'pending' || p.status === 'scheduled') out.active.push(p);
    else out.resolved.push(p);
  }
  res.json(out);
});

/**
 * POST /api/penalties/manual  (HR / Super Admin)
 */
const createManual = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only'); }
  const {
    employee, type,
    marks, completionPercent, reason,
    graceHours,
    // Phase 64 Part 5 -- completion adjustment date range (past-only).
    evaluationStart, evaluationEnd,
    // Phase 65 -- Financial Penalty payload.
    amount, dueDate,
    employeeMessage,
  } = req.body;

  if (!employee) { res.status(400); throw new Error('employee is required'); }
  const target = await User.findById(employee).select('_id name').lean();
  if (!target) { res.status(404); throw new Error('Employee not found'); }

  if (!['marks', 'completion', 'financial'].includes(type)) {
    res.status(400); throw new Error(`type must be 'marks', 'completion' or 'financial'`);
  }

  const now = new Date();
  // Phase 64 Part 4 -- HR-created marks tweaks are now categorised as
  // `marks_adjustment` (Adjustments group in the F&P module).  The old
  // `manual_marks` category is kept in the enum for legacy rows.
  // Phase 64 Part 5 -- completion is now `completion_adjustment`.
  // Phase 65    -- new `financial_penalty` category (₹ fines).
  const category =
    type === 'marks'      ? 'marks_adjustment' :
    type === 'completion' ? 'completion_adjustment' :
                            'financial_penalty';
  const doc = {
    employee: target._id,
    category,
    source: 'manual',
    probable: false,
    penaltyMarks: type === 'marks' ? Math.max(0, Number(marks) || 0) : 0,
    // Phase 64 Part 5 -- completion adjustments can be positive OR
    // negative points (spec: "−5%" example).  We keep the value as
    // a signed integer/decimal and skip the 0..100 clamp of the old
    // manual_completion path.
    completionPercent: type === 'completion' ? Number(completionPercent) || 0 : 0,
    rule: type === 'marks' ? 'marks_adjustment_v1'
        : type === 'completion' ? 'completion_adjustment_v1'
        : 'financial_penalty_v1',
    reason: String(reason || '').trim(),
    employeeMessage: String(employeeMessage || '').trim(),
    createdBy: req.user._id,
    effectiveDate: now,
    targetDate: startOfDay(now),
    status: 'active',
  };

  // Phase 65 -- Financial Penalty.  Amount is mandatory; due date is
  // optional and informational.  Financial penalties never affect
  // marks or completion %; salary integration is a SEPARATE step.
  if (type === 'financial') {
    const amt = Math.max(0, Number(amount) || 0);
    if (amt <= 0) { res.status(400); throw new Error('amount must be > 0 for a Financial Penalty.'); }
    doc.amount = amt;
    doc.financialStatus = 'pending';
    if (dueDate) doc.dueDate = startOfDay(new Date(dueDate));
  }

  // Grace period only applies to marks_adjustment.  A pending grace
  // period parks the penalty as 'scheduled'; the state-transition
  // sweep flips it to 'active' when effectiveDate passes.
  const gh = Number(graceHours) || 0;
  if (type === 'marks' && gh > 0) {
    doc.effectiveDate = new Date(now.getTime() + gh * 60 * 60 * 1000);
    doc.status = 'scheduled';
  }

  // Phase 64 Part 5 -- Completion Adjustment.
  //   * evaluationStart + evaluationEnd are MANDATORY.
  //   * BOTH dates must be strictly in the past ("Only allow Past
  //     Dates. Never future dates.").
  //   * No auto-expiry -- adjustment lives forever unless cancelled.
  if (type === 'completion') {
    if (!evaluationStart || !evaluationEnd) {
      res.status(400);
      throw new Error('Completion adjustment requires evaluationStart + evaluationEnd (past dates).');
    }
    const s = startOfDay(new Date(evaluationStart));
    const e = startOfDay(new Date(evaluationEnd));
    const today = startOfDay(now);
    if (s > e) { res.status(400); throw new Error('evaluationStart must be on or before evaluationEnd.'); }
    if (s > today || e > today) {
      res.status(400);
      throw new Error('Completion Adjustment period must be strictly in the past.');
    }
    doc.evaluationPeriod = { startDate: s, endDate: e };
    // Anchor targetDate to the end of the range so the F&P
    // Active/Resolved tabs display it near the effect window.
    doc.targetDate = e;
    // No expiryDate -- lives forever until cancelled.
  }

  const created = await Penalty.create(doc);
  logAudit(req, {
    action: 'penalty.manual.create',
    targetType: 'Penalty',
    targetId: created._id,
    targetLabel: `${target.name} · ${type}`,
    meta: {
      type,
      marks: doc.penaltyMarks,
      completionPercent: doc.completionPercent,
      graceHours: gh,
      evaluationStart: doc.evaluationPeriod?.startDate || null,
      evaluationEnd:   doc.evaluationPeriod?.endDate   || null,
      reason: doc.reason,
    },
  });
  notify.notifyPenalty({ employeeId: target._id, penalty: created.toObject(), mode: 'active' });
  res.json(created);
});

/**
 * POST /api/penalties/:id/cancel   (HR / Super Admin)
 */
const cancel = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only'); }
  const p = await Penalty.findById(req.params.id);
  if (!p) { res.status(404); throw new Error('Penalty not found'); }
  if (!['pending', 'scheduled', 'active'].includes(p.status)) {
    res.status(400); throw new Error('Only active / scheduled penalties can be cancelled');
  }
  // Snapshot the pre-mutation status so the audit meta can record
  // what state the penalty was in before HR cancelled it.
  const previousStatus = p.status;

  p.status = 'cancelled';
  p.cancelledBy = req.user._id;
  p.cancelledAt = new Date();
  p.cancelReason = String(req.body.reason || '').trim();
  await p.save();

  // Enrich the audit entry with business context so someone reading
  // the log months later can understand the event without opening
  // the Penalty document.  Only tiny scalar fields are stored --
  // never the full Employee / Submission / Template docs.  Both
  // lookups run in parallel and are wrapped in try / catch so an
  // enrichment failure never blocks the cancel response.
  let employeeSnap = null;
  let submissionSnap = null;
  try {
    const Submission = require('../models/Submission');
    [employeeSnap, submissionSnap] = await Promise.all([
      User.findById(p.employee).select('name employeeId').lean(),
      p.submission
        ? Submission.findById(p.submission)
            .select('date template assignment')
            .populate('template', 'title')
            .populate('assignment', 'scheduleLabel')
            .lean()
        : Promise.resolve(null),
    ]);
  } catch (_) { /* audit enrichment is best-effort */ }

  logAudit(req, {
    action: 'penalty.cancel',
    targetType: 'Penalty',
    targetId: p._id,
    // targetLabel gains the employee code so log listings surface
    // the "who" at a glance without opening the row.
    targetLabel: employeeSnap?.employeeId
      ? `${p.category} · ${employeeSnap.employeeId}`
      : `${p.category}`,
    meta: {
      reason: p.cancelReason,
      previousStatus,
      category: p.category,
      employeeRef:  String(p.employee),
      employeeId:   employeeSnap?.employeeId || null,
      employeeName: employeeSnap?.name       || null,
      submissionId: p.submission ? String(p.submission) : null,
      templateTitle: submissionSnap?.template?.title || null,
      scheduleLabel: submissionSnap?.assignment?.scheduleLabel || null,
      // Prefer the submission's date (the actual work day); fall
      // back to the penalty's targetDate for penalties that don't
      // reference a submission (manual marks / completion / financial).
      workDate: submissionSnap?.date || p.targetDate || null,
      targetDate: p.targetDate || null,
    },
  });
  // Verification-audit fix -- push a realtime event so the
  // employee's dashboard warning card + Fines & Penalties feed
  // refresh immediately; Final Marks are recomputed on next read.
  try { rt.publish(p.employee, 'penalty:changed', { penaltyId: p._id, status: 'cancelled' }); }
  catch (_) { /* never blocks */ }
  res.json(p);
});

/**
 * POST /api/penalties/:id/acknowledge
 * The employee opened the dashboard warning card.  Only the owning
 * employee can acknowledge.
 */
const acknowledge = asyncHandler(async (req, res) => {
  const p = await Penalty.findById(req.params.id);
  if (!p) { res.status(404); throw new Error('Penalty not found'); }
  if (String(p.employee) !== String(req.user._id) && !_isAdmin(req.user)) {
    res.status(403); throw new Error('Not your penalty');
  }
  if (!p.acknowledgedAt) {
    p.acknowledgedAt = new Date();
    await p.save();
    logAudit(req, {
      action: 'penalty.acknowledge',
      targetType: 'Penalty',
      targetId: p._id,
      targetLabel: `${p.category}`,
      meta: {},
    });
    // Phase 64.4 Gap 4 -- HR watches acknowledgements.
    _publishToHR('penalty:changed', { event: 'acknowledged', penaltyId: p._id, employeeId: p.employee });
  }
  res.json(p);
});

/**
 * Phase 64 Part 2 -- Employee dismisses a Missed-Submission /
 * Performance-Lock notification.  Dismiss only hides the notification;
 * marks / penalty status are NOT altered.  Idempotent.
 */
const dismissNotification = asyncHandler(async (req, res) => {
  const p = await Penalty.findById(req.params.id);
  if (!p) { res.status(404); throw new Error('Penalty not found'); }
  if (String(p.employee) !== String(req.user._id)) {
    res.status(403); throw new Error('Not your penalty');
  }
  if (!p.dismissedByEmployeeAt) {
    p.dismissedByEmployeeAt = new Date();
    await p.save();
    logAudit(req, {
      action: 'penalty.dismiss',
      targetType: 'Penalty',
      targetId: p._id,
      targetLabel: p.category,
      meta: {},
    });
    // Phase 64.4 Gap 4 -- HR watches dismissals.
    _publishToHR('penalty:changed', { event: 'dismissed', penaltyId: p._id, employeeId: p.employee });
  }
  res.json(p);
});

/**
 * Phase 64 Part 2 -- Employee raises a Request Reopening.  Mandatory
 * `reason` string.  Only valid on missed_submission / performance_lock
 * categories; the employee must own the penalty.
 */
const requestReopening = asyncHandler(async (req, res) => {
  const p = await Penalty.findById(req.params.id);
  if (!p) { res.status(404); throw new Error('Penalty not found'); }
  if (String(p.employee) !== String(req.user._id)) {
    res.status(403); throw new Error('Not your penalty');
  }
  const reason = String(req.body.reason || '').trim();
  if (!reason) { res.status(400); throw new Error('Reason is required.'); }
  if (!['missed_submission', 'performance_lock', 'absent_submission'].includes(p.category)) {
    res.status(400); throw new Error('Reopen requests are only for Missed Submission / Performance Lock.');
  }
  // Phase 64.2 Item 6 -- deduplicate.  An existing pending or
  // approved-but-not-completed request must not be silently
  // overwritten.  The employee must cancel or complete the first
  // before raising a fresh one.
  if (p.reopenRequest?.requested
      && ['pending', 'approved'].includes(p.reopenRequest.decision || '')) {
    res.status(400);
    throw new Error(
      p.reopenRequest.decision === 'approved'
        ? 'HR already approved your previous request. Please re-submit that day\'s work to complete it.'
        : 'A reopen request is already pending. Wait for HR\'s decision or cancel it first.'
    );
  }
  p.reopenRequest = {
    requested: true,
    reason,
    requestedAt: new Date(),
    decision: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: '',
    completedAt: null,
  };
  await p.save();
  logAudit(req, {
    action: 'penalty.reopen.request',
    targetType: 'Penalty',
    targetId: p._id,
    targetLabel: p.category,
    meta: { reason },
  });
  try { rt.publish(p.employee, 'penalty:changed', { penaltyId: p._id, request: 'pending' }); }
  catch (_) { /* silent */ }
  // Phase 64.4 Gap 4 -- HR + Super Admin need to see the new
  // pending request without a manual refresh.
  _publishToHR('penalty:changed', {
    event: 'reopen_requested',
    penaltyId: p._id,
    employeeId: p.employee,
    category: p.category,
  });
  res.json(p);
});

/**
 * Phase 64 Part 2 -- HR decides on a reopen request.  Body:
 *   { decision: 'approved' | 'rejected',
 *     evaluationMode: 'restore' | 'information' | 'neutral' | null,
 *     note?: string }
 *
 * On 'approved' + evaluationMode set, we route through the shared
 * performanceRecovery.applyEvaluationMode helper so Missed Submission
 * and Performance Lock share exactly one code path.
 */
const decideReopen = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only'); }
  const p = await Penalty.findById(req.params.id);
  if (!p) { res.status(404); throw new Error('Penalty not found'); }
  const decision = req.body.decision;
  const note = String(req.body.note || '').trim();
  if (!['approved', 'rejected'].includes(decision)) {
    res.status(400); throw new Error("decision must be 'approved' or 'rejected'");
  }
  // Submission Review UI integration -- HR can initiate a "Send Back
  // to Employee" flow WITHOUT the employee having raised a request
  // first.  When there is no pending reopenRequest and HR is approving
  // (decision='approved'), we synthesize the request sub-doc as
  // HR-initiated.  Rejects with no request still make no sense.
  if (!p.reopenRequest?.requested) {
    if (decision === 'rejected') {
      res.status(400); throw new Error('This penalty has no pending reopen request.');
    }
    p.reopenRequest = {
      requested:    true,
      reason:       note || 'Reopened by HR from Submission Review',
      requestedAt:  new Date(),
      decision:     'pending',
      decidedBy:    null,
      decidedAt:    null,
      decisionNote: '',
      completedAt:  null,
    };
  }
  p.reopenRequest.decision   = decision;
  p.reopenRequest.decidedBy  = req.user._id;
  p.reopenRequest.decidedAt  = new Date();
  p.reopenRequest.decisionNote = note;
  await p.save();

  logAudit(req, {
    action: decision === 'approved' ? 'penalty.reopen.approve' : 'penalty.reopen.reject',
    targetType: 'Penalty',
    targetId: p._id,
    targetLabel: p.category,
    meta: { note },
  });

  if (decision === 'approved') {
    const evaluationMode = req.body.evaluationMode;
    if (evaluationMode) {
      // Route through the shared recovery helper (audit + notify).
      const { applyEvaluationMode } = require('../services/performanceRecovery');
      await applyEvaluationMode({ penalty: p, mode: evaluationMode, actor: req.user, note, req });
    }
    // If HR approved without picking a mode, the frontend will show
    // the "reopened -- please refile" prompt to the employee; a later
    // /decision call can then set evaluationMode via applyEvaluationMode.
  }

  try { rt.publish(p.employee, 'penalty:changed', { penaltyId: p._id, decision }); }
  catch (_) { /* silent */ }

  res.json(p);
});

/**
 * Phase 64 Part 3 -- HR adjusts the Resolve Within value on a
 * specific pending task inside a submission (spec: "HR OVERRIDE").
 * Recomputes resolveBy immediately using the shared working-day
 * helper.  Route: PATCH /api/penalties/pending-task/deadline
 *   Body: { submissionId, taskId, resolveWithin }
 */
const overridePendingDeadline = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only'); }
  const { submissionId, taskId, resolveWithin, reason } = req.body;
  const days = Math.max(0, Number(resolveWithin) || 0);
  const Submission = require('../models/Submission');
  const sub = await Submission.findById(submissionId);
  if (!sub) { res.status(404); throw new Error('Submission not found'); }
  const task = sub.tasks.id(taskId);
  if (!task) { res.status(404); throw new Error('Task not found on submission'); }
  if (task.status !== 'pending') {
    res.status(400); throw new Error('Only pending tasks have a Resolve By deadline.');
  }
  // Phase 64.1 Item 4 -- capture OLD values BEFORE mutating so the
  // audit trail has a complete before/after record.
  const oldResolveWithin = Number(task.resolveWithin) || 0;
  const oldResolveBy     = task.resolveBy || null;

  task.resolveWithin = days;
  try {
    const { addWorkingDays, loadWorkingDayContext } = require('../utils/workingDays');
    const owner = await User.findById(sub.employee).select('weeklyOff').lean();
    const from = task.pendingSince || sub.date || new Date();
    const ctx = await loadWorkingDayContext({
      employee: { _id: sub.employee, weeklyOff: owner?.weeklyOff || [0] },
      from,
      to: new Date(new Date(from).getTime() + 90 * 86400000),
    });
    task.resolveBy = addWorkingDays(from, days, ctx);
  } catch (_) {
    task.resolveBy = null;
  }
  await sub.save();
  // Phase 64.1 Item 4 -- complete deadline-change audit record.
  logAudit(req, {
    action: 'penalty.pending.override',
    targetType: 'Submission',
    targetId: sub._id,
    targetLabel: `task ${task.title}`,
    meta: {
      employee:         String(sub.employee),
      submissionId:     String(sub._id),
      taskId:           String(taskId),
      taskTitle:        task.title,
      oldResolveWithin,
      newResolveWithin: days,
      oldResolveBy:     oldResolveBy,
      newResolveBy:     task.resolveBy,
      reason:           String(reason || '').trim(),
    },
  });
  // Phase 64.2 Item 5 -- an extension may push the deadline past
  // "today", turning a currently-overdue task into a non-overdue
  // one.  Route through the shared resolver so any stale
  // performance_lock rows are cleared and the employee's UI
  // refreshes live.  Never blocks the response.
  try {
    const penaltyEngine = require('../services/penaltyEngine');
    await penaltyEngine.onPendingTaskResolved({ employeeId: sub.employee });
  } catch (e) { console.error('[penaltyController] onPendingTaskResolved:', e.message); }
  try { rt.publish(sub.employee, 'penalty:changed', { submissionId: sub._id, taskId, resolveWithin: days }); }
  catch (_) { /* silent */ }
  res.json({ ok: true, resolveWithin: days, resolveBy: task.resolveBy });
});

/**
 * Phase 64.4 Gap 3 -- Bulk Performance Restore.
 *
 *   POST /api/penalties/restore-range
 *
 *   Body:
 *     { employee, category?, from, to, evaluationMode, note? }
 *
 *   - `category` defaults to 'performance_lock' (spec's use case);
 *     'missed_submission' is also accepted so HR can restore a
 *     range of Missed-Submission days at once.
 *   - `evaluationMode` in { 'restore', 'information', 'neutral' } --
 *     reuses the SHARED performanceRecovery.applyEvaluationMode
 *     helper (no parallel restoration logic).
 *   - Iterates every matching Penalty in [from, to] and applies the
 *     mode.  Each row keeps its own audit trail, restoredMarks,
 *     restoredBy, and restorationReason.  Realtime events are
 *     emitted per row via the shared helper.
 *
 *   Returns { attempted, restored, skipped, errors[] }.
 */
const restoreRange = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only'); }
  const { employee, from, to, evaluationMode, note = '' } = req.body;
  const category = req.body.category || 'performance_lock';
  if (!employee) { res.status(400); throw new Error('employee is required'); }
  if (!from || !to) { res.status(400); throw new Error('from + to are required (YYYY-MM-DD).'); }
  if (!['performance_lock', 'missed_submission', 'absent_submission'].includes(category)) {
    res.status(400);
    throw new Error("category must be 'performance_lock' or 'missed_submission'");
  }
  const { applyEvaluationMode, VALID_MODES } = require('../services/performanceRecovery');
  if (!VALID_MODES.includes(evaluationMode)) {
    res.status(400);
    throw new Error(`evaluationMode must be one of: ${VALID_MODES.join(', ')}`);
  }
  const start = startOfDay(new Date(from));
  const end   = startOfDay(new Date(to));
  if (end < start) { res.status(400); throw new Error('"to" must be on or after "from"'); }

  const target = await User.findById(employee).select('_id name').lean();
  if (!target) { res.status(404); throw new Error('Employee not found'); }

  const rows = await Penalty.find({
    employee: target._id,
    category: { $in: category === 'missed_submission'
      ? ['missed_submission', 'absent_submission']
      : [category] },
    // Only restore ACTIVE rows -- already-resolved / cancelled /
    // expired rows are historical; touching them would rewrite
    // history (spec Part 11).
    status: 'active',
    targetDate: { $gte: start, $lte: end },
  });

  const result = {
    attempted: rows.length, restored: 0, skipped: 0, errors: [],
    // Phase 64.5 hardening -- surface whether the range restore was
    // atomic or ran in the per-row fallback path.
    atomic: false,
  };

  /* Phase 64.5 hardening -- wrap the whole range in a MongoDB
   * transaction so a mid-loop failure rolls EVERY penalty back to
   * its pre-restore state (spec: "If any restoration fails: rollback
   * every restored row, rollback audit writes").  Realtime + audit
   * side-effects are deferred via applyEvaluationMode's new
   * `deferSideEffects` option; they only fire AFTER the transaction
   * commits.  Standalone Mongo (no replica set) fails startTransaction
   * with a well-known error -- we detect that and gracefully fall
   * back to the pre-64.5 per-row path so single-node deployments
   * keep working.
   */
  const mongooseLib = require('mongoose');
  let session = null;
  const pendingFires = [];
  try {
    session = await mongooseLib.startSession();
    await session.withTransaction(async () => {
      // Reset per attempt in case withTransaction retries the block.
      pendingFires.length = 0;
      // Re-load rows in the session so writes participate atomically.
      const txRows = await Penalty.find({
        _id: { $in: rows.map((r) => r._id) },
        status: 'active',
      }).session(session);
      for (const p of txRows) {
        const { pendingSideEffects } = await applyEvaluationMode({
          penalty: p,
          mode: evaluationMode,
          actor: req.user,
          note: String(note || '').trim(),
          req,
          session,
          deferSideEffects: true,
        });
        pendingFires.push(pendingSideEffects);
      }
    });
    result.atomic = true;
    result.restored = pendingFires.length;
  } catch (txErr) {
    const msg = String(txErr && txErr.message || '');
    // Well-known standalone-topology errors -> fall back gracefully.
    const noTx = msg.includes('replica set')
              || msg.includes('mongos')
              || msg.includes('Transaction numbers')
              || msg.includes('does not support');
    if (!noTx) {
      // Genuine transaction failure -- report and abort.  No side
      // effects fired because we defer until after commit.
      result.errors.push({ error: 'transaction aborted', message: msg });
      pendingFires.length = 0;
    } else {
      // Fallback: pre-64.5 per-row best-effort path.  Side effects
      // fire inline as before, preserving backward-compat behaviour
      // on single-node deployments.
      pendingFires.length = 0;
      for (const p of rows) {
        try {
          await applyEvaluationMode({
            penalty: p,
            mode: evaluationMode,
            actor: req.user,
            note: String(note || '').trim(),
            req,
          });
          result.restored += 1;
        } catch (rowErr) {
          result.errors.push({ penaltyId: p._id, error: rowErr.message });
          result.skipped += 1;
        }
      }
    }
  } finally {
    if (session) session.endSession();
  }

  // Phase 64.5 -- fire deferred audit + notify AFTER the transaction
  // has successfully committed.  When we fell into the fallback path
  // above, pendingFires is empty (side effects already fired inline),
  // so this loop is a no-op there.
  for (const pending of pendingFires) {
    try { pending.fire(req); } catch (_) { /* silent */ }
  }

  // Phase 64.4 Gap 3 -- master audit row summarising the range op.
  // Individual applyEvaluationMode calls also log per row so the
  // full trail is preserved (spec: "keep audit history").
  logAudit(req, {
    action: 'penalty.restore.range',
    targetType: 'User',
    targetId: target._id,
    targetLabel: `${target.name} · ${evaluationMode} · ${category}`,
    meta: {
      category,
      from: start,
      to: end,
      evaluationMode,
      attempted: result.attempted,
      restored: result.restored,
      skipped: result.skipped,
      atomic: result.atomic,
      note: String(note || '').trim(),
    },
  });
  // Fan the change out on the employee's channel so their dashboard
  // refreshes without a manual reload.  Idempotent -- the helper
  // per-row already publishes; this is a single summary nudge.
  try { rt.publish(target._id, 'penalty:changed', { event: 'restore_range', category, restored: result.restored }); }
  catch (_) { /* silent */ }
  res.json(result);
});

/**
 * Phase 65 -- Financial Penalty operations.
 *
 * Financial penalties are HR-created ₹ fines.  They have their own
 * lifecycle field (`financialStatus`) so the standard Penalty
 * `status` enum stays clean.  This file exposes three HR actions
 * (waive / resolve / mark-deducted) plus a listing endpoint used by
 * the Salary generation flow to recommend inclusions.
 *
 *   POST /api/penalties/:id/waive      -- financialStatus = 'waived',
 *                                         Penalty.status = 'resolved'.
 *   POST /api/penalties/:id/resolve-fin -- financialStatus = 'resolved',
 *                                         Penalty.status = 'resolved'.
 *   GET  /api/penalties/financial/pending?employee=&asOf=
 *                                       -- rows still owed; used by
 *                                          the Salary generation UI.
 *   POST /api/penalties/financial/mark-deducted
 *        Body: { penaltyIds: [], salarySlipId, salaryMonth }
 *                                       -- HR confirms a slip
 *                                          includes these penalties.
 */
const _isFinancial = (p) => p && p.category === 'financial_penalty';

const waiveFinancial = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only'); }
  const p = await Penalty.findById(req.params.id);
  if (!p)                 { res.status(404); throw new Error('Penalty not found'); }
  if (!_isFinancial(p))   { res.status(400); throw new Error('Not a Financial Penalty.'); }
  if (p.financialStatus === 'deducted') {
    res.status(400); throw new Error('Already deducted -- cannot waive.');
  }
  p.financialStatus = 'waived';
  p.status = 'resolved';
  p.resolvedAt = new Date();
  p.resolvedBy = req.user._id;
  p.restorationReason = String(req.body.reason || '').trim();
  await p.save();
  logAudit(req, {
    action: 'financial_penalty.waive',
    targetType: 'Penalty',
    targetId: p._id,
    targetLabel: `₹${p.amount || 0}`,
    meta: { amount: p.amount, reason: p.restorationReason },
  });
  try {
    notify.notifyPenalty({
      employeeId: p.employee,
      penalty: { ...p.toObject(), employeeMessage: `Financial penalty waived: ${p.restorationReason || p.reason || ''}`.trim() },
      mode: 'probable',
      event: 'waived',
    });
  } catch (_) { /* silent */ }
  try { rt.publish(p.employee, 'penalty:changed', { penaltyId: p._id, financialStatus: 'waived' }); } catch (_) {}
  _publishToHR('penalty:changed', { event: 'financial_waived', penaltyId: p._id });
  res.json(p);
});

const resolveFinancial = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only'); }
  const p = await Penalty.findById(req.params.id);
  if (!p)                 { res.status(404); throw new Error('Penalty not found'); }
  if (!_isFinancial(p))   { res.status(400); throw new Error('Not a Financial Penalty.'); }
  if (p.financialStatus === 'deducted') {
    res.status(400); throw new Error('Already deducted -- resolve/waive not applicable.');
  }
  p.financialStatus = 'resolved';
  p.status = 'resolved';
  p.resolvedAt = new Date();
  p.resolvedBy = req.user._id;
  p.restorationReason = String(req.body.reason || '').trim();
  await p.save();
  logAudit(req, {
    action: 'financial_penalty.resolve',
    targetType: 'Penalty',
    targetId: p._id,
    targetLabel: `₹${p.amount || 0}`,
    meta: { amount: p.amount, reason: p.restorationReason },
  });
  try {
    notify.notifyPenalty({
      employeeId: p.employee,
      penalty: { ...p.toObject(), employeeMessage: `Financial penalty resolved: ${p.restorationReason || p.reason || ''}`.trim() },
      mode: 'probable',
      event: 'resolved',
    });
  } catch (_) { /* silent */ }
  try { rt.publish(p.employee, 'penalty:changed', { penaltyId: p._id, financialStatus: 'resolved' }); } catch (_) {}
  _publishToHR('penalty:changed', { event: 'financial_resolved', penaltyId: p._id });
  res.json(p);
});

/**
 * GET /api/penalties/financial/pending?employee=&asOf=YYYY-MM-DD
 *
 * Returns every financial_penalty that is still owed:
 *   - financialStatus === 'pending'
 *   - status === 'active' (i.e. not already resolved / waived)
 *   - effectiveDate <= asOf  (defaults to today)
 *
 * Used by the Salary generation flow to recommend which fines the
 * HR user should include in the current month's slips.
 */
const listPendingFinancial = asyncHandler(async (req, res) => {
  const asOf = req.query.asOf ? startOfDay(new Date(req.query.asOf)) : new Date();
  const where = {
    category: 'financial_penalty',
    financialStatus: 'pending',
    status: 'active',
    effectiveDate: { $lte: asOf },
  };
  if (req.query.employee) where.employee = req.query.employee;
  else if (!_isAdmin(req.user) && !_isHOD(req.user)) where.employee = req.user._id;
  const rows = await Penalty.find(where)
    .populate('employee', 'name employeeId department')
    .sort({ effectiveDate: 1 })
    .lean();
  res.json(rows);
});

/**
 * POST /api/penalties/financial/mark-deducted
 * Body: { penaltyIds: [], salarySlipId, salaryMonth }
 *
 * HR calls this after including one or more financial penalties in a
 * slip.  We atomically flip financialStatus to 'deducted' and stamp
 * the deduction metadata so the penalty can NEVER be deducted twice
 * (the pending-listing query filters on financialStatus:'pending').
 */
const markFinancialDeducted = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only'); }
  const ids = Array.isArray(req.body.penaltyIds) ? req.body.penaltyIds : [];
  if (ids.length === 0) { res.status(400); throw new Error('penaltyIds required'); }
  const salarySlipId = req.body.salarySlipId || null;
  const salaryMonth  = String(req.body.salaryMonth || '').trim();
  if (!salarySlipId || !salaryMonth) {
    res.status(400); throw new Error('salarySlipId and salaryMonth (YYYY-MM) are required.');
  }
  const now = new Date();
  const result = await Penalty.updateMany(
    {
      _id: { $in: ids },
      category: 'financial_penalty',
      financialStatus: 'pending',
      status: 'active',
    },
    {
      $set: {
        financialStatus: 'deducted',
        deductedInSalaryMonth: salaryMonth,
        deductedBy: req.user._id,
        deductedAt: now,
        salarySlipId,
        status: 'resolved',
        resolvedAt: now,
      },
    },
  );
  logAudit(req, {
    action: 'financial_penalty.deducted',
    targetType: 'SalarySlip',
    targetId: salarySlipId,
    targetLabel: `${result.modifiedCount || 0} penalty(ies) · ${salaryMonth}`,
    meta: { penaltyIds: ids, salarySlipId, salaryMonth, modified: result.modifiedCount },
  });
  // Notify each impacted employee.
  try {
    const rows = await Penalty.find({ _id: { $in: ids } }).select('employee amount').lean();
    for (const r of rows) {
      notify.notifyPenalty({
        employeeId: r.employee,
        penalty: { ...r, employeeMessage: `Financial penalty of ₹${r.amount || 0} deducted from your ${salaryMonth} salary.` },
        mode: 'active',
        event: `deducted.${salaryMonth}`,
      });
      try { rt.publish(r.employee, 'penalty:changed', { penaltyId: r._id, financialStatus: 'deducted' }); } catch (_) {}
    }
    _publishToHR('penalty:changed', { event: 'financial_deducted', slipId: salarySlipId });
  } catch (_) { /* silent */ }
  res.json({ modified: result.modifiedCount || 0 });
});

/**
 * GET /api/penalties/analytics/summary
 * Aggregations for Performance Analytics.
 */
const analyticsSummary = asyncHandler(async (req, res) => {
  const scope = await _scopeToUser(req);
  const window = _dateWindow(req);
  const where = { ...scope, probable: false, ...excludeLegacyClause() };
  if (window) where.targetDate = window;
  const rows = await Penalty.find(where).populate('employee', 'name employeeId department').lean();

  const byEmp = {};
  const byReason = {};
  let totalPenaltyMarks = 0;
  let totalCount = 0;
  // Phase 64.1 Item 9 -- KPI aggregates for the Performance dashboard.
  // Phase 65 adds financial-penalty aggregates alongside them.
  const kpi = {
    totalMarksLost: 0,
    employeesCurrentlyLocked: 0,
    missedSubmissionCases: 0,
    overduePendingTasks: 0,
    completionAdjustmentsApplied: 0,
    manualMarksAdjustments: 0,
    averageMarksLostPerEmployee: 0,
    // Phase 65 -- financial-penalty aggregates.
    financialPending:  0,   // ₹ still owed
    financialDeducted: 0,   // ₹ deducted through salary
    financialWaived:   0,   // ₹ waived by HR
    financialThisMonth: 0,  // # of rows created this month
    employeesWithPendingFinancial: 0,
  };
  const _fpEmpsPending = new Set();
  const _thisMonthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
  const lockedEmps = new Set();
  for (const p of rows) {
    if (p.status !== 'active' && p.status !== 'resolved' && p.status !== 'expired') continue;
    totalCount += 1;
    totalPenaltyMarks += Number(p.penaltyMarks) || 0;
    const ek = String(p.employee?._id || '');
    if (!byEmp[ek]) byEmp[ek] = { employee: p.employee, count: 0, marks: 0 };
    byEmp[ek].count += 1;
    byEmp[ek].marks += Number(p.penaltyMarks) || 0;
    byReason[p.category] = (byReason[p.category] || 0) + 1;

    // Phase 64.1 Item 9 -- bucket the KPI counters.
    kpi.totalMarksLost += Number(p.penaltyMarks) || 0;
    if (p.status === 'active') {
      if (p.category === 'performance_lock') {
        lockedEmps.add(ek);
      }
    }
    if (p.category === 'missed_submission' || p.category === 'absent_submission') kpi.missedSubmissionCases += 1;
    if (p.category === 'performance_lock' && p.status === 'active') kpi.overduePendingTasks += 1;
    if (p.category === 'completion_adjustment' || p.category === 'manual_completion') kpi.completionAdjustmentsApplied += 1;
    if (p.category === 'marks_adjustment' || p.category === 'manual_marks') kpi.manualMarksAdjustments += 1;
    // Phase 65 -- financial-penalty rollups.
    if (p.category === 'financial_penalty') {
      const amt = Number(p.amount) || 0;
      if (p.financialStatus === 'pending')  { kpi.financialPending  += amt; _fpEmpsPending.add(ek); }
      if (p.financialStatus === 'deducted')   kpi.financialDeducted += amt;
      if (p.financialStatus === 'waived')     kpi.financialWaived   += amt;
      const created = p.createdAt || p.effectiveDate;
      if (created && new Date(created).toISOString().slice(0, 7) === _thisMonthKey) {
        kpi.financialThisMonth += 1;
      }
    }
  }
  kpi.employeesWithPendingFinancial = _fpEmpsPending.size;
  kpi.employeesCurrentlyLocked = lockedEmps.size;
  const empCount = Object.keys(byEmp).length;
  kpi.averageMarksLostPerEmployee = empCount > 0
    ? Math.round((kpi.totalMarksLost / empCount) * 10) / 10
    : 0;

  const mostPenalized = Object.values(byEmp).sort((a, b) => b.marks - a.marks).slice(0, 10);
  res.json({
    totalCount,
    totalPenaltyMarks,
    byReason,
    mostPenalized,
    // Phase 64.1 Item 9 -- pure additive KPI object (analytics only,
    // no workflow changes).  Consumed by the Performance dashboard.
    kpi,
  });
});

module.exports = {
  dashboard, mine, createManual, cancel, acknowledge, analyticsSummary,
  // Phase 64 -- new endpoints.
  dismissNotification,
  requestReopening,
  decideReopen,
  overridePendingDeadline,
  // Phase 64.4 Gap 3 -- bulk restore across a date range.
  restoreRange,
  // Phase 65 -- Financial Penalty lifecycle operations.
  waiveFinancial,
  resolveFinancial,
  listPendingFinancial,
  markFinancialDeducted,
};
