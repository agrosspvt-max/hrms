const asyncHandler = require('express-async-handler');
const mongoose     = require('mongoose');
const User         = require('../models/User');
const Holiday      = require('../models/Holiday');
const Leave        = require('../models/Leave');
const Attendance   = require('../models/Attendance');
const AttendanceConfirmation = require('../models/AttendanceConfirmation');
const { startOfDay } = require('../utils/dateHelpers');
const { logAudit }   = require('../utils/audit');

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
};

const ACTION_TO_CONFIRMATION_STATUS = {
  approve_present:   'approved_present',
  mark_absent:       'marked_absent',
  mark_half_paid:    'marked_half_paid',
  mark_half_unpaid:  'marked_half_unpaid',
  mark_paid_leave:   'marked_paid_leave',
  mark_unpaid_leave: 'marked_unpaid_leave',
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
    .select('_id name employeeId department')
    .populate('department', 'name')
    .lean();
  if (employees.length === 0) return res.json([]);

  const confs = await AttendanceConfirmation.find({
    employee: { $in: employees.map((e) => e._id) },
    date: day,
  }).populate('reviewedBy', 'name role').lean();
  const confByEmp = new Map(confs.map((c) => [String(c.employee), c]));

  const out = employees.map((e) => {
    const c = confByEmp.get(String(e._id));
    return {
      employee: {
        _id: e._id,
        name: e.name,
        employeeId: e.employeeId,
        department: e.department?.name || '',
      },
      date: day,
      confirmation: c
        ? {
          _id: c._id,
          confirmedAt: c.confirmedAt,
          status: c.status,
          reviewedAt: c.reviewedAt || null,
          reviewedBy: c.reviewedBy ? { _id: c.reviewedBy._id, name: c.reviewedBy.name } : null,
          remarks: c.remarks || '',
        }
        : null,
    };
  });
  // Sort pending first, then by name -- mirrors how HR scans the queue.
  out.sort((a, b) => {
    const ap = a.confirmation?.status === 'pending' ? 0 : 1;
    const bp = b.confirmation?.status === 'pending' ? 0 : 1;
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

module.exports = { todayMine, confirm, queueForDay, review };
