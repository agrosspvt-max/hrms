# Testing and deployment

Audit date2026-10-03; source `91aae29`; available Node v23.3.0, Darwin ARM64. The working tree was clean at the start. No dependencies installed, no production application/server started, no seed/migration/diagnostic data script executed, no configured MONGO_URI connected and no external email sent. Only the requested documentation is added to the repository; temporary command output/helpers were kept outside it.

## Executed verification and classification

| Check | Actual command/action | Result | Meaning and limitation |
| --- | --- | --- | --- |
| Regression scripts | Each exact `NODE_ENV=test node backend/services/compliance/__tests__/<file>.test.js`, individually via Python subprocess from repo root, timeout25 seconds | **30 passed**, exit0 | Primarily Node assert with model/module stubs; not production Mongo or browser behavior |
| Mongo integration | `NODE_ENV=test node backend/services/compliance/__tests__/phase4.integration.test.js` | **Blocked by environment**, exit1 | MongoMemoryServer failed port allocation with `listen EPERM: operation not permitted 0.0.0.0`; blocked before assertions |
| Frontend build | `npm --prefix frontend run build -- --outDir /private/tmp/hrms-system-audit-build --emptyOutDir false` | **Blocked by environment**, exit1 | Existing esbuild platform dependency includes `@esbuild/aix-ppc64`, required `@esbuild/darwin-arm64`; config load fails before bundling. No install/repair attempted |
| Backend syntax | `node --check <file>` for228 production/config/middleware/model/controller/route/service/utility JS files and server.js, excluding tests/node_modules/top-level diagnostics | **Passed**,228/228 | Parses syntax without executing server or proving business correctness |
| Schema inventory | Require43 exported models and inspect schema paths/indexes without a connection | **Completed** | Declared constraints only, not existing database indexes/data validity |
| Notification compatibility diagnostic | Real installed Mongoose8.24.0; replace Notification.collection.findOneAndUpdate with a synthetic in-memory collection function, call notifyEvents._upsertOne | **Confirmed mismatch** | Simulated first insert returns created:false/doc:null; driver options rawResult present, includeResultMetadata absent. No Mongo writes |
| Reminder compatibility diagnostic | Synthetic collection returns new document to reminders.createOrUpdate under installed Mongoose | **Confirmed mismatch** | Helper returns doc:null/created:false despite simulated document return; admin create then reports failure after persistence |
| Integration fixture validation | User/DependencyTask validateSync using synthetic objects, no connection | **Confirmed latent fixture errors** | Too-short password rejected; currentStatus pending rejected by actual enum. These failures were not reached in environment-blocked integration run |
| Browser/API/external production verification | No authenticated browser session, HTTP server or production connection used | **Not run** | Role/scope assertions and runtime prevalence remain source-based |

No executed regression was classified as failing due to production code. The integration fixture and compatibility diagnostics identify source defects but are separate from the observed integration environmental failure. Some passing scripts log Mongoose notification buffering timeouts after assertions; those logs reveal incomplete notification stubbing and do not prove successful secondary delivery. Raw test output is not copied into documentation because fixtures/logs can include unnecessary identities.

### Reproducible regression runner

The audit invoked each discovered script separately; the following expresses the same command set without package-script assumptions. It uses existing dependencies only and does not import server.js or load backend/.env. Run from repository root. The memory-server integration may need a Mongo binary cache/download and permission to bind a local port; do not substitute the deployed database.

```python
from pathlib import Path
import os, subprocess
for file in sorted(Path('backend/services/compliance/__tests__').glob('*.test.js')):
    result = subprocess.run(
        ['node', str(file)],
        env={**os.environ, 'NODE_ENV': 'test'},
        capture_output=True, text=True, timeout=25,
    )
    print(file.name, result.returncode)
```

Tests mutate only their stub state or ephemeral memory-server intended instance. `phase4.integration.test.js` contains a stale comment pointing to phase4.test.js; use the actual integration filename. The installed mongodb-memory-server exists locally but is **not declared** in backend/package.json. A clean dependency installation cannot be assumed to reproduce that test. There is no `test`/lint script in either application manifest and no discovered frontend test/e2e runner configuration.

## Workflow coverage matrix

| Important business path | Existing coverage inspected/executed | Remaining material gap |
| --- | --- | --- |
| Account create/import/role/status/password/reset | No dedicated end-to-end suite identified | Target roles, final-SA invariant, hash response redaction, password-reset state/consume/resend, inactive sessions |
| Feature/HOD authorization | Some helper/controller behavior in phases/batches | Middleware+controller negative requests; cross-dept detail/export/write/bulk; permission levels and private response fields |
| Leave effective dates/units/off/holiday | leaveDaysRecalc, leaveEdgeCases, leaveHolidaySync, leaveOverlap | Real overlap constraint/races, merged Event vs persisted attendance, current probation vs request dates |
| Leave approval/edit/revoke/balance | leaveApprovalEdit, leaveAbsentSync, leaveSync, sameDayLeaveSync | Missing-model half→full path, failure/retry rollback, concurrent usage, large-range cap and historical salary effects |
| Assignment create/revoke/today visibility | assignmentSync, assignmentTodayVisibility |409 should preserve all rows; generic deactivate/delete parity; multiple schedules/template key collision; target-change cleanup |
| Template update/daily generation | templateTaskSync, hrAddedTaskGrading | Scoped custom generation+GET, disabled templates, holiday overrides, real concurrent index creation |
| Submit/reflection/backlog/reopen | resubmissionSelfEval, pendingSync, selected batches | Full payload failure side effects, custom cache/legacy score parity, historical attendance day, draft/suppression ownership |
| Review/extra-task scoring | hrAddedTaskGrading, selected batches/phase scripts | Fine HOD permissions, raw private fields, true return/resubmit, multi-template innovation, immutable finalization |
| Attendance/manual delta/confirmation | leave/same-day/prodPatch/batch scripts partially exercise helpers | Every controller write path, legacy/new parity, cross-dept writes, orphan leaveId, future/mode/timezones |
| Pending/dependencies | pendingSync, phase4/5, stabilization and batches | Real chain/source dedupe/concurrency; score recalc after completion; Excel/sheet/custom consistency |
| Rule/schema/registry/detector/action lifecycle | phase1–6, manualIncident, batch1–3, stabilization, prodPatch | Real Mongo transactions/index errors and retry; current-rule vs snapshot; promotion/crash recovery |
| Waiver/recovery/ledgers/escalation | phase5/6, stabilization and batches | Foreign effect IDs, approved-before-transaction failure, concurrent credits/backdated balances, mode/evidence enforcement |
| Legacy/v2 rollout/mirrors/filtering | phase9/10, rollout, prodPatch | Actual enabled flag combinations, all-reader parity, financial deduction and LWP attendance integration |
| Analytics/dashboard/template/self-review | Selected phase/batch arithmetic/scoping fixtures | Complete metrics/exports/cohort/date parity, HOD scope override, current-definition fallback, query plans |
| Payroll/publish/edit/PDF | No dedicated monetary workflow suite identified | Generation/edit invariance, employer/gross/CTC/period policy, published regeneration, deduction evidence, PDF layout |
| Events/holidays/calendar | eventCrud, leaveHolidaySync and batches | Recurring/multiday affected-leave discovery, timezone/leap birthdays/audience, historic recalculation |
| Notification/reminder/bus/SSE | Phase/batch/prodPatch stubs; isolated audit diagnostics | Real Mongoose metadata/indexes, first insert/repeat/concurrent delivery, client allowlist, replay/expiry/multi-instance |
| Interactions/notes/timeline/files/contacts/catalogues | No dedicated comprehensive suite identified | Private timeline adapters, detail-vs-list scopes, RSVP/visibility, upload content and download ownership, export formulas |
| Deployment/migrations/backup | Source review and build attempt only | Clean install CI, staged migrations/rollback, replica-set topology, live indexes/flags, backups/recovery and readiness |

### Script-by-script results

The table below records all31 scripts actually executed. A “pass” is process exit0, not comprehensive coverage. Batch/phase naming is historical; follow actual assertions instead of inferring full functionality from the number.

| Exact Node target | Result |
| --- | --- |
| `backend/services/compliance/__tests__/assignmentSync.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/assignmentTodayVisibility.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/batch1.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/batch2.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/batch3.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/eventCrud.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/hrAddedTaskGrading.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/leaveAbsentSync.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/leaveApprovalEdit.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/leaveDaysRecalc.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/leaveEdgeCases.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/leaveHolidaySync.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/leaveOverlap.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/leaveSync.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/manualIncident.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/pendingSync.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/phase1.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/phase10.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/phase2.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/phase3.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/phase4.integration.test.js` | Environment-blocked (exit1; MongoMemoryServer EPERM) |
| `backend/services/compliance/__tests__/phase4.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/phase5.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/phase6.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/phase9.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/prodPatch.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/resubmissionSelfEval.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/rollout.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/sameDayLeaveSync.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/stabilization.test.js` | Passed (exit0) |
| `backend/services/compliance/__tests__/templateTaskSync.test.js` | Passed (exit0) |

## Run and build procedures from manifests

These are documented operating commands, **not commands all executed during this audit**. Use an isolated development database when starting the API because boot performs writes. Existing `.env` was inspected only for variable names; no secret values were printed or copied.

```bash
# Repository root, after platform-correct dependencies are available:
npm run dev
# Or run the two surfaces individually:
npm --prefix backend run dev
npm --prefix frontend run dev
# Build the SPA:
npm run build
# API production entry:
npm --prefix backend start
# Local static build preview, not production API hosting:
npm --prefix frontend run preview
```

Root `install:all` runs npm install in root/backend/frontend; dependency installation was not performed. A clean lockfile-based CI installation per package is a future reproducibility step, not an audit claim. No Node engine/.nvmrc/version pin or container/CI definition was identified in the inspected repository. Use a supported runtime matching dependency/global-fetch requirements and validate it independently; the audit's Node23 availability is not a deployment recommendation.

**Do not use `npm run seed` as an ordinary startup command.** `backend/seed.js` loads dotenv and deletes existing User, Department, Designation, Template and Assignment collections before creating sample data. It was inspected for destructive operations and not run. Local diagnostic/scratch scripts may connect to configured data or mutate it; filenames do not make them tests.

Vite serves5173 and proxies `/api` to localhost5001; API default is5000. Align backend PORT to5001 for the current proxy, or explicitly change configuration in a separately authorized code task. This audit does not alter either value. VITE_API_URL bypasses the default relative path and must include the desired API base, typically the independently deployed `/api` prefix.

## Configuration names and purpose (no values)

| Variable(s) | Purpose/source |
| --- | --- |
| MONGO_URI | Mongo connection string, config/db.js; includes credentials/topology, must be supplied privately |
| JWT_SECRET, JWT_EXPIRES_IN | JWT signing/verification secret and expiry (code default7d) |
| PORT, NODE_ENV | Listener port; production error-stack/logging and environment behavior |
| CLIENT_URL | CORS origin and reset email frontend base; fallback wildcard CORS or localhost reset URL is not verified production configuration |
| VITE_API_URL | Frontend build-time Axios/SSE base URL, shared by both transports |
| COMPANY_NAME, COMPANY_ADDRESS, COMPANY_CURRENCY, COMPANY_CURRENCY_SYMBOL | Company/report/PDF labels and currency formatting |
| PASSWORD_RESET_TOKEN_TTL_MIN | Reset token TTL, code default30 minutes |
| HRMS_LOGIN_URL | Welcome email login link |
| EMAIL_PROVIDER | Explicit resend chooses HTTPS; unset/other uses SMTP, despite comments suggesting hosting defaults |
| RESEND_API_KEY | Resend API credential; only required by selected provider |
| SMTP_HOST, SMTP_PORT, SMTP_EMAIL, SMTP_PASSWORD | SMTP host/transport and authentication; port465 secure vs common587 STARTTLS |
| SMTP_FROM_NAME, SMTP_FROM_EMAIL | Sender display/from address; also used for Resend |
| ATTENDANCE_HALFDAY_CUTOFF_HOUR | Submission-time attendance/half-day behavior knob; validate timezone/mode semantics |
| MISSED_SUBMISSION_EFFECTIVE_FROM | Legacy missed/absent rollout date, code fallback2026-07-14 UTC |
| COMPLIANCE_SCHED_HOUR, COMPLIANCE_SCHED_MIN | Daily local server-time sweep slot, defaults00:15; day key uses UTC |
| COMPLIANCE_TICK_CONCURRENCY | Detector cohort parallelism, bounded1–256, default32 |
| COMPLIANCE_RECONCILER_HOUR, COMPLIANCE_RECONCILER_DRIFT_CAP | Local-time integrity check default02:00 and bounded drift report default500 |
| COMPLIANCE_AUTO_ENABLE_SEEDED | Optional enabled built-in rule seeding; inspect existing rules/HR edits before relying on default disabled behavior |

The example environment contains the core API/SMTP/company/reset names; several Resend/compliance operational names used by source are not represented in the example. Diagnostic-only EMP/DAY variables are excluded from required runtime configuration. No deployment secret inventory or secret rotation was performed.

### Feature flags and default behavior

`backend/config/featureFlags.js` derives uppercase snake names from dotted/camel capability names, parses1/true/yes/on, and caches resolution per process. Restart is required for changes. These flags are distinct from User.featurePermissions and per-rule enabled state. Deployed values were not verified.

| Environment key | Capability | Default |
| --- | --- | --- |
| COMPLIANCE_SCAFFOLD | scaffold/registries banner | true |
| COMPLIANCE_SCHEMAS | new model scaffold | true |
| COMPLIANCE_RULES | rules surface/seeding behavior | false |
| COMPLIANCE_NEW_ENGINE | v2 detector/incident tick | false |
| COMPLIANCE_ACTION_ENGINE | consequence execution | false |
| COMPLIANCE_WAIVER_RECOVERY | incident lifecycle/ledger/timeline endpoints and escalation paths | false |
| COMPLIANCE_RECONCILER | integrity reporting scheduler | false |
| COMPLIANCE_EMPLOYEE_CARD_V2 | employee UI rollout flag | false |
| COMPLIANCE_DASHBOARD_V2 | administrative dashboard | false |
| COMPLIANCE_READ_SHIM | legacy-compatible read projection | false |
| COMPLIANCE_DUAL_WRITE | current implementation's legacy mirror cutover switch | false |
| COMPLIANCE_LEGACY_BACKFILL | optional legacy projection/backfill behavior | false |
| COMPLIANCE_LEGACY_GONE | final cleanup/deprecation lock | false |

Read each consumer before enabling flags. In particular, current dualWrite=true turns selected legacy mirror writes **off**, rather than simply meaning “write both.” Incidents can promote while actionEngine is off; enabling it later does not automatically replay every old one-shot action. Reconciler logs drift; it does not correct caches despite the transaction fallback log wording.

## Startup and migrations

`server.js:start` connects Mongo with autoIndex true, then runs a mixed awaited/nonblocking boot sequence. A running listener or health200 does not establish completion of nonblocking or caught migrations.

| Startup operation | Data/index effects and scope |
| --- | --- |
| syncSalaryIndexes | Backfill missing payroll dates/periodKey, drop employee/month index, sync declared SalarySlip indexes; schema itself disables autoIndex |
| customTemplate built-in seed/migrateCallingDialedCalls | Ensure default Calling/Product-Farmer definitions; backfill selected historical report field |
| departmentMigration | Backfill department analyticsType |
| dealerMigration | Backfill dealer firm/person naming, replace legacy unique index |
| dailyReviewMigration | Backfill employee/day DailyReflection/DailyReview from grouped submissions |
| templateAnalyticsMigration | Backfill analytics labels/review-flow defaults |
| assignmentSubTemplateMigration | Copy legacy singular assignment scope into plural array |
| leaveAttendance.migrateApprovedLeaves | Materialize historic approved-leave attendance, intended to preserve selected manual states |
| verifyTransporterAtBoot | Nonblocking provider handshake/API check; can make external network calls and logs credential presence/length, not password/key value |
| dailyComplianceScheduler | Boot catch-up and local daily timer; legacy always, v2 when enabled; per-process once-day key |
| compliance logBoot/ruleSeed | Load registries/flag banner and seed built-in rule definitions under configuration |
| ledgerReconciler | Boot/nightly check if flag enabled; report drift, no repair |
| attendanceModeMigration | Rewrites non-auto/non-review modes to attendance_review at each boot, including explicit submission_based choices |
| legacyMissedSubmissionArchive | Archive selected pre-cutoff legacy penalties and hide related notifications |
| interactionTagSeeder | Upsert default tag catalogue |
| reminderScheduler | Boot catch-up plus15-minute timer, recent due window20 minutes/max500 rows |

Many failures log and continue. No versioned migration journal, global migration lease or verified backup/rollback protocol was found. Some operations are designed to be repeatable, but “idempotent” comments are not proof under concurrent startup, partial state or changed business inputs. Do not run startup on production simply to inspect it.

## Hosting assumptions and operational verification still needed

- frontend/vercel.json rewrites all SPA paths to index.html. It does not route `/api` to the backend. Build-time VITE_API_URL or separately configured proxy is required for a split deployment. No API static frontend serving was identified.
- Comments reference Render API/Vercel frontend. Actual deployment projects, build/start settings, TLS, custom domains, provider plan restrictions, secret values and live traffic were not accessed. SMTP may be unavailable on some hosts; explicit Resend path exists but was not invoked.
- SSE must be allowed through proxy buffering/timeouts; multiple instances need cross-process delivery/coordination. Current service bus and SSE map are local. No shared queue, leader election or persisted notification retry/outbox was found.
- Business day normalization uses UTC while daily/reconciliation timers use server-local time, then fixed24-hour intervals. Check TZ, local-midnight versus UTC-date boundary and DST behavior; user Asia/Kolkata context does not establish server timezone.
- Verify real Mongo server/topology/indexes, especially unsupported notification partial predicate, unique constraints, transaction capability and salary migration status. Standalone serial fallback is not equivalent to atomic execution.
- Establish backup/restore, payroll period correction/revision, retained identity/deletion policy, retention/orphan-file handling, audit completeness, provider failure retry and health/readiness monitoring. None was operationally verified in this pass.
- Run a dependency/security advisory review against the locked and actually installed versions; no package vulnerability scan was executed.

## Inspection coverage and next pass

This pass reviewed the application entry/build/auth pipeline, all42 router files and their mounted317 endpoint declarations,43 model metadata sets, major core controllers/services, flags/migrations/schedulers, frontend route/session/SSE and representative workflow request/subscriber call sites. Source counts:47 controllers (~21k lines),44 model files (~4k),42 routers (~1k),104 services including tests (~20k),16 utilities (~2k),101 frontend source files (~39k). Deep workflow traces are strongest for leave, attendance, generation/submission/review, payroll and compliance.

Large secondary analytics/report formatting branches, detailed React visual behavior, every form/modal, historical migration/backfill edge case and operational diagnostic script were inspected selectively or not run. No complete browser walkthrough, production reconciliation, live index verification, load testing, penetration test, PDF/XLSX visual QA or replica-set race test was performed. This is a durable first audit pass with explicit gaps, not a complete production certification.

Next authorized implementation/audit pass: negative request tests for S02–S07/S10–S11; payroll generation/edit invariance; isolated replica-set concurrent leave/attendance/waiver/ledger fixtures; notification/reminder real-Mongoose/index integration; frontend scope/return/realtime flows; then migration/readiness/deployment review. The ranked sequence is in [Known issues](KNOWN_ISSUES_AND_RISKS.md).
