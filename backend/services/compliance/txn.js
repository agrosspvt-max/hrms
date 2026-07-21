/**
 * txn.js -- Mongo transaction helper for the compliance engine.
 *
 * Stabilization patch (C2 + C4): the previous implementation had
 * no transactional boundary, so:
 *   - `ledgerService.append` could race two writers on the same
 *     (employee, ledger) and materialise inconsistent balances.
 *   - `actionEngine.apply` could crash between an effect row and
 *     its ledger row, orphaning the effect.
 *
 * This helper wraps a Mongo session + `withTransaction`, falls back
 * to a serial run on standalone Mongo (no replica set support), and
 * makes the mode explicit so downstream code always knows whether
 * atomicity was actually achieved.
 *
 * A boot-time probe (see `_probeCapability`) logs one line telling
 * ops whether transactions are available on their deployment.  On
 * standalone Mongo the fallback path relies on the nightly ledger
 * reconciler to catch drift; that pathway is unchanged.
 */

const mongoose = require('mongoose');

let _txnCapabilityCache = null;      // null (unknown) | true | false
let _probeInflight = null;

/**
 * Ask the server whether transactions are supported.  A single probe
 * per process; the answer is cached.  Never throws.  When called
 * without a live connection it returns `false` so callers gracefully
 * take the serial path.
 */
const _probeCapability = async () => {
  if (_txnCapabilityCache !== null) return _txnCapabilityCache;
  if (_probeInflight) return _probeInflight;
  _probeInflight = (async () => {
    try {
      if (mongoose.connection.readyState !== 1) return false;
      const admin = mongoose.connection.db.admin();
      const info = await admin.command({ hello: 1 }).catch(() => null);
      // Presence of `setName` implies a replica set (and therefore
      // transaction support).  Sharded clusters return `msg:'isdbgrid'`.
      const hasReplicaSet = !!(info && (info.setName || info.msg === 'isdbgrid'));
      return hasReplicaSet;
    } catch (_) { return false; }
  })().then((v) => {
    _txnCapabilityCache = v;
    _probeInflight = null;
    if (v) console.log('[compliance/txn] transactions available (replica set / mongos)');
    else   console.log('[compliance/txn] transactions NOT available (standalone Mongo); relying on reconciler for drift correction');
    return v;
  });
  return _probeInflight;
};

/**
 * Run `fn(session)` inside a Mongo transaction when available; fall
 * back to `fn(null)` on standalone Mongo.  `fn` MUST accept the
 * session and forward it into every write it performs.
 *
 * Returns `{ result, mode }`.  `mode` is one of:
 *   'transaction'  -- ran inside `session.withTransaction`
 *   'serial'       -- ran without a session (standalone Mongo)
 *   'serial-fallback' -- transaction attempted but the server
 *                       refused (e.g. legacy driver); reran serially.
 *
 * Callers that need the raw return value only can ignore `mode` and
 * read `.result`.
 */
const withComplianceTransaction = async (fn) => {
  const canTxn = await _probeCapability();
  if (!canTxn) {
    return { result: await fn(null), mode: 'serial' };
  }
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return { result: out, mode: 'transaction' };
  } catch (e) {
    // Transaction refused (e.g. mongodb-memory-server single-node).
    // Fall back to a serial run so behaviour degrades gracefully.
    if (/Transaction numbers|replica set|does not support|no such command/i.test(String(e.message))) {
      _txnCapabilityCache = false;  // don't keep trying
      return { result: await fn(null), mode: 'serial-fallback' };
    }
    throw e;
  } finally {
    session.endSession();
  }
};

const _resetForTest = () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('txn._resetForTest not allowed in production');
  }
  _txnCapabilityCache = null;
  _probeInflight = null;
};

module.exports = { withComplianceTransaction, _resetForTest };
