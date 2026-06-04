/**
 * Date helpers used across the system.
 * We normalise every "day" to UTC midnight so that submissions
 * and salary calculations align regardless of server timezone.
 */

const startOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

const endOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
};

const addDays = (d, n) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};

const sameDay = (a, b) =>
  a.getUTCFullYear() === b.getUTCFullYear() &&
  a.getUTCMonth() === b.getUTCMonth() &&
  a.getUTCDate() === b.getUTCDate();

const daysBetween = (a, b) => {
  const ms = startOfDay(b) - startOfDay(a);
  return Math.round(ms / (1000 * 60 * 60 * 24));
};

const monthRange = (year, monthNumber /* 1-12 */) => {
  const from = new Date(Date.UTC(year, monthNumber - 1, 1));
  const to = new Date(Date.UTC(year, monthNumber, 1));
  return { from, to };
};

const formatMonth = (year, m) => `${year}-${String(m).padStart(2, '0')}`;

// 'YYYY-MM-DD' (UTC) for a date - used to build payroll-period keys/labels.
const formatYMD = (d) => {
  const x = startOfDay(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};

// Parse a 'YYYY-MM-DD' (or ISO) string into a UTC-midnight Date.
const parseDay = (s) => {
  if (s instanceof Date) return startOfDay(s);
  const str = String(s || '');
  // date-only strings are parsed as UTC by JS; append time for full ISO too.
  const d = new Date(str.length <= 10 ? `${str}T00:00:00.000Z` : str);
  return startOfDay(d);
};

// Iterate every UTC day from `from` (inclusive) to `to` (exclusive)
const eachDay = function* (from, to) {
  let cur = startOfDay(from);
  const end = startOfDay(to);
  while (cur < end) {
    yield new Date(cur);
    cur = addDays(cur, 1);
  }
};

/**
 * Effective leave-day count, excluding the employee's weekly off days
 * (and -- when provided -- a set of holiday calendar dates).  This is
 * the source of truth for "how many leave units does this request
 * actually consume" used by the leave controller at apply / revoke and
 * by any analytics that needs a billable-leave-day count.
 *
 * Behaviour:
 *   - Half-day request: returns 0.5 normally, 0 if the single day is a
 *     weekly off / holiday (no work was owed anyway).
 *   - Full-day request: counts each UTC day in [from, to] (INCLUSIVE)
 *     whose weekday is not in `weeklyOff` and whose YYYY-MM-DD is not
 *     in the optional `holidaySet`.
 *
 *   weeklyOff defaults to [0] (Sunday) to match the User model default.
 *
 * Pure & side-effect-free so it's safe to import anywhere.
 */
const effectiveLeaveDays = ({ from, to, weeklyOff = [0], dayType = 'full', holidaySet } = {}) => {
  if (!from || !to) return 0;
  const f = startOfDay(from);
  const t = startOfDay(to);
  const offs = Array.isArray(weeklyOff) && weeklyOff.length ? weeklyOff : [0];
  const hset = holidaySet instanceof Set ? holidaySet : null;
  const isNonWorking = (d) => offs.includes(d.getUTCDay()) || (hset && hset.has(formatYMD(d)));
  if (dayType === 'half') {
    return f.getTime() === t.getTime() && !isNonWorking(f) ? 0.5 : 0;
  }
  let count = 0;
  for (let d = new Date(f.getTime()); d.getTime() <= t.getTime(); d = addDays(d, 1)) {
    if (!isNonWorking(d)) count += 1;
  }
  return count;
};

module.exports = {
  startOfDay,
  endOfDay,
  addDays,
  sameDay,
  daysBetween,
  monthRange,
  formatMonth,
  formatYMD,
  parseDay,
  eachDay,
  effectiveLeaveDays,
};
