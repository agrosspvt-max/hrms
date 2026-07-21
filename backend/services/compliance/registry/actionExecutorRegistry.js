/**
 * actionExecutorRegistry.js -- pluggable action executors.
 *
 * One executor per ComplianceRule.actions[].type.
 *
 *   executorFn({ rule, actionConfig, incident, session? })
 *     -> Promise< { effect, ledgerRefs } >
 *
 * The engine (Phase 5) iterates every enabled action on a promoted
 * incident, calls the matching executor, persists the returned
 * ComplianceActionEffect + ledger rows.  Executors NEVER call the
 * ledger services directly -- they return the intent; the engine
 * writes.  This keeps executors small and unit-testable without any
 * DB dependency.
 *
 * Registration is one-shot per action type; re-registering throws.
 */

const _registry = new Map();

const register = (type, fn) => {
  if (!type || typeof type !== 'string') {
    throw new TypeError('actionExecutorRegistry.register: `type` must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`actionExecutorRegistry.register(${type}): fn must be a function`);
  }
  if (_registry.has(type)) {
    throw new Error(`actionExecutorRegistry: executor "${type}" already registered`);
  }
  _registry.set(type, fn);
};

const get = (type) => _registry.get(type) || null;

const list = () => [..._registry.keys()].sort();

const _resetForTest = () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('actionExecutorRegistry._resetForTest is not allowed in production');
  }
  _registry.clear();
};

module.exports = { register, get, list, _resetForTest };
