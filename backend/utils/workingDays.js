/**
 * workingDays.js  --  Phase 64 shared working-day arithmetic.
 *
 * Used by both the Missed-Submission engine (day-after check) and
 * the Pending-Task Compliance engine (Resolve By).  Spec Part 3
 * explicitly says: "Do NOT count Approved Leave / Holiday /
 * Weekly Off. Only actual working days."
 *
 * Spec Part 9: "The same working-day calculation helper should be
 * used everywhere." -- this file is that helper.  It stays pure so
 * tests + callers don't have to stub Mongo.  All Mongo reads
 * (holidays + leaves) happen in the caller, which passes them in
 * via `ctx`.
 */
const { startOfDay } = require('./dateHelpers');

const DAY_MS = 24 * 60 * 60 * 1000;
const _iso = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Is `day` a working day for the given employee?
 *
 *   day        -- UTC-midnight Date.
 *   ctx.weeklyOff  -- number[] (0=Sun..6=Sat) from User.weeklyOff.
 *                     Falls back to [0] to match the User schema default.
 *   ctx.holidaySet -- Set<YYYY-MM-DD> of company holidays.
 *   ctx.leaveDaySet -- Set<YYYY-MM-DD> of days the employee is on
 *                      an APPROVED leave (any type, full or half).
 *
 * Half-day leaves still count as non-working per spec, matching
 * the existing Not-Submitted rules.
 */
const isWorkingDay = (day, ctx = {}) => {
  const d = startOfDay(day);
  const weeklyOff = ctx.weeklyOff || [0];
  if (weeklyOff.includes(d.getUTCDay())) return false;
  const key = _iso(d);
  if (ctx.holidaySet && ctx.holidaySet.has(key)) return false;
  if (ctx.leaveDaySet && ctx.leaveDaySet.has(key)) return false;
  return true;
};

/**
 * Add N working days to `from` and return the resulting date.
 *
 *   addWorkingDays(from=Mon 2026-07-13, n=3, ctx)
 *     -> Thu 2026-07-16 (assuming no holidays / weekly-off / leave)
 *
 * If N is 0 the same day is returned when it's a working day,
 * otherwise the next working day.  Guarded at 366 iterations to
 * prevent an infinite loop on pathological input.
 */
const addWorkingDays = (from, n, ctx = {}) => {
  let d = startOfDay(from);
  let remaining = Math.max(0, Number(n) || 0);
  let hops = 0;
  // If n === 0 we still need to land on a working day.
  if (remaining === 0) {
    while (!isWorkingDay(d, ctx) && hops++ < 366) d = new Date(d.getTime() + DAY_MS);
    return d;
  }
  while (remaining > 0 && hops++ < 366) {
    d = new Date(d.getTime() + DAY_MS);
    if (isWorkingDay(d, ctx)) remaining -= 1;
  }
  return d;
};

/**
 * Count the working days inside [from, to] inclusive.  Same rule
 * set as isWorkingDay; caps at 366 iterations.
 */
const countWorkingDays = (from, to, ctx = {}) => {
  const start = startOfDay(from);
  const end   = startOfDay(to);
  let count = 0;
  let hops = 0;
  for (let t = start.getTime(); t <= end.getTime() && hops < 366; t += DAY_MS, hops++) {
    if (isWorkingDay(new Date(t), ctx)) count += 1;
  }
  return count;
};

/**
 * Build the day-set fixtures a caller needs to invoke the pure
 * helpers above.  Kept in this file so every consumer wires them
 * up the same way.
 *
 *   ctx = await loadWorkingDayContext({ employee, from, to })
 *
 * The returned ctx is safe to pass to any of the helpers above.
 */
const loadWorkingDayContext = async ({ employee, from, to }) => {
  const Holiday = require('../models/Holiday');
  const Leave   = require('../models/Leave');
  const start = startOfDay(from);
  const end   = startOfDay(to);
  const [holidays, leaves] = await Promise.all([
    Holiday.find({ date: { $gte: start, $lte: end } }).select('date').lean(),
    Leave.find({
      employee: employee._id,
      status: 'approved',
      fromDate: { $lte: end },
      toDate:   { $gte: start },
    }).select('fromDate toDate').lean(),
  ]);
  const holidaySet = new Set(holidays.map((h) => _iso(h.date)));
  const leaveDaySet = new Set();
  for (const lv of leaves) {
    let t = startOfDay(lv.fromDate).getTime();
    const stop = startOfDay(lv.toDate).getTime();
    let hops = 0;
    while (t <= stop && hops++ < 366) {
      leaveDaySet.add(_iso(new Date(t)));
      t += DAY_MS;
    }
  }
  return { weeklyOff: employee.weeklyOff || [0], holidaySet, leaveDaySet };
};

module.exports = {
  isWorkingDay,
  addWorkingDays,
  countWorkingDays,
  loadWorkingDayContext,
};
