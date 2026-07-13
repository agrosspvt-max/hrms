/**
 * dailyComplianceScheduler.js
 *
 * Phase 64.4 Gap 1 -- system-driven engine.  The compliance engine
 * ran only when an employee opened their own dashboard; HR could
 * not see Missed Submissions / Performance Locks until the
 * employee logged in.
 *
 * This scheduler runs the EXISTING `penaltyEngine.runDaily` for
 * every active employee once per calendar day, at server boot and
 * every 24 hours thereafter.  It DOES NOT introduce any new
 * business logic -- it just re-invokes the same helper that was
 * already the single source of truth.
 *
 * Idempotency guarantees (already in penaltyEngine.js):
 *   - Partial unique index on (employee, category, targetDate,
 *     submission) for automatic + non-probable rows.
 *   - `_upsertAutoPenalty` catches duplicate-key errors.
 *   - Audit rows are only written on FIRST insert.
 * As a result, running the sweep multiple times per day (e.g. on
 * a server restart) never produces duplicate penalties, duplicate
 * audit rows, or duplicate realtime events.
 */
const penaltyEngine = require('./penaltyEngine');
const User = require('../models/User');

const DAY_MS = 24 * 60 * 60 * 1000;
let _timerId = null;
let _kickoffTimerId = null;
let _lastRunKey = null;

/**
 * Local time-of-day the daily sweep should fire.  Chosen to be
 * shortly after midnight so all "yesterday" penalties for the org's
 * timezone are materialised before the morning workday begins.
 * Set via env for ops flexibility; defaults to 00:15 local.
 */
const SCHEDULED_HOUR = Math.max(0, Math.min(23, Number(process.env.COMPLIANCE_SCHED_HOUR) || 0));
const SCHEDULED_MIN  = Math.max(0, Math.min(59, Number(process.env.COMPLIANCE_SCHED_MIN)  || 15));

const _dayKey = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

/** Milliseconds from `now` to the next occurrence of HH:MM local. */
const _msUntilNextSlot = (now = new Date()) => {
  const next = new Date(now);
  next.setHours(SCHEDULED_HOUR, SCHEDULED_MIN, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
};

const _runOnceForAll = async () => {
  const startedAt = new Date();
  const dayKey = _dayKey(startedAt);
  if (_lastRunKey === dayKey) return { skipped: true, reason: 'already ran today' };

  try {
    // Scope: every active employee.  HR / Super Admin accounts are
    // included because they can also carry pending tasks / assignments.
    const employees = await User.find({ status: 'active' })
      .select('_id')
      .lean();
    let ok = 0;
    let failed = 0;
    for (const e of employees) {
      try {
        await penaltyEngine.runDaily({ employeeId: e._id, day: startedAt });
        ok += 1;
      } catch (err) {
        failed += 1;
        console.error('[compliance-scheduler] runDaily failed for',
          String(e._id), '-', err.message);
      }
    }
    _lastRunKey = dayKey;
    console.log(`[compliance-scheduler] daily sweep complete ` +
      `(${ok} ok, ${failed} failed) for ${dayKey}`);
    return { ok, failed, dayKey };
  } catch (err) {
    console.error('[compliance-scheduler] sweep aborted:', err.message);
    return { error: err.message };
  }
};

/**
 * Start the scheduler.  Called ONCE from server.js after Mongo is
 * connected.
 *
 * Phase 64.5 hardening -- swap the fixed 24h-from-boot interval for
 * a scheduler pinned to a local-time slot (default 00:15).
 *
 *   1. Boot catch-up: fires an immediate sweep so that a server
 *      restart during the day still surfaces yesterday's penalties.
 *   2. `setTimeout` waits until the next HH:MM local, fires a sweep,
 *      then a 24h `setInterval` keeps the daily cadence going.
 *
 * The internal `_lastRunKey` (ISO day) guarantees at-most-one run
 * per calendar day even if the timers overlap on a DST switch or
 * a restart within the same minute.  Individual penaltyEngine
 * writes are also idempotent (Phase 61 partial-unique indexes) so
 * a duplicate call produces zero duplicate rows anyway.
 */
const start = () => {
  if (_timerId || _kickoffTimerId) return; // already started
  // Boot catch-up.  Non-blocking.
  setImmediate(() => _runOnceForAll().catch(() => {}));
  // Wait until the next scheduled slot (e.g. 00:15 local), fire
  // once, then keep a 24h cadence from that anchor.
  const delay = _msUntilNextSlot();
  _kickoffTimerId = setTimeout(() => {
    _runOnceForAll().catch(() => {});
    _timerId = setInterval(() => {
      _runOnceForAll().catch(() => {});
    }, DAY_MS);
    _kickoffTimerId = null;
  }, delay);
  console.log(`[compliance-scheduler] started -- boot catch-up + daily at ${String(SCHEDULED_HOUR).padStart(2,'0')}:${String(SCHEDULED_MIN).padStart(2,'0')} local`);
};

/** Stop the scheduler (used only by tests). */
const stop = () => {
  if (_timerId) clearInterval(_timerId);
  if (_kickoffTimerId) clearTimeout(_kickoffTimerId);
  _timerId = null;
  _kickoffTimerId = null;
  _lastRunKey = null;
};

module.exports = {
  start,
  stop,
  // Exposed for manual invocation from routes / tests.
  runOnceForAll: _runOnceForAll,
};
