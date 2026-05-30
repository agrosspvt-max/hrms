/**
 * scheduleHelpers
 *
 * Centralised recurrence logic for the assignment engine.  Supports four
 * frequencies:
 *
 *   one-time : generates exactly once, on startDate.
 *   daily    : generates every (non-off / non-holiday) day in range.
 *   weekly   : generates on a chosen weekday (weeklyDay, 0=Sun..6=Sat).
 *   monthly  : generates on a chosen day-of-month (monthlyDate, 1..31),
 *              clamped to the last valid day for short months (so 31 in
 *              February falls on the 28th/29th).
 *
 * All day comparisons use UTC midnight to match the rest of the system.
 */

const { startOfDay } = require('./dateHelpers');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Number of days in the UTC month that `day` falls in. */
const daysInMonth = (day) =>
  new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();

/** Ordinal suffix for a day number, e.g. 1 -> "1st", 22 -> "22nd". */
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/**
 * The effective day-of-month a monthly assignment runs on for the month
 * that `day` belongs to (handles month-end clamping).
 */
const effectiveMonthlyDate = (assignment, day) => {
  const start = startOfDay(assignment.startDate || new Date());
  const wanted = assignment.monthlyDate || start.getUTCDate();
  return Math.min(wanted, daysInMonth(day));
};

/**
 * Returns true if `assignment` is scheduled to generate a submission on
 * the given UTC `day`.  Respects startDate / endDate bounds.
 */
const isScheduledOn = (assignment, day) => {
  const d = startOfDay(day);
  const start = startOfDay(assignment.startDate || new Date());

  if (d < start) return false;
  if (assignment.endDate && d > startOfDay(assignment.endDate)) return false;

  switch (assignment.frequency) {
    case 'one-time':
      return d.getTime() === start.getTime();

    case 'weekly': {
      const target = assignment.weeklyDay != null ? assignment.weeklyDay : start.getUTCDay();
      return d.getUTCDay() === target;
    }

    case 'monthly':
      return d.getUTCDate() === effectiveMonthlyDate(assignment, d);

    case 'daily':
    default:
      return true;
  }
};

/**
 * Human-readable schedule summary used for tags / dashboards.
 *   daily    -> "Daily"
 *   weekly   -> "Weekly • Every Monday"
 *   monthly  -> "Monthly • Every 5th"
 *   one-time -> "One-time"
 */
const buildScheduleLabel = (assignment) => {
  const start = assignment.startDate ? startOfDay(assignment.startDate) : new Date();
  switch (assignment.frequency) {
    case 'weekly': {
      const wd = assignment.weeklyDay != null ? assignment.weeklyDay : start.getUTCDay();
      return `Weekly • Every ${WEEKDAYS[wd] || 'day'}`;
    }
    case 'monthly': {
      const dom = assignment.monthlyDate || start.getUTCDate();
      return `Monthly • Every ${ordinal(dom)}`;
    }
    case 'one-time':
      return 'One-time';
    case 'daily':
    default:
      return 'Daily';
  }
};

module.exports = {
  WEEKDAYS,
  daysInMonth,
  ordinal,
  effectiveMonthlyDate,
  isScheduledOn,
  buildScheduleLabel,
};
