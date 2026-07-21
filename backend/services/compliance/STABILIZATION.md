# Compliance v2 — Stabilization Patch Notes

Fixes for the seven Priority-1 critical issues from the first
production readiness review.  Every change is behind the existing
compliance feature flags; no new runtime behaviour when flags are off.

Regression suite: `services/compliance/__tests__/stabilization.test.js`
(seven assertions).  Every pre-patch suite (`phase1..phase10`) still
passes unmodified.

| ID | Symptom | Fix location |
|----|---------|--------------|
| C1 | Non-recurring actions re-fire on every subsequent tick, accumulating ledger debits every day forever. | `services/compliance/actions/actionEngine.js` (`recurringOnly` opt) + `scheduler/ruleEvaluationScheduler.js` (`_runRecurring`) |
| C2 | Ledger `runningBalance` race between concurrent writers on the same `(employee, ledger)`. | `services/compliance/ledger/ledgerService.js` + new `services/compliance/txn.js` |
| C3 | `promoteToActive` read-then-write race → duplicate `incident_effective` events. | `services/compliance/incidents/incidentService.js` |
| C4 | Effect insert + ledger appends not atomic → orphan effect on crash. | `services/compliance/actions/actionEngine.js` (wrapped in `withComplianceTransaction`) |
| C5 | `departmentAvg` strategy always returned 0 because detectors never populated `context.departmentId`. | `services/compliance/marks/strategies.js` (User fallback) + all three built-in detectors (`context.departmentId + designationId`). |
| C6 | `financialFine` `criticalAmount` branch never fired because no detector set `detectorMeta.criticalTask`. | `services/compliance/detectors/dependencyDetector.js`, `services/compliance/detectors/performanceLockDetector.js`. |
| C7 | Detection loop O(N employees) sequential — unacceptable at >1000 employees. | `services/compliance/scheduler/ruleEvaluationScheduler.js` (`_pMap` + `_preloadEmployees`). |

## C1 — Recurring-only apply

**Contract change:** `actionEngine.apply({incident, day, recurringOnly})` now
accepts an optional third field.  When `recurringOnly:true`, actions
without `config.recurring === true` are skipped.  The scheduler's
`_runRecurring` pass sets this flag; the promotion pass and manual
callers do not, preserving day-1 semantics.

**Backward compatibility:** every existing caller (`_runPromotion`,
Phase 8 controllers, backfill) either omits `recurringOnly` (defaults
to false → identical behaviour) or explicitly passes true.  Phase-5
tests continue to pass because Day-1 apply is unchanged.

**Feature-flag behaviour:** `_runRecurring` is only reached when
`compliance.actionEngine` is on; the fix therefore only takes effect
inside the already-gated pass.

## C2 — Ledger atomicity

**Contract change:** `ledgerService.append({..., session})` now accepts
an optional Mongo session.  When passed, the read of the last row and
the insert of the new row participate in the same session; on
replica-set Mongo this closes the race.

**Standalone-Mongo fallback:** `withComplianceTransaction` probes the
server once at first call (`{hello:1}` command) and caches the result.
On standalone Mongo it runs `fn(null)` serially and logs a one-line
warning at boot.  The nightly reconciler catches drift within 24 hours
on those deployments — this is the same safety net that already
existed pre-patch.

**Backward compatibility:** callers that omit `session` behave exactly
as before.

## C3 — Atomic promotion

**Contract change:** `incidentService.promoteToActive(incidentId,{now})`
now uses `findOneAndUpdate` with a `{status:'candidate',
effectiveDate:{$lte:now}}` predicate.  Only one caller wins; losers
receive `null` and return without emitting.

**Backward compatibility:** the return shape is unchanged — winner
gets the updated doc, loser gets `null`.  Every caller (`_runPromotion`)
already handled the `null` path.

## C4 — Effect + ledger atomic

**Contract change:** `actionEngine.apply` wraps the effect create +
ledger appends + effect back-reference save in
`withComplianceTransaction`.  On transactional Mongo a crash mid-write
rolls back; on standalone Mongo behaviour degrades to the pre-patch
sequence (still with idempotent partial-unique indexes and the
reconciler as safety net).

**Backward compatibility:** identical inputs, identical outputs.  The
`txnErr / alreadyExisted` local variables replace the previous try/catch
chain; the returned `{effects, errors}` shape is unchanged.

## C5 — departmentAvg wired

**Two-part fix:**
1. `strategies.departmentAvg` now falls back to
   `User.findById(employee._id).select('department')` when
   `employee.department` is absent.  Returns 0 only when the employee
   truly has no department.
2. All three built-in detectors now populate `context.departmentId`
   and `context.designationId` so the strategy hits the fast path.

**Backward compatibility:** existing rules and existing incidents are
unaffected.  Incidents created before the patch have no
`context.departmentId`; the strategy's fallback query handles them.

## C6 — Critical-task flag stamped

Detectors now stamp `detectorMeta.criticalTask` based on the
underlying data:

* `dependencyDetector` -- `overdue.some((d) => d.isCritical === true)`
* `performanceLockDetector` -- `overdue.some((o) => o.isCritical)` plus
  the oldest task's `isCritical` inside `detectorMeta.oldest`.

`missedSubmissionDetector` deliberately does NOT stamp the flag —
Submission stubs don't carry per-day criticality; the feature is
scoped to tasks/dependencies where the source has the flag.

**Backward compatibility:** the `financialFine` executor's
`criticalAmount` branch has always been present; it just never fired.
Now it does.  Rules that don't set `criticalAmount` continue to use
the base `amount` value.

## C7 — Parallel detection loop

**Two changes:**
1. Preload every in-scope employee once per rule via a single bulk
   `User.find({_id:{$in}})`.
2. Fan detectors out with bounded concurrency (`_pMap`) using a pool
   size of `COMPLIANCE_TICK_CONCURRENCY` (default 32).

**Backward compatibility:** deterministic — every employee still gets
one detector invocation per rule per tick.  Only the wall-clock time
changes.

**Feature-flag behaviour:** unchanged; `tick()` still only runs when
`compliance.newEngine` is on.

## Feature-flag matrix after the patch

| Flag | Fix rides on it | New behaviour when off |
|------|:---:|-----------------------|
| `compliance.scaffold`     | — | boot banner suppressed |
| `compliance.newEngine`    | C1, C3, C5, C6, C7 | tick never runs; fixes are dormant |
| `compliance.actionEngine` | C1, C4 | no action apply; no ledger writes |
| `compliance.waiverRecovery` | — | Phase-6 endpoints 404 |
| `compliance.reconciler`   | — | nightly job silent |

Every fix is a strict overlay on the already-gated write paths.
`compliance.newEngine=false` in production means production runs the
legacy engine only, byte-identically to pre-patch.

## Pending Production Validation (unchanged from prior report)

- Real MongoDB replica-set integration test for C2 + C4 transaction
  semantics (`phase4.integration.test.js` was written but cannot run
  in this sandbox's network policy).
- Load test the parallel detection loop at 5k+ employees.
- Verify boot log line `[compliance/txn] transactions available` on
  staging (replica set) and `[compliance/txn] transactions NOT
  available` on any dev standalone Mongo.
