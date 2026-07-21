/**
 * Placeholder file (was: legacy missed-submission backfill utility).
 *
 * The legacy compatibility layer has been removed.  There is now a
 * single implementation path: the daily compliance scheduler is the
 * ONLY source of missed_submission penalties.  Historical submissions
 * that pre-dated the penalty system remain read-only historical
 * records with no Send Back workflow.
 *
 * This file is retained empty because Node's require cache may have
 * held a reference during the cleanup; the module exports nothing so
 * any stray consumer fails loudly rather than silently succeeding.
 *
 * @deprecated Phase 10 -- superseded by
 *   `services/compliance/backfill/backfillJob.js` (dry-run + commit
 *   + rollback).  Removal is pending the post-soak cleanup PR.
 *   `services/deprecations` emits a one-time warning on load.
 */
try {
  const dep = require('./deprecations');
  dep.warn(dep.CODES.LEGACY_MISSED_BACKFILL_STUB,
    'services/missedSubmissionBackfill.js is deprecated; ' +
    'use services/compliance/backfill/backfillJob.js instead. ' +
    'Scheduled for removal after the compliance.legacyGone soak window.');
} catch (_) { /* deprecations module optional during boot ordering */ }

module.exports = {};
