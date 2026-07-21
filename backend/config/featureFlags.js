/**
 * featureFlags.js -- lightweight flag store for the Compliance &
 * Accountability rollout.
 *
 * Every flag is env-var backed with an explicit default.  Flags are
 * READ-ONLY at runtime -- flipping a flag requires a process restart,
 * which matches how the existing MISSED_SUBMISSION_EFFECTIVE_FROM +
 * COMPLIANCE_SCHED_HOUR knobs already work.  No hot-reload, no admin
 * UI -- ops toggles via the environment.
 *
 * Naming convention: dot-separated `<domain>.<capability>`.  Env-var
 * form uppercases and replaces dots with underscores, e.g.
 *   compliance.newEngine   ->  COMPLIANCE_NEW_ENGINE
 *
 * Consumers MUST route through `isEnabled(name)` so a future runtime
 * store can drop in without touching call sites.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Flag defaults.  Each entry is `{name: bool}`; when the env var is
 * unset the default applies.  Anything not declared here is treated
 * as `false`.  Declaring the flag here is the contract that lets
 * `list()` (below) return every known flag for the boot banner and
 * docs.
 */
const DEFAULTS = Object.freeze({
  // Phase 1 -- boot banner + registries wired but idle.
  'compliance.scaffold': true,
  // Phase 2 -- new schemas loaded.  Metadata only; no consumer yet.
  'compliance.schemas': true,
  // Phase 3 -- Rule CRUD + seeder.  Rules seed disabled=true regardless.
  'compliance.rules': false,
  // Phase 4 -- detectors + IncidentService write incidents.
  'compliance.newEngine': false,
  // Phase 5 -- executors + ledger writes.
  'compliance.actionEngine': false,
  // Phase 6 -- waiver/recovery/timeline/escalation + reconciler.
  'compliance.waiverRecovery': false,
  'compliance.reconciler': false,
  // Phase 7 -- new employee UI.
  'compliance.employeeCardV2': false,
  // Phase 8 -- new HR dashboard.
  'compliance.dashboardV2': false,
  // Phase 9 -- read shim + optional backfill + dual-write cutover.
  'compliance.readShim': false,
  'compliance.dualWrite': false,
  'compliance.legacyBackfill': false,
  // Phase 10 -- final cleanup lock.
  'compliance.legacyGone': false,
});

// Convert dot.camelCase -> UPPER_SNAKE_CASE so `compliance.newEngine`
// resolves against COMPLIANCE_NEW_ENGINE, matching the docblock above.
const _envKey = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')  // insert _ between camelCase transitions
    .replace(/\./g, '_')
    .toUpperCase();

const _readOnce = (name) => {
  const raw = process.env[_envKey(name)];
  if (raw === undefined || raw === '') return DEFAULTS[name] ?? false;
  return TRUTHY.has(String(raw).trim().toLowerCase());
};

// One-shot resolution.  Repeated calls in the hot path (per-request)
// hit this cache instead of `process.env`.
const _cache = new Map();
const _resolve = (name) => {
  if (!_cache.has(name)) _cache.set(name, _readOnce(name));
  return _cache.get(name);
};

/**
 * Fast test used everywhere in application code.  Accepts an optional
 * `{user}` for future per-user overrides (Phase 7 progressive rollout);
 * user-level overrides fall through to the flag default until Phase 7
 * introduces the per-user check.
 */
const isEnabled = (name /* , { user } = {} */) => {
  if (!name) return false;
  return _resolve(name);
};

/** Return every known flag + its current resolved value.  Used by the
 *  boot banner and by docs generation. */
const snapshot = () => {
  const out = {};
  for (const name of Object.keys(DEFAULTS)) out[name] = _resolve(name);
  return out;
};

/** Test-only reset (throws in production so no runtime consumer can
 *  accidentally use it). */
const _resetForTest = () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('featureFlags._resetForTest is not allowed in production');
  }
  _cache.clear();
};

module.exports = {
  isEnabled,
  snapshot,
  DEFAULTS,
  _resetForTest,
};
