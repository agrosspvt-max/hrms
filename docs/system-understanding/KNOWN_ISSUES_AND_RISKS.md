# Known issues and risks

Source baseline `91aae29`; audit 2026-10-03. No issues were fixed. **Confirmed** means the executable source path contradicts an enforced constraint, related implementation or advertised behavior; it does not mean exploitation or corrupt production data was observed. **Potential** means a reachable risk depends on concurrent requests, failures, deployment or business policy. **Unverified** means evidence is insufficient. Severity reflects realistic impact, not implementation effort. High confidence applies to the cited code; operational prevalence remains unknown.

## Priority and recommended order

1. Close public email sending and authorization/data-disclosure paths (S01–S06, S10–S11 and D23). Establish negative authorization tests before broadening permissions.
2. Correct payroll input consistency and define the intended payroll formula (D01–D03), using fixed-period reconciliation fixtures and approved business examples.
3. Make leave/attendance and assignment operations validate before mutation and recover safely (D04–D08, R01).
4. Repair compliance effect ownership, atomicity, lifecycle reversal and ledger integrity (S07, D09–D13, R02).
5. Restore notification dependency compatibility and realtime propagation (D14–D16), then generation/scoring/review consistency (D17–D22).
6. Address configuration, startup migrations, deletion history and deployment reproducibility (R03–R08). Verify live indexes/flags and backups in a separately authorized operational review.

These are defects and engineering risks. New reporting hierarchies, durable queues, new storage providers and richer reminder recurrence are separate feature/design proposals, not claimed missing contractual features.

## Authorization and security

### S01 — High — Public email sending endpoint

- **Evidence:** [server.js](../../backend/server.js), inline GET `/api/test-email`; `emailService.sendMail` in [emailService.js](../../backend/utils/emailService.js).
- **Scenario/impact:** any unauthenticated caller supplies `?to=` and triggers a configured SMTP or Resend send with a fixed test message. Repeated requests consume provider quota and enable unsolicited mail. The endpoint also returns delivery/error diagnostics. It is mounted unconditionally before the error handler, with no authentication or application rate limit.
- **Status/confidence:** confirmed reachable source path; high. No actual messages sent during audit; provider availability is unverified.
- **Next step:** remove or restrict the production diagnostic and test unauthorized requests and provider abuse limits.

### S02 — High — HOD attendance writes lack the queue's department restriction

- **Evidence:** [attendanceConfirmationController.js](../../backend/controllers/attendanceConfirmationController.js), `queueForDay`, `review`, `_assertReviewerGate`, `_applyReviewAction`, `actOne`, `bulkAct`; [attendanceConfirmationRoutes.js](../../backend/routes/attendanceConfirmationRoutes.js).
- **Scenario/impact:** an authenticated HOD can submit another department's confirmation ID or employee/day to the action endpoints. Queue reads constrain the department; writes accept the HOD overlay without verifying the target department or `hodPermissions.canReview`. Self-target checks and attendance-mode checks do not enforce department isolation.
- **Status/confidence:** confirmed authorization omission in reachable handlers; high. Live request exploitation not attempted.
- **Next step:** share an ownership/department/target-role guard across individual and bulk review paths; add cross-department and permission-disabled tests.

### S03 — High — Self-review scope parameter overrides HOD isolation

- **Evidence:** [dailySelfReviewController.js](../../backend/controllers/dailySelfReviewController.js), `_resolveScope`; [dailySelfReviewRoutes.js](../../backend/routes/dailySelfReviewRoutes.js).
- **Scenario/impact:** `_resolveScope` first sets `empWhere.department = hodDepartment`, then accepts `scopeType=department&scopeValue=<other department>` and replaces it. The analytics guard allows HODs. Overview, notes/ideas libraries and exports reuse this scope and can expose other departments' employee self-evaluations.
- **Status/confidence:** confirmed source defect; high. An employee with only an analytics grant is instead rejected by the controller, illustrating separate frontend/backend inconsistency.
- **Next step:** apply immutable authorization scope after filters and test every shared-scope reader.

### S04 — High — Directory grants disclose financial and personal profile fields

- **Evidence:** [employeeRoutes.js](../../backend/routes/employeeRoutes.js), `directoryGate`; [employeeController.js](../../backend/controllers/employeeController.js), `listEmployees`; [User.js](../../backend/models/User.js).
- **Scenario/impact:** an employee given one of several directory-consuming grants can GET `/api/employees`. The controller returns User documents without a restricted projection or employee/department clamp. Password is schema-excluded, but bank identifiers, salary structure, leave balances and personal profile fields are not. HR excludes Super Admin by default; granted employees do not receive that HR-only restriction.
- **Status/confidence:** confirmed excessive response surface; high. Whether every grant is intended to authorize financial disclosure requires policy confirmation.
- **Next step:** define a minimal directory DTO independently of profile/payroll endpoints and verify target-role/scoping rules.

### S05 — High — Daily review mutations bypass fine HOD permissions and return private fields

- **Evidence:** [dailyReviewController.js](../../backend/controllers/dailyReviewController.js), `finalizeDay`, `bulkFinalize`, `editTaskStatus`, `editTaskMarks`, `editSubmissionValue`; compare [submissionController.js](../../backend/controllers/submissionController.js), `hodReview`, and [privateRemark.js](../../backend/utils/privateRemark.js).
- **Scenario/impact:** daily handlers accept the HOD flag without consistently checking `canReview`, `canMarks` or `canRecommend`, whereas the per-submission HOD handler checks them. Task/value mutation responses return the raw Submission including `privateRemark` and internal recommendation fields; the read paths' scrubbers are not applied. `editSubmissionValue` also treats a feature grant as an alternative to a HOD department/permission restriction. Some target-role restrictions apply only when caller.role is literally HR, allowing feature employees to reach HR-owned work in daily paths.
- **Status/confidence:** confirmed inconsistent guards and unsanitized mutation responses; high. Each endpoint needs distinct negative fixtures; avoid treating all review APIs as equally permissive.
- **Next step:** centralize record scope/fine permissions and response scrubbing; cover both no-op and changed responses, bulk and individual actions.

### S06 — High — HOD interaction detail/timeline reads bypass department and visibility restrictions

- **Evidence:** [interactionController.js](../../backend/controllers/interactionController.js), `_isReviewer`, `list`, `getOne`, `timeline`, `mine`; [interactionRoutes.js](../../backend/routes/interactionRoutes.js); [noteController.js](../../backend/controllers/noteController.js), `_assert`, `list`, `getOne`.
- **Scenario/impact:** `getOne` and `timeline` are protect-only routes and treat any HOD with a department as a reviewer, bypassing ordinary participant/visibility checks without constraining the target department. List/analytics have a department restriction, and most writes have a route feature gate that does not automatically admit HODs. Global Notes gate HODs but return all nonpersonal notes regardless of `visibility=hr_only`; personal-note author protection does exist. `mine` includes HR-only meetings but detail rejects ordinary employee readers unless employee-visible, producing a visibility contradiction.
- **Status/confidence:** confirmed detail-read and Notes scope behavior; high. Exact intended meaning of Notes visibility requires product confirmation.
- **Next step:** define scope and visibility independently from reviewer capability; test detail/timeline as well as list.

### S07 — High — Partial waiver effect IDs are not bound to the incident

- **Evidence:** [waiverService.js](../../backend/services/compliance/waiver/waiverService.js), `request`, `decide`, effect `findById`; [incidentController.js](../../backend/controllers/compliance/incidentController.js), `waiveRequest`, `waiveDecide`.
- **Scenario/impact:** a user permitted to request a waiver for their own incident can supply effect IDs belonging to another incident/employee. HR approval later loads those effects by ID without validating their incident/employee relationship and applies reversal/waiver. Employee incident ownership checks are a real compensating restriction, but do not establish effect ownership. This requires an approver and knowledge of an effect ID; it is not a direct unauthenticated reversal.
- **Status/confidence:** confirmed relationship-validation omission; high.
- **Next step:** validate all targets against the authorized incident at both request and decision, inside the transaction; add foreign-effect and mixed-target tests.

### S08 — Medium — Feature level/sub-permissions are usually cosmetic for writes

- **Evidence:** [auth.js](../../backend/middleware/auth.js), `requireRoleOrFeature`; [featurePermissionsController.js](../../backend/controllers/featurePermissionsController.js), `requireFeature`; frontend [FeatureAccess.jsx](../../frontend/src/pages/superadmin/FeatureAccess.jsx); product/contact/assignment/attendance/salary route gates.
- **Scenario/impact:** a grant configured as view-level still passes `.enabled` gates for POST/PUT/DELETE. The stricter exported `requireFeature` is not wired into inspected routers. Calling analytics does explicitly honor `performance.sub.calling`, and dynamic analytics enforces `allowedTemplateIds`; those exceptions do not protect unrelated writes.
- **Status/confidence:** confirmed implementation/configuration mismatch; high. Severity can be high if operators rely on view-only delegation for payroll or attendance.
- **Next step:** enumerate supported capabilities and enforce action-level access, or stop representing unenforced options as effective restrictions.

### S09 — Medium — Session persistence and public authentication abuse risks

- **Evidence:** [auth.js](../../backend/middleware/auth.js), `protect`; [AuthContext.jsx](../../frontend/src/context/AuthContext.jsx); [realtime.js](../../frontend/src/realtime.js); [authController.js](../../backend/controllers/authController.js); [passwordResetController.js](../../backend/controllers/passwordResetController.js).
- **Scenario/impact:** bearer JWT lives in localStorage; query `token` is accepted by protect beyond SSE and appears in stream URLs. XSS or URL/access-log exposure can disclose a reusable token. Password changes/reset and local logout do not invalidate issued JWTs. Public reset request distinguishes nonexistent/inactive accounts; its five-minute per-email pending-request check is not a general brute-force/IP limiter. No application login rate limiter or security-header middleware was found in the inspected pipeline. Existing SSE sessions authenticate only on connection.
- **Status/confidence:** confirmed design properties; potential exposure/abuse, medium-high confidence. Proxy protections and exploitability were not verified.
- **Next step:** establish session/revocation policy, restrict URL tokens to needed surfaces, redact access logs, add abuse protection and verify production headers/CORS.

### S10 — High — Own derived timeline exposes private interaction notes and personal-note titles

- **Evidence:** [timelineController.js](../../backend/controllers/timelineController.js), `mine`; [timeline.js](../../backend/services/timeline.js), `collect` interaction and note adapters (around lines207–299).
- **Scenario/impact:** any authenticated employee can GET `/api/timeline/mine`. collect loads interactions in which the subject participates, then InteractionNote rows without visibility filtering, returning up to200 characters of note body. It also loads all Note rows mentioning the subject without checking personal author/visibility and exposes their titles/author. The employee-visible detail and personal-note protections in interactionController/noteController do not apply to this independent projection. No frontend consumer is required for the API to disclose this information.
- **Status/confidence:** confirmed reachable read path and omission; high. Only source inspected, no actual employee notes accessed.
- **Next step:** apply source-level authorization to each timeline adapter; test ordinary employee own timeline against HR-only interaction notes and another author's personal note. Include this in the first authorization fix group S01–S06.


### S11 — High — Shared default account password and creation-response hash exposure

- **Evidence:** [employeeController.js](../../backend/controllers/employeeController.js), `createEmployee`, bulk import default-password path; [User.js](../../backend/models/User.js), password select:false, save hook and JSON options.
- **Scenario/impact:** creating/importing without an explicit password uses a common hardcoded fallback, with no required first-login password change identified. Accounts remaining on the fallback have predictable credentials. createEmployee returns the newly saved User directly; password select:false affects queries, not fields on the created instance, and no JSON transform strips it. An authorized HR/SA caller receives the saved hash. This is not disclosure to an ordinary unauthenticated caller, but unnecessarily exposes a credential verifier.
- **Status/confidence:** confirmed source behavior; high. No account was created or existing password examined. Password values are deliberately omitted from this report.
- **Next step:** use unique expiring account setup credentials/reset flow and an explicit safe User response projection; test omitted-password creation/import and every response shape.

## Data integrity and business behavior

### D01 — High — Editing a salary slip changes payroll inputs

- **Evidence:** [salaryController.js](../../backend/controllers/salaryController.js), `computeSlip` versus `updateSlip` calls to `computePayroll`; [payroll.js](../../backend/utils/payroll.js), `computePayroll`.
- **Scenario/impact:** generation passes period `monthDays` and `holidayWorkedDays`; editing passes neither. The utility falls back to workingDays and zero holiday-work credit. A nonfinancial edit can change absence deductions and remove holiday-work credit. Scalar bonus/deduction mirrors are also not equivalent to item lists consumed by the calculator.
- **Status/confidence:** confirmed input mismatch; high, no live monetary example executed.
- **Next step:** use one persisted payroll input contract and assert generation/edit invariance for fixed periods, holidays and absences.

### D02 — High — Payroll formula requires explicit business validation

- **Evidence:** [payroll.js](../../backend/utils/payroll.js), `computePayroll`: `ctcMonthly = monthlyGross + employerTotal`; net starts with `ctcMonthly`. [salaryController.js](../../backend/controllers/salaryController.js), `computeSlip` uses full monthly salary for an arbitrary inclusive period and treats future/ongoing days as payable by subtraction of known absences/unpaid days.
- **Scenario/impact:** employer PF/ESIC contributions can increase net payable; short-period runs can start from a full monthly amount; future periods can be paid before attendance is known. Comments about employer contributions do not match the net formula.
- **Status/confidence:** confirmed formula; **potential policy defect**, high code confidence, intended payroll policy unverified. This audit makes no statutory/legal compliance conclusion.
- **Next step:** obtain approved numerical examples and reconcile CTC, gross, employee deductions, employer contributions, period proration and future-day handling before changing money calculations.

### D03 — High — Regeneration overwrites published payroll snapshots

- **Evidence:** [salaryController.js](../../backend/controllers/salaryController.js), `generate`/upsert path; [SalarySlip.js](../../backend/models/SalarySlip.js), `(employee, periodKey)` uniqueness.
- **Scenario/impact:** generating the same period updates the existing slip and sets it active, but does not reset existing `publishStatus`. A previously published slip can change and remain employee-visible immediately. No immutable revision/closed-period guard exists. Historic leave/attendance changes do not regenerate slips automatically.
- **Status/confidence:** confirmed lifecycle path; high.
- **Next step:** define payroll revision/publication/locking rules and audit regeneration explicitly; preserve prior published snapshots.

### D04 — High — Leave edit conflict check references an unimported model

- **Evidence:** [leaveController.js](../../backend/controllers/leaveController.js), `edit`, half-to-full branch `Submission.find` around line 929; file imports do not define Submission.
- **Scenario/impact:** changing half-day leave to full-day should detect started/submitted work. The explicit conflict check throws ReferenceError, is caught/logged and proceeds. The dry-run before it evaluates the old persisted leave. The controller then changes balances/leave/attendance and only later receives synchronization conflicts.
- **Status/confidence:** confirmed source defect; high. Existing stub regressions did not demonstrate this branch against real Mongo.
- **Next step:** validate against proposed state before any write and exercise half-to-full transitions with untouched, drafted and submitted work, with and without force.

### D05 — High — Leave and attendance updates can partially succeed and race

- **Evidence:** [leaveController.js](../../backend/controllers/leaveController.js), `apply`, `decide`, `revoke`, `edit`; [leaveHolidaySync.js](../../backend/services/leaveHolidaySync.js); [attendanceController.js](../../backend/controllers/attendanceController.js), `setStatus`, `clearStatus`; [leaveAccounting.js](../../backend/utils/leaveAccounting.js).
- **Scenario/impact:** User balance is saved separately before Leave/Attendance. Crash/failure leaves inconsistent debit/status; a retry may debit again. Overlap validation is a find-before-create, not a database exclusion constraint. Concurrent approvals or overrides read the same balance and can lose updates. Pending leave does not reserve allowance, and approval is not an all-or-nothing transaction. Correct incremental override arithmetic alone does not make these writes atomic.
- **Status/confidence:** confirmed boundaries, potential race/failure impact; high.
- **Next step:** introduce atomic decisions/conditional writes and an auditable balance ledger or reconciler; test repeated and concurrent operations on replica-set Mongo.

### D06 — Medium — Holiday treatment differs between leave balance and persisted attendance

- **Evidence:** [leaveController.js](../../backend/controllers/leaveController.js), merged `eventOccurrences.holidayDaySet` for effective units; [leaveAttendance.js](../../backend/services/leaveAttendance.js), `syncAttendanceForLeave`, queries Holiday only; [attendanceController.js](../../backend/controllers/attendanceController.js), range preparation; [dailyEngine.js](../../backend/services/dailyEngine.js), `deriveAttendance` record precedence.
- **Scenario/impact:** approved leave spanning an Event marked as a holiday can consume zero units for that date while persisted leave attendance marks it full/half paid/unpaid. Stored Attendance then outranks holiday inference in the calendar/payroll.
- **Status/confidence:** confirmed differing readers; high.
- **Next step:** use one merged working-day context for calculation and synchronization; test recurring and multiday Event holidays. Also reconcile half-day policy: workingDays.isWorkingDay excludes any approved leave day supplied in leaveDaySet, while daily work generation excludes full-day leave; deadlines/expected work can therefore follow different policies.

### D07 — Medium — Legacy attendance review bypasses incremental leave accounting

- **Evidence:** [attendanceConfirmationController.js](../../backend/controllers/attendanceConfirmationController.js), `review` versus `_applyReviewAction`.
- **Scenario/impact:** the legacy confirmation review endpoint writes manual attendance with zero leaveDelta, without the balance adjustment used by the newer action endpoint. Similar paid statuses reached through different UI/API paths do not have equivalent accounting.
- **Status/confidence:** confirmed competing write paths; high.
- **Next step:** retire or align the legacy path and reconcile affected records using the approval/manual ownership rules.

### D08 — Medium — Assignment revocation can mutate submissions before returning 409

- **Evidence:** [businessStateSync.js](../../backend/services/businessStateSync.js), `suppressAssignmentSubmissions`; [assignmentController.js](../../backend/controllers/assignmentController.js), `revoke`.
- **Scenario/impact:** suppression hides untouched rows while walking the set, then discovers started work. Without force the controller returns a conflict and leaves the assignment active, but earlier rows are already hidden. Generic update `active=false` and hard delete also do not share revocation's suppression policy.
- **Status/confidence:** confirmed write order and alternate paths; high.
- **Next step:** preflight the entire set before mutation; unify deactivation paths and assert no database changes on conflict.

### D09 — High — Incident resolution does not resolve or reverse action effects

- **Evidence:** [incidentService.js](../../backend/services/compliance/incidents/incidentService.js), `resolveIncident`, versus `cancelIncident`; callers in submission, leave/business sync and pending/dependency handling; [recoveryService.js](../../backend/services/compliance/recovery/recoveryService.js).
- **Scenario/impact:** business recovery changes incident status to resolved but leaves active ActionEffects and ledger debits. Status dashboards and consequence balances can disagree. Explicit cancel/recover paths have separate reversal semantics; incident resolution is not equivalent to them.
- **Status/confidence:** confirmed lifecycle separation; high. Whether a specific resolved sanction should persist is a business question.
- **Next step:** specify terminal incident/effect/ledger invariants and route automatic and manual resolutions through the intended consequence lifecycle.

### D10 — High — Ledger running balances drift on backdating and concurrent writes

- **Evidence:** [ledgerService.js](../../backend/services/compliance/ledger/ledgerService.js), `append`, `balance`; [ledgerReconciler.js](../../backend/services/compliance/reconciliation/ledgerReconciler.js), reconciliation loop; [_complianceLedgerSchema.js](../../backend/models/_complianceLedgerSchema.js).
- **Scenario/impact:** append loads the latest date-sorted row's runningBalance and adds the new delta, even for a backdated entry. Later date-sorted balance reads can ignore that newly inserted older debit, and intermediate balances are inconsistent. Two writers can read the same prior row; transaction isolation does not by itself serialize inserts that update no shared counter. No unique ledger-entry operation key exists. The reconciler reports drift; it does not repair it and uses the previously recorded balance while checking each row.
- **Status/confidence:** confirmed algorithmic limitation; high; actual drift unverified.
- **Next step:** separate signed-entry truth from cached balances, serialize/rebuild per employee/ledger, add backdated/concurrent fixtures and a controlled reconciliation process.

### D11 — High — Waiver status is committed before reversals; recovery modes have identical effects

- **Evidence:** [waiverService.js](../../backend/services/compliance/waiver/waiverService.js), `decide`; [recoveryService.js](../../backend/services/compliance/recovery/recoveryService.js), `apply`; [ComplianceRule.js](../../backend/models/ComplianceRule.js), recovery configuration.
- **Scenario/impact:** waiver is saved approved before the transaction; failed reversals leave an approved request that decision retry treats as already done. Recovery records are created before their transaction. Restore/information/neutral all invoke reversal, and rule `recovery.allowed`, allowed modes and required evidence are not used as enforcement in that path.
- **Status/confidence:** confirmed write order and mode behavior; high.
- **Next step:** bind request/effect/ledger status atomically, define mode semantics and safely resume failed operations.

### D12 — High — Action execution uses current rules and cannot reliably repair partial effects

- **Evidence:** [actionEngine.js](../../backend/services/compliance/actions/actionEngine.js), `apply`; [ruleEvaluationScheduler.js](../../backend/services/compliance/scheduler/ruleEvaluationScheduler.js), `_runPromotion`, `_runRecurring`; [txn.js](../../backend/services/compliance/txn.js).
- **Scenario/impact:** an incident stores ruleVersion but execution loads the current rule. Edits between detection and activation can change consequences. Promotion saves active before action execution; a crash can leave a one-shot incident active without effects, and promotion will not revisit it. Serial fallback can leave an effect without ledgers; an existing effect's unique-key hit short-circuits instead of healing missing rows. Turning actionEngine on after promotion has similar replay concerns.
- **Status/confidence:** confirmed control flow, potential crash/reconfiguration impact; high.
- **Next step:** preserve an executable rule snapshot, track action execution state and reconcile/retry incomplete effects deliberately.

### D13 — High — Financial/LWP records are not unified with payroll or attendance

- **Evidence:** [executors/index.js](../../backend/services/compliance/actions/executors/index.js), financial/LWP executors; [salaryController.js](../../backend/controllers/salaryController.js); [penaltyController.js](../../backend/controllers/penaltyController.js), `markFinancialDeducted`.
- **Scenario/impact:** v2 fine/LWP execution writes FinancialLedger/AttendanceLedger, not SalarySlip/Attendance. Legacy `markFinancialDeducted` records supplied slip/month IDs and resolves penalties without loading the slip, verifying employee ownership, or creating a matching deduction item. Administrators can mark a deduction completed while no corresponding payroll deduction exists.
- **Status/confidence:** confirmed disconnected persistence paths; high; actual desired v2 rollout stage is unverified.
- **Next step:** define outstanding-versus-deducted truth, verify slip relationships and link explicit accounting entries to actual payroll revisions. Do not infer deduction from a status label.

### D14 — Medium — Notification dedupe index uses unsupported partial-filter operator

- **Evidence:** [Notification.js](../../backend/models/Notification.js), `notif_dedupe_recipient_event_variant` includes `$ne: ''`. MongoDB's [supported partial-filter expressions](https://www.mongodb.com/docs/manual/core/index-partial/) do not include `$ne`.
- **Scenario/impact:** MongoDB can reject the declared index. Startup auto-indexing does not prove the index exists; missing uniqueness undermines concurrent deduplication. Other automatic penalty/incident indexes use equality predicates and are a different case.
- **Status/confidence:** confirmed schema/vendor incompatibility; high. Live index build/result unverified because no Mongo service was started.
- **Next step:** verify actual indexes and replace the predicate with a supported equivalent through a reviewed migration; test on real Mongo with concurrent inserts.

### D15 — Medium — Notification insertion metadata uses removed Mongoose option

- **Evidence:** [notifyEvents.js](../../backend/services/notifyEvents.js), `_upsertOne`, and [reminders.js](../../backend/services/reminders.js), `createOrUpdate`, request `rawResult: true` and reads `lastErrorObject`; lockfile Mongoose 8.24.0. [Mongoose 8 migration guide](https://mongoosejs.com/docs/8.x/docs/migrating_to_8.html) replaces that option with `includeResultMetadata`.
- **Scenario/impact:** `reminders.js:createOrUpdate` uses the same removed rawResult contract with new:true; it returns doc:null, so admin reminder create can persist a row then report400. A new notification upsert with `new:false` returns the previous document/null rather than metadata; `created` is false and returned `doc` null. Salary/penalty helpers suppress `notification:new`; meeting projector code can likewise miss insert-dependent effects. Database rows may still be inserted.
- **Status/confidence:** confirmed by source and an isolated real-Mongoose query/collection stub: simulated insert returned `{created:false,doc:null}`, options contained rawResult but no includeResultMetadata. No Mongo write occurred. High confidence.
- **Next step:** align the option/result contract and test first insert, duplicate and concurrent cases against installed Mongoose.

### D16 — Medium — Frontend silently drops emitted realtime event types

- **Evidence:** [realtime.js](../../frontend/src/realtime.js), `_wire` TYPED list; backend realtimeMirror, notifyPenalty, incidentService and reminderScheduler publishers.
- **Scenario/impact:** `penalty:changed`, `compliance:changed`, `alert:changed`, `timeline:appended`, `reminder:changed` are absent from the client forwarding list. Components subscribing to these browser events cannot receive them through this singleton. Other events or manual refresh can incidentally refresh some views.
- **Status/confidence:** confirmed event-surface mismatch; high.
- **Next step:** compare publisher, transport and subscriber registries and test delivery/refetch for each supported event.

### D17 — Medium — Scoped custom assignment expands when today's data is fetched

- **Evidence:** [dailyEngine.js](../../backend/services/dailyEngine.js), `ensureDailySubmissions`; [Submission.js](../../backend/models/Submission.js); [submissionController.js](../../backend/controllers/submissionController.js), `getToday` custom-field synchronization.
- **Scenario/impact:** generation filters using Assignment.subTemplateIds but does not persist that scope on Submission; the schema has no scope fields. getToday reads absent Submission.subTemplateIds/subTemplateId and falls back to all template fields. Assignment scope can disappear during retrieval.
- **Status/confidence:** confirmed missing snapshot/read contract; high.
- **Next step:** preserve scope explicitly and test generation plus subsequent GET with multiple subtemplates and scope edits.

### D18 — Medium — Holiday override generation is blocked at submission

- **Evidence:** [dailyEngine.js](../../backend/services/dailyEngine.js), override-aware generation; [submissionController.js](../../backend/controllers/submissionController.js), `submitOne` holiday gate.
- **Scenario/impact:** a holiday override produces work, but submitOne rejects when today is a merged holiday without consulting the submission override or target date. Historical reopened work can also be blocked by today's holiday.
- **Status/confidence:** confirmed mismatch; high.
- **Next step:** use the assigned day and saved override semantics consistently; test once/all override and historic reopening.

### D19 — Medium — Failed submission can resolve penalties before validation completes

- **Evidence:** [submissionController.js](../../backend/controllers/submissionController.js), `submitOne`: `resolveAbsentSubmissionOnSubmit` runs before required private-remark validation and final `sub.save`.
- **Scenario/impact:** an employee submits a payload missing a required private remark. The API returns 400 after resolution helpers have run, so penalty/incident state can change even though the submission remains unsubmitted. DailyReflection and catalog writes can also precede final save.
- **Status/confidence:** confirmed write order; high; production occurrence unverified.
- **Next step:** validate the complete payload first, then perform atomic or recoverable writes and effects after persistence.

### D20 — Medium — Scoring and live-record filters are inconsistent across readers/writers

- **Evidence:** [submissionController.js](../../backend/controllers/submissionController.js), `completeBacklogTask`, calling `pendingStateService.autoResolveBacklog`, custom submission branch; [dailyReviewController.js](../../backend/controllers/dailyReviewController.js), task editors; [dailyEngine.js](../../backend/services/dailyEngine.js), `deriveAttendance`; analytics and salary controllers.
- **Scenario/impact:** backlog completion changes task status without recomputing the cached work score, unlike daily task edit endpoints. Custom marks live in custom* fields while generic completion/payroll read earnedPoints/totalPoints, which custom submission paths initialize to zero. Submitted deleted/test/hidden records can infer present attendance because that query does not use the live filter; work analytics excludes them.
- **Status/confidence:** confirmed competing representations; high. Whether custom work should participate in generic completion is unverified policy.
- **Next step:** establish score inclusion and status invariants; compare task truth, cached scores, attendance, template analytics and salary in shared fixtures.

### D21 — Medium — “Needs changes” is not a complete return/resubmit transition

- **Evidence:** [submissionController.js](../../backend/controllers/submissionController.js), `hodReview`, `submitOne`; legacy [penaltyController.js](../../backend/controllers/penaltyController.js), reopen decision paths.
- **Scenario/impact:** HOD recommendation `needs_changes` leaves submitted true and stage hod_reviewed, while submitOne rejects already submitted rows. No ordinary return endpoint resetting editability was found. Legacy penalty reopening is a separate mechanism and cannot be assumed for this recommendation. HOD review can also modify a finalized submission unless the guarded recommendation condition applies.
- **Status/confidence:** confirmed transitions, medium-high confidence on absence of an ordinary return path across inspected routes.
- **Next step:** define return state and immutable-finalization policy, trace UI behavior and test correction/resubmission separately from penalty reopening.

### D22 — Medium — Organization/HOD and attendance-mode truth can be overwritten

- **Evidence:** [employeeController.js](../../backend/controllers/employeeController.js), `normalizeHodPermissions`, `syncHodAssignment`, `updateEmployee`; [departmentController.js](../../backend/controllers/departmentController.js), `update`; [attendanceModeMigration.js](../../backend/services/attendanceModeMigration.js).
- **Scenario/impact:** normalization omits canEditSubmissions, leaving a persisted permission unassignable through normal account forms. HOD changes update User and Department independently; moving a HOD can leave the old department pointer, and department edits need not update User flags. Every boot rewrites submission_based users to attendance_review, including an explicit later administrator choice. Creation/import paths default differently.
- **Status/confidence:** confirmed source behavior; high.
- **Next step:** designate one HOD relationship and synchronize it atomically; version/retire migrations and validate account creation/import/restart round trips.

### D23 — High — Generic user update bypasses last-active-Super-Admin protection

- **Evidence:** [employeeController.js](../../backend/controllers/employeeController.js), `updateEmployee` versus `toggleStatus`, delete/bulk protections.
- **Scenario/impact:** last-SA checks protect demotion/deletion/toggling, but a permitted generic update with status inactive can deactivate the final active Super Admin without triggering those guards. Subsequent protected requests reject the account.
- **Status/confidence:** confirmed alternate mutation path; high.
- **Next step:** enforce the invariant for every role/status write and add last-account and concurrent mutation tests.

## Reliability, operations and remaining risks

### R01 — High — Synchronization success is not consistency

- **Evidence:** [businessStateSync.js](../../backend/services/businessStateSync.js), `syncEmployeeDay`, `syncEmployeeRange`, union and assignment helpers; controller catch-and-log wrappers.
- **Scenario/impact:** leave/assignment primary writes can succeed while attendance, suppression, pending, compliance or notification writes fail. Range synchronization caps at 400 days without a clear truncation signal; large historical edits can stop partially. Retargeting current assignments does not necessarily remove prior-target submissions. Concurrent find-then-create helpers rely on index failure rather than successful retry recovery.
- **Status/confidence:** confirmed boundaries/cap; potential inconsistency, high.
- **Next step:** return explicit secondary-operation status, persist repair jobs and test crash/retry/long-range reconciliation.

### R02 — High — Process-local scheduling and bus are not durable

- **Evidence:** [dailyComplianceScheduler.js](../../backend/services/dailyComplianceScheduler.js), `_lastRunKey`, `start`; [reminderScheduler.js](../../backend/services/reminderScheduler.js), `tick`; [events.js](../../backend/services/events.js); [realtime.js](../../backend/services/realtime.js).
- **Scenario/impact:** each API process runs schedulers and hosts its own SSE client map. Different instances may evaluate actions concurrently, publish to the wrong instance, or lose events on crash. Unique incident/effect indexes reduce duplicates but do not serialize balance updates. Daily scheduler records the day after per-employee failures, suppressing same-day retry. Reminder catch-up scans only a recent 20-minute window and 500 rows.
- **Status/confidence:** confirmed design; potential deployed impact, high.
- **Next step:** establish supported instance count, distributed execution/delivery ownership and a durable retry/outbox plan; verify real topology before scaling.

### R03 — Medium — Password-reset approval/send is not retryable as described

- **Evidence:** [passwordResetController.js](../../backend/controllers/passwordResetController.js), `approve`, `resetPassword`, `reject`, `listRequests`.
- **Scenario/impact:** approval saves APPROVED and cleartext reset token before email send. SMTP failure returns 500; re-approve rejects non-PENDING, and no resend route was found. Password save precedes token consumption; concurrent token uses can both pass checks. Tokens are unredacted in admin reset list documents. Approve has target-role/self guards; reject lacks the same guards, so a guessed admin reset ID can be rejected by HR even though its list omits it.
- **Status/confidence:** confirmed state/guard mismatch; potential concurrent reuse and token exposure, high.
- **Next step:** add controlled resend/consume state, hash stored tokens, avoid list disclosure and align decision permissions.

### R04 — Medium — Frontend permission state is stale after login

- **Evidence:** [authController.js](../../backend/controllers/authController.js), login response field list; [AuthContext.jsx](../../frontend/src/context/AuthContext.jsx), login versus mount-only `/auth/me` effect; [App.jsx](../../frontend/src/App.jsx).
- **Scenario/impact:** login response omits grants/attendanceMode; a fresh login does not rerun the mount effect, so granted pages may remain hidden until reload. Unguarded local user JSON parsing can fail bootstrap; failed initial me calls are swallowed until a later 401 interceptor clears the session.
- **Status/confidence:** confirmed flow; high source confidence, visual behavior unverified.
- **Next step:** refresh canonical profile after login/grant changes and test new session, reload, malformed storage and deactivation.

### R05 — Medium — Default ports, generated dependencies and test setup are not reproducible

- **Evidence:** [vite.config.js](../../frontend/vite.config.js), port5001 proxy; [server.js](../../backend/server.js), default5000; manifests omit test scripts and mongodb-memory-server. Audit build failed with an AIX esbuild package on Darwin ARM64; Mongo integration failed allocating a socket.
- **Scenario/impact:** unconfigured local API requests fail; copied/generated dependencies cannot build on this platform. CI cannot reproduce the integration test using manifest dependencies alone. Integration fixture additionally uses a too-short User password and invalid DependencyTask status.
- **Status/confidence:** confirmed defaults, dependency declaration gap, observed environmental blocks; high. Fixture errors are statically verified but not reached at runtime.
- **Next step:** establish runtime/platform and clean lockfile install procedure in a separate implementation task, declare test requirements, repair fixtures and run isolated real-database/browser tests.

### R06 — Medium — Boot performs broad data/index changes without a migration ledger

- **Evidence:** [server.js](../../backend/server.js), `syncSalaryIndexes` and startup seed/migration chain; services `dailyReviewMigration`, `customTemplate`, `dealerMigration`, `attendanceModeMigration`, `legacyMissedSubmissionArchive`.
- **Scenario/impact:** application startup backfills history, drops/syncs indexes, changes attendance configuration, archives penalties and seeds templates/rules/tags. Exceptions frequently log and continue, so health200/listening does not prove migrations/indexes succeeded. Multiple API instances can run boot transformations simultaneously.
- **Status/confidence:** confirmed startup behavior; potential data/deploy impact, high.
- **Next step:** inventory and version migrations, obtain backups/dry-run counts, separate readiness from health and verify index creation before traffic.

### R07 — Medium — Hard deletion and current definitions alter historical interpretation

- **Evidence:** employee/template/department/designation delete handlers; [templateAnalyticsController.js](../../backend/controllers/templateAnalyticsController.js), point/field fallback to current template; [customTemplate.js](../../backend/services/customTemplate.js), custom grading/formulas.
- **Scenario/impact:** deleting Users/Templates leaves dangling refs; deleting organization targets can strand assignments. Current-template fallback can change past numeric interpretation without editing the historical Submission. AuditLog and review histories are partial application records, not a complete immutable event store; audit errors are generally swallowed.
- **Status/confidence:** confirmed absence of universal cascade/snapshot immutability; potential historical/report impact, high.
- **Next step:** prefer retained identities/definitions and explicit revisions; map every destructive operation to affected refs and history before executing it.

### R08 — Medium — Upload/export and query resource limits need operational testing

- **Evidence:** leave routes memory uploads up to20×10MB; company-document MIME-only checks; [csvExporter.js](../../backend/utils/csvExporter.js), `toCSV`; user-controlled strings exported by self-review/employee CSV paths; list/search handlers and `eventOccurrences.resolveOccurrences`.
- **Scenario/impact:** uploads buffer large payloads in process RAM; MIME headers are not content-signature validation. CSV quoting does not neutralize spreadsheet formula-leading employee text. Some lists fetch all rows before slicing and regex queries lack uniform escaping/range caps. Calendar holiday calls scan all Events and query birthdays even for work-stop classification. These can become memory, export safety and latency issues at scale.
- **Status/confidence:** confirmed patterns; **potential** resource/formula risk, medium-high. No malicious file opened, spreadsheet execution, load test or query-plan measurement performed. Formula evaluation itself has restricted characters/identifier replacement; no arbitrary-code-execution conclusion is made from `new Function` alone.
- **Next step:** add content/range limits, safe spreadsheet exports and query-plan/load checks using synthetic data; verify reverse-proxy limits and backup/storage policy.

## Open questions and inspection boundary

- Which flags, rule enablement, Mongo version/topology and indexes actually exist in deployment? No configured database or hosting account was accessed.
- What is the approved payroll model, period proration, paid-overallowance policy, sanction recovery policy and closed-period policy? Source can establish arithmetic, not business intent.
- Should feature grants be organization-wide; do view/write levels and HOD fine permissions constitute contractual restrictions? The UI/config suggests restrictions that several handlers do not enforce.
- Should custom work affect generic performance/payroll? Should incident resolution retain monetary sanctions? Those decisions must precede fixes.
- Are API access logs redacted, TLS/headers/rate limiting/backups configured upstream, and how many API instances run? Repository comments/config do not prove this.
- Remaining inspection: complete browser rendering/interaction of large tables and review modals, every report-format/PDF layout branch, detailed meeting/reminder recurrence behavior, all diagnostics/backfill cleanup modes, live record reconciliation, replica-set concurrency/transaction tests and dependency vulnerability scanning. Core workflows and route/model catalogues were reviewed; this is not an exhaustive security penetration test or line-by-line audit.

The next pass should start with authorization fixtures for S02–S07 and fixed-input payroll invariance for D01, then use an isolated Mongo replica set for atomicity/retry tests. Use the coverage matrix in [Testing](TESTING_AND_DEPLOYMENT.md), not passing stub counts, to judge readiness.
