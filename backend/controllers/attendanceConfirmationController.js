const asyncHandler = require('express-async-handler');
const mongoose     = require('mongoose');
const User         = require('../models/User');
const Holiday      = require('../models/Holiday');
const Leave        = require('../models/Leave');
const Attendance   = require('../models/Attendance');
const AttendanceConfirmation = require('../models/AttendanceConfirmation');
const { startOfDay } = require('../utils/dateHelpers');
const { logAudit }   = require('../utils/audit');
// Phase 67 -- Attendance Review edits must go through the SAME leave-
// accounting helpers HR's manual override path uses so leave balances
// never drift.  Never duplicate this logic here; always call through.
const {
  leaveUnitsForStatus,
  approvedPaidLeaveUnitsForDay,
  computeOverrideLeaveDelta,
  round2,
} = require('../utils/leaveAccounting');
const rt = require('../services/realtime');

// Phase 44.4 -- shared featurePermissions[key].enabled probe.  Mirrors
// the helper used in dailyReviewController / templateAnalyticsController.
const _hasFeature = (req, key) => {
  const perms = (req.user?.featurePermissions
    && (req.user.featurePermissions.toObject
      ? req.user.featurePermissions.toObject() : req.user.featurePermissions)) || {};
  return !!perms[key]?.enabled;
};

/**
 * Phase 29 — Attendance Confirmation workflow (mode 2: attendance_review)
 *
 * Employee posts /confirm to flag "I'm present today".  HR / Super
 * Admin sees the pending confirmation in the Attendance Reviews section
 * of Submission Reviews and acts on it (Approve Present / Mark Absent
 * / Mark Half Day Paid|Unpaid / Mark Leave Paid|Unpaid).  The review
 * action writes a corresponding Attendance record so the existing
 * deriveAttendance + payroll pipelines see the finalised state for the
 * day -- no changes needed in those engines.
 *
 * The confirmation only exists when the employee's attendanceMode is
 * 'attendance_review'.  Other modes are rejected at the endpoint.
 *
 * Holidays, weekly offs, and approved full-day leaves are NOT
 * confirmation days; the endpoint refuses to create a confirmation
 * record on such days so the existing attendance logic continues to own
 * them.
 */

const _isWeeklyOff = (employee, day) => (employee.weeklyOff || [0]).includes(day.getUTCDay());

const _approvedFullDayLeave = async (employeeId, day) => Leave.findOne({
  employee: employeeId,
  status: 'approved',
  fromDate: { $lte: day },
  toDate:   { $gte: day },
  dayType: { $ne: 'half' },
});

/**
 * Map the HR review action onto the canonical Attendance.status value.
 * The keys mirror what the UI sends as `action`; the values are the
 * status strings the existing attendance pipeline already understands.
 */
const ACTION_TO_STATUS = {
  approve_present:   'present',
  mark_absent:       'absent',
  mark_half_paid:    'half_paid',
  mark_half_unpaid:  'half_unpaid',
  mark_paid_leave:   'full_paid',
  mark_unpaid_leave: 'full_unpaid',
  // Phase 68 -- the redesigned dropdown exposes Weekly Off as a
  // selectable status; maps 1:1 onto the existing Attendance enum.
  mark_weekly_off:   'weekly_off',
};

const ACTION_TO_CONFIRMATION_STATUS = {
  approve_present:   'approved_present',
  mark_absent:       'marked_absent',
  mark_half_paid:    'marked_half_paid',
  mark_half_unpaid:  'marked_half_unpaid',
  mark_paid_leave:   'marked_paid_leave',
  mark_unpaid_leave: 'marked_unpaid_leave',
  mark_weekly_off:   'marked_weekly_off',
};

/* ------------------------------------------------------------------ */
/* Employee endpoint                                                   */
/* ------------------------------------------------------------------ */
/**
 * GET /api/attendance-confirmation/today
 *
 * Returns the employee's confirmation status for today plus a small
 * payload the dashboard needs to decide whether to render the card:
 *   { eligible, todayIso, status, confirmedAt, reviewedAt, reason }
 *
 *   eligible=false + reason explains why no card should render
 *     ('not_attendance_review_mode' | 'weekly_off' | 'holiday' |
 *      'approved_leave').
 */
const todayMine = asyncHandler(async (req, res) => {
  const employee = await User.findById(req.user._id).lean();
  if (!employee) { res.status(404); throw new Error('Employee not found.'); }
  const day = startOfDay(new Date());

  if (employee.attendanceMode !== 'attendance_review') {
    return res.json({ eligible: false, reason: 'not_attendance_review_mode' });
  }
  if (_isWeeklyOff(employee, day)) {
    return res.json({ eligible: false, reason: 'weekly_off' });
  }
  const holiday = await Holiday.findOne({ date: day }).lean();
  if (holiday) return res.json({ eligible: false, reason: 'holiday' });
  if (await _approvedFullDayLeave(employee._id, day)) {
    return res.json({ eligible: false, reason: 'approved_leave' });
  }

  const conf = await AttendanceConfirmation.findOne({ employee: employee._id, date: day }).lean();
  res.json({
    eligible: true,
    todayIso: day.toISOString().slice(0, 10),
    status: conf?.status || null,
    confirmedAt: conf?.confirmedAt || null,
    reviewedAt: conf?.reviewedAt || null,
  });
});

/**
 * POST /api/attendance-confirmation/confirm
 *
 * Employee clicks "Confirm Present".  Idempotent: a second call on the
 * same day refreshes confirmedAt without resetting any HR review state.
 */
const confirm = asyncHandler(async (req, res) => {
  const employee = await User.findById(req.user._id);
  if (!employee) { res.status(404); throw new Error('Employee not found.'); }
  if (employee.attendanceMode !== 'attendance_review') {
    res.status(400);
    throw new Error('Attendance confirmations are only available for employees on Attendance Review mode.');
  }
  const day = startOfDay(new Date());
  if (_isWeeklyOff(employee, day)) {
    res.status(400); throw new Error('Today is a weekly off — no confirmation needed.');
  }
  if (await Holiday.findOne({ date: day })) {
    res.status(400); throw new Error('Today is a holiday — no confirmation needed.');
  }
  if (await _approvedFullDayLeave(employee._id, day)) {
    res.status(400); throw new Error('Today is an approved leave — no confirmation needed.');
  }

  // findOneAndUpdate with upsert so a second click refreshes confirmedAt
  // (the employee may have moved between devices) without erasing any
  // prior HR review state that came in between.
  const existing = await AttendanceConfirmation.findOne({ employee: employee._id, date: day });
  if (existing && existing.status !== 'pending') {
    // HR already acted — don't let a re-click override the resolution.
    return res.json(existing);
  }
  const conf = await AttendanceConfirmation.findOneAndUpdate(
    { employee: employee._id, date: day },
    {
      $set: { confirmedAt: new Date(), status: 'pending' },
      $setOnInsert: { employee: employee._id, date: day },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  res.json(conf);
});

/* ------------------------------------------------------------------ */
/* Reviewer endpoints (HR / Super Admin)                               */
/* ------------------------------------------------------------------ */

/**
 * GET /api/attendance-confirmation/queue?date=YYYY-MM-DD
 *
 * Returns one row per (employee, date) in scope where:
 *   - employee.attendanceMode === 'attendance_review'
 *   - the date is the requested day
 * Rows can be in 'pending' or already-resolved state -- the UI groups
 * them so HR can audit past decisions.
 *
 * Role scope: HR / Super Admin see everything; HOD is auto-clamped to
 * their own department (consistent with grouped review feed).
 */
const queueForDay = asyncHandler(async (req, res) => {
  const day = req.query.date
    ? startOfDay(new Date(req.query.date))
    : startOfDay(new Date());
  if (Number.isNaN(day.getTime())) { res.status(400); throw new Error('Invalid date'); }

  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  const hasReviewGrant = _hasFeature(req, 'submissionReviews');
  const where = { status: 'active', attendanceMode: 'attendance_review' };
  if (role !== 'hr' && role !== 'super_admin') {
    if (isHOD) {
      where.department = req.user.hodDepartment;
    } else if (!hasReviewGrant) {
      res.status(403); throw new Error('Forbidden');
    }
    // hasReviewGrant employees see the full queue, matching what
    // Submission Reviews shows them on the daily-review side.
  }
  const employees = await User.find(where)
    .select('_id name employeeId department weeklyOff')
    .populate('department', 'name')
    .lean();
  if (employees.length === 0) return res.json([]);

  const empIds = employees.map((e) => e._id);
  // Phase 67 -- batch every dependency the priority chain needs so the
  // queue can classify each employee-day without any per-row round
  // trips.  Priority: Holiday > Weekly Off > Approved Leave (paid or
  // unpaid) > Existing Attendance Record > Confirmation status.
  const [confs, attendance, leaves, holiday] = await Promise.all([
    AttendanceConfirmation.find({ employee: { $in: empIds }, date: day })
      .populate('reviewedBy', 'name role').lean(),
    Attendance.find({ employee: { $in: empIds }, date: day })
      .populate('setBy', 'name role').lean(),
    Leave.find({
      employee: { $in: empIds },
      status: 'approved',
      fromDate: { $lte: day },
      toDate:   { $gte: day },
    }).lean(),
    Holiday.findOne({ date: day }).lean(),
  ]);
  const confByEmp = new Map(confs.map((c) => [String(c.employee), c]));
  const attByEmp  = new Map(attendance.map((a) => [String(a.employee), a]));
  // Multiple approved leaves could overlap the same day; take the first
  // (paid wins over unpaid if both exist — matches leaveAccounting).
  const leaveByEmp = new Map();
  for (const lv of leaves) {
    const k = String(lv.employee);
    const cur = leaveByEmp.get(k);
    if (!cur || (lv.paid && !cur.paid)) leaveByEmp.set(k, lv);
  }

  const out = employees.map((e) => {
    const c   = confByEmp.get(String(e._id));
    const att = attByEmp.get(String(e._id));
    const lv  = leaveByEmp.get(String(e._id));
    const isWeeklyOff = (e.weeklyOff || [0]).includes(day.getUTCDay());

    // Priority chain -- picks the single canonical state for the day.
    let resolvedState;
    if (holiday)                                        resolvedState = 'holiday';
    else if (isWeeklyOff)                               resolvedState = 'weekly_off';
    else if (lv && lv.paid)                             resolvedState = 'leave_paid';
    else if (lv && !lv.paid)                            resolvedState = 'leave_unpaid';
    else if (att)                                       resolvedState = 'reviewed';
    else if (c && c.status !== 'pending')               resolvedState = 'reviewed';
    else if (c && c.status === 'pending')               resolvedState = 'awaiting';
    else                                                resolvedState = 'not_confirmed';

    // Concrete status label the UI shows on the card.  Mirrors what
    // deriveAttendance would resolve for this day (priority order).
    let effectiveStatus;
    if (holiday)                          effectiveStatus = 'holiday';
    else if (isWeeklyOff)                 effectiveStatus = 'weekly_off';
    else if (att)                         effectiveStatus = att.status;
    else if (lv && lv.paid)               effectiveStatus = lv.dayType === 'half' ? 'half_paid' : 'full_paid';
    else if (lv && !lv.paid)              effectiveStatus = lv.dayType === 'half' ? 'half_unpaid' : 'full_unpaid';
    else if (c && c.status === 'pending') effectiveStatus = 'awaiting';
    else                                  effectiveStatus = 'not_confirmed';

    return {
      employee: {
        _id: e._id,
        name: e.name,
        employeeId: e.employeeId,
        department: e.department?.name || '',
      },
      date: day,
      resolvedState,
      effectiveStatus,
      isWeeklyOff,
      holiday: holiday ? { _id: holiday._id, name: holiday.name || '' } : null,
      leave: lv ? {
        _id: lv._id, paid: !!lv.paid, dayType: lv.dayType || 'full', type: lv.type || '',
      } : null,
      attendance: att ? {
        _id: att._id, status: att.status, source: att.source,
        setBy: att.setBy ? { _id: att.setBy._id, name: att.setBy.name } : null,
        note: att.note || '', leaveDelta: att.leaveDelta || 0,
      } : null,
      confirmation: c ? {
        _id: c._id,
        confirmedAt: c.confirmedAt,
        status: c.status,
        reviewedAt: c.reviewedAt || null,
        reviewedBy: c.reviewedBy ? { _id: c.reviewedBy._id, name: c.reviewedBy.name } : null,
        remarks: c.remarks || '',
      } : null,
    };
  });
  // Awaiting Review first, then Not Confirmed, then everything else --
  // matches the workflow priority a reviewer scans in.
  const bucketOrder = { awaiting: 0, not_confirmed: 1 };
  out.sort((a, b) => {
    const ap = bucketOrder[a.resolvedState] ?? 2;
    const bp = bucketOrder[b.resolvedState] ?? 2;
    if (ap !== bp) return ap - bp;
    return (a.employee.name || '').localeCompare(b.employee.name || '');
  });
  res.json(out);
});

/**
 * POST /api/attendance-confirmation/:id/review
 * Body: { action, remarks? }
 *
 * Apply the reviewer decision.  Writes an Attendance record so the
 * existing deriveAttendance / salary pipelines pick it up.  The
 * AttendanceConfirmation document is kept as the audit trail of who
 * confirmed when and who reviewed when.
 */
const review = asyncHandler(async (req, res) => {
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin'
    && !isHOD
    && !_hasFeature(req, 'submissionReviews')) {
    res.status(403);
    throw new Error('Only HR / Super Admin or a user with Submission Reviews access may review attendance confirmations.');
  }
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400); throw new Error('Invalid confirmation id.');
  }
  const action = req.body?.action;
  const remarks = String(req.body?.remarks || '').trim();
  if (!ACTION_TO_STATUS[action]) {
    res.status(400);
    throw new Error(`action must be one of: ${Object.keys(ACTION_TO_STATUS).join(', ')}`);
  }

  const conf = await AttendanceConfirmation.findById(id);
  if (!conf) { res.status(404); throw new Error('Confirmation not found.'); }
  if (String(conf.employee) === String(req.user._id)) {
    res.status(403); throw new Error('You cannot review your own attendance confirmation.');
  }

  // Write the resolved Attendance record.  We deliberately set
  // source='manual' so it wins over any derived day-state, matching
  // how HR's existing override path works.
  const day = startOfDay(conf.date);
  const attendanceStatus = ACTION_TO_STATUS[action];
  const record = await Attendance.findOneAndUpdate(
    { employee: conf.employee, date: day },
    {
      employee: conf.employee,
      date: day,
      status: attendanceStatus,
      source: 'manual',
      note: remarks || `Attendance Review: ${action}`,
      setBy: req.user._id,
      leaveDelta: 0,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  conf.status     = ACTION_TO_CONFIRMATION_STATUS[action];
  conf.reviewedBy = req.user._id;
  conf.reviewedAt = new Date();
  if (remarks) conf.remarks = remarks;
  await conf.save();

  logAudit(req, {
    action: 'attendance_confirmation.review',
    targetType: 'AttendanceConfirmation',
    targetId: conf._id,
    targetLabel: `${String(conf.employee)} · ${day.toISOString().slice(0, 10)}`,
    meta: {
      action, attendanceStatus,
      attendanceRecordId: String(record._id),
      remarks,
    },
  });

  res.json({ confirmation: conf, attendance: record });
});

/* ------------------------------------------------------------------ */
/* Phase 67 -- unified Attendance Review actions                        */
/* ------------------------------------------------------------------ */
/**
 * Shared permission gate for every reviewer-side attendance action.
 * Mirrors what queueForDay + review already enforce so the three
 * entry points can never drift out of sync.
 */
const _assertReviewerGate = (req) => {
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin'
    && !isHOD
    && !_hasFeature(req, 'submissionReviews')) {
    const err = new Error('Only HR / Super Admin / HOD or a user with Submission Reviews access may review attendance.');
    err._http = 403;
    throw err;
  }
};

/**
 * Actions allowed via Attendance Review.  Everything except 'revoke'
 * maps 1:1 onto an Attendance.status value.  'revoke' removes any
 * manual/auto override so the day reverts to its derived state (leave-
 * driven records are intentionally left alone -- Leave owns them).
 */
const REVIEW_ACTIONS = new Set([
  'approve_present', 'mark_absent',
  'mark_half_paid', 'mark_half_unpaid',
  'mark_paid_leave', 'mark_unpaid_leave',
  'mark_weekly_off',
  'revoke',
]);

/**
 * Apply a single reviewer action.  Central worker used by both the
 * single-row and bulk endpoints so leave-accounting, audit, and
 * realtime fan-out never drift.
 */
const _applyReviewAction = async ({ req, employeeId, day, action, remarks, via }) => {
  if (String(employeeId) === String(req.user._id)) {
    const err = new Error('You cannot review your own attendance.');
    err._http = 403;
    throw err;
  }
  const employee = await User.findById(employeeId);
  if (!employee) { const e = new Error('Employee not found.'); e._http = 404; throw e; }
  if (employee.attendanceMode !== 'attendance_review') {
    const e = new Error('Attendance Review actions are only valid for employees on Attendance Review mode.');
    e._http = 400; throw e;
  }

  const conf = await AttendanceConfirmation.findOne({ employee: employee._id, date: day });
  const existing = await Attendance.findOne({ employee: employee._id, date: day });

  if (action === 'revoke') {
    // Refund whatever this override deducted from leaveBalance and
    // delete the Attendance record.  Leaves the AttendanceConfirmation
    // row in place but resets its status so the queue re-classifies
    // the employee as Awaiting Review (if they had confirmed) or Not
    // Confirmed (if the record was HR-only).
    let refunded = 0;
    if (existing) {
      if (existing.source === 'leave') {
        // Approved-leave-generated record; belongs to the Leave doc.
        const e = new Error('Cannot revoke an attendance record generated by an approved leave. Cancel the leave instead.');
        e._http = 400; throw e;
      }
      if (existing.source === 'manual' && existing.leaveDelta) {
        const used = (employee.leaveBalance?.used || 0) - existing.leaveDelta;
        employee.leaveBalance.used = Math.max(0, round2(used));
        refunded = existing.leaveDelta;
        await employee.save();
      }
      await existing.deleteOne();
    }
    if (conf) {
      if (conf.confirmedAt) {
        // Employee-initiated confirmation still stands -- reset to
        // pending so the queue re-shows the row under Awaiting Review.
        conf.status = 'pending';
        conf.reviewedBy = undefined;
        conf.reviewedAt = undefined;
        await conf.save();
      } else {
        // HR-only confirmation stub with no employee confirmation --
        // remove it entirely so the queue shows Not Confirmed again.
        await conf.deleteOne();
      }
    }
    logAudit(req, {
      action: 'attendance_review.revoke',
      targetType: 'Attendance',
      targetId: existing ? existing._id : null,
      targetLabel: `${employee.name} · ${day.toISOString().slice(0, 10)}${via ? ` (${via})` : ''}`,
      meta: {
        employeeId: String(employee._id),
        date: day.toISOString().slice(0, 10),
        refundedLeaveUnits: refunded,
      },
    });
    try { rt.publish(employee._id, 'attendance:changed', { date: day, status: null }); } catch (_) { /* no-op */ }
    return { employeeId: String(employee._id), name: employee.name, action, revoked: true };
  }

  if (!ACTION_TO_STATUS[action]) {
    const e = new Error(`action must be one of: ${[...REVIEW_ACTIONS].join(', ')}`);
    e._http = 400; throw e;
  }
  const attendanceStatus = ACTION_TO_STATUS[action];

  // Same leave-accounting math as attendanceController.setStatus --
  // never duplicated; always routed through leaveAccounting so a paid
  // leave already deducted for the day never double-counts.
  const targetUnits = leaveUnitsForStatus(attendanceStatus);
  const approvalUnits = await approvedPaidLeaveUnitsForDay(employee._id, day);
  const existingOverrideDelta = existing && existing.source === 'manual'
    ? (existing.leaveDelta || 0) : 0;
  const { overrideDelta, balanceChange } = computeOverrideLeaveDelta({
    targetUnits, approvalUnits, existingOverrideDelta,
  });
  if (balanceChange !== 0) {
    const used = (employee.leaveBalance?.used || 0) + balanceChange;
    employee.leaveBalance.used = Math.max(0, round2(used));
    await employee.save();
  }

  const record = await Attendance.findOneAndUpdate(
    { employee: employee._id, date: day },
    {
      employee: employee._id,
      date: day,
      status: attendanceStatus,
      source: 'manual',
      note: remarks || `Attendance Review: ${action}`,
      setBy: req.user._id,
      leaveDelta: overrideDelta,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // Keep the AttendanceConfirmation row coherent with the resolution
  // so the queue's Reviewed/Awaiting filter reflects reality.  If HR
  // acted before the employee confirmed, we do NOT synthesise a
  // confirmation -- the Attendance record itself signals "reviewed".
  if (conf) {
    conf.status = ACTION_TO_CONFIRMATION_STATUS[action];
    conf.reviewedBy = req.user._id;
    conf.reviewedAt = new Date();
    if (remarks) conf.remarks = remarks;
    await conf.save();
  }

  logAudit(req, {
    action: 'attendance_review.act',
    targetType: 'Attendance',
    targetId: record._id,
    targetLabel: `${employee.name} · ${day.toISOString().slice(0, 10)}${via ? ` (${via})` : ''}`,
    meta: {
      employeeId: String(employee._id),
      date: day.toISOString().slice(0, 10),
      action, attendanceStatus,
      targetLeaveUnits: targetUnits,
      approvedLeaveUnits: approvalUnits,
      leaveDelta: overrideDelta,
      balanceChange,
      remarks: remarks || '',
    },
  });
  try { rt.publish(employee._id, 'attendance:changed', { date: day, status: attendanceStatus }); } catch (_) { /* no-op */ }

  return {
    employeeId: String(employee._id),
    name: employee.name,
    action,
    attendance: {
      _id: record._id, status: record.status, source: record.source,
      leaveDelta: record.leaveDelta,
    },
    confirmation: conf ? { _id: conf._id, status: conf.status } : null,
  };
};

/**
 * POST /api/attendance-confirmation/act
 * Body: { employeeId, date, action, remarks? }
 *
 * Reviewer-side attendance edit that works whether or not the employee
 * confirmed.  Reuses the exact leave-accounting math of the HR manual
 * override path so the Attendance record is the single source of
 * truth (Salary / Compliance / Missed Submission still read the same
 * record they always did).
 */
const actOne = asyncHandler(async (req, res) => {
  try { _assertReviewerGate(req); } catch (e) { res.status(e._http || 403); throw e; }
  const { employeeId, date, action } = req.body || {};
  const remarks = String(req.body?.remarks || '').trim();
  if (!employeeId || !mongoose.Types.ObjectId.isValid(employeeId)) {
    res.status(400); throw new Error('employeeId is required.');
  }
  if (!date) { res.status(400); throw new Error('date is required.'); }
  if (!REVIEW_ACTIONS.has(action)) {
    res.status(400);
    throw new Error(`action must be one of: ${[...REVIEW_ACTIONS].join(', ')}`);
  }
  const day = startOfDay(new Date(date));
  if (Number.isNaN(day.getTime())) { res.status(400); throw new Error('Invalid date.'); }

  try {
    const result = await _applyReviewAction({ req, employeeId, day, action, remarks });
    res.json(result);
  } catch (e) {
    res.status(e._http || 500);
    throw e;
  }
});

/**
 * POST /api/attendance-confirmation/bulk-act
 * Body: { employeeIds: [String], date, action, remarks? }
 *
 * Apply the SAME reviewer action to many employees on one date.
 * Each row is processed independently through _applyReviewAction so
 * per-row failures are captured without aborting the batch.
 */
const bulkAct = asyncHandler(async (req, res) => {
  try { _assertReviewerGate(req); } catch (e) { res.status(e._http || 403); throw e; }
  const { employeeIds, date, action } = req.body || {};
  const remarks = String(req.body?.remarks || '').trim();
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
    res.status(400); throw new Error('No employees selected.');
  }
  if (!date) { res.status(400); throw new Error('date is required.'); }
  if (!REVIEW_ACTIONS.has(action)) {
    res.status(400);
    throw new Error(`action must be one of: ${[...REVIEW_ACTIONS].join(', ')}`);
  }
  const day = startOfDay(new Date(date));
  if (Number.isNaN(day.getTime())) { res.status(400); throw new Error('Invalid date.'); }

  const succeeded = [];
  const failed = [];
  for (const id of employeeIds) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      failed.push({ employeeId: String(id), reason: 'Invalid employeeId.' }); continue;
    }
    try {
      const r = await _applyReviewAction({ req, employeeId: id, day, action, remarks, via: 'bulk' });
      succeeded.push(r);
    } catch (e) {
      failed.push({ employeeId: String(id), reason: e.message });
    }
  }
  res.json({
    date: day.toISOString().slice(0, 10),
    action,
    requested: employeeIds.length,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    succeeded, failed,
  });
});

module.exports = { todayMine, confirm, queueForDay, review, actOne, bulkAct };
