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
};
