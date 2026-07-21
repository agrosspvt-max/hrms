/**
 * detectorRegistry.js -- pluggable rule detectors.
 *
 * A detector is:
 *
 *   detectorFn({ rule, employee, day, ctx }) -> Promise<Array<Candidate>>
 *
 *   Candidate = {
 *     naturalKey,     // idempotency key -- see services/compliance/naturalKey.js
 *     incidentDate,   // Date (UTC midnight) when the violation happened
 *     context,        // small scalar snapshot for the audit trail
 *     detectorMeta,   // free-form; anything the rule wants to persist
 *   }
 *
 * Detectors NEVER touch the DB directly -- they emit candidate
 * descriptors that IncidentService (Phase 4) upserts.  This lets the
 * registry drive tests without a Mongo connection.
 *
 * Registration is one-shot per code.  Re-registering the same code
 * throws -- silent overwrite would defeat the point of the registry.
 */

const _registry = new Map();

const register = (code, fn) => {
  if (!code || typeof code !== 'string') {
    throw new TypeError('detectorRegistry.register: `code` must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`detectorRegistry.register(${code}): fn must be a function`);
  }
  if (_registry.has(code)) {
    throw new Error(`detectorRegistry: detector "${code}" already registered`);
  }
  _registry.set(code, fn);
};

const get = (code) => _registry.get(code) || null;

const list = () => [..._registry.keys()].sort();

const _resetForTest = () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('detectorRegistry._resetForTest is not allowed in production');
  }
  _registry.clear();
};

module.exports = { register, get, list, _resetForTest };
