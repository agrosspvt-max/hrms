/**
 * missedSubmissionBackfill.js
 *
 * Backward-compatibility utility.  Before the Missed-Submission
 * penalty system existed, many historical "Not Submitted" days
 * already lived in the Submission collection with `submitted: false`.
 * They never had a corresponding Penalty document, so HR's new
 * "Send Back to Employee" workflow couldn't reach them.
 *
 * This utility scans those historical days and calls the EXISTING
 * `penaltyEngine.enforceAbsentSubmission` helper for each of them.
 * The helper is idempotent (partial-unique index + duplicate-key
 * catch), so re-runs are safe and produce zero duplicate penalties
 * or audit rows.
 *
 *   - Only fills gaps.  Days that already have a missed_submission
 *     / absent_submission penalty are left untouched.
 *   - Reuses the same creation code path the daily scheduler uses,
 *     so audit rows, notification payloads, and reason strings all
 *     match the automatic pipeline byte-for-byte.
 *   - Bounded lookback window (default 180 days) to keep the first
 *     boot cheap; tunable via COMPLIANCE_BACKFILL_DAYS env var.
 */
const Submission = require('../models/Submission');
const Penalty    = require('../models/Penalty');
const User       = require('../models/User');
const penaltyEngine = require('./penaltyEngine');
const { startOfDay } = require('../utils/dateHelpers');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * runOnce({ lookbackDays, employeeId? }) -- iterate over every
 * unsubmitted historical Submission for the caller-supplied window
 * (default 180 days back) and ensure a missed_submission Penalty
 * exists for each.
 *
 * Returns { scanned, created, skipped, errors[] }.
 */
const runOnce = async ({ lookbackDays, employeeId } = {}) => {
  const days = Math.max(1, Math.min(3650, Number(lookbackDays)
    || Number(process.env.COMPLIANCE_BACKFILL_DAYS) || 180));
  const today   = startOfDay(new Date());
  const cutoff  = new Date(today.getTime() - days * DAY_MS);

  const subWhere = {
    date: { $gte: cutoff, $lt: today },
    submitted: false,
    deleted: { $ne: true },
  };
  if (employeeId) subWhere.employee = employeeId;

  const subs = await Submission.find(subWhere)
    .select('_id employee date templateType')
    .lean();

  // Build a set of (employee, day) tuples that ALREADY have a
  // missed_submission / absent_submission penalty so we skip them
  // quickly.  Uses the same natural key the engine's unique index
  // guards -- one round-trip, no per-row query.
  const empIds = [...new Set(subs.map((s) => String(s.employee)))];
  const dates  = [...new Set(subs.map((s) => new Date(s.date).getTime()))].map((t) => new Date(t));
  const existing = await Penalty.find({
    employee: { $in: empIds },
    category: { $in: ['missed_submission', 'absent_submission'] },
    targetDate: { $in: dates },
    source: 'automatic',
    probable: false,
  }).select('employee targetDate').lean();
  const _key = (e, d) => `${String(e)}|${new Date(d).toISOString().slice(0, 10)}`;
  const have = new Set(existing.map((p) => _key(p.employee, p.targetDate)));

  const result = { scanned: subs.length, created: 0, skipped: 0, errors: [] };
  // Group by (employee, day) so enforceAbsentSubmission is invoked
  // once per tuple even when the employee has multiple templates
  // on the same historical day (the helper itself iterates the
  // template submissions inside).
  const seen = new Set();
  for (const s of subs) {
    const empId = String(s.employee);
    const target = startOfDay(s.date);
    const k = _key(empId, target);
    if (seen.has(k)) continue;
    seen.add(k);
    if (have.has(k)) { result.skipped += 1; continue; }
    try {
      const created = await penaltyEngine.enforceAbsentSubmission({
        employeeId: empId,
        previousDay: target,
      });
      // enforceAbsentSubmission returns an array of created rows.
      // It skips silently when the employee isn't Present that day
      // or when no unsubmitted subs exist -- that's the correct
      // no-op for a legacy row that shouldn't be a penalty.
      if (Array.isArray(created) && created.length > 0) result.created += created.length;
      else result.skipped += 1;
    } catch (e) {
      result.errors.push({ employee: empId, day: target, error: e.message });
    }
  }
  return result;
};

/**
 * Fire-and-forget wrapper used at server boot.  Runs the backfill
 * asynchronously so app startup is never blocked; logs a summary
 * when complete.  Safe to invoke repeatedly (idempotent).
 */
const start = () => {
  setImmediate(async () => {
    try {
      const result = await runOnce();
      console.log(`[missed-submission-backfill] scanned=${result.scanned} `
        + `created=${result.created} skipped=${result.skipped} `
        + `errors=${result.errors.length}`);
    } catch (e) {
      console.error('[missed-submission-backfill] failed:', e.message);
    }
  });
};

module.exports = { runOnce, start };
