# Compliance & Accountability (v2)

Backend engine for the redesigned Fines & Penalties system.  Loads as
a scaffold from the moment `services/compliance` is imported; every
behaviour beyond loading is gated by a per-phase feature flag so this
folder is a no-op on production until the phases are explicitly
enabled.

## Feature flags

Declared in `backend/config/featureFlags.js`.

| Flag                          | Default | Phase | Purpose                                              |
|-------------------------------|:-------:|:-----:|------------------------------------------------------|
| `compliance.scaffold`         | on      |  1    | Boot banner + registries loaded (this file).         |
| `compliance.schemas`          | on      |  2    | New models registered.  No consumer yet.             |
| `compliance.rules`            | off     |  3    | Rule CRUD + seeder + editor.                         |
| `compliance.newEngine`        | off     |  4    | Detectors + IncidentService write incidents.         |
| `compliance.actionEngine`     | off     |  5    | Executors + ledger writes.                           |
| `compliance.waiverRecovery`   | off     |  6    | Waiver + recovery + timeline + escalation.           |
| `compliance.reconciler`       | off     |  6    | Nightly ledger drift check.                          |
| `compliance.employeeCardV2`   | off     |  7    | Employee Compliance Card + My Compliance page.       |
| `compliance.dashboardV2`      | off     |  8    | HR Compliance Dashboard.                             |
| `compliance.readShim`         | off     |  9    | Legacy Penalty rows projected as synthetic incidents.|
| `compliance.dualWrite`        | off     |  9    | Executors stop writing legacy Penalty mirror rows.   |
| `compliance.legacyBackfill`   | off     |  9    | Batch backfill historical Penalty -> Incident.       |
| `compliance.legacyGone`       | off     | 10    | Deprecation: `POST /penalties/manual` returns 410.   |

Env-var form: uppercase, `.` and camelCase transitions become `_`.
`compliance.newEngine` -> `COMPLIANCE_NEW_ENGINE`.  Truthy values:
`1 | true | yes | on` (case-insensitive).

## Registries

Three pluggable registries feed the engine:

* `registry/detectorRegistry.js` -- rule detectors.
* `registry/actionExecutorRegistry.js` -- action executors.
* `registry/marksStrategyRegistry.js` -- "how many marks does this
  action deduct?" strategies.

Every registry uses one-shot registration (re-registering a code
throws) and exposes `register(code, fn)`, `get(code)`, `list()`.

## Idempotency

`naturalKey.js` builds the string used by
`ComplianceIncident.naturalKey` (partial-unique on
`{source:'automatic'}`).  A detector that re-fires for the same
violation naturally short-circuits at the DB.  Format:

    <ruleCode>|<empId>|<isoDay>|<optional scalar>

## Event bus

The v2 engine emits event codes registered in
`services/events/registry.js` under the `compliance.*` namespace:

* `compliance.incident_created`
* `compliance.incident_effective`
* `compliance.action_applied`
* `compliance.notification_sent`
* `compliance.waiver_requested`
* `compliance.waiver_decided`
* `compliance.recovery_applied`
* `compliance.incident_resolved`
* `compliance.incident_cancelled`
* `compliance.escalated`
* `compliance.rule_updated`

Notification / timeline / realtime flags follow the same shape as
the legacy `penalty.*` codes.

## Testing

    cd backend
    node services/compliance/__tests__/phase1.test.js
    node services/compliance/__tests__/phase2.test.js
    node services/compliance/__tests__/phase3.test.js

The suite runs on plain Node with the built-in `assert` module; no
Jest / Mocha dependency.  Add new `phase<N>.test.js` files alongside
this one; each phase's suite must pass before the phase ships.

## Phase 4 engine

Layers landed:

* `scope.js` — resolves `rule.scope` -> User id set.
* `incidents/incidentService.js` — `recordIncident` / `promoteToActive` /
  `resolveIncident` / `cancelIncident`.  Idempotent via natural key +
  E11000 catch.  Emits `ComplianceEvent` rows and `AuditLog` entries.
* `detectors/*.js` — three built-in detectors + a `manual` no-op.  All
  are pure DB-read functions that emit candidate descriptors.
* `scheduler/ruleEvaluationScheduler.js` — `tick(day)` iterates every
  enabled rule, resolves scope, dispatches detectors, upserts incidents,
  promotes candidates whose `effectiveDate` has arrived.
* `dailyComplianceScheduler` — same boot-catch-up + 00:15 local loop
  now calls `tick(day)` when `compliance.newEngine` is on.  The legacy
  `penaltyEngine.runDaily` path is untouched -- writes to Penalty
  continue exactly as before.

### Feature-flag behaviour

* `compliance.newEngine` off (default): `tick` is never called; every
  request path is a no-op; Penalty rows continue to be written by the
  legacy engine.
* `compliance.newEngine` on: `tick` runs AFTER the legacy sweep, in the
  same daily job.  Both stores accrue rows for the same incidents (dual
  observation).  Ledger writes and action execution are still gated by
  `compliance.actionEngine` (Phase 5).

### Testing

    node services/compliance/__tests__/phase4.test.js

The Phase 4 unit suite covers detector output, idempotency, promotion,
resolve/cancel, scheduler orchestration, and backward-compat surface
using a lightweight in-memory adapter (`_stubMongo.js`).

    node services/compliance/__tests__/phase4.integration.test.js

The integration variant seeds fixtures against `mongodb-memory-server`
and exercises the exact partial-unique index at the DB layer.  It
requires a downloadable mongod binary and does NOT run in
network-restricted environments; use a dev machine or CI runner with
external access.

## Phase 5 action engine

Layers landed:

* `marks/strategies.js` -- four built-in strategies
  (`last_n_avg`, `template_default`, `department_avg`, `admin_defined`)
  plus a `compute()` dispatcher that walks the fallback chain until it
  produces a non-zero number.
* `actions/executors/index.js` -- twelve built-in executors
  (`zero_daily_marks`, `add_daily_total`, `fixed_marks_reduction`,
  `percent_reduction`, `financial_fine`, `half_day_lwp`, `full_day_lwp`,
  `warning`, `notification`, `manager_notification`, `performance_lock`,
  `suspend_incentive`, `custom`).  Executors are pure -- they return
  an intent (`effectDoc` + `ledgerAppends` + optional `legacyPenalty`);
  the engine handles persistence.
* `ledger/ledgerService.js` -- append-only writer with materialised
  `runningBalance`.  Serves all four ledgers via a single API.
* `actions/actionEngine.js` -- given a promoted incident, walks every
  enabled action on the rule, calls the executor, persists the
  `ComplianceActionEffect`, appends ledger rows, emits
  `compliance.action_applied` events, and mirror-writes the legacy
  `Penalty` row for `performance_lock` (BC shim, gated by
  `compliance.dualWrite`).
* `scheduler/ruleEvaluationScheduler.js` -- tick() now runs three
  passes: detection (Phase 4), promotion + first action apply
  (Phase 5), and recurring re-apply for still-active incidents.

### Recurring actions

An action with `config.recurring: true` re-fires on every subsequent
`tick(day)` for as long as the incident stays `active`.  Each daily
re-apply gets its own `ComplianceActionEffect` (unique per
`{incidentId, ruleActionId, effectiveDate}`) and its own ledger row
-- history is never overwritten.

### Backward-compat shim

`performance_lock` executors emit `legacyPenalty` metadata.  While
`compliance.dualWrite` is OFF (default through Phase 5-8) the engine
mirror-writes a legacy `Penalty` row with `incidentId` set, so the
current EmployeeDashboard "Performance Lock Active" card keeps
rendering.  Flipping `compliance.dualWrite` ON (Phase 9) stops the
mirror-write; the shim then relies on the read-shim in Phase 9.

### Testing

    node services/compliance/__tests__/phase5.test.js

Covers executor shapes, marks strategy chain, ledger balance,
actionEngine persistence + idempotency, dualWrite gating, and disabled
actions.  Full integration (against real Mongo) will land in Phase 6.

## Phase 6 lifecycle

Layers landed:

* `waiver/waiverService.js` -- `request` / `decide` for
  ComplianceWaiver.  Partial waivers (per-effect) and full waivers
  supported.  Approvals write inverse ledger rows (`type:'waiver'`);
  the incident auto-flips to `waived` when every effect is closed.
* `recovery/recoveryService.js` -- `apply` for ComplianceRecovery
  (`restore` / `information` / `neutral`).  Reverses effects + writes
  inverse ledger rows (`type:'recovery'`).  Reuses the semantics of
  the existing `services/performanceRecovery.applyEvaluationMode`.
* `escalation/escalationRunner.js` -- one pass per `tick()` (when
  `compliance.waiverRecovery` is on).  Iterates active incidents;
  each `rule.escalation` step fires at most once per incident via
  `detectorMeta.escalatedStepIds` memoisation.
* `timeline/timelineService.js` -- read helpers over `ComplianceEvent`
  (per employee / per incident).
* `reconciliation/ledgerReconciler.js` -- nightly integrity check at
  02:00 local (env: `COMPLIANCE_RECONCILER_HOUR`).  Detects
  `runningBalance` drift by replaying the ordered row set.
* Controllers + routes -- incident + timeline HTTP surface under
  `/api/compliance/*`, gated by `compliance.waiverRecovery`.

### Phase 6 API surface

| Method | Path                                     | Auth              |
|--------|------------------------------------------|-------------------|
| GET    | `/api/compliance/incidents`              | HR (any employee) / employee (self) |
| POST   | `/api/compliance/incidents`              | HR / Super Admin  |
| GET    | `/api/compliance/incidents/:id`          | HR / owner        |
| POST   | `/api/compliance/incidents/:id/cancel`   | HR / Super Admin  |
| POST   | `/api/compliance/incidents/:id/recover`  | HR / Super Admin  |
| POST   | `/api/compliance/incidents/:id/waive`    | HR / Super Admin  |
| POST   | `/api/compliance/incidents/:id/waive/request` | Employee (own) / HR |
| POST   | `/api/compliance/incidents/:id/waive/decide`  | HR / Super Admin |
| GET    | `/api/compliance/timeline/me`            | Employee          |
| GET    | `/api/compliance/timeline/:employeeId`   | HR / Super Admin  |
| GET    | `/api/compliance/timeline/incident/:id`  | HR / owner        |

Every endpoint returns 404 when `compliance.waiverRecovery` is off.

### Feature-flag behaviour

* `compliance.waiverRecovery` off (default): the routes 404; the
  escalation pass inside `tick()` is skipped.
* `compliance.reconciler` off (default): the nightly job is skipped
  at boot.

### Testing

    node services/compliance/__tests__/phase6.test.js

Ten assertions across request/decide/reject/partial waiver, recovery
of all vs subset, escalation memoisation, timeline reads, and
reconciler drift detection.

## Phase 7 Employee UI

Landed:

* `frontend/src/hooks/useComplianceConfig.js` -- one-shot cached read
  of `/api/compliance/config` shared across every consumer.
* `frontend/src/components/compliance/ComplianceCard.jsx` -- employee
  dashboard block; renders every active + candidate incident with
  per-action badges and a "Request Waiver" button.
* `frontend/src/components/compliance/ActionBadge.jsx`,
  `CountdownBadge.jsx` -- reusable presentational atoms.
* `frontend/src/pages/employee/WaiverRequestModal.jsx` -- full +
  partial waiver flow.
* `frontend/src/pages/employee/MyCompliance.jsx` -- three-tab page
  (Timeline / Incidents / Ledgers) with proper loading + empty +
  error states.
* `frontend/src/App.jsx` -- new `/my-compliance` route.
* `frontend/src/components/Sidebar.jsx` -- link filtered out when
  the backend flag is off.
* `backend/controllers/compliance/configController.js` -- exposes
  the flag snapshot the frontend gates on.
* `backend/controllers/compliance/ledgerController.js` -- read
  endpoints for the four ledgers.

### Feature-flag behaviour

`compliance.employeeCardV2` off -> the dashboard block collapses to
nothing, the sidebar link is hidden, `/my-compliance` still routes
(page renders empty timelines / incidents / ledgers because the
underlying endpoints are also flag-gated at 404).

### Pending visual QA

Verify in a browser after enabling `compliance.employeeCardV2`:

- [ ] ComplianceCard renders both candidate + active incident states
      with the correct pill colour (amber for candidate, red for active).
- [ ] CountdownBadge updates once per minute; falls back to "due now"
      when the effective date has passed.
- [ ] "Request Waiver" opens the modal, both scopes are usable, and
      partial-mode disables the submit button when nothing is picked.
- [ ] `/my-compliance` renders each tab; ledger colours read
      correctly (red debits, green credits).
- [ ] Empty states surface for a clean user (no incidents, no ledger
      entries).
- [ ] Error state shows a red inline message when the API returns
      500.
- [ ] Sidebar link only appears when the flag is on.

## Phase 9 migration framework

Framework only.  Nothing is executed against production until you
explicitly run the CLI with `--commit` AND flip
`compliance.legacyBackfill` on.

Layers landed:

* `services/compliance/backfill/penaltyProjectionService.js`
  -- `project(penalty)` returns an in-memory synthetic incident +
  effect; `mappingFor(penalty)` returns the natural key + rule code
  the backfill will use.  Zero writes.
* `services/compliance/backfill/backfillJob.js` -- `run({commit})`
  scans every legacy `Penalty` row, projects, and (if committed)
  writes `ComplianceIncident` + `ComplianceActionEffect` rows with
  `naturalKey` prefix `legacy_projection|`.  Refuses commit unless
  the flag is on.  Refuses commit when >=50% of rows are already
  backfilled (idempotency check).  `deleteSynthetic({commit})`
  reverses the migration by removing every row with that natural-
  key prefix, then clearing the `Penalty.incidentId` back-reference.
* `scripts/complianceBackfill.js` -- CLI:
  * `node scripts/complianceBackfill.js` (dry-run)
  * `node scripts/complianceBackfill.js --commit`
  * `node scripts/complianceBackfill.js --rollback`
  * `node scripts/complianceBackfill.js --rollback --commit`
  * `--category=<name>`, `--batch=<n>` optional flags.

### Safety checks

1. Commit mode requires `compliance.legacyBackfill` flag on.
2. Commit mode refuses when at least half of the automatic Penalty
   rows already carry `incidentId` (double-write protection).
3. Every write uses the `legacy_projection|<penaltyId>` natural key
   under a partial-unique index, so retries after a crash never
   duplicate rows.
4. Rollback ONLY touches rows whose natural key starts with
   `legacy_projection|`.  Genuine incidents are untouched.

### Pending Production Validation

* Run `node scripts/complianceBackfill.js` against a **snapshot**
  of production first; inspect the `sampleProjections` output.
* Then run `--commit` against a staging DB seeded from the snapshot.
* Only after full soak, run against production.

## Phase 10 deprecation markers

Nothing is removed.  Every legacy code path now emits a one-time
`console.warn(...)` when `compliance.legacyGone` is on, and legacy
HTTP responses carry a `Deprecation` + `Sunset` + `Link` header
pointing at the replacement URL.

Marked:

* `services/missedSubmissionBackfill.js` (placeholder) -- warns on
  load; superseded by `services/compliance/backfill/backfillJob.js`.
* `services/penaltyEngine.sweepProbableAbsentSubmission` -- warns
  when invoked; no-op body preserved.
* `POST /api/penalties/manual` -- adds Deprecation header, still
  functional.
* `GET /api/penalties/dashboard` -- adds Deprecation header, still
  functional.
* `Penalty.category` enum values `absent_submission`, `manual_marks`,
  `manual_completion` -- retained for historical rows, docblock
  flags them for removal after a separate migration.

`services/deprecations.js` centralises the helper (`warn`,
`stampResponse`, `CODES`).  `CLEANUP_RUNBOOK.md` (this folder) is
the step-by-step guide for the eventual removal PR.

### Testing

    node services/compliance/__tests__/phase10.test.js

## Phase 3 API surface

Under `/api/compliance/rules` (all handlers gated by the
`compliance.rules` flag — 404 when off):

| Method | Path                          | Auth                 |
|--------|-------------------------------|----------------------|
| GET    | `/`                           | HR / Super Admin     |
| GET    | `/:id`                        | HR / Super Admin     |
| POST   | `/`                           | Super Admin *(or `featurePermissions.complianceRules.enabled`)* |
| PATCH  | `/:id`                        | Super Admin *(same)* |
| POST   | `/:id/enable`                 | Super Admin *(same)* |
| POST   | `/:id/disable`                | Super Admin *(same)* |
| GET    | `/:id/history`                | HR / Super Admin     |

Every mutation bumps `version`, writes an `AuditLog` row
(`compliance.rule.create` / `.update` / `.enable` / `.disable`), and
returns the updated document.

## Built-in rule seed

`services/compliance/rules/ruleSeed.js` seeds seven built-in rules on
every boot when `compliance.rules` is enabled:

* `missed_submission_v2`
* `dependency_pending_v2`
* `performance_lock_v2`
* `attendance_manual_v2`
* `manual_marks_v2`
* `completion_adjustment_v2`
* `financial_penalty_v2`

Every rule is seeded with `enabled: false`; HR flips them on
individually from the editor.  Re-runs are safe: rules that already
exist are left untouched (HR's edits win).
