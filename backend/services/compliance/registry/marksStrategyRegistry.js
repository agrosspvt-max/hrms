/**
 * marksStrategyRegistry.js -- pluggable "how many marks does this
 * action deduct?" strategies.
 *
 *   strategyFn({ employee, submission, template, day, config })
 *     -> Promise<number>       // clamped >= 0
 *
 * Strategies live behind a chain-of-responsibility dispatcher
 * (services/compliance/marks/computeMarksStrategy.js, Phase 5) so an
 * unrecognised code falls back to `admin_defined` (config-fixed)
 * before returning 0.
 */

const _registry = new Map();

const register = (code, fn) => {
  if (!code || typeof code !== 'string') {
    throw new TypeError('marksStrategyRegistry.register: `code` must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`marksStrategyRegistry.register(${code}): fn must be a function`);
  }
  if (_registry.has(code)) {
    throw new Error(`marksStrategyRegistry: strategy "${code}" already registered`);
  }
  _registry.set(code, fn);
};

const get = (code) => _registry.get(code) || null;

const list = () => [..._registry.keys()].sort();

const _resetForTest = () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('marksStrategyRegistry._resetForTest is not allowed in production');
  }
  _registry.clear();
};

module.exports = { register, get, list, _resetForTest };
