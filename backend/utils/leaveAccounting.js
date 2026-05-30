/**
 * leaveAccounting
 *
 * Single source of truth for "how much paid leave is consumed on a given
 * day" so that leave balances are deducted exactly ONCE per day, no matter
 * which subsystem touches the day:
 *
 *   - leaveController.decide  : deducts a leave's days when HR APPROVES it.
 *   - attendanceController     : HR manually overrides a day's status.
 *   - submissionController     : auto half-day at submission time.
 *
 * The rule the business cares about (see spec):
 *   A manual attendance override is an attendance-STATE correction, not a
 *   new leave transaction.  If an approved paid leave already deducted the
 *   balance for that day, an override to the matching paid status must NOT
 *   deduct again.
 *
 * We achieve idempotency by treating the day's total paid-leave units as a
 * target, subtracting whatever an approved paid leave already accounts for,
 * and letting the override deduct ONLY the remaining difference.  That
 * remaining amount is persisted on the Attendance record as `leaveDelta`,
 * so clearing the override refunds exactly its own contribution and never
 * the approval's.
 */

const Leave = require('../models/Leave');
const { startOfDay } = require('./dateHelpers');

// Paid-leave units consumed by an attendance status.  Only the two "paid
// leave" statuses draw down the balance; everything else is 0.
const STATUS_LEAVE_UNITS = { half_paid: 0.5, full_paid: 1 };

/**
 * Target paid-leave units a day should consume given an attendance status.
 */
const leaveUnitsForStatus = (status) => STATUS_LEAVE_UNITS[status] || 0;

/**
 * Paid-leave units ALREADY deducted from the balance for this employee/day
 * via an approved PAID leave record (unpaid approved leaves never touch the
 * balance, so they count as 0).  A half-day leave contributes 0.5, a
 * full-day leave 1; the total is capped at 1 (a single day can't consume
 * more than one leave unit).
 */
const approvedPaidLeaveUnitsForDay = async (employeeId, day) => {
  const d = startOfDay(day);
  const leaves = await Leave.find({
    employee: employeeId,
    status: 'approved',
    paid: true,
    fromDate: { $lte: d },
    toDate: { $gte: d },
  }).select('dayType');

  let units = 0;
  for (const lv of leaves) units += lv.dayType === 'half' ? 0.5 : 1;
  return Math.min(units, 1);
};

/**
 * Compute the incremental leave-balance change a manual override should
 * apply, so that a day is never double-deducted.
 *
 * @param {number} targetUnits        units the new status wants the day to consume
 * @param {number} approvalUnits      units an approved paid leave already deducted
 * @param {number} existingOverrideDelta units a PRIOR manual override on this day deducted
 *
 * Returns { overrideDelta, balanceChange } where:
 *   - overrideDelta  = units this override itself is responsible for
 *                      (persist on Attendance.leaveDelta)
 *   - balanceChange  = amount to add to leaveBalance.used right now
 *                      (overrideDelta minus what the prior override took)
 */
const computeOverrideLeaveDelta = ({ targetUnits, approvalUnits, existingOverrideDelta = 0 }) => {
  // Only deduct the part of the target NOT already covered by an approval.
  const overrideDelta = Math.max(0, round2(targetUnits - approvalUnits));
  const balanceChange = round2(overrideDelta - existingOverrideDelta);
  return { overrideDelta, balanceChange };
};

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = {
  STATUS_LEAVE_UNITS,
  leaveUnitsForStatus,
  approvedPaidLeaveUnitsForDay,
  computeOverrideLeaveDelta,
  round2,
};
