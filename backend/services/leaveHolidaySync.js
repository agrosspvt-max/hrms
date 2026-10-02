/**
 * leaveHolidaySync.js
 *
 * Issue #2 (Part 8-10): when a Holiday (or event-holiday) is
 * created / edited / deleted, any APPROVED leave whose range now
 * intersects the changed date(s) must have its `days` recomputed via
 * the SAME canonical calculator every other path uses
 * (`effectiveLeaveDays`), the leave-balance delta applied exactly
 * once, attendance/business-state re-synced through the existing
 * services, and the change audited.
 *
 * Design guarantees
 * -----------------
 * * ONE calculator: `effectiveLeaveDays` (never a second impl).
 * * ONE holiday source: `eventOccurrences.holidayDaySet` (Holiday
 *   collection + event holidays), the same set apply/decide/edit use.
 * * Idempotent: the balance delta is `newDays - lv.days` where
 *   `lv.days` is the CURRENTLY stored value.  After we persist
 *   `lv.days = newDays`, a re-run computes `newDays - newDays = 0`,
 *   so no leave is ever refunded or deducted twice.
 * * Scoped: only approved leaves whose [fromDate,toDate] intersects
 *   the changed date window are touched — never every leave in the DB.
 * * Reuses existing sync: `leaveAttendance.clear/sync` +
 *   `businessStateSync.syncForLeave` (no new attendance path).
 * * Non-destructive: never deletes leave/history; only recomputes the
 *   numeric `days` + reconciles balance + attendance.
 *
 * Notification decision (Part 14): the HRMS notifies employees on HR
 * decide / revoke / modified-approval only.  A holiday-driven
 * recompute is a system reconciliation, not an HR decision, so we do
 * NOT emit a leave_decision notification (avoids noise / a new rule).
 * The employee's dashboard still refreshes live via the
 * `working_day:changed` realtime nudge businessStateSync already
 * publishes.
 *
 * Historical leaves (Part 11): there is no closed-period / payroll-lock
 * model in the schema, so intersecting past approved leaves ARE
 * recomputed (with audit + balance delta).  If a closed-period rule is
 * introduced later, gate the per-leave loop below on it.
 */

const Leave = require('../models/Leave');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { startOfDay, effectiveLeaveDays } = require('../utils/dateHelpers');

const SYSTEM_ACTOR = '000000000000000000000000';

/**
 * Recompute approved leaves affected by a holiday change over the
 * given date(s).
 *
 * @param {Object} opts
 * @param {Array<Date|string>} opts.dates   changed holiday date(s)
 * @param {ObjectId} [opts.actor]           HR user who changed the holiday
 * @param {string} [opts.reason]            e.g. 'holiday created 2026-09-03'
 * @param {string} [opts.source]            'holiday' | 'event'
 * @returns {Promise<{ recalculated: Array, unchanged: number }>}
 */
const recalcApprovedLeavesForDates = async ({ dates = [], actor = null, reason = '', source = 'holiday' } = {}) => {
  const out = { recalculated: [], unchanged: 0 };
  const norm = (dates || [])
    .map((d) => { try { return startOfDay(new Date(d)); } catch (_) { return null; } })
    .filter(Boolean);
  if (norm.length === 0) return out;

  const min = new Date(Math.min(...norm.map((d) => d.getTime())));
  const max = new Date(Math.max(...norm.map((d) => d.getTime())));

  // Approved leaves whose window intersects [min, max].
  const leaves = await Leave.find({
    status: 'approved',
    fromDate: { $lte: max },
    toDate: { $gte: min },
  });
  if (!leaves.length) return out;

  const { holidayDaySet } = require('./eventOccurrences');
  const businessStateSync = require('./businessStateSync');
  const leaveAtt = require('./leaveAttendance');

  for (const lv of leaves) {
    // eslint-disable-next-line no-await-in-loop
    const user = await User.findById(lv.employee).select('weeklyOff');
    const weeklyOff = user?.weeklyOff || [0];
    // eslint-disable-next-line no-await-in-loop
    const holidaySet = await holidayDaySet(lv.fromDate, lv.toDate);
    const newDays = effectiveLeaveDays({
      from: lv.fromDate,
      to: lv.toDate,
      weeklyOff,
      dayType: lv.dayType,
      holidaySet,
    });
    const oldDays = Number(lv.days) || 0;
    if (newDays === oldDays) { out.unchanged += 1; continue; }

    const delta = newDays - oldDays;   // <0 = refund, >0 = extra deduction

    // Balance reconciliation -- paid leaves only, applied exactly once
    // (idempotent because delta is measured against the stored value
    // which we immediately overwrite with newDays).
    if (lv.paid && delta !== 0) {
      // eslint-disable-next-line no-await-in-loop
      const u = await User.findById(lv.employee);
      if (u) {
        const cur = Number(u.leaveBalance?.used) || 0;
        u.leaveBalance.used = Math.max(0, Math.round((cur + delta) * 100) / 100);
        // eslint-disable-next-line no-await-in-loop
        await u.save();
      }
    }

    lv.days = newDays;
    // eslint-disable-next-line no-await-in-loop
    await lv.save();

    // Reuse the existing leave->attendance sync: clear then rebuild so
    // a day that is now a holiday drops its leave-linked attendance
    // (syncAttendanceForLeave skips holiday days), and business-state
    // (submissions / compliance / realtime) re-evaluates.
    try {
      // eslint-disable-next-line no-await-in-loop
      await leaveAtt.clearAttendanceForLeave(lv._id);
      // eslint-disable-next-line no-await-in-loop
      await leaveAtt.syncAttendanceForLeave(lv);
    } catch (e) { console.error('[leaveHolidaySync] attendance resync:', e.message); }
    try {
      // eslint-disable-next-line no-await-in-loop
      await businessStateSync.syncForLeave(lv, { trigger: 'holiday_changed', actor });
    } catch (e) { console.error('[leaveHolidaySync] businessStateSync:', e.message); }

    // Audit -- reuse the existing AuditLog collection.
    try {
      // eslint-disable-next-line no-await-in-loop
      await AuditLog.create({
        actor: actor || SYSTEM_ACTOR,
        actorRole: actor ? 'hr' : 'system',
        action: 'leave.days.recalc',
        targetType: 'Leave',
        targetId: lv._id,
        targetLabel: `${String(lv.fromDate).slice(0, 10)} → ${String(lv.toDate).slice(0, 10)}`,
        meta: {
          employee: String(lv.employee),
          previousDays: oldDays,
          newDays,
          delta,
          paid: lv.paid,
          affectedDates: norm.map((d) => d.toISOString().slice(0, 10)),
          source, reason,
        },
      });
    } catch (e) { console.error('[leaveHolidaySync] audit:', e.message); }

    out.recalculated.push({
      leaveId: lv._id, employee: lv.employee,
      previousDays: oldDays, newDays, delta,
    });
  }
  return out;
};

module.exports = { recalcApprovedLeavesForDates };
