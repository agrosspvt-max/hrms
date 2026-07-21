/**
 * ledgerReconciler.js -- nightly integrity check for the four ledgers.
 *
 * For every (employee, ledger), replays the ordered rows and asserts
 * the derived running balance matches the row's `runningBalance`.
 * Discrepancies are logged and (Phase 8) surfaced on the HR
 * Compliance dashboard.  This job never rewrites a row; it only
 * detects drift.
 *
 * Runs at 02:00 local via `start()` in server.js.  Boot catch-up runs
 * once, then a setInterval keeps the daily cadence.  Idempotent --
 * safe to run any number of times per day.
 */

const MarksLedger      = require('../../../models/MarksLedger');
const FinancialLedger  = require('../../../models/FinancialLedger');
const PercentageLedger = require('../../../models/PercentageLedger');
const AttendanceLedger = require('../../../models/AttendanceLedger');
const { isEnabled } = require('../../../config/featureFlags');

const LEDGERS = {
  marks: MarksLedger, financial: FinancialLedger,
  percentage: PercentageLedger, attendance: AttendanceLedger,
};

/**
 * Batch-2 fix #13 -- streaming reconciler.  Previous implementation
 * loaded every ledger row into memory (`Model.find({}).lean()`),
 * which was fine at pilot scale but OOM-prone on a mature deployment.
 * We now iterate a Mongoose cursor and keep only the per-employee
 * "last known balance" map in memory (bounded by number of distinct
 * employees, not total rows).  Drift detection semantics are
 * unchanged.  Drift-list length is capped so a systemic corruption
 * doesn't push all rows into memory either.
 */
const _DRIFT_CAP = Math.max(1, Number(process.env.COMPLIANCE_RECONCILER_DRIFT_CAP) || 500);

const _scan = async (Model) => {
  const perEmp = new Map();
  const drift = [];
  let checked = 0;
  const cursor = Model.find({})
    .sort({ employee: 1, date: 1, createdAt: 1 })
    .lean()
    .cursor();
  try {
    for await (const r of cursor) {
      checked += 1;
      const k = String(r.employee);
      const prev = perEmp.get(k) || 0;
      const expected = prev + Number(r.direction) * Number(r.quantity);
      if (Math.abs(expected - Number(r.runningBalance || 0)) > 1e-6
          && drift.length < _DRIFT_CAP) {
        drift.push({
          rowId: r._id, employee: r.employee, expected,
          recorded: r.runningBalance,
        });
      }
      perEmp.set(k, Number(r.runningBalance));
    }
  } finally {
    // Cursor.close is best-effort -- some drivers auto-close on
    // for-await completion, others need an explicit call.
    try { if (cursor && typeof cursor.close === 'function') await cursor.close(); }
    catch (_) { /* silent */ }
  }
  return { checked, drift, driftTruncated: drift.length >= _DRIFT_CAP };
};

const runOnce = async () => {
  const summary = {};
  for (const [name, Model] of Object.entries(LEDGERS)) {
    try {
      summary[name] = await _scan(Model);
      if (summary[name].drift.length) {
        console.error(`[compliance/reconciler] drift in ${name}:`,
          summary[name].drift.slice(0, 5));
      }
    } catch (e) {
      summary[name] = { error: e.message };
      console.error(`[compliance/reconciler] ${name} scan failed:`, e.message);
    }
  }
  return summary;
};

let _timer = null;
let _kickoff = null;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR = Math.max(0, Math.min(23, Number(process.env.COMPLIANCE_RECONCILER_HOUR) || 2));

const _msUntilNextSlot = (now = new Date()) => {
  const next = new Date(now);
  next.setHours(HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
};

const start = () => {
  if (!isEnabled('compliance.reconciler')) {
    console.log('[compliance/reconciler] skipped (compliance.reconciler flag off)');
    return;
  }
  if (_timer || _kickoff) return;
  // Boot catch-up, non-blocking.
  setImmediate(() => runOnce().catch(() => {}));
  _kickoff = setTimeout(() => {
    runOnce().catch(() => {});
    _timer = setInterval(() => runOnce().catch(() => {}), DAY_MS);
    _kickoff = null;
  }, _msUntilNextSlot());
  console.log(`[compliance/reconciler] started -- daily at ${String(HOUR).padStart(2,'0')}:00 local`);
};

const stop = () => {
  if (_timer)   clearInterval(_timer);
  if (_kickoff) clearTimeout(_kickoff);
  _timer = null; _kickoff = null;
};

module.exports = { runOnce, start, stop };
