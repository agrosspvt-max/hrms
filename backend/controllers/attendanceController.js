const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const { deriveAttendance } = require('../services/dailyEngine');
const { monthRange, startOfDay, addDays } = require('../utils/dateHelpers');
const { logAudit } = require('../utils/audit');
// Phase 47 -- realtime fan-out so the affected employee's Attendance
// page re-fetches without a manual refresh.
const rt = require('../services/realtime');
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
  const { date, status, note, penaltyDecision } = req.body;
  if (!date) { res.status(400); throw new Error('date is required'); }
  if (!MANUAL_STATUSES.includes(status)) {
    res.status(400);
    throw new Error(`status must be one of: ${MANUAL_STATUSES.join(', ')}`);
  }
  // Phase 61 -- when HR flips Absent -> Present on a day with no
  // submission they must pick one of two behaviours.
  //   'performance_penalty' -- creates attendance_manual penalty.
  //   'neutral_adjustment'  -- day is fully ignored (0/0/0).
  // The decision is required only for the specific transition; every
  // other setStatus call ignores this field.
  const PENALTY_DECISIONS = ['performance_penalty', 'neutral_adjustment'];
  if (penaltyDecision && !PENALTY_DECISIONS.includes(penaltyDecision)) {
    res.status(400);
    throw new Error(`penaltyDecision must be one of: ${PENALTY_DECISIONS.join(', ')}`);
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
      // Phase 61 -- permanent record of HR's penalty choice, if any.
      penaltyDecision: penaltyDecision || null,
    },
  });

  // Phase 61 -- Manual Attendance Correction.  When HR flips a day
  // that was Absent (either explicitly or by derivation) into a
  // present-type status, and the employee never submitted work for
  // that day, we honour HR's Performance-Penalty vs. Neutral
  // Adjustment choice.
  try {
    const wasAbsent = previousStatus === 'absent';
    const isPresent = status === 'present' || status === 'half_paid' || status === 'half_unpaid';
    if (wasAbsent && isPresent && penaltyDecision) {
      const Submission = require('../models/Submission');
      const submitted = await Submission.findOne({
        employee: employee._id, date: day, submitted: true, deleted: { $ne: true },
      }).select('_id').lean();
      if (!submitted) {
        if (penaltyDecision === 'performance_penalty') {
          // Option A: penalty = whatever the employee had earned
          // for the day (usually 0).  Final Marks -> 0.
          const Penalty = require('../models/Penalty');
          const sub = await Submission.findOne({
            employee: employee._id, date: day, deleted: { $ne: true },
          }).select('_id earnedPoints').lean();
          await Penalty.create({
            employee: employee._id,
            category: 'attendance_manual',
            source: 'manual',
            probable: false,
            status: 'active',
            penaltyMarks: sub ? Number(sub.earnedPoints) || 0 : 0,
            targetDate: day,
            submission: sub ? sub._id : null,
            rule: 'attendance_absent_to_present_v1',
            reason: 'HR marked absent -> present with no submission (Performance Penalty).',
            employeeMessage: 'HR marked you present for a day you did not submit work. A performance penalty has been recorded.',
            createdBy: req.user._id,
            effectiveDate: new Date(),
          });
        }
        // Option B ('neutral_adjustment') is a no-op here: no
        // penalty is created; the day is simply ignored.  The
        // decision is stored on the audit log below.
      }
    }
  } catch (e) { console.error('[attendance] penalty decision:', e.message); }

  // Notify the employee that HR changed their attendance.  The
  // notifyEvents helper is a Phase-45 no-op (notification row no longer
  // created — too noisy), but we still emit a realtime push so the
  // employee's My Attendance page and Dashboard counters re-fetch.
  try {
    const notify = require('../services/notifyEvents');
    notify.notifyAttendanceChanged({
      employeeId: employee._id,
      date: day,
      status,
      changedBy: req.user,
    });
    rt.publish(employee._id, 'attendance:changed', { date: day, status });
  } catch (_) { /* never blocks */ }

  res.json({
    record,
    previousStatus,
    leaveAccounting: { targetUnits, approvalUnits, overrideDelta, balanceChange },
    leaveBalance: employee.leaveBalance,
    // Phase 61 -- surface the chosen decision so the UI can confirm.
    penaltyDecision: penaltyDecision || null,
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

  // Phase 47 -- realtime push to the employee whose override was cleared.
  rt.publish(employee._id, 'attendance:changed', { date: day, status: revertedStatus });

  res.json({ cleared: true, revertedStatus, leaveBalance: employee.leaveBalance });
});

/**
 * POST /api/attendance/bulk    (HR / Super Admin)
 *
 * Apply one attendance status to many employees on one date.  Each row
 * is processed independently using the exact same leave-accounting +
 * audit-log path setStatus() uses on a single row -- so a bulk apply
 * lands the same audit trail you'd get from N individual edits.
 *
 * Body: { employeeIds: [String], date: 'YYYY-MM-DD', status, note? }
 * Returns: { requested, succeededCount, failedCount, succeeded[], failed[] }
 */
const bulkSetStatus = asyncHandler(async (req, res) => {
  const { employeeIds, date, status, note } = req.body || {};
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
    res.status(400); throw new Error('No employees selected');
  }
  if (!date)   { res.status(400); throw new Error('date is required'); }
  if (!MANUAL_STATUSES.includes(status)) {
    res.status(400);
    throw new Error(`status must be one of: ${MANUAL_STATUSES.join(', ')}`);
  }
  const day = startOfDay(new Date(date));
  if (Number.isNaN(day.getTime())) { res.status(400); throw new Error('Invalid date'); }

  const succeeded = [];
  const failed = [];

  for (const id of employeeIds) {
    try {
      const employee = await User.findById(id);
      if (!employee) { failed.push({ id, name: '(deleted)', reason: 'Employee not found' }); continue; }

      // Capture previous status for audit.
      const previousStatus = await effectiveStatusForDay(employee, day);
      const existing = await Attendance.findOne({ employee: employee._id, date: day });

      // Same leave-accounting math the single-row setStatus uses.
      const targetUnits = leaveUnitsForStatus(status);
      const approvalUnits = await approvedPaidLeaveUnitsForDay(employee._id, day);
      const existingOverrideDelta = existing && existing.source === 'manual' ? (existing.leaveDelta || 0) : 0;
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
          status,
          source: 'manual',
          note: note || '',
          setBy: req.user._id,
          leaveDelta: overrideDelta,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      logAudit(req, {
        action: 'attendance.override',
        targetType: 'Attendance',
        targetId: record._id,
        targetLabel: `${employee.name} · ${day.toISOString().slice(0, 10)} (bulk)`,
        meta: {
          employeeId: String(employee._id),
          date: day.toISOString().slice(0, 10),
          previousStatus, newStatus: status,
          targetLeaveUnits: targetUnits, approvedLeaveUnits: approvalUnits,
          leaveDelta: overrideDelta, balanceChange,
          via: 'bulk',
          note: note || '',
        },
      });

      succeeded.push({ id: String(employee._id), name: employee.name });
      // Phase 47 -- per-employee realtime push so each affected user's
      // My Attendance / Dashboard refreshes.
      rt.publish(employee._id, 'attendance:changed', { date: day, status });
    } catch (err) {
      failed.push({ id, name: '(error)', reason: err.message });
    }
  }

  res.json({
    date: day.toISOString().slice(0, 10),
    status,
    requested: employeeIds.length,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    succeeded,
    failed,
  });
});

/* ====================================================================
 * Phase 29.4 — Date-range bulk attendance + conflict detection
 *
 * The legacy single-date bulkSetStatus stays as-is for backward
 * compatibility.  These two endpoints add the new flow:
 *
 *   POST /api/attendance/bulk-range/preview
 *     Body: { employeeIds, fromDate, toDate, status }
 *     Returns: { rows: [{ employeeId, name, date, hasConflict, reason,
 *                          existingStatus }], conflictCount, cleanCount }
 *
 *   POST /api/attendance/bulk-range/apply
 *     Body: { employeeIds, fromDate, toDate, status, note?,
 *             mode: 'skip' | 'override' | 'selected',
 *             selected?: [{ employeeId, date }]   // mode='selected' only
 *           }
 *     Returns: { applied: [...], skipped: [...], failed: [...] }
 *
 * The two endpoints reuse the same conflict detection helper so the
 * preview and the apply step can't drift apart.
 * ================================================================== */
const Leave_for_bulk = require('../models/Leave');
const Holiday_for_bulk = require('../models/Holiday');

const _eachDay = function* (from, to) {
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86400000)) {
    yield startOfDay(d);
  }
};

/**
 * Build the list of (employee, date) cells the range would touch + flag
 * any that conflict with existing leave / holiday / weekly-off /
 * existing-Attendance entries.
 */
const _detectConflicts = async ({ employees, fromDay, toDay }) => {
  const empIds = employees.map((e) => e._id);
  const holidays = await Holiday_for_bulk.find({ date: { $gte: fromDay, $lte: toDay } }).lean();
  const holidayDays = new Set(holidays.map((h) => startOfDay(h.date).toISOString()));
  const leaves = await Leave_for_bulk.find({
    employee: { $in: empIds },
    status: 'approved',
    fromDate: { $lte: toDay },
    toDate:   { $gte: fromDay },
  }).lean();
  const attendance = await Attendance.find({
    employee: { $in: empIds },
    date: { $gte: fromDay, $lte: toDay },
  }).lean();
  const attByKey = new Map(attendance.map((a) => [`${String(a.employee)}|${startOfDay(a.date).toISOString()}`, a]));

  const rows = [];
  for (const e of employees) {
    const weeklyOff = e.weeklyOff || [0];
    for (const day of _eachDay(fromDay, toDay)) {
      const iso = day.toISOString();
      const key = `${String(e._id)}|${iso}`;
      let reason = '';
      let existingStatus = '';
      if (weeklyOff.includes(day.getUTCDay())) reason = 'Weekly Off';
      else if (holidayDays.has(iso)) reason = 'Holiday';
      else {
        const lv = leaves.find((l) => String(l.employee) === String(e._id)
          && startOfDay(l.fromDate) <= day && startOfDay(l.toDate) >= day);
        if (lv) reason = lv.paid ? 'Approved Paid Leave' : 'Approved Unpaid Leave';
        else {
          const att = attByKey.get(key);
          if (att) {
            reason = 'Existing Attendance Entry';
            existingStatus = att.status;
          }
        }
      }
      rows.push({
        employeeId: String(e._id),
        name: e.name,
        employeeCode: e.employeeId,
        date: day.toISOString().slice(0, 10),
        hasConflict: !!reason,
        reason,
        existingStatus,
      });
    }
  }
  return rows;
};

const _validateBulkRangeBody = (req) => {
  const { employeeIds, fromDate, toDate, status } = req.body || {};
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
    throw Object.assign(new Error('No employees selected'), { _http: 400 });
  }
  if (!fromDate || !toDate) {
    throw Object.assign(new Error('fromDate and toDate are required'), { _http: 400 });
  }
  if (!MANUAL_STATUSES.includes(status)) {
    throw Object.assign(new Error(`status must be one of: ${MANUAL_STATUSES.join(', ')}`), { _http: 400 });
  }
  const fromDay = startOfDay(new Date(fromDate));
  const toDay   = startOfDay(new Date(toDate));
  if (Number.isNaN(fromDay.getTime()) || Number.isNaN(toDay.getTime())) {
    throw Object.assign(new Error('Invalid date'), { _http: 400 });
  }
  if (fromDay > toDay) {
    throw Object.assign(new Error('fromDate must be on or before toDate'), { _http: 400 });
  }
  return { employeeIds, fromDay, toDay, status };
};

const bulkRangePreview = asyncHandler(async (req, res) => {
  let body;
  try { body = _validateBulkRangeBody(req); }
  catch (err) { res.status(err._http || 500); throw err; }
  const employees = await User.find({ _id: { $in: body.employeeIds } })
    .select('_id name employeeId weeklyOff').lean();
  const rows = await _detectConflicts({ employees, fromDay: body.fromDay, toDay: body.toDay });
  const conflictCount = rows.filter((r) => r.hasConflict).length;
  res.json({
    rows,
    totalCells: rows.length,
    conflictCount,
    cleanCount: rows.length - conflictCount,
  });
});

const bulkRangeApply = asyncHandler(async (req, res) => {
  let body;
  try { body = _validateBulkRangeBody(req); }
  catch (err) { res.status(err._http || 500); throw err; }
  const mode = req.body?.mode || 'skip';
  if (!['skip', 'override', 'selected'].includes(mode)) {
    res.status(400); throw new Error(`mode must be one of: skip, override, selected`);
  }
  const selectedSet = new Set(
    Array.isArray(req.body?.selected)
      ? req.body.selected.map((s) => `${String(s.employeeId)}|${s.date}`)
      : [],
  );
  const note = String(req.body?.note || '').trim();
  const employees = await User.find({ _id: { $in: body.employeeIds } });
  const empById = new Map(employees.map((e) => [String(e._id), e]));
  const rows = await _detectConflicts({
    employees: employees.map((e) => ({
      _id: e._id, name: e.name, employeeId: e.employeeId, weeklyOff: e.weeklyOff,
    })),
    fromDay: body.fromDay, toDay: body.toDay,
  });

  const applied = [];
  const skipped = [];
  const failed  = [];

  for (const row of rows) {
    const key = `${row.employeeId}|${row.date}`;
    // mode-aware filter -- decide whether to touch this cell.
    if (row.hasConflict) {
      if (mode === 'skip') { skipped.push({ ...row, reason: row.reason }); continue; }
      if (mode === 'selected' && !selectedSet.has(key)) { skipped.push({ ...row, reason: row.reason }); continue; }
    }
    const employee = empById.get(row.employeeId);
    if (!employee) { failed.push({ ...row, error: 'Employee not found' }); continue; }
    const day = startOfDay(new Date(row.date));
    try {
      // Reuse the same leave-accounting math as the single-date bulk.
      const previousStatus = await effectiveStatusForDay(employee, day);
      const existing = await Attendance.findOne({ employee: employee._id, date: day });
      const targetUnits = leaveUnitsForStatus(body.status);
      const approvalUnits = await approvedPaidLeaveUnitsForDay(employee._id, day);
      const existingOverrideDelta = existing && existing.source === 'manual' ? (existing.leaveDelta || 0) : 0;
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
          employee: employee._id, date: day,
          status: body.status, source: 'manual',
          note: note || '', setBy: req.user._id, leaveDelta: overrideDelta,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      logAudit(req, {
        action: 'attendance.override',
        targetType: 'Attendance',
        targetId: record._id,
        targetLabel: `${employee.name} · ${row.date} (bulk-range, ${mode})`,
        meta: {
          employeeId: row.employeeId, date: row.date,
          previousStatus, newStatus: body.status,
          targetLeaveUnits: targetUnits, approvedLeaveUnits: approvalUnits,
          leaveDelta: overrideDelta, balanceChange,
          via: 'bulk-range', mode, conflict: row.reason || '',
          note,
        },
      });
      applied.push({ ...row });
    } catch (err) {
      failed.push({ ...row, error: err.message });
    }
  }

  res.json({
    fromDate: body.fromDay.toISOString().slice(0, 10),
    toDate:   body.toDay.toISOString().slice(0, 10),
    status:   body.status,
    mode,
    appliedCount: applied.length,
    skippedCount: skipped.length,
    failedCount:  failed.length,
    applied, skipped, failed,
  });
});

module.exports = { mine, ofEmployee, setStatus, clearStatus, bulkSetStatus, bulkRangePreview, bulkRangeApply };
