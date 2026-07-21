# Compliance & Accountability v2 — Cleanup Runbook (Phase 10)

Deprecation markers are live.  Code is NOT removed yet -- removal
happens after the post-soak cleanup PR, in the order below.

## Prerequisite

`compliance.legacyGone` flag has been on in production for **at
least 30 days** with zero rollbacks and:

- Zero Deprecation-header hits on `/api/penalties/*` for the last
  30 days.
- Zero `[deprecated:*]` warnings in production logs.
- HR + Employee dashboards read `/api/compliance/*` exclusively.
- Every seeded rule has been enabled for 30+ days.
- The `compliance.dualWrite` flag has been ON (mirror-write off)
  for the same window.

## Cleanup PR checklist

Perform each step in a separate commit for clean revert history.

1. **Remove dead engine surface**
   * Delete `sweepProbableAbsentSubmission` and `runProbablesForToday`
     from `backend/services/penaltyEngine.js`.
   * Update `module.exports` accordingly.
   * Update any test fixtures.

2. **Delete `services/missedSubmissionBackfill.js`**
   * Remove the placeholder file and its deprecation-warning
     require.  Confirm zero references remain via
     `grep -rn missedSubmissionBackfill backend`.

3. **Retire legacy `/api/penalties/manual`**
   * Convert `createManual` to a 410 Gone response body pointing at
     `/api/compliance/incidents`.  Keep the route mounted for one
     more release so third-party integrations discover the change.

4. **Retire legacy `/api/penalties/dashboard`**
   * Convert to a compatibility shim that internally calls the
     compliance controllers.  Response shape unchanged for one
     release, then deleted in the next.

5. **Retire legacy Penalty category values**
   * Only after a separate migration renames every historical row
     (`absent_submission -> missed_submission`, etc.), drop the
     enum values from `models/Penalty.js`.
   * Keep the `attendance_manual`, `critical_threshold`,
     `repeated_missing`, `financial_penalty` and v2-named values.

6. **Retire the deprecations helper**
   * Delete `services/deprecations.js` once every consumer has been
     rewritten.

## Rollback

Every step in the cleanup PR must be independently revertible.  Do
NOT combine steps into one commit.  If a customer reports breakage
after the release, revert only the offending commit; the rest of
the cleanup stays in place.

## Post-cleanup verification

- Run `phase1..phase9.test.js` suites; every one must still pass.
- Run the mongodb-memory-server integration suite in CI.
- Watch dashboards for 7 days before removing the compatibility
  shim at `/api/penalties/dashboard`.
