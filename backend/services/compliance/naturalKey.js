/**
 * naturalKey.js -- canonical idempotency keys for ComplianceIncident.
 *
 * Every detector emits candidates with a naturalKey that (a) uniquely
 * identifies the violation, and (b) is stable across scheduler runs.
 * The Incident partial-unique index on {naturalKey, source:'automatic'}
 * turns "did I already record this?" into a DB constraint instead of
 * a lookup + race.
 *
 * Format: `<ruleCode>|<empId>|<isoDay>|<optional-scalar>`
 *
 * All builders are pure and synchronous; every value is coerced to
 * string, dates to `YYYY-MM-DD`.  No DB access.
 */

const { startOfDay } = require('../../utils/dateHelpers');

/** UTC-midnight ISO-day for a Date-like input. */
const _isoDay = (d) => {
  if (!d) return '';
  const dt = startOfDay(d instanceof Date ? d : new Date(d));
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
};

const _s = (v) => (v === undefined || v === null ? '' : String(v));

/** Missed Submission -- one candidate per unsubmitted stub. */
const missedSubmissionKey = ({ ruleCode, employeeId, day, submissionId }) =>
  [ruleCode, _s(employeeId), _isoDay(day), _s(submissionId)].join('|');

/** Dependency Pending -- one candidate per employee-day. */
const dependencyPendingKey = ({ ruleCode, employeeId, day }) =>
  [ruleCode, _s(employeeId), _isoDay(day)].join('|');

/** Performance Lock -- one candidate per employee-day (day-scoped). */
const performanceLockKey = ({ ruleCode, employeeId, day }) =>
  [ruleCode, _s(employeeId), _isoDay(day)].join('|');

/** Manual incident -- HR provides its own idempotency token; if none,
 *  fall back to a per-employee-day tuple.  Manual incidents may repeat
 *  across the same day (e.g. two separate customer complaints), so
 *  callers CAN pass a fresh token to bypass the partial-unique index. */
const manualIncidentKey = ({ ruleCode, employeeId, day, token }) =>
  [ruleCode, _s(employeeId), _isoDay(day), _s(token)].join('|');

/** Generic fallback for future rules -- caller supplies its own scalar. */
const buildKey = ({ ruleCode, employeeId, day, extra }) =>
  [ruleCode, _s(employeeId), _isoDay(day), _s(extra)].join('|');

module.exports = {
  missedSubmissionKey,
  dependencyPendingKey,
  performanceLockKey,
  manualIncidentKey,
  buildKey,
};
