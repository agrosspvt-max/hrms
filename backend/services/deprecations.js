/**
 * deprecations.js -- centralised deprecation warnings for the
 * Compliance & Accountability v2 rollout (Phase 10).
 *
 * Every helper here emits at most ONE console warning per process
 * per code + one HTTP `Deprecation` header per response.  Consumers
 * on the way out (legacy `/api/penalties/*` routes, dead `services/
 * penaltyEngine.sweepProbableAbsentSubmission`, the placeholder
 * `services/missedSubmissionBackfill.js`, and the legacy Penalty
 * `manual_marks` / `manual_completion` / `absent_submission`
 * category values) call these helpers so operators see a warning
 * long before the removal PR lands.
 *
 * NOTHING IS REMOVED HERE.  Removal is post-soak.  This file is the
 * marker layer -- flip a switch, watch the warnings, hunt down
 * consumers, then delete in a future release.
 */

const { isEnabled } = require('../config/featureFlags');

// One warning per (code, PID).  Prevents log spam under high volume.
const _seenLog = new Set();

/**
 * Log a one-time console warning tagged with a stable `code` so
 * operators can grep for it.  Silent when `compliance.legacyGone`
 * is off (default) so pre-cutover deployments don't accidentally
 * spam ops.
 */
const warn = (code, message, { forceOn = false } = {}) => {
  if (!forceOn && !isEnabled('compliance.legacyGone')) return;
  if (_seenLog.has(code)) return;
  _seenLog.add(code);
  console.warn(`[deprecated:${code}] ${message}`);
};

/**
 * Stamp an HTTP response with the standardised `Deprecation`
 * header (RFC-drafted) + a `Link` header pointing to the
 * replacement URL.  Idempotent -- calling multiple times per
 * response replaces the header value.
 */
const stampResponse = (res, { code, sunset = '', replacement = '' } = {}) => {
  if (!res || res.headersSent) return;
  res.setHeader('Deprecation', code);
  if (sunset)      res.setHeader('Sunset', sunset);
  if (replacement) res.setHeader('Link', `<${replacement}>; rel="successor-version"`);
};

/** Every deprecation code the project uses.  Keeps ops on one page. */
const CODES = Object.freeze({
  LEGACY_PENALTY_MANUAL:       'legacy.penalty.manual',
  LEGACY_PENALTY_DASHBOARD:    'legacy.penalty.dashboard',
  LEGACY_PENALTY_ROUTES:       'legacy.penalty.routes',
  LEGACY_ENGINE_HELPERS:       'legacy.engine.helpers',
  LEGACY_PROBABLE_SWEEP:       'legacy.probable.sweep',
  LEGACY_MISSED_BACKFILL_STUB: 'legacy.missed_backfill_stub',
  LEGACY_CATEGORY_ABSENT:      'legacy.category.absent_submission',
  LEGACY_CATEGORY_MANUAL_MK:   'legacy.category.manual_marks',
  LEGACY_CATEGORY_MANUAL_CP:   'legacy.category.manual_completion',
});

/** Test-only helper.  Never call in production. */
const _resetForTest = () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('deprecations._resetForTest not allowed in production');
  }
  _seenLog.clear();
};

module.exports = { warn, stampResponse, CODES, _resetForTest };
