/**
 * leaveAttendance.js
 *
 * Three helpers that bridge the Leave module and the Attendance module:
 *
 *   syncAttendanceForLeave(lv)
 *     For an approved Leave, walk every working day in [from, to] and
 *     upsert an Attendance record (source='leave', linked via leaveId).
 *     Weekly-off days and holidays are skipped.  An existing record that
 *     was authored manually (source='manual') or by another approved leave
 *     is left untouched -- we only ever own records we created.
 *
 *   clearAttendanceForLeave(leaveId)
 *     Removes every Attendance record we created for the leave.  Manual
 *     overrides (where HR converted a leave day into something else) are
 *     not affected because their leaveId is null.
 *
 *   migrateApprovedLeaves()
 *     On boot, ensure every currently-approved leave has its
 *     attendance records.  Idempotent + re-runnable: the unique
 *     (employee, date) index plus `findOneAndUpdate` guard mean repeated
 *     runs never create duplicates.
 *
 * Balance math lives ENTIRELY in leaveController (decide/revoke).  This
 * service writes attendance state only -- it never touches
 * `user.leaveBalance` so we cannot double-count.
 */

const mongoose = require('mongoose');
const Leave      = require('../models/Leave');
const Attendance = require('../models/Attendance');
const User       = require('../models/User');
const Holiday    = require('../models/Holiday');
const { startOfDay, addDays, formatYMD } = require('../utils/dateHelpers');

/** Status the day should carry given the leave's day-type + paid flag. */
const statusForLeave = (lv) => {
  if (lv.dayType === 'half') return lv.paid ? 'half_paid' : 'half_unpaid';
  return lv.paid ? 'full_paid' : 'full_unpaid';
};

/** Units the record itself consumes (mirrors STATUS_LEAVE_UNITS). */
const unitsForLeave = (lv) => {
  if (!lv.paid) return 0;
  return lv.dayType === 'half' ? 0.5 : 1;
};

/**
 * Sync attendance records for a single approved Leave document.
 * Returns { created, kept } counts for logging / verification.
 */
const syncAttendanceForLeave = async (lv) => {
  if (!lv || lv.status !== 'approved') return { created: 0, kept: 0 };
  const employee = await User.findById(lv.employee).select('weeklyOff');
  if (!employee) return { created: 0, kept: 0 };
  const weeklyOff = Array.isArray(employee.weeklyOff) && employee.weeklyOff.length ? employee.weeklyOff : [0];

  const from = startOfDay(lv.fromDate);
  const to   = startOfDay(lv.toDate);

  // All holidays in the leave window so we can skip them in one go.
  const holidays = await Holiday.find({ date: { $gte: from, $lte: to } }).select('date').lean();
  const holidaySet = new Set(holidays.map((h) => formatYMD(h.date)));

  const status = statusForLeave(lv);
  const leaveDelta = unitsForLeave(lv);

  let created = 0;
  let kept = 0;
  for (let d = new Date(from.getTime()); d.getTime() <= to.getTime(); d = addDays(d, 1)) {
    if (weeklyOff.includes(d.getUTCDay())) continue;        // employee's weekly off
    if (holidaySet.has(formatYMD(d))) continue;             // company holiday

    // Atomic upsert -- if there's already a record for this day:
    //   - leave-driven from THIS or another approved leave -> leave alone
    //   - manual override -> respect HR's intent, leave alone
    //   - auto half-day from a submission -> upgrade to leave-linked so
    //     revocation can clean up
    const existing = await Attendance.findOne({ employee: lv.employee, date: d });
    if (existing) {
      if (existing.source === 'manual') { kept += 1; continue; }
      if (existing.source === 'leave' && String(existing.leaveId) === String(lv._id)) { kept += 1; continue; }
      if (existing.source === 'leave' && existing.leaveId) { kept += 1; continue; }
      // 'auto' record (submission-driven half-day): take it over.
      existing.status = status;
      existing.source = 'leave';
      existing.leaveId = lv._id;
      existing.leaveDelta = leaveDelta;
      existing.note = existing.note || `Approved leave (${formatYMD(lv.fromDate)} → ${formatYMD(lv.toDate)})`;
      await existing.save();
      created += 1;
      continue;
    }
    await Attendance.create({
      employee: lv.employee,
      date: d,
      status,
      source: 'leave',
      leaveId: lv._id,
      leaveDelta,
      setBy: lv.decidedBy || lv.employee,
      note: `Approved leave (${formatYMD(lv.fromDate)} → ${formatYMD(lv.toDate)})`,
    });
    created += 1;
  }
  return { created, kept };
};

/** Delete every Attendance record we created for a given leaveId. */
const clearAttendanceForLeave = async (leaveId) => {
  if (!leaveId) return { deleted: 0 };
  const r = await Attendance.deleteMany({ leaveId, source: 'leave' });
  return { deleted: r?.deletedCount || 0 };
};

/**
 * One-time + boot-time migration.  Walks every currently-APPROVED leave
 * and runs syncAttendanceForLeave on it.  Safe to run on every restart:
 * the per-day upsert short-circuits when records already exist.
 *
 * Logs a single summary line so deploys see migration progress without
 * spamming Render's log volume.
 */
const migrateApprovedLeaves = async () => {
  const approved = await Leave.find({ status: 'approved' }).select('_id employee fromDate toDate dayType paid status decidedBy');
  if (approved.length === 0) {
    console.log('[migrate] leave→attendance: no approved leaves to backfill');
    return { totalLeaves: 0, totalCreated: 0, totalKept: 0 };
  }
  let totalCreated = 0;
  let totalKept = 0;
  for (const lv of approved) {
    try {
      const r = await syncAttendanceForLeave(lv);
      totalCreated += r.created;
      totalKept    += r.kept;
    } catch (e) {
      console.error(`[migrate] leave→attendance failed for leave ${lv._id}: ${e.message}`);
    }
  }
  console.log(`[migrate] leave→attendance: scanned ${approved.length} approved leave(s), created/upgraded ${totalCreated} attendance record(s), kept ${totalKept} existing`);
  return { totalLeaves: approved.length, totalCreated, totalKept };
};

module.exports = {
  syncAttendanceForLeave,
  clearAttendanceForLeave,
  migrateApprovedLeaves,
  statusForLeave,
  unitsForLeave,
};
