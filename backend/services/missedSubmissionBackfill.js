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
 */
module.exports = {};
