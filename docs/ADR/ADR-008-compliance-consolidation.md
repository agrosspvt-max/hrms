# ADR-008 -- Compliance is the single canonical accountability system

Status: **in progress (Phase 4)**.  Legacy `Penalty` is still live; nothing is deleted.

## Decision
Compliance (rule -> ONE incident -> typed effects -> append-only ledger / events) is the
canonical system.  Fines & Penalties is absorbed.  Legacy features move over as effect
types and read projections, each behind its own flag, each proven by a parity suite.

## Rollout states (per read path)
`LEGACY` (flag off, default) -> `COMPLIANCE READ` (flag on) -> later: legacy writers off -> legacy removal.

| Flag | Read path switched | Parity suite |
|---|---|---|
| `compliance.readFinalMarks` | `penaltyMath.attachFinalMarks` (every Final Marks consumer) | `phase4Parity.test.js` (22 scenarios) + `phase4Domain.integration.test.js` |
| `compliance.readCompletion` | completion-% adjustment rows (analytics) | `phase4Parity.test.js` |
| `compliance.readWarnings` | employee warning / penalty card feed (`/compliance/me/accountability`) | `phase4Domain.test.js` |

**Do not flip `readWarnings` and then disable legacy writers**: the card still points the
employee to the legacy reopen flow (see "Blocked").

## Moved to Compliance in Phase 4
effect -> submission link (`submissionId`, `services/compliance/submissionLink.js`);
"zero the day" marks (`submission_earned` strategy, frozen like `penaltyMarks`);
Final Marks + completion projections; warnings view; acknowledgement (on the INCIDENT);
financial effect -> payroll bookkeeping (`payroll.status`, deduct-once, `refundDue`);
manual fines / marks / completion / warning through `POST /api/compliance/incidents`.

## Semantics decisions that need business confirmation
1. Seeded rules now zero the day with `submission_earned` (missed submission, dependency
   pending, performance lock, attendance flip) -- this reproduces the legacy Final Marks.
   The earlier v2 seed charged an average (`last_n_avg`) to the ledger only.
2. Only `completion_adjustment_v2` percent effects change the completion %; the automatic
   rules' percent effects (e.g. dependency 1%/day) stay ledger-only, as in the legacy engine.
3. Legacy manual *marks* penalties carried no submission, so they never reduced Final Marks.
   Compliance manual marks deduct only when HR links a submission.

## 4F -- Re-file (reopen) grant now owned by Compliance (done; legacy still bridged)
`ComplianceRefile` (one open grant per missed-day Submission stub; pending -> approved -> consumed,
or rejected / revoked) answers "may this employee submit this past day?" through ONE service,
`services/compliance/refile/refileEligibility.js`.  Migrated readers: `submissionController`
(getToday list, submitOne gate, consume on submit), `expectedSubmissions.buildReopenIndex`,
`dailyReviewController` (3 indexes + Send Back enrichment), the Submission Review badge
(`penaltyMath.attachFinalMarks` decorates breakdown rows).  BRIDGES (delete with Penalty): the
missed-day marker also counts a legacy active Penalty; an approved legacy `reopenRequest` is still
honoured; an approval carrying an evaluation mode is mirrored onto the legacy Penalty so legacy
Final Marks stay equivalent.  Performance-lock "reopen" is a RECOVERY (mode) decision, already
covered by Compliance recovery, and has no submission gate.

## (historical) BLOCKED -- unrelated HRMS code depends on `Penalty` (stop condition) -- resolved for the re-file gate by 4F
`Penalty.reopenRequest` and missed-submission `Penalty` rows gate the submission feature:
- `controllers/submissionController.js` -- getToday "reopened" list (~l.197); late-submit gate (~l.417)
- `services/expectedSubmissions/index.js` -- `classifySubmissionState` 'reopened', missed lookup (~l.142, 201)
- `controllers/dailyReviewController.js` -- reopen decision shown on reviews (~l.584, 720, 802, 908)
- `services/penaltyEngine.js` -- completes the reopen on re-submission (~l.346)
Also reads of Penalty: `dashboardAlertsController` (active count), `services/timeline.js`.
=> The contest/reopen consolidation (4F) and disabling the legacy writers (4L) need a design
for "who is allowed to re-file a missed day" in Compliance AND changes to the files above.
Not done.  Disabling `penaltyEngine` / the attendance Penalty write today would remove the
missed-day marker the submission gate uses.

## Legacy writers (all still ON)
`penaltyEngine` (runDaily, enforceAbsentSubmission, enforceDependencyPending,
enforcePerformanceLock, resolve hooks), `penaltyController` (manual, cancel, acknowledge,
reopen, waive/resolve-fin, mark-deducted, restoreRange, deadline override),
`attendanceController` (absent->present Penalty), `performanceRecovery`, the performance-lock
shim in `actionEngine` (`compliance.dualWrite` off), `legacyMissedSubmissionArchive`.

## Removal checklist (nothing removed yet) -- callers found by repository search
| Item | Still used by |
|---|---|
| `models/Penalty.js` | everything above, `penaltyMath`, `timeline`, `expectedSubmissions`, `dailyReview`, `submissionController`, `dashboardAlerts` |
| `services/penaltyEngine.js` | server.js, dailyComplianceScheduler, dependencyController, submissionController, pendingStateService, businessStateSync, penaltyController, expectedSubmissions |
| `services/penaltyMath.js` | salaryController, analyticsController, submissionController, submissionControlController, penaltyController (kept as the dispatcher while flags exist) |
| `controllers/penaltyController.js`, `/api/penalties` | `FinesPenalties.jsx`, `EmployeeDashboard.jsx` (feed unless readWarnings), HR pages |
| `FinesPenalties.jsx` | App.jsx route `/penalties`, sidebar |
| `services/compliance/legacyMirror.js` | incidentService, waiverService, recoveryService |
| performance-lock shim / `compliance.dualWrite` | actionEngine, executors |
| `services/penalty/service.js` | no importers found (dead facade) -- still verify before deleting |
| `services/performanceRecovery.js` | penaltyController (reopen decision), penaltyMath |
| `compliance.readShim`, `penaltyProjectionService`, backfill job | backfill script only (manual) |

## Not implemented in Phase 4
4F contest/reopen consolidation; 4L disabling legacy writers; 4N removal; HR workspace
consolidation (payroll-pending panel in the salary screen, marks/completion forms in
`CreateIncidentModal`); employee single-page consolidation beyond the flag-driven card.
