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

// Manual salary-cut marks.  An approved leave supersedes one of these when the
// mark was made BEFORE the leave was approved (HR marked the day on the facts
// they had; the approval is the later, more specific decision).  A mark made
// AFTER the approval is a deliberate override of the leave and always wins.
// 'absent' keeps its original (Issue #3) behaviour: always superseded.
const NEGATIVE_MANUAL_STATUSES = Object.freeze(['half_unpaid', 'full_unpaid']);

const _ts = (d) => (d ? new Date(d).getTime() : NaN);

/**
 * Should an approved leave take over this MANUAL attendance record?
 * Returns 'stale_absent' | 'pre_approval_unpaid_mark' | null (keep the manual row).
 */
const manualSupersession = (existing, lv, { repair = true } = {}) => {
  if (!existing || existing.source !== 'manual') return null;
  if (existing.status === 'absent') return 'stale_absent';
  if (!repair) return null;                                             // boot re-sync never rewrites history
  if ((existing.leaveDelta || 0) !== 0) return null;                    // never disturb leave accounting
  if (!NEGATIVE_MANUAL_STATUSES.includes(existing.status)) return null; // present / paid / weekly_off are deliberate
  const markedAt = _ts(existing.updatedAt || existing.createdAt);
  const approvedAt = _ts(lv.decidedAt);
  if (Number.isNaN(markedAt) || Number.isNaN(approvedAt)) return null;  // cannot prove it predates: keep
  return markedAt <= approvedAt ? 'pre_approval_unpaid_mark' : null;
};

const _systemAudit = async (action, targetId, label, meta) => {
  try {
    const AuditLog = require('../models/AuditLog');
    await AuditLog.create({
      actor: new mongoose.Types.ObjectId('000000000000000000000000'), actorRole: 'system',
      action, targetType: 'Attendance', targetId, targetLabel: label, meta,
    });
  } catch (e) { console.error('[leaveAttendance] audit failed:', e.message); }
};

/**
 * Give a leave-linked row back: restore the manual record it superseded (with its
 * ORIGINAL timestamp, so a later re-sync can still tell it predates the approval),
 * otherwise delete it so the day falls back to its derived state.
 */
const _releaseRow = async (row) => {
  const prev = row.supersededManual;
  if (prev && prev.status) {
    await Attendance.updateOne(
      { _id: row._id, source: 'leave' },
      { $set: {
        status: prev.status, source: 'manual', note: prev.note || '', setBy: prev.setBy || null,
        leaveDelta: prev.leaveDelta || 0, leaveId: null, supersededManual: null,
        ...(prev.updatedAt ? { updatedAt: prev.updatedAt } : {}),
      } },
      { timestamps: false },
    );
    return 'restored';
  }
  await Attendance.deleteMany({ _id: row._id, source: 'leave' });
  return 'deleted';
};

/**
 * Reconcile the attendance records of ONE approved Leave with the leave as it is
 * NOW (status, paid flag, day type, dates).  Idempotent and safe to repeat:
 *   - missing day                    -> create the leave-linked record
 *   - this leave's own record, stale -> refresh status / leaveDelta in place
 *     (this is the "approved as unpaid, now paid" case: the row is never kept stale)
 *   - another leave's record         -> leave alone
 *   - manual record                  -> kept, unless manualSupersession() says the
 *     approval takes over (stale Absent, or an unpaid mark that predates it)
 *   - auto half-day from a submission-> adopted so revocation can clean up
 *   - this leave's records on days that are no longer part of it -> released
 * Only this employee's records for this leave's window are touched.
 *
 * `repair:false` (used by the boot-time re-sync) keeps the historical rules only:
 * create missing days, adopt auto rows, supersede a stale Absent -- it does NOT
 * refresh stale leave-linked rows, supersede unpaid marks or release rows, so a
 * deploy never silently rewrites past attendance.  Live leave events use the
 * default (repair) mode; historical repair is a separate, reviewed step.
 * Returns { created, kept, updated, released }.
 */
const syncAttendanceForLeave = async (lv, { repair = true } = {}) => {
  if (!lv || lv.status !== 'approved') return { created: 0, kept: 0, updated: 0, released: 0 };
  const employee = await User.findById(lv.employee).select('weeklyOff');
  if (!employee) return { created: 0, kept: 0, updated: 0, released: 0 };
  const weeklyOff = Array.isArray(employee.weeklyOff) && employee.weeklyOff.length ? employee.weeklyOff : [0];

  const from = startOfDay(lv.fromDate);
  const to   = startOfDay(lv.toDate);

  // All holidays in the leave window so we can skip them in one go.
  const holidays = await Holiday.find({ date: { $gte: from, $lte: to } }).select('date').lean();
  const holidaySet = new Set(holidays.map((h) => formatYMD(h.date)));

  const status = statusForLeave(lv);
  const leaveDelta = unitsForLeave(lv);
  const windowNote = `(${formatYMD(lv.fromDate)} → ${formatYMD(lv.toDate)})`;

  let created = 0;
  let kept = 0;
  let updated = 0;
  const owned = new Set();          // YMD of every day this leave should own
  for (let d = new Date(from.getTime()); d.getTime() <= to.getTime(); d = addDays(d, 1)) {
    if (weeklyOff.includes(d.getUTCDay())) continue;        // employee's weekly off
    if (holidaySet.has(formatYMD(d))) continue;             // company holiday
    owned.add(formatYMD(d));

    const existing = await Attendance.findOne({ employee: lv.employee, date: d });
    if (!existing) {
      await Attendance.create({
        employee: lv.employee, date: d, status, source: 'leave', leaveId: lv._id, leaveDelta,
        setBy: lv.decidedBy || lv.employee, note: `Approved leave ${windowNote}`,
      });
      created += 1;
      continue;
    }
    if (existing.source === 'leave') {
      if (String(existing.leaveId) !== String(lv._id)) { kept += 1; continue; }   // another leave's row
      if (!repair || (existing.status === status && (existing.leaveDelta || 0) === leaveDelta)) { kept += 1; continue; }
      // Our own row carries an obsolete classification: bring it up to date.
      await Attendance.updateOne(
        { _id: existing._id, source: 'leave', leaveId: lv._id },
        { $set: { status, leaveDelta, note: `Approved leave ${windowNote}` } },
      );
      updated += 1;
      continue;
    }
    if (existing.source === 'manual') {
      const why = manualSupersession(existing, lv, { repair });
      if (!why) { kept += 1; continue; }
      const snapshot = why === 'stale_absent' ? null : {
        status: existing.status, note: existing.note || '', setBy: existing.setBy || null,
        leaveDelta: existing.leaveDelta || 0, updatedAt: existing.updatedAt || existing.createdAt || null,
      };
      const won = await Attendance.updateOne(
        { _id: existing._id, source: 'manual', status: existing.status },     // not if HR changed it meanwhile
        { $set: {
          status, source: 'leave', leaveId: lv._id, leaveDelta, supersededManual: snapshot,
          note: why === 'stale_absent'
            ? `Approved leave superseded a prior Absent mark ${windowNote}`
            : `Approved leave superseded a prior ${existing.status} mark ${windowNote}`,
        } },
      );
      if (won && (won.modifiedCount === undefined || won.modifiedCount > 0)) {
        created += 1;
        await _systemAudit('attendance.leave_superseded_manual', existing._id,
          `${formatYMD(d)} ${existing.status} -> ${status}`,
          { employee: String(lv.employee), leaveId: String(lv._id), date: formatYMD(d), reason: why,
            previous: { status: existing.status, note: existing.note || '', setBy: existing.setBy ? String(existing.setBy) : null },
            next: { status } });
      } else { kept += 1; }
      continue;
    }
    // 'auto' record (submission-driven half-day): take it over so revocation can clean up.
    await Attendance.updateOne(
      { _id: existing._id, source: 'auto' },
      { $set: {
        status, source: 'leave', leaveId: lv._id, leaveDelta,
        note: existing.note || `Approved leave ${windowNote}`,
      } },
    );
    created += 1;
  }

  // This leave's records on days that no longer belong to it (window shrunk / moved,
  // a holiday or weekly off now covers the day): release them.
  let released = 0;
  const mine = repair ? await Attendance.find({ leaveId: lv._id, source: 'leave' }) : [];
  for (const row of mine) {
    if (owned.has(formatYMD(row.date))) continue;
    await _releaseRow(row);
    released += 1;
  }
  return { created, kept, updated, released };
};

/**
 * Release every Attendance record we created for a given leaveId.  A record that
 * had superseded a manual mark gives that mark back; everything else is deleted.
 */
const clearAttendanceForLeave = async (leaveId) => {
  if (!leaveId) return { deleted: 0, restored: 0 };
  const rows = await Attendance.find({ leaveId, source: 'leave' });
  let deleted = 0; let restored = 0;
  for (const row of rows) {
    if ((await _releaseRow(row)) === 'restored') restored += 1; else deleted += 1;
  }
  return { deleted, restored };
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
  const approved = await Leave.find({ status: 'approved' }).select('_id employee fromDate toDate dayType paid status decidedBy decidedAt');
  if (approved.length === 0) {
    console.log('[migrate] leave→attendance: no approved leaves to backfill');
    return { totalLeaves: 0, totalCreated: 0, totalKept: 0 };
  }
  let totalCreated = 0;
  let totalKept = 0;
  for (const lv of approved) {
    try {
      const r = await syncAttendanceForLeave(lv, { repair: false });   // never rewrite history at boot
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
  manualSupersession,
};
