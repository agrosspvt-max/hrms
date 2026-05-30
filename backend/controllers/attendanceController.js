const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const { deriveAttendance } = require('../services/dailyEngine');
const { monthRange, startOfDay, addDays } = require('../utils/dateHelpers');
const { logAudit } = require('../utils/audit');
const {
  leaveUnitsForStatus,
  approvedPaidLeaveUnitsForDay,
  computeOverrideLeaveDelta,
  round2,
} = require('../utils/leaveAccounting');

/**
 * GET /api/attendance/mine?year=&month=
 */
const mine = asyncHandler(async (req, res) => {
  const y = Number(req.query.year) || new Date().getUTCFullYear();
  const m = Number(req.query.month) || new Date().getUTCMonth() + 1;
  const { from, to } = monthRange(y, m);
  const employee = await User.findById(req.user._id);
  const att = await deriveAttendance(employee, from, to);
  res.json({ year: y, month: m, ...att });
});

/**
 * GET /api/attendance/employee/:id?year=&month=  (HR)
 */
const ofEmployee = asyncHandler(async (req, res) => {
  const y = Number(req.query.year) || new Date().getUTCFullYear();
  const m = Number(req.query.month) || new Date().getUTCMonth() + 1;
  const { from, to } = monthRange(y, m);
  const employee = await User.findById(req.params.id);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }
  const att = await deriveAttendance(employee, from, to);
  res.json({ year: y, month: m, employee: { _id: employee._id, name: employee.name }, ...att });
});

// Statuses HR is allowed to assign through a manual override.
const MANUAL_STATUSES = [
  'present', 'half_paid', 'half_unpaid',
  'full_paid', 'full_unpaid', 'absent', 'weekly_off',
];

/**
 * Resolve the effective status of a single day for one employee BEFORE we
 * mutate anything (used to record the "previous status" in the audit log).
 */
const effectiveStatusForDay = async (employee, day) => {
  const att = await deriveAttendance(employee, day, addDays(day, 1));
  return att.perDay[0]?.status || 'absent';
};

/**
 * PUT /api/attendance/employee/:id/status   (HR)
 * Body: { date: 'YYYY-MM-DD', status, note? }
 *
 * Manually overrides one day's attendance.  The record is written with
 * source 'manual' so it wins over any derived/auto status.
 *
 * Leave is accounted for ONCE per day.  Before deducting anything we ask
 * the centralized leaveAccounting helper how much paid leave an approved
 * leave already consumed for this day, then deduct only the remaining
 * difference (which may be zero).  So overriding a day that already has an
 * approved half/full PAID leave to the matching paid status deducts nothing
 * extra - it is purely an attendance-state correction.
 */
const setStatus = asyncHandler(async (req, res) => {
  const { date, status, note } = req.body;
  if (!date) { res.status(400); throw new Error('date is required'); }
  if (!MANUAL_STATUSES.includes(status)) {
    res.status(400);
    throw new Error(`status must be one of: ${MANUAL_STATUSES.join(', ')}`);
  }

  const employee = await User.findById(req.params.id);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const day = startOfDay(new Date(date));
  if (Number.isNaN(day.getTime())) { res.status(400); throw new Error('Invalid date'); }

  // Capture the effective status before we change anything (for the audit
  // trail) and the existing record (to reconcile leave units).
  const previousStatus = await effectiveStatusForDay(employee, day);
  const existing = await Attendance.findOne({ employee: employee._id, date: day });

  // Centralized, idempotent leave accounting.
  const targetUnits = leaveUnitsForStatus(status);
  const approvalUnits = await approvedPaidLeaveUnitsForDay(employee._id, day);
  const existingOverrideDelta = existing && existing.source === 'manual'
    ? (existing.leaveDelta || 0) : 0;
  const { overrideDelta, balanceChange } = computeOverrideLeaveDelta({
    targetUnits, approvalUnits, existingOverrideDelta,
  });

  // Reconcile the leave balance only by the override's own (non-duplicate)
  // contribution, clamped at >= 0.
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
      status,
      source: 'manual',
      note: note || '',
      setBy: req.user._id,
      leaveDelta: overrideDelta,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  logAudit(req, {
    action: 'attendance.override',
    targetType: 'Attendance',
    targetId: record._id,
    targetLabel: `${employee.name} · ${day.toISOString().slice(0, 10)}`,
    meta: {
      employeeId: String(employee._id),
      date: day.toISOString().slice(0, 10),
      previousStatus,
      newStatus: status,
      note: note || '',
      // Transparency: total units the day should consume, what an approved
      // leave already covered, and what THIS override actually deducted.
      targetLeaveUnits: targetUnits,
      approvedLeaveUnits: approvalUnits,
      leaveDelta: overrideDelta,
      balanceChange,
    },
  });

  res.json({
    record,
    previousStatus,
    leaveAccounting: { targetUnits, approvalUnits, overrideDelta, balanceChange },
    leaveBalance: employee.leaveBalance,
  });
});

/**
 * DELETE /api/attendance/employee/:id/status?date=YYYY-MM-DD   (HR)
 *
 * Removes a manual override so the day reverts to its derived/auto status.
 * Any leave units the override consumed are returned to the balance.
 */
const clearStatus = asyncHandler(async (req, res) => {
  const date = req.query.date || req.body?.date;
  if (!date) { res.status(400); throw new Error('date is required'); }

  const employee = await User.findById(req.params.id);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const day = startOfDay(new Date(date));
  const existing = await Attendance.findOne({ employee: employee._id, date: day });
  if (!existing) {
    res.status(404);
    throw new Error('No attendance override exists for that date');
  }

  const previousStatus = existing.status;

  // Refund only what THIS override itself deducted (never the approval's
  // share - that stays owned by the approved leave record).
  if (existing.source === 'manual' && existing.leaveDelta) {
    const used = (employee.leaveBalance?.used || 0) - existing.leaveDelta;
    employee.leaveBalance.used = Math.max(0, round2(used));
    await employee.save();
  }

  await existing.deleteOne();

  // The status the day will now show once the override is gone.
  const revertedStatus = await effectiveStatusForDay(employee, day);

  logAudit(req, {
    action: 'attendance.override.clear',
    targetType: 'Attendance',
    targetId: existing._id,
    targetLabel: `${employee.name} · ${day.toISOString().slice(0, 10)}`,
    meta: {
      employeeId: String(employee._id),
      date: day.toISOString().slice(0, 10),
      previousStatus,
      newStatus: revertedStatus,
    },
  });

  res.json({ cleared: true, revertedStatus, leaveBalance: employee.leaveBalance });
});

module.exports = { mine, ofEmployee, setStatus, clearStatus };
