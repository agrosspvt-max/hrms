# Module reference

Paths are relative to repository root. The [API inventory](API_AND_PERMISSIONS.md) lists every mounted method, guard and handler; the [schema catalogue](DATA_MODEL_AND_SOURCES_OF_TRUTH.md) lists every model and index. The tables below group modules by actual behavior rather than filename existence. Function locations are indexed at the end. Coverage names refer to scripts in `backend/services/compliance/__tests__/`; all passing coverage is primarily stub-based unless otherwise stated. No frontend end-to-end suite was found.

## 1. Authentication, sessions and account recovery

- **Purpose/users/UI:** all account roles use `pages/Login.jsx`, `ChangePassword.jsx`, `ResetPassword.jsx`; HR uses `pages/hr/ResetRequests.jsx`. `context/AuthContext.jsx`, `api/axios.js`, `ProtectedRoute.jsx` manage cached identity, bearer requests and navigation.
- **Backend/models:** `/api/auth` → authController (login, me, password change); `/api/password-reset` → passwordResetController. User password save hook hashes with bcrypt; generateToken and auth middleware verify JWT. PasswordResetRequest stores pending approval, crypto tokens, expiry, approver, email send and use timestamps.
- **Rules/lifecycle:** active email/password login; role/grants are reloaded for HTTP requests. Reset PENDING→APPROVED/REJECTED, then APPROVED→USED. HR approval limited to employee accounts, SA needed for administrator reset, no self-approval. Reset rejects passwords below6 characters. Logout clears local state, not server tokens.
- **Effects/events:** welcome/reset email through SMTP or Resend. Reset-notification helpers exist but are no-ops; approval may succeed before email fails. Audit is best effort. SSE opens on login or existing-session mount.
- **Coverage/questions:** no dedicated login, brute-force, JWT revocation or reset integration tests found. S09, R03–R04 cover session/recovery issues.

## 2. Employees, administrator accounts and lifecycle

- **Purpose/UI:** employee register/profile, organization/job/salary details, increments, import/export, history and account status. `hr/Employees.jsx`, `EmployeeDetail.jsx`, `EmployeeTemplates.jsx`, `EmployeeLeaves.jsx`, `EmployeeWorkHistory.jsx`, `superadmin/HRManagement.jsx`, `ManageAccess.jsx`; team view `hod/HODEmployees.jsx`.
- **Backend/data:** employeeController and `/api/employees`; `/api/admin-accounts` uses employeeController.adminAccounts for the Super Admin-only account listing. User references Department/Designation and embeds HOD grants, salaryStructure, leaveBalance, probation, increments and favorites.
- **Validation/scope/state:** unique employeeId/email; HR creates/manages employee targets and cannot promote itself; SA can manage administrator roles. Active/inactive status; selective final-SA protections. Generic update uses a field whitelist; creation can accept supported schema fields through body spread. Import uses XLSX and5MB memory upload, row validation, newly created departments/designations/users and compensating rollback.
- **Dependencies/effects:** syncHodAssignment updates HOD flags/pointers; salary changes feed future slip generation; weekly offs/probation/attendance mode feed leave/work rules. Hard delete removes User only, preserving dangling history. Welcome email asynchronous; employee-created notification no-op.
- **Coverage/questions:** no full CRUD/import rollback/last-admin/password response or target-role integration suite. S04/S11, D22–D23, R07. Creation returns the saved hash because query select:false does not redact a newly created document.

## 3. Organization, HOD configuration and delegated features

- **Purpose/UI:** `hr/Organization.jsx` unifies department/designation pages; `superadmin/FeatureAccess.jsx` and ManageAccess configure role overlays/grants. Legacy `/departments` and `/designations` pages route to the unified component.
- **Backend/data:** departmentController/designationController; featurePermissionsController. Department.hodEmployeeId competes with User.isHOD/hodDepartment. FeaturePermissions is a Mixed object; User has permission update actor/time. reportingManager remains text.
- **Rules/lifecycle:** authenticated catalogue reads; HR/SA organization writes, with Department feature extension but not identical designation extension. HR/SA set grant configuration. Delete optionally reassigns selected users/designations; assignments have polymorphic targets and are not universally rewired. HOD reviewFlow/fine permission behavior depends on the consuming controller.
- **Effects/coverage:** no durable hierarchy events or dedicated integration tests identified. Permission levels have a stricter helper that is not wired into inspected routes; calling sub-permission and allowed analytics templates are explicit exceptions. S08, D22 and R07. A UI configuration label is not an enforced backend policy.

## 4. Templates and assignment scheduling

- **Purpose/UI:** `hr/WorkAssignments.jsx` unifies `Templates.jsx` and `Assignments.jsx`; employee MyTasks/dashboard renders generated work; template and sheet/custom form components implement task, Excel, sheet and custom variants.
- **Backend/data:** templateController (list/get/create/update/remove/clone/excelParse/sheetParse), assignmentController (list/create/update/remove/revoke); Template, Assignment, User, Submission. Parsers use XLSX/ExcelJS/JSZip; customTemplate provides formulas, grading and built-in report templates; scheduleHelpers resolves recurrence.
- **Rules/lifecycle:** employee/department/designation target, active schedule, one-time/daily/weekly/monthly frequency, start/end and schedule label. Holiday override once/all with reason. Custom subTemplateIds constrain seeded fields; four template types have different payload/mark rules. Clone creates a separate definition; hard delete can orphan references. Update can change targeting/active status without sharing revoke policy.
- **Effects/events:** create targets employee IDs, emits work-assigned notifications/SSE and synchronizes today's stubs via businessStateSync; update synchronizes current target sets; revoke suppresses untouched work or needs force for started work. Work-revoked notification helper is a no-op.
- **Coverage/questions:** assignmentSync, assignmentTodayVisibility, templateTaskSync and hrAddedTaskGrading cover selected stub flows. Real overlap schedules/target changes and scoped custom GET round-trips need coverage. D08, D17–D18, R01/R07; duplicate employee/template/day means separate assignments are not independent daily records.

## 5. Daily submissions, self-evaluation, review and scoring

- **Purpose/UI:** employee `EmployeeDashboard.jsx`, HR `MyTasks.jsx`; `hr/SubmissionReviews.jsx`, shared daily/submission review forms and grouped review modals, HOD `/team-reviews`. SelfReviewMode appears within Performance rather than a standalone route.
- **Backend/data:** submissionController; dailyReviewController; Submission, DailyReflection, DailyReview, Template, User, Attendance, DependencyTask. dailyEngine creates daily snapshots; customTemplate calculates formulas/marks; privateRemark/hodRecommendation utilities redact selected reads.
- **Validation/states:** own submission/draft/backlog; mandatory self-rating0–10 on submit; private remark required when configured. submitted and pending/reviewed are separate from stage submitted/under_hod/hod_reviewed/under_hr/under_super_admin/finalized. User.reviewFlow determines HOD-first routing. HOD recommendation approve/needs_changes differs from final review. Daily reflection unique employee/day; innovation marks on DailyReview unique employee/day. Standard task done/ongoing earn full points, pending participates in denominator; WNA/untouched do not. Employee extra work can have awarded marks; custom work stores separate grading caches.
- **Effects/events:** submit saves reflections/catalog changes before final work save in some paths; creates dependencies, auto-resolves old pending work and attempts penalty resolution/attendance. Review writes score/status/history, daily finalization writes DailyReview then Submission rows. Per-submission reviewed notifier is disabled; submission SSE still signals reviewer views.
- **Coverage/questions:** hrAddedTaskGrading, resubmissionSelfEval, templateTaskSync and several batch/phase tests; no comprehensive fine-permission/private-field, return/resubmit, multi-template innovation or browser suite. S05, D19–D21. GET today writes stubs/definition sync and is not a pure read despite ADR-006's intent.

## 6. Submission control, test data and history repair

- **Purpose/UI:** `hr/SubmissionControl.jsx` lists/inspects/edits, soft-deletes/restores, marks tests, performs bulk operations and XLSX export.
- **Backend/data:** submissionControlController; Submission flags/deletion metadata/editHistory; User/Template/Assignment/Department; carryForwardRebuild, penaltyMath, private remark and HOD recommendation scrubbers.
- **Rules/state:** route HR/SA or submissionControl feature, not strictly HR despite old controller comments. Soft deletion requires confirm DELETE; restore clears metadata; test flag switches analytics inclusion. Field whitelist edits tasks/customResponses/productSales/farmerRecords/reflection compatibility fields; freeze mode intentionally does not recompute all derived values or snapshot sales values.
- **Effects/events:** logs edits; deleting/restoring/testing rebuilds Calling carry-forward best effort. Analytics using liveSubmissionFilter changes on next read; attendance inference may disagree. Per-handler mutation responses are scrubbed here, unlike several daily-review editors.
- **Coverage/questions:** phase/batch tests cover selected filtering/carry-forward; no full admin tool, no transactional bulk cleanup or raw source/cache reconciliation suite. D20 and R07; canonical DailyReflection versus edited legacy reflection fields warrants reconciliation.

## 7. Leave requests, balances, policy and probation

- **Purpose/UI:** `employee/MyLeaves.jsx`, `hr/HRLeaves.jsx`, EmployeeLeaves/profile; attachments and approval-edit/force-conflict forms; probation cards.
- **Backend/data:** leaveController (apply/mine/list/calendar/decide/revoke/edit/setBalance), leaveConfigController, probationController. Leave, User.leaveBalance, singleton LeaveConfig; dateHelpers, eventOccurrences, probation service, leaveAttendance, leaveHolidaySync, businessStateSync.
- **Rules/state:** pending→approved/rejected, approved→revoked; approved edit retains originalRequest/modification audit. Full/half, paid independent of type, inclusive effective units excluding offs/merged holidays. Multi-day half input becomes full. Apply checks probation restrictions at current employment state and insufficient employee paid allowance; HR apply has different balance treatment, SA apply blocked. Pending/approved overlaps checked by range. Approval/revoke own/HR-target restrictions vary by caller role vs feature.
- **Effects/events:** paid approval increments mutable usage before leave save; revoke refunds stored paid days; edit/recalculation applies delta. Attendance rows rebuilt, untouched full-leave stubs hidden, force hides started work, conflict can retain it; reverse changes regenerate/unhide and reevaluate pending/compliance. Apply/decision notify; modified approvals use a separate notification; revocation notification intentionally disabled.
- **Coverage/questions:** leaveSync, leaveAbsentSync, leaveApprovalEdit, leaveDaysRecalc, leaveEdgeCases, leaveHolidaySync, leaveOverlap and sameDayLeaveSync cover selected stub arithmetic/flow. Real overlapping concurrent requests, half→full missing import, rollback and closed payroll changes untested. D04–D07, R01.

## 8. Attendance, confirmation and calendar notes

- **Purpose/UI:** `employee/MyAttendance.jsx`, `hr/EmployeeAttendance.jsx`, `EmployeeAttendanceTab.jsx`, attendance review queue and calendar note modal.
- **Backend/data:** attendanceController, attendanceConfirmationController, attendanceNoteController. Attendance employee/day with source auto/manual/leave, leaveId and leaveDelta; separate AttendanceConfirmation; AttendanceNote state/lock/checklist/metadata. dailyEngine derives per-day calendars, leaveAccounting computes override ownership, leaveAttendance materializes leave status.
- **Rules/state:** present/half_paid/half_unpaid/full_paid/full_unpaid/absent/weekly_off. Stored record wins, then offs/holidays/full leave/submitted work/mode/time inference. Confirm own eligible attendance_review day; reviewers select paid/unpaid/present/absent/revoke actions. Bulk operations report per-row failures. Notes owner/author/lock rules; completion/archive differ from edit permission.
- **Effects/events:** manual paid override updates only incremental balance contribution; clearing refunds its delta. Absence correction may invoke an explicit penalty choice. New action path and legacy confirmation review differ in balance behavior. Writes emit attendance:changed on selected paths; attendance inbox notification helper is a no-op. Note changes are independent business data.
- **Coverage/questions:** leave/sameDay/prodPatch/batch scripts partially cover status/accounting; not complete controller authorization, mode import/restart, manual-over-leave history or multi-instance tests. S02, D06–D07, D20/D22.

## 9. Payroll, salary structures, slips and export

- **Purpose/UI:** `hr/HRSalary.jsx`, `employee/MySalary.jsx`, salary/profile forms and increment history. Generate a period, edit item bonuses/deductions, publish/retract, download PDF/CSV.
- **Backend/data:** salaryController computeSlip/generate/generateAll/listSlips/updateSlip/retract/publish/downloadPdf/exportCsv; computePayroll, pdfGenerator, csvExporter. User salary/bank identity inputs, Attendance/Leave/Submission/DailyReview/Penalty reads; SalarySlip snapshots salaryStructure, attendance counts, payroll, employee metadata and publication status.
- **Rules/state:** inclusive period or month converted to date bounds; employee/periodKey uniqueness; draft→published with separate active/retracted/paid status. Employee reads require own published/nonretracted, management PDF uses admin role, not generic salary grant. Other management handlers have mixed grant/admin gates. Work percent and backlog are derived at generation. Pay formula combines structured components and current period attendance.
- **Effects/events:** same-period generation overwrites stored slip; metadata/attendance snapshots do not follow later source edits automatically. Keyed salary notification and salary:slip:generated are emitted. Generation notification may advertise availability while the slip is still draft. Financial penalty deducted status is an independent endpoint, not proof of a salary item.
- **Coverage/questions:** no dedicated payroll monetary-invariance/publication/PDF/finance integration suite found. D01–D03/D13 have priority; tax/employer contributions and partial/future periods require policy examples. PDF visual output not verified.

## 10. Pending work, carry-forward and dependencies

- **Purpose/UI:** dashboard backlog, `hr/GlobalBacklog.jsx`, `EmployeePendency.jsx`, `EmployeePendingManagement.jsx`, shared dependency inbox/outbox and task resolution.
- **Backend/data:** dependencyController (assignable/mine/created/listAll/chain/setStatus/resolve); pendingManagementController; pendingStateService, dependencyEngine, carryForwardRebuild, dailyEngine.getBacklog. Source Submission task identity/completedAt/resolveBy plus DependencyTask chain/parent/assignee/status.
- **Rules/state:** pending excludes completedAt; overdue depends on working-day deadline for work, some dependency display/detector thresholds use calendar aging. Dependency open↔in_progress→resolved; owner or HR/SA can resolve, HOD alone is not dependency reviewer. Pending Management is strict admin and requires resolution reason/relationship checks. Calling numeric carry-forward derives yesterday's live submitted state separately from task pending.
- **Effects/events:** submission creates handoff rows; resolution touches originating work, notifies assigner and tries to lift last overdue penalty; business sync recomputes/reevaluates work state. No unique dependency source key prevents all duplicate handoffs. Completing old task can leave cached scores stale.
- **Coverage/questions:** pendingSync, phase4/phase5, stabilization and rollout cover stub paths; real dependency chain concurrency/source replay and all formats lack coverage. D09/D20, R01/R02.

## 11. Legacy penalties and financial adjustments

- **Purpose/UI:** `hr/FinesPenalties.jsx` manual/automatic penalties, probable/active records, adjustments, reopen requests and financial resolution; dashboard/inbox employee warning surfaces.
- **Backend/data:** penaltyController/penaltyRoutes; penaltyEngine, penaltyMath, complianceRollout, legacyMissedSubmissionArchive; Penalty plus Submission/DependencyTask/User/Notification.
- **Rules/state:** category and probable/status/evaluationMode/financialStatus are separate. Automatic source gets partial unique keys. Daily legacy sweep evaluates missed submission, dependency and performance-lock inputs; rollout cutoff excludes archived historical missed/absent penalties. Reopen request is requested→approved/rejected and supports specific evaluation modes for historic work. Manual mark/percentage/financial consequences have distinct rules; own acknowledgement/dismissal is not recovery.
- **Effects/events:** finalMarks and completion percentage adjustments are attached/read dynamically; selected GET readers sweep state transitions. Financial mark-deducted stamps supplied salarySlipId/month and resolves status without proving deduction. notifyPenalty writes keyed notifications and emits penalty:changed, dropped by frontend singleton.
- **Coverage/questions:** phase9/prodPatch/rollout/batch suites cover selective arithmetic and compatibility; actual payroll integration and concurrent deduction are absent. D13–D16; preserve legacy/v2 distinction when diagnosing totals.

## 12. Compliance v2 rules, incidents, actions and ledgers

- **Purpose/UI:** `employee/MyCompliance.jsx`, WaiverRequestModal; `hr/compliance/ComplianceWorkspace.jsx`, RuleBuilderPage and incident/history/lifecycle panels.
- **Backend/data:** complianceController refresh; nested controllers rule/incident/ledger/dashboard/config/timeline. ComplianceRule, Incident, ActionEffect, Event, Waiver, Recovery and four ledgers. Registries select built-in missed-submission, performance-lock, dependency and manual detectors; ruleService validates/version-bumps; critical, scope, workingDayContext and dates determine input eligibility. ruleEvaluationScheduler runs detection→promotion→actions→recurrence/escalation.
- **Rules/state:** runtime flag layers can hide surfaces404; config exposes selected rollout flags. Scope excludes Super Admin/auto_attendance in the v2 resolver. Incident candidate→active→resolved/waived/cancelled, effects have separate statuses. Action types include mark/percentage/fine/LWP/warning/notification/lock/incentive/custom. Unique automatic naturalKey and effect incident/action/day prevent selected duplicates. ruleVersion is metadata, execution still reads current rule.
- **Effects/events:** action effects plus debit ledger intents; cancellation/recovery/waiver add credits, optional legacy mirror restricted by action/flag. Transaction wrapper conditional on topology; escrow/request state is not all in transaction. Incident/Event timelines stored plus SSE. Legacy readers mostly continue; no automatic salary/Attendance mutation from v2 financial/LWP ledger rows. Backfill/readShim/legacyGone services exist under flags, not a verified completed cutover.
- **Coverage/questions:** phases1–6/9/10, batch1–3/manualIncident/stabilization/rollout cover schema, validation, detectors, actions and compatibility with stubs. phase4.integration test environment-blocked before assertions. S07, D09–D15, R02/R06; inspect supported rollout flags before enabling features.

## 13. Performance, dashboards, self-review and reports

- **Purpose/UI:** HRDashboard/EmployeeDashboard, `hr/Performance.jsx`, SelfReviewMode, TemplateAnalytics, Calling analytics and Product/Farmer analytics. Recharts renders derived metrics; exports CSV/XLSX.
- **Backend/data:** dashboardController/dashboardAlertsController, analyticsController, dailySelfReviewController, templateAnalyticsController; Submission, DailyReflection/DailyReview, User, Assignment, DependencyTask, Penalty, Template. Scope joins current User department/designation; liveSubmissionFilter and penaltyMath affect inclusion.
- **Rules/metrics:** pendency only explicit submitted live pending units; completion reviewed live work plus daily innovation, legacy final marks and percentage adjustments; dynamic template metrics reviewed data against generated-stub denominator; self-review statistics on canonical reflections with calendar-day consistency denominator. Calling numerical field formulas/status and sales/price/NBV snapshots have dedicated paths. Main HOD analytics clamp department; self-review scope override is defective. Generic grants differ by endpoint.
- **Effects/events:** generally on-demand query/reduction, not cached analytics tables. Some legacy penalty helpers called by reads save state; expected work is not identical to persisted stub counts. Current-user cohorts and current-template fallbacks can change history. Frontend refetches on filters and selected realtime events.
- **Coverage/questions:** selected phases/batches test filters/scoring/pending, not all aggregation parity/date/cohort/export combinations. No measured query plans or browser chart validation. S03, D20, R07/R08. Complete 2,099-line analytics and 1,588-line dynamic reporting controllers were reviewed selectively, not every formatting/aggregation branch.

## 14. Events, holidays, birthdays and working-day changes

- **Purpose/UI:** shared `hr/EventsCalendar.jsx`, HR Holidays, dashboard upcoming widgets; reads available to authenticated users, writes admin/eventsHolidays grant.
- **Backend/data:** eventController/holidayController; Event, Holiday, active User.dateOfBirth; eventOccurrences, eventHolidays, workingDays, leaveHolidaySync. resolveOccurrences expands yearly/multiday events and merges real Holidays plus auto birthdays, deduping stored birthdays for the same employee/year.
- **Rules/state:** birthday classification precedes holiday; birthday events forced nonholiday; otherwise isHoliday controls work-stop. Occurrence APIs are inclusive UTC ranges. Calendar audience metadata is returned but resolver does not itself scope its results by caller audience. Event notification settings exist, but event notification firing is disabled.
- **Effects/events:** holiday edits recalculate approved leave days/balance and rebuild/sync attendance/work. Event recalc passes stored start/end dates; yearly recurrence and middle-of-span affected-leave discovery need a follow-up fixture. LeaveAttendance still uses Holiday only. Payroll snapshots are not automatically regenerated.
- **Coverage/questions:** eventCrud, leaveHolidaySync/leaveDaysRecalc and phase tests cover selective normalization/merged holidays. Recurring/multiday history and audience isolation not verified. D06, R01/R08.

## 15. Notification center, broadcasts, priority notices and realtime

- **Purpose/UI:** Notifications, SentAlerts, layout/sidebar badge, dashboard priority notices. Ordinary inbox owns recipient; sendAlerts grant/admin broadcasts to selected users and accesses shared sends.
- **Backend/data:** notificationController (send/inbox/count/read/readAll/resolve/dismiss/delete/sent/senders); notifyEvents facade, notificationProjector, EventEmitter registry, realtime service; Notification recipient/sender/eventKey/variant, priority/deadline, read/resolved/dismissed fields.
- **Rules/state:** broadcast title/message/nonempty recipient list; urgent requires deadline. Resolve urgent implicitly marks read; important clear needs read, urgent clear needs resolved. Employee deletion denied; SA delete still matches own recipient. Senders shared history uses current administrator roles by default. Keyed notifications have intended dedupe, legacy leave/assignment/manual sends use insertMany.
- **Effects/events:** in-process bus subscribers project meeting notifications; notifyEvents direct helpers emit corresponding SSE. Attendance/work-revoke/review/reset/employee-created helpers are no-ops. EventSource JWT in URL, heartbeats and process-local registry; reconnect without replay. Backend-authenticated session updates refetch pages only for client-forwarded event types.
- **Coverage/questions:** phase1/prodPatch/batch suites partially stub dedupe and events; no real index/Mongoose metadata compatibility/reconnect/multi-process delivery suite. D14–D16, S09/R02. New synthetic audit check demonstrated the rawResult metadata issue.

## 16. Reminders, derived alerts, timeline and audit

- **Purpose/UI:** backend reminder/derived-alert/activity-timeline API surfaces and Super Admin/granted AuditLog page. Compliance-specific timeline is consumed by MyCompliance and incident panels; no frontend call sites for the general `/reminders`, `/timeline` or `/dashboard/alerts` APIs were found in src.
- **Backend/data:** reminderController; reminder service createOrUpdate/applyAction and reminderProjector; Reminder hash/deadline/actionKind/completed/dismissed/snoozed/cadence. reminderScheduler; dashboardAlertsController derives current cards. timelineController/timeline service derives merged source history, while ComplianceEvent is a separate persisted event stream. auditController/utils.audit writes AuditLog.
- **Rules/state:** reminder owner actions, strict admin create/edit/cancel/complete; active unique hash, done/dismiss/snooze; own timeline plus admin/HODdept. Audit route SA or auditLog grant; timestamps/actor/target metadata. Derived alerts do not imply a corresponding Notification row.
- **Effects/events:** projector creates actionable reminders after business events; due scheduler emits reminder:changed and stamps lastFiredAt without notification. Source histories joined per request; own general timeline adapters omit interaction-note visibility and personal-note author checks (S10). Event completion emits domain event; SSE types missing client registration. No proof all cadence fields implement scheduled recurrence.
- **Coverage/questions:** late phases/batches provide stub coverage; no long-offline catch-up, recurrence, privacy or immutable-history integration suite. S10, R02/R07 and D15/D16. Reuse existing [ADR index](../ADR/README.md) and [event registry](../EVENT_REGISTRY.md) as intentions, not runtime assertions.

## 17. Interactions, meetings, knowledge notes and tags

- **Purpose/UI:** `hr/interactions/InteractionsWorkspace.jsx`, legacy EmployeeInteractions/ManageInteractionTags sources, employee MyInteractions; meetings/RSVP/attendance, HR case notes, warnings/appreciation, follow-ups, personal notes and typed knowledge entries.
- **Backend/data:** interactionController, interactionTagController, noteController; Interaction with embedded participants/meeting/followUp and searchText; InteractionNote; InteractionTag; Note and NoteType. Tag/mention search joins User; meeting service and bus/projectors support notifications/reminders.
- **Rules/state:** invitation statuses and attendance tracked per participant; respond matches current participant. Reviewers edit meeting/content/participants/attendance/follow-up. Ordinary detail needs participant+employee_visible (or author); HOD treated reviewer without dept clamp. list/analytics HOD clamp differs from protect-only detail/timeline. Note personal entries are author-private; nonpersonal records are broad despite visibility metadata. NoteType deletion requires zero entries, otherwise archive.
- **Effects/events:** create publishes interaction.created after persistence, projector emits notifications; audits preserve action metadata best effort. Delete Interaction then delete notes is separate writes. Warning tags feed analytics, not proof of an automatic compliance fine. Module follow-up attendance is meeting attendance, not employee daily Attendance.
- **Coverage/questions:** no dedicated interaction/notes authorization/RSVP/search/privacy/browser suite found. S06/R07/R08. Detailed recurrence/meeting projections reviewed selectively.

## 18. Contacts and product/dealer/quantity catalogues

- **Purpose/UI:** Contacts available to authenticated users; Products management with product/dealer/quantity tabs; sales/farmer report pickers consume catalogues.
- **Backend/data:** contactController and productController/dealerController; Contact external or linked-employee live hydration, User.favoriteContacts; Product.pricePerUnit/nbvPercentage/unit; Dealer firmName/place/dealerName; Quantity label/value/unit. `/api` product router mounts three catalogue families.
- **Rules/state:** authenticated read, corresponding enabled feature/admin writes; unique catalogue keys, active/status toggles, delete vs deactivate. Employee-contact hydration reads selected current User identity/job fields and fallback snapshots; per-user favorites and view counter. Dealer schema migration changes legacy name uniqueness to firmName/place.
- **Effects/events:** product/quantity/dealer prices and NBV are snapshotted in Submission rows; edits should not automatically rewrite saved sales values. CSV contact export plus product/dealer workbook samples, exports and5MB memory imports; no dedicated realtime catalogue refresh contract confirmed.
- **Coverage/questions:** selected phase/batch custom report fixtures, no full catalogue scope/input/concurrent uniqueness/export suite. S08/R07/R08. Distinguish farmerRecords personal data in submissions from the Contact collection.

## 19. Attachments, company policy documents, parsers and exports

- **Purpose/UI:** leave attachment upload/inline/download in MyLeaves/HR leaves; CompanyDocuments source and dashboard document components; salary PDF, employee/contact/self-review CSV, analytics/submission-control XLSX and template parser workflows.
- **Backend/data:** leaveAttachmentController with two-phase LeaveAttachment orphan/link; companyDocumentController with CompanyDocument buffer/select:false; excelParser/sheetParser, ExcelJS/XLSX/JSZip, csvExporter/pdfGenerator.
- **Rules/state:** uploaded files stored in Mongo buffers, not local/cloud storage. Leave up to20 files,10MB each; PDF/images MIME allowlist, owner or HR/SA reads, explicit ID/ownership validation. PDF policy file10MB MIME; employee only active+visibleToEmployees, HR/SA all. Replace retains same document ID; hard delete removes file. Unsupported leave storage provider returns501. Buffer hydration/coercion handles Mongo Binary conversion. Files use private/no-store or no-store responses and encoded filenames.
- **Effects/events:** attachment upload before leave creation can leave unlinked files; no comprehensive orphan GC verified. Spreadsheet/parser fields seed templates; exports derive controller data and may buffer in process memory. Document write audits best effort; no universal file virus/content-signature check.
- **Coverage/questions:** no actual PDF byte/layout, MIME spoof, malicious CSV/formula, download authorization or upload stress suite run. R08/S09. Existing source alone does not prove an App route for company management.

## Source function and dependency index

The following lists controller-owned async handlers and local require dependencies. It supports navigating less frequently used operations without duplicating their source. Middleware and controller checks must still be read together; helper names do not prove a workflow succeeds. Non-handler helper functions are intentionally omitted here.

### backend/controllers/analyticsController.js

[analyticsController.js](../../backend/controllers/analyticsController.js)

Handlers: `pendency`, `completion`, `assignmentAnalytics`, `callingAnalytics`, `myCallingAnalytics`, `exportCallingAnalytics`, `callingRoster`, `scopeOptions`.

Local dependencies: `../models/User`, `../models/Submission`, `../models/DependencyTask`, `../models/Assignment`, `../models/Department`, `../models/Designation`, `../models/Template`, `../utils/dateHelpers`, `../utils/submissionFilter`, `../services/pendingStateService`, `../services/penaltyMath`, `../models/DailyReview`, `../models/Penalty`, `../models/Dealer`.

### backend/controllers/assignmentController.js

[assignmentController.js](../../backend/controllers/assignmentController.js)

Handlers: `list`, `create`, `update`, `remove`, `revoke`, `stats`.

Local dependencies: `../models/Assignment`, `../models/User`, `../models/Submission`, `../models/DependencyTask`, `../utils/scheduleHelpers`, `../services/notifyEvents`, `../services/businessStateSync`, `../utils/audit`.

### backend/controllers/attendanceConfirmationController.js

[attendanceConfirmationController.js](../../backend/controllers/attendanceConfirmationController.js)

Handlers: `todayMine`, `confirm`, `queueForDay`, `review`, `actOne`, `bulkAct`.

Local dependencies: `../models/User`, `../models/Holiday`, `../models/Leave`, `../models/Attendance`, `../models/AttendanceConfirmation`, `../utils/dateHelpers`, `../utils/audit`, `../utils/leaveAccounting`, `../services/realtime`, `../services/eventOccurrences`.

### backend/controllers/attendanceController.js

[attendanceController.js](../../backend/controllers/attendanceController.js)

Handlers: `mine`, `ofEmployee`, `setStatus`, `clearStatus`, `bulkSetStatus`, `bulkRangePreview`, `bulkRangeApply`.

Local dependencies: `../models/User`, `../models/Attendance`, `../services/dailyEngine`, `../utils/dateHelpers`, `../utils/audit`, `../services/realtime`, `../utils/leaveAccounting`, `../models/Submission`, `../models/Penalty`, `../config/featureFlags`, `../models/ComplianceRule`, `../services/compliance`, `../services/notifyEvents`, `../models/Leave`, `../models/Holiday`.

### backend/controllers/attendanceNoteController.js

[attendanceNoteController.js](../../backend/controllers/attendanceNoteController.js)

Handlers: `list`, `create`, `patch`, `remove`, `daySummary`.

Local dependencies: `../models/AttendanceNote`, `../models/User`, `../utils/dateHelpers`.

### backend/controllers/auditController.js

[auditController.js](../../backend/controllers/auditController.js)

Handlers: `list`.

Local dependencies: `../models/AuditLog`.

### backend/controllers/authController.js

[authController.js](../../backend/controllers/authController.js)

Handlers: `login`, `me`, `changePassword`.

Local dependencies: `../models/User`, `../utils/generateToken`.

### backend/controllers/companyDocumentController.js

[companyDocumentController.js](../../backend/controllers/companyDocumentController.js)

Handlers: `list`, `inline`, `upload`, `update`, `replaceFile`, `remove`.

Local dependencies: `../utils/audit`, `../models/CompanyDocument`.

### backend/controllers/compliance/configController.js

[configController.js](../../backend/controllers/compliance/configController.js)

Handlers: `get`.

Local dependencies: `../../config/featureFlags`, `../../config/complianceRollout`, `../../models/ComplianceRule`, `../../services/compliance/rules/ruleService`, `../../services/compliance/registry/detectorRegistry`.

### backend/controllers/compliance/dashboardController.js

[dashboardController.js](../../backend/controllers/compliance/dashboardController.js)

Handlers: `summary`, `mostPenalised`, `commonViolations`, `pendingWaivers`, `financialTotals`, `trends`.

Local dependencies: `../../models/ComplianceIncident`, `../../models/ComplianceWaiver`, `../../models/FinancialLedger`, `../../models/User`, `../../config/featureFlags`, `../../models/Department`.

### backend/controllers/compliance/incidentController.js

[incidentController.js](../../backend/controllers/compliance/incidentController.js)

Handlers: `list`, `get`, `create`, `cancel`, `activate`, `resolve`, `recover`, `waiveDirect`, `waiveRequest`, `waiveDecide`.

Local dependencies: `../../models/ComplianceIncident`, `../../models/ComplianceRule`, `../../models/ComplianceActionEffect`, `../../models/ComplianceWaiver`, `../../config/featureFlags`, `../../utils/audit`, `../../services/compliance`, `../../services/compliance/waiver/waiverService`, `../../services/compliance/recovery/recoveryService`.

### backend/controllers/compliance/ledgerController.js

[ledgerController.js](../../backend/controllers/compliance/ledgerController.js)

Handlers: `get`.

Local dependencies: `../../config/featureFlags`, `../../models/MarksLedger`, `../../models/FinancialLedger`, `../../models/PercentageLedger`, `../../models/AttendanceLedger`.

### backend/controllers/compliance/ruleController.js

[ruleController.js](../../backend/controllers/compliance/ruleController.js)

Handlers: `list`, `get`, `create`, `update`, `enable`, `disable`, `history`.

Local dependencies: `../../services/compliance/rules/ruleService`, `../../config/featureFlags`, `../../models/AuditLog`.

### backend/controllers/compliance/timelineController.js

[timelineController.js](../../backend/controllers/compliance/timelineController.js)

Handlers: `me`, `forEmployee`, `forIncident`.

Local dependencies: `../../models/ComplianceIncident`, `../../config/featureFlags`, `../../services/compliance/timeline/timelineService`.

### backend/controllers/complianceController.js

[complianceController.js](../../backend/controllers/complianceController.js)

Handlers: `refresh`, `refreshAll`.

Local dependencies: `../services/penaltyEngine`, `../utils/dateHelpers`, `../services/dailyComplianceScheduler`.

### backend/controllers/contactController.js

[contactController.js](../../backend/controllers/contactController.js)

Handlers: `list`, `get`, `create`, `update`, `toggleStatus`, `remove`, `exportCsv`, `myFavorites`, `favorite`, `unfavorite`, `view`, `analytics`.

Local dependencies: `../models/Contact`, `../models/User`, `../utils/csvExporter`.

### backend/controllers/dailyReviewController.js

[dailyReviewController.js](../../backend/controllers/dailyReviewController.js)

Handlers: `listGrouped`, `getDay`, `getMyReflection`, `saveReflection`, `finalizeDay`, `editTaskStatus`, `editTaskMarks`, `bulkFinalize`, `editSubmissionValue`.

Local dependencies: `../models/Submission`, `../models/User`, `../models/DailyReflection`, `../models/DailyReview`, `../models/DependencyTask`, `../models/Leave`, `../models/Attendance`, `../models/Assignment`, `../models/Holiday`, `../utils/dateHelpers`, `../utils/submissionFilter`, `../utils/scheduleHelpers`, `../utils/audit`, `../services/notifyEvents`, `../utils/privateRemark`, `../utils/hodRecommendation`, `../config/complianceRollout`, `../services/expectedSubmissions`, `../models/AttendanceConfirmation`, `../models/Penalty`, `../services/eventOccurrences`, `../services/customMarks`.

### backend/controllers/dailySelfReviewController.js

[dailySelfReviewController.js](../../backend/controllers/dailySelfReviewController.js)

Handlers: `overview`, `employeeDetail`, `ideasLibrary`, `notesLibrary`, `exportCsv`, `breakdown`.

Local dependencies: `../models/DailyReflection`, `../models/User`, `../models/Submission`, `../models/Attendance`, `../utils/dateHelpers`.

### backend/controllers/dashboardAlertsController.js

[dashboardAlertsController.js](../../backend/controllers/dashboardAlertsController.js)

Handlers: `mine`.

Local dependencies: `../models/Penalty`, `../models/Leave`, `../models/Interaction`, `../models/Notification`, `../models/Submission`, `../models/Reminder`, `../utils/dateHelpers`.

### backend/controllers/dashboardController.js

[dashboardController.js](../../backend/controllers/dashboardController.js)

Handlers: `hrToday`, `hrBacklog`, `hrPerformance`, `hrSummary`, `employeeSummary`.

Local dependencies: `../models/User`, `../models/Submission`, `../models/Department`, `../models/Leave`, `../utils/dateHelpers`, `../services/dailyEngine`, `../utils/submissionFilter`, `../services/pendingStateService`, `../models/DailyReview`.

### backend/controllers/dealerController.js

[dealerController.js](../../backend/controllers/dealerController.js)

Handlers: `listDealers`, `createDealer`, `updateDealer`, `deactivateDealer`, `importSample`, `exportDealers`, `importBulk`.

Local dependencies: `../models/Dealer`, `../utils/audit`.

### backend/controllers/departmentController.js

[departmentController.js](../../backend/controllers/departmentController.js)

Handlers: `list`, `create`, `update`, `remove`, `orgStructure`.

Local dependencies: `../models/Department`, `../models/Designation`, `../models/User`.

### backend/controllers/dependencyController.js

[dependencyController.js](../../backend/controllers/dependencyController.js)

Handlers: `assignable`, `mine`, `mineCount`, `created`, `listAll`, `chain`, `setStatus`, `resolve`.

Local dependencies: `../models/DependencyTask`, `../models/User`, `../services/dependencyEngine`, `../services/penaltyEngine`.

### backend/controllers/designationController.js

[designationController.js](../../backend/controllers/designationController.js)

Handlers: `list`, `create`, `update`, `remove`.

Local dependencies: `../models/Designation`, `../models/User`.

### backend/controllers/employeeController.js

[employeeController.js](../../backend/controllers/employeeController.js)

Handlers: `listEmployees`, `getEmployee`, `createEmployee`, `updateEmployee`, `teamList`, `deleteEmployee`, `toggleStatus`, `resetPassword`, `exportCsv`, `workHistory`, `attendanceSummary`, `leaveHistory`, `addIncrement`, `editIncrement`, `deleteIncrement`, `adminAccounts`, `importTemplate`, `importBulk`, `bulkAction`.

Local dependencies: `../models/User`, `../models/Department`, `../models/Designation`, `../models/Submission`, `../models/Leave`, `../models/DependencyTask`, `../utils/csvExporter`, `../utils/audit`, `../utils/emailService`, `../utils/dateHelpers`, `../utils/submissionFilter`, `../services/dailyEngine`, `../services/notifyEvents`, `../models/Notification`, `../models/Event`.

### backend/controllers/eventController.js

[eventController.js](../../backend/controllers/eventController.js)

Handlers: `list`, `get`, `create`, `update`, `remove`, `upcoming`, `birthdaysToday`, `analytics`.

Local dependencies: `../models/Event`, `../models/User`, `../services/eventOccurrences`, `../utils/dateHelpers`, `../services/leaveHolidaySync`, `../models/Holiday`.

### backend/controllers/featurePermissionsController.js

[featurePermissionsController.js](../../backend/controllers/featurePermissionsController.js)

Handlers: `listEmployees`, `getOne`, `update`, `copyFrom`, `reset`.

Local dependencies: `../models/User`, `../utils/audit`.

### backend/controllers/holidayController.js

[holidayController.js](../../backend/controllers/holidayController.js)

Handlers: `list`, `create`, `update`, `remove`.

Local dependencies: `../models/Holiday`, `../utils/dateHelpers`, `../services/leaveHolidaySync`.

### backend/controllers/interactionController.js

[interactionController.js](../../backend/controllers/interactionController.js)

Handlers: `list`, `create`, `getOne`, `update`, `remove`, `addNote`, `updateNote`, `removeNote`, `setParticipants`, `respond`, `setAttendance`, `resolveFollowUp`, `analytics`, `timeline`, `mine`, `mentions`.

Local dependencies: `../models/Interaction`, `../models/InteractionNote`, `../models/InteractionTag`, `../models/User`, `../utils/audit`, `../services/events`.

### backend/controllers/interactionTagController.js

[interactionTagController.js](../../backend/controllers/interactionTagController.js)

Handlers: `list`, `create`, `update`, `remove`.

Local dependencies: `../models/InteractionTag`, `../utils/audit`.

### backend/controllers/leaveAttachmentController.js

[leaveAttachmentController.js](../../backend/controllers/leaveAttachmentController.js)

Handlers: `upload`, `listForLeave`, `getMeta`.

Local dependencies: `../models/LeaveAttachment`, `../models/Leave`.

### backend/controllers/leaveConfigController.js

[leaveConfigController.js](../../backend/controllers/leaveConfigController.js)

Handlers: `get`, `update`.

Local dependencies: `../models/LeaveConfig`, `../utils/audit`, `../services/probation`.

### backend/controllers/leaveController.js

[leaveController.js](../../backend/controllers/leaveController.js)

Handlers: `apply`, `myLeaves`, `listAll`, `decide`, `setBalance`, `calendar`, `revoke`, `edit`.

Local dependencies: `../models/Leave`, `../models/User`, `../models/Department`, `../models/Notification`, `../utils/dateHelpers`, `../models/Holiday`, `../utils/audit`, `../services/notifyEvents`, `../models/LeaveAttachment`, `../services/probation`, `../services/eventOccurrences`, `../services/leaveAttendance`, `../services/businessStateSync`, `../services/realtime`, `../services/events`.

### backend/controllers/noteController.js

[noteController.js](../../backend/controllers/noteController.js)

Handlers: `listTypes`, `createType`, `updateType`, `deleteType`, `list`, `create`, `getOne`, `update`, `remove`.

Local dependencies: `../models/Note`, `../models/NoteType`, `../models/InteractionTag`, `../utils/audit`.

### backend/controllers/notificationController.js

[notificationController.js](../../backend/controllers/notificationController.js)

Handlers: `send`, `myPriority`, `myInbox`, `unreadCount`, `markRead`, `markAllRead`, `remove`, `resolve`, `dismissDashboard`, `sentList`, `listSenders`.

Local dependencies: `../models/Notification`, `../models/User`, `../services/realtime`.

### backend/controllers/passwordResetController.js

[passwordResetController.js](../../backend/controllers/passwordResetController.js)

Handlers: `requestReset`, `listRequests`, `pendingCount`, `approve`, `reject`, `validateToken`, `resetPassword`.

Local dependencies: `../models/PasswordResetRequest`, `../models/User`, `../utils/emailService`, `../utils/audit`, `../services/notifyEvents`.

### backend/controllers/penaltyController.js

[penaltyController.js](../../backend/controllers/penaltyController.js)

Handlers: `dashboard`, `mine`, `createManual`, `cancel`, `acknowledge`, `dismissNotification`, `requestReopening`, `decideReopen`, `overridePendingDeadline`, `restoreRange`, `waiveFinancial`, `resolveFinancial`, `listPendingFinancial`, `markFinancialDeducted`, `analyticsSummary`.

Local dependencies: `../models/Penalty`, `../models/User`, `../utils/audit`, `../utils/dateHelpers`, `../services/notifyEvents`, `../services/penaltyMath`, `../services/realtime`, `../config/complianceRollout`, `../services/deprecations`, `../models/Submission`, `../services/performanceRecovery`, `../utils/workingDays`, `../services/penaltyEngine`.

### backend/controllers/pendingManagementController.js

[pendingManagementController.js](../../backend/controllers/pendingManagementController.js)

Handlers: `list`, `resolve`.

Local dependencies: `../models/User`, `../models/Submission`, `../services/pendingStateService`, `../utils/dateHelpers`, `../utils/audit`, `../models/Template`, `../models/DependencyTask`.

### backend/controllers/probationController.js

[probationController.js](../../backend/controllers/probationController.js)

Handlers: `mine`, `ofEmployee`.

Local dependencies: `../models/User`, `../services/probation`.

### backend/controllers/productController.js

[productController.js](../../backend/controllers/productController.js)

Handlers: `listProducts`, `createProduct`, `updateProduct`, `deactivateProduct`, `listQuantities`, `createQuantity`, `updateQuantity`, `deactivateQuantity`, `importSample`, `exportProducts`, `importBulk`.

Local dependencies: `../models/Product`, `../models/Quantity`, `../utils/audit`.

### backend/controllers/reminderController.js

[reminderController.js](../../backend/controllers/reminderController.js)

Handlers: `mine`, `create`, `update`, `cancel`, `complete`.

Local dependencies: `../models/Reminder`, `../services/reminders`, `../services/events`, `../services/realtime`, `../utils/audit`.

### backend/controllers/salaryController.js

[salaryController.js](../../backend/controllers/salaryController.js)

Handlers: `generate`, `generateAll`, `mySlips`, `listSlips`, `downloadPdf`, `updateSlip`, `exportCsv`, `retract`, `bulkRetract`, `bulkGenerateForEmployees`, `publishSlips`.

Local dependencies: `../models/User`, `../models/Submission`, `../models/SalarySlip`, `../utils/submissionFilter`, `../services/dailyEngine`, `../utils/dateHelpers`, `../utils/pdfGenerator`, `../utils/csvExporter`, `../utils/payroll`, `../utils/audit`, `../services/notifyEvents`, `../services/penaltyMath`, `../models/DailyReview`, `../services/eventOccurrences`, `../models/Attendance`.

### backend/controllers/submissionControlController.js

[submissionControlController.js](../../backend/controllers/submissionControlController.js)

Handlers: `list`, `get`, `update`, `remove`, `restore`, `markTest`, `bulkDelete`, `bulkRestore`, `bulkMarkTest`, `exportFiltered`, `rebuildScores`, `rebuildAnalytics`, `rebuildCarryForwardEndpoint`, `filterOptions`.

Local dependencies: `../models/Submission`, `../models/User`, `../models/Template`, `../models/Assignment`, `../models/Department`, `../utils/audit`, `../services/carryForwardRebuild`, `../utils/privateRemark`, `../utils/hodRecommendation`, `../services/penaltyMath`.

### backend/controllers/submissionController.js

[submissionController.js](../../backend/controllers/submissionController.js)

Handlers: `getToday`, `submitOne`, `completeBacklogTask`, `history`, `listForReview`, `reviewSubmission`, `listForHodReview`, `hodReviewSubmission`, `bulkReview`, `saveDraft`.

Local dependencies: `../models/Submission`, `../models/User`, `../models/Leave`, `../models/Holiday`, `../models/Department`, `../models/Notification`, `../models/Attendance`, `../models/Template`, `../models/DependencyTask`, `../services/dailyEngine`, `../services/dependencyEngine`, `../utils/dateHelpers`, `../utils/submissionFilter`, `../services/realtime`, `../utils/privateRemark`, `../utils/hodRecommendation`, `../services/penaltyEngine`, `../services/penaltyMath`, `../models/Penalty`, `../services/eventOccurrences`, `../utils/audit`, `../models/DailyReflection`, `../services/customTemplate`, `../services/customMarks`, `../models/Product`, `../models/Quantity`, `../models/Dealer`, `../utils/workingDays`, `../services/pendingStateService`, `../services/notifyEvents`.

### backend/controllers/templateAnalyticsController.js

[templateAnalyticsController.js](../../backend/controllers/templateAnalyticsController.js)

Handlers: `list`, `generate`, `remove`, `removeBulk`, `assignedEmployees`.

Local dependencies: `../models/Template`, `../models/Submission`, `../models/User`, `../models/Assignment`, `../utils/dateHelpers`, `../utils/submissionFilter`.

### backend/controllers/templateController.js

[templateController.js](../../backend/controllers/templateController.js)

Handlers: `list`, `get`, `create`, `update`, `remove`, `excelParse`, `sheetParse`, `clone`.

Local dependencies: `../models/Template`, `../utils/excelParser`, `../utils/sheetParser`.

### backend/controllers/timelineController.js

[timelineController.js](../../backend/controllers/timelineController.js)

Handlers: `mine`, `forEmployee`.

Local dependencies: `../services/timeline`, `../models/User`.
