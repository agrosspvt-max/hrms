/**
 * probation.js  --  Phase 62 Employee Probation Period.
 *
 * Every read path (dashboard, HR profile, leave apply) routes through
 * these pure helpers so the "am I on probation?" decision is derived
 * in exactly one place.  No mutation, no side-effects.
 *
 * Defaults, per spec:
 *   enabled   = true
 *   startDate = user.joiningDate
 *   endDate   = startDate + 4 months
 *
 * These defaults are computed AT READ TIME so legacy users (who never
 * had a probation sub-document) automatically materialise the same
 * window every request without a data migration.
 */
const LeaveConfig = require('../models/LeaveConfig');

const DEFAULT_DURATION_MONTHS = 4;

/**
 * Return the probation sub-document with all fields resolved.  Never
 * mutates the User doc.
 *
 * @param {Object} user  A hydrated User doc OR a .lean() plain object.
 * @returns {{ enabled: boolean, startDate: Date|null, endDate: Date|null }}
 */
const getProbationWindow = (user) => {
  if (!user) return { enabled: false, startDate: null, endDate: null };
  const p = user.probation || {};
  const enabled = p.enabled === undefined ? true : !!p.enabled;
  // startDate: explicit override OR user's joining date.
  const startDate = p.startDate ? new Date(p.startDate)
                : user.joiningDate ? new Date(user.joiningDate) : null;
  // endDate: explicit override OR startDate + 4 months.
  let endDate = p.endDate ? new Date(p.endDate) : null;
  if (!endDate && startDate) {
    endDate = new Date(startDate.getTime());
    endDate.setMonth(endDate.getMonth() + DEFAULT_DURATION_MONTHS);
  }
  return { enabled, startDate, endDate };
};

/**
 * Is the user currently inside their probation window?
 *   - Probation must be enabled
 *   - startDate <= asOf < endDate
 *
 * `asOf` defaults to now.  Uses inclusive-start / exclusive-end so
 * the last day of probation still shows as "on probation".
 */
const isOnProbation = (user, asOf = new Date()) => {
  const { enabled, startDate, endDate } = getProbationWindow(user);
  if (!enabled || !startDate || !endDate) return false;
  const t = asOf.getTime();
  return t >= startDate.getTime() && t < endDate.getTime();
};

/**
 * Days remaining until probation ends, minimum 0.
 */
const daysRemaining = (user, asOf = new Date()) => {
  const { endDate } = getProbationWindow(user);
  if (!endDate) return 0;
  const ms = endDate.getTime() - asOf.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
};

/**
 * Fetch the org-wide list of leave types restricted during
 * probation.  Cached briefly to save round-trips during a burst
 * of leave applications.  On cache miss falls back to ['paid'].
 */
let _cachedTypes = null;
let _cachedAt = 0;
const CACHE_MS = 30 * 1000;

const getRestrictedTypes = async () => {
  const now = Date.now();
  if (_cachedTypes && (now - _cachedAt) < CACHE_MS) return _cachedTypes;
  try {
    const cfg = await LeaveConfig.findOne({ singleton: true }).lean();
    _cachedTypes = Array.isArray(cfg?.restrictedDuringProbation) && cfg.restrictedDuringProbation.length
      ? cfg.restrictedDuringProbation
      : ['paid'];
  } catch (_) {
    _cachedTypes = ['paid'];
  }
  _cachedAt = now;
  return _cachedTypes;
};

/** Force-drop the cache after the HR admin saves new config. */
const invalidateRestrictedTypesCache = () => {
  _cachedTypes = null;
  _cachedAt = 0;
};

/**
 * Format the human-readable date used in the spec's error message:
 *   "You are currently under probation until DD/MM/YYYY."
 */
const formatEndDate = (d) => {
  if (!d) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
};

/**
 * "active" while inside the window, "completed" after, "disabled"
 * when the feature is turned off for this employee.
 */
const probationStatus = (user, asOf = new Date()) => {
  const { enabled, startDate, endDate } = getProbationWindow(user);
  if (!enabled)        return 'disabled';
  if (!startDate || !endDate) return 'disabled';
  const t = asOf.getTime();
  if (t < startDate.getTime()) return 'scheduled';
  if (t >= endDate.getTime())  return 'completed';
  return 'active';
};

module.exports = {
  DEFAULT_DURATION_MONTHS,
  getProbationWindow,
  isOnProbation,
  daysRemaining,
  getRestrictedTypes,
  invalidateRestrictedTypesCache,
  formatEndDate,
  probationStatus,
};
