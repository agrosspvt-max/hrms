# Business workflows

These traces describe source behavior at `91aae29`, not verified production outcomes. Every path starts with the shared Axios/bearer pipeline unless marked public. `protect` loads the current active User; route feature/role gates and controller ownership checks are separate layers. SSE is an ephemeral refresh signal, not commit confirmation. See [API inventory](API_AND_PERMISSIONS.md) for exact handler declarations and [Known issues](KNOWN_ISSUES_AND_RISKS.md) for failure scenarios.

## A. Employee and authentication lifecycle

### Create, import and change an account

1. Employees/HRManagement form → POST `/api/employees` (the administrator-account router is a separate GET listing) → protect plus HR/SA role guard. `employeeController.createEmployee` checks required identity and caller/target role, normalizes HOD/weekly-off and related profile inputs.
2. Creates User; password hook hashes on save. If no password is supplied, a shared default is used; its value is intentionally omitted here. Salary/bank/probation/leave fields are embedded. Newly created document responses need explicit password redaction verification.
3. `syncHodAssignment` may clear another User's HOD flag for the department and update Department.hodEmployeeId. Welcome email is asynchronous; no-op employee-created notifier does not prove inbox delivery. Audit is best effort.
4. PUT `/api/employees/:id` allows listed fields; HR cannot mutate self/administrator targets or promote roles. SA can change roles; selected last-SA checks apply on demotion. Generic status update lacks the final-active-SA guard enforced by toggle/delete (D23).
5. Deactivation changes status; new protected requests reload and reject it, but open SSE connections are not revalidated. Hard deletion only removes User, leaving historical references. Department/designation changes affect current cohort/target resolution; historical submissions are not department snapshots.
6. XLSX import: POST `/api/employees/import`, upload5MB → parse/validate rows → create needed organization data/users → on failure attempt to delete newly created documents. Email/audit and rollback failures are outside a transaction. Import attendanceMode default differs from normal creation until boot migration.

### Login, logout and password change/reset

- Login form → public POST `/api/auth/login` → active User plus password comparison → JWT with id/expiry and selected user payload. AuthContext persists token/user, opens SSE, navigates. Login payload does not contain all fields returned by `/auth/me`; mount-only me refresh can leave fresh login grants stale.
- Every Axios call injects bearer. 401 clears local session and redirects. Logout closes SSE and deletes local storage; no server logout or JWT denylist. Password change saves a newly hashed password without revoking older JWTs.
- Forgot-password request → public POST `/api/password-reset/request` → email/account check and five-minute recent PENDING dedupe → PasswordResetRequest PENDING. Reset-request notifier is disabled.
- HR/SA approves via POST `/:id/approve` → checks PENDING, target account role and no self-approval → crypto token/expiry and APPROVED save → send reset email → stamp emailSentAt/audit. Failure after approval returns500 with persisted approval; reapproval rejects, no resend path found. Rejection changes PENDING→REJECTED but lacks approval's identical target checks.
- Reset page validates URL token publicly, then POST `/reset` → checks token/status/expiry/unused/password minimum → User password save → request USED, token cleared. Token consumption is after password save, not an atomic claim, so concurrent use requires testing. No token or personal employee values are included in these documents.

## B. Leave lifecycle

### Apply, reject and approve

1. MyLeaves form optionally uploads attachments first, then POST `/api/leaves` with range/type/dayType/reason and attachmentIds. `leaveController.apply` owns the record to req.user and blocks SA application.
2. Normalize inclusive UTC dates, reject invalid/reversed ranges; a multi-day half selection becomes full. Current weekly offs and `eventOccurrences.holidayDaySet` determine effective units. Zero working units rejected. Probation restricted types are checked against current probation state; failure reading policy is soft in relevant branches.
3. Paid is initially derived from leaveType except unpaid. Ordinary employee application checks remaining usage allowance; pending requests do not reserve balance. Query pending/approved date overlaps; this preflight is not atomic. Create pending Leave with stored days. Link uploaded orphan IDs owned by caller, best effort. Emit leave-applied notifications/SSE to active HR/SA and return record.
4. HRLeaves decision → PATCH `/api/leaves/:id/decision` → roleOrFeature leaveApprovals → controller PENDING + no self/target-role checks. HR cannot decide HR/SA leave; a feature employee is not the same literal-role path and has no general dept restriction.
5. **Reject:** save rejected, actor/time/note; no paid debit. Notify decision and publish leave.status.changed; queue refresh uses leave:decision.
6. **Approve:** may edit requested dates/type/day type. Capture originalRequest once when modified. Recalculate effective units on relevant date/day changes, check approved overlaps, save paid usage on User first, then approved Leave. Approval need not spill overallowance units into unpaid automatically; current paid flag is authoritative.
7. Attempt leaveAttendance sync, then businessStateSync over affected range; audit and approval/modified notification. Secondary failures are caught/logged; success does not establish cross-model consistency.

### Full/half, edit/revoke and holidays

- Full working-day leave creates full_paid/full_unpaid Attendance with source leave. Half creates half_paid/half_unpaid and should retain daily work. Manual positive attendance may be respected; manual absence can be superseded. LeaveAttendance excludes Holiday collection dates and weekly offs but not all Event holidays, unlike effective unit calculation.
- PUT `/api/leaves/:id` approved edit validates whitelist, dates/units/approved overlaps and proposed difference. Type and paid are separately editable and can diverge. Preflight dry-run uses current persisted leave; half→full explicit Submission lookup references an unimported model and is caught. The controller can therefore persist proposed leave/balance/attendance before discovering started-work conflicts. Force requires forceReason on intended conflict override paths.
- POST `/:id/revoke`: approve-state/no-self/target checks → subtract stored paid days from User.used, clamp nonnegative → save Leave revoked metadata → remove source-leave Attendance rows with matching leaveId → synchronize union of old/new dates and audit. Revocation notification is intentionally disabled. Manually overwritten attendance has different source and may retain a stale leaveId link; do not assume revocation removes it.
- Holiday/Event holiday CRUD → leaveHolidaySync finds affected approved leaves → compute revised days from current unified calendar → apply balance delta, save days, clear/rebuild attendance, sync work/pending/compliance. Calendar edits can change historic usage; no automatic salary snapshot correction. Event mutation discovery passes stored start/end dates, so recurring and inner-span leave matching remains a follow-up question.
- Effective leave unit arithmetic and correct manual override ownership do not prevent concurrent lost updates or partial User/Leave writes (D05).

### Leave-to-work synchronization

`businessStateSync.syncEmployeeDay` loads User, approved leave and daily work:

1. Full-day leave: materialize attendance; untouched live stubs get hidden=true/hiddenSource=leave. Started/submitted work is retained and reported as conflict unless force explicitly hides it. Suppression preserves documents for audit.
2. Half/no full leave: ensure eligible daily submissions; unhide leave-origin or compatible legacy hidden rows while keeping assignment-origin hiding separate. Work generation still respects schedule and calendar/override conditions.
3. Recompute pending/dependency-derived state and attempt compliance resolution/re-evaluation. It is possible to resolve missed incidents for an existing submission that remained as a work conflict; incident status change alone does not reverse v2 effects.
4. Emit working_day:changed to affected employee, domain working_day.synced for projectors. Client singleton forwards this specific type, allowing dashboard refresh.
5. Range helper iterates inclusive dates with cap400; union old/new range uses min/max and can include gaps. Read result counters/conflicts; secondary catch-and-log failures/truncation are not a durable repair queue.

## C. Assignment → submission → review → scoring

### Definition, generation and draft

1. WorkAssignments form creates/parses/clones a task/Excel/sheet/custom Template via corresponding gated APIs. Structure, points, status fields, formulas, sheet grid and extra-task catalogue differ by type. Parsing uploaded workbook structure is not executing a workbook macro.
2. POST `/api/assignments`: protect + assignments grant/HR → validate target, template, recurrence/dates/override; HR direct-employee targeting has admin/self restrictions, group targets differ → Assignment.create → notify target employees → sync today's work.
3. Employee dashboard calls GET `/api/submissions/today`. `getToday` invokes `ensureDailySubmissions`; active assignments matching employee/department/designation and schedule are considered. Full leave/nonworking day stops normal work; holiday override once at start/all can permit generation.
4. Find/create Submission keyed by employee/template/date. It snapshots tasks, points/critical flags, sheet structure, type/schedule/override and selected custom responses. Two matching assignments with the same template/day share a row. Template.isActive is not consistently consulted. Hidden/test/deleted existing key can block new generation or remain inconsistent between readers.
5. getToday then synchronizes current tasks/custom fields into unsubmitted records, preserving certain edited task snapshots. Assignment subTemplate scope is not persisted in Submission, so custom sync can expand it to all fields (D17). Saving drafts changes lastDraftSavedAt and task/response content; draft visibility counts as started work for some suppression checks.

### Submit and downstream effects

1. Dashboard/MyTasks submit → own submit endpoint → owner lookup and already-submitted check. A queryable own ID is not by itself a live/schedule/leave restriction. Historical work may be gated by a legacy missed penalty/reopen decision; no such penalty can leave a different path open.
2. Holiday gate checks **today**, not saved assignment date/override, conflicting with generated override work (D18). Validate self-rating0–10; save DailyReflection for sub.date. Process task/custom/Excel/sheet values, pending reasons/deadlines and extra work/catalogue.
3. Calculate task points or row/cell awards. Done/ongoing standard tasks earn full points. Pending counts available total; WNA/untouched do not. Custom grade totals stored separately; generic earned/total may remain zero.
4. Mark submitted/submittedAt/stage. Employee User.reviewFlow hod_first selects HOD; HR-owned work routes to Super Admin; HOD/self and missing-manager cases route differently. Template.reviewFlow is not the sole effective review route.
5. Resolve absent/missed sanctions before remaining required private-remark validation/final save in the current order. A validation400 can follow secondary writes (D19). Save Submission.
6. Auto-resolve matching historic backlog rows (ID/title) when newer done/ongoing work fulfills them; this can alter task status without cached score recomputation. Create DependencyTask handoffs and save pointers, best effort. Attendance helper is keyed to today in relevant submission-time handling even for historical work. Emit submission:submitted to reviewers; disabled review notifier is not proof of a delivery row.

### Review, return recommendation and daily finalization

- Per-submission HR review uses reviewer grant plus controller self/target rules, clamps relevant awards, recalculates work marks, saves reviewed/finalized/history. HR does not review HR/SA targets; SA has broader access with handler-specific self exceptions.
- HOD review checks own department, hod_first and fine permissions. Marks/remark/recommendation configured independently; save stage hod_reviewed and recommend approve/needs_changes. **Needs_changes does not reset submitted**, so it is not a complete return/resubmit operation. Recommendation lock does not universally freeze finalized work.
- Daily grouped review GET derives employees/dates and expected/stub status; day drill loads source work and canonical reflection/review. Feature/HOD scope differs by handler. POST `/api/daily-review/finalize` writes DailyReview ideaMarks/maxIdeaMarks/reviewer/status first, then submission rows. Pure HOD recommendation is not the same finalization as HR/SA; fine permissions are not consistently checked here.
- Per-task status/marks editors update work caches and append editHistory; value editor computes custom/extra marks with current template. Several raw mutation responses omit private-field scrubbing. Bulk finalization reports item failures; no all-row transaction or closed historical period lock.
- Ordinary penalty reopen: employee request → HR/SA approval/evaluationMode → historical row reopened under that workflow → employee submit and saved canonical reflection for original day. Treat this separately from HOD needs_changes and confirm actual editable state.

### Assignment edits/revocation and administrative flags

- Update targeting/schedule → current-day sync for old/new sets; old records are not comprehensively deleted/suppressed. Hard delete and generic active=false update differ from revoke.
- Revoke calls suppressAssignmentSubmissions: untouched rows may be hidden before started conflicts found. A409 can therefore leave partial suppression. Force/reason then allow hiding started work and mark Assignment inactive/revoked.
- SubmissionControl edit whitelist preserves chosen source values without universal recomputation; delete/test/restore alter flags and trigger Calling carry-forward rebuild best effort. Most analytics responds on next read; Attendance submitted inference can still count flagged rows. Historical rows and current Template fallback must be compared when debugging score changes.

## D. Attendance lifecycle

1. MyAttendance own range or EmployeeAttendance management range → deriveAttendance per UTC day. Persisted Attendance wins; without a row the sequence is weekly off, unified holiday, approved full leave, submitted work, auto_attendance, future/ongoing versus absent. There is no persisted holiday enum; it is a derived classification.
2. PUT manual status endpoint validates employee/day/status and calculates effective before state. leaveAccounting queries approved paid units. Target paid units minus approved coverage yields own manual override delta; subtract prior manual delta for balanceChange.
3. Save User.used change, then upsert Attendance source manual/status/note/setBy/leaveDelta. Existing leaveId is not always cleared. Some absence→nonabsence corrections apply explicit legacy penaltyChoice; generic attendance state change is not always an automatic sanction reversal.
4. Clear/revoke refunds only manual contribution, deletes the record and lets inference or leave sync restore state. A leave source row has separate revocation semantics. Audit and selected attendance:changed events follow; notifier no-op. Bulk statuses and range actions have individual partial-error behavior and do not all share identical effects.
5. Own attendance_review confirmation: todayMine checks mode/off/holiday/full leave → confirm upserts employee/day pending with confirmedAt. Reviewer queue has HOD department restriction.
6. Legacy review by confirmation ID writes source manual with zero leaveDelta; new actOne/bulkAct uses accounting helper. Both accept HODs without matching queue department/fine permission checks (S02/D07). New action revoke checks source and balance ownership. Confirmation status/reviewedAt is updated separately from Attendance.
7. Calendar notes POST/edit/complete/archive/lock touch AttendanceNote only; note completion is not daily attendance or work completion. Author, owner and lock rights must be tested independently.

## E. Compliance, penalties, waivers and finance

### Legacy evaluation and display

1. API boot/start dailyComplianceScheduler → active users → penaltyEngine.runDaily(day). Or explicit POST `/api/compliance/refresh` targets self/nonadmin or specified employee/admin; refreshAll shares once-per-day sweep state, so it may skip after a completed run despite “force” wording.
2. Legacy detector candidates come from submitted/pending/dependencies/attendance and generated work. Automatic Penalty writes use partial unique probable/nonprobable keys; missed/absent rollout cutoff prevents selected old records from resurfacing.
3. Penalty status/probable/effective/expiry and financialStatus differ. Dashboard/mine/attachFinalMarks can promote/expire records on reads. attachFinalMarks derives legacy work minus active mark sanctions with clamp and evaluation override; percentage-point adjustments operate separately on completion periods.
4. Financial legacy resolution/waiver changes financial fields; markFinancialDeducted accepts slip/month IDs and records deducted/resolved without loading payroll or adding an item. Caller must separately prove the money changed; the current code does not prove it.

### v2 rule-to-effect flow

1. HR/SA RuleBuilder → flag-gated CRUD → ruleService validates detector/actions/scope/thresholds and increments version. Rule seed creates built-ins, disabled unless explicit auto-enable behavior. Flags do not mean every seeded rule is enabled.
2. Scheduler first performs legacy sweep, then v2 tick when newEngine flag enabled. `_runDetection` loads enabled rules, resolves active eligible users, preloads critical/template/working-day context where needed, invokes registry detector and records candidate incident with code/version/context/naturalKey.
3. Automatic naturalKey unique insert collapses repeat detections. Manual incident keys are not covered by that automatic-only constraint. ComplianceEvent/audit are separate persisted side effects with system/actor metadata.
4. `_runPromotion` claims candidate→active when effective date arrived. actionEngine flag controls consequences. `apply` reads current rule, not a full frozen version, and creates ActionEffect for incident/action/day followed by ledger intents and refs. Conditional transaction wrapper covers participating writes; standalone fallback is serial.
5. Each executor computes mark/percent/money/LWP or notification/warning/lock effect. Ledger direction-1 is debit; quantity nonnegative. Effect unique key prevents duplicate effect rows, but existing effect early return does not heal missing ledgers. Fine/LWP ledger writes do not directly alter payroll/calendar attendance. Legacy mirror is specific to applicable executor and disabled when dualWrite flag is true in the current implementation.
6. Recurring-only actions reapply on active incidents on subsequent effective days; escalation adds configured actions when waiverRecovery enabled. Promotion crash/action error does not reliably replay a missing one-shot consequence.
7. Candidate/active/terminal incident and effect states are separate. Generic resolveIncident sets incident resolved without consequence reversal; cancel walks effects and adds inverse credits/legacy cancellation. Automatic business recovery must not be equated with monetary restoration.

### Waiver/recovery and dashboard interpretation

- Employee own-incident waiver request checks rule waiver allowance/reason/scope then saves pending request. HR/SA decision saves approved/rejected first. Approved total targets incident effects; partial uses supplied effect IDs without binding them to incident/employee. Reversal appends credit and changes effect status, may waive incident when no active effects. Transaction failure after approved save is not repaired by repeat decision.
- HR/SA recovery saves ComplianceRecovery then reverses selected effects inside optional transaction. restore/information/neutral currently take equivalent consequence reversal paths; rule.allowed/evidence configuration does not supply all advertised enforcement. Cancelled/waived/resolved effects need concurrency/idempotence fixtures.
- Financial/marks/etc ledger rows are append-intent history; runningBalance cache can drift with backdates/concurrency. Nightly reconciler (default off) logs mismatches, not a repair. A dashboard financial debit total is assessed amount, not necessarily net after waiver/recovery or actual salary deduction.
- Incident/ledger/timeline/config endpoints have own flag and scope rules. Employee/HOD v2 reads are own-only; penalties feature opening the HR workspace does not bypass strict admin backend checks. Backend compliance:changed/penalty:changed are not forwarded by current frontend singleton.

## F. Analytics, reporting and publication

| View/action | Input/query and calculation | Inclusion/date/scope; persistence |
| --- | --- | --- |
| Employee dashboard | Own submissions, backlog, own notices/attendance/dependencies | Several separate reads, UTC today; today generation mutates and POST refresh may evaluate sanctions |
| HR overview | User/Submission/Leave/Attendance and review counts | Controller-specific cohorts; do not assume every total uses reviewed-only/live filter |
| Pendency | Submitted live task/Excel/sheet pending/done units, dependencies | Default7 days, custom inclusive dates→exclusive next day; unsubmitted/untouched/WNA excluded. Done+ongoing both work-performed; pending/(pending+done). Main HOD dept clamp |
| Completion | Reviewed live scores, penaltyMath finalMarks, reviewed DailyReview innovation once/day | Weighted earned/total, optional template/recurrence/reviewer; current active employee/HR cohorts, SA excluded; completion-percent adjustments separate |
| Dynamic template | Reviewed submissions and current Template fields/statuses/custom grading/product snapshots | Generated live stubs denominator, not all schedule-expected work. Numeric totals/averages/extrema, task/status trends. HOD department; grant allowedTemplateIds |
| Calling / sales / farmer | Dedicated customResponses and saved numeric/sales/NBV/product/farmer rows | Dedicated controller calculations/filters; historic snapshots versus current fallback differ. Sales money is not salary money |
| Self-review | DailyReflection selfRating/selfNote/idea | Range inclusive UTC; average/high/low/median and consistency over calendar dates, not working-day expectation. Current active Users; S03 scope override affects readers/exports |
| Interactions | Interaction/participant/tag/source history | Headline cards can be lifetime/current-period while charts honor from/to; meeting attendance is separate. Visibility/scope per handler |
| Compliance v2 dashboard | Incident/effect status counts and ledger aggregates | Flag+admin; assessed debit totals differ from net balance and salary. Date timestamp normalization must be checked per query |
| Exports | CSV helper, ExcelJS/XLSX, PDFKit fed from controller datasets/slip snapshots | Exports are not separate authoritative stores. Frontend blob download/API auth, formula-leading text risk; PDF layout not inspected in this audit |

### Salary report workflow

HRSalary generate → POST `/api/salary/generate` with employee and period/month → salary gate + computeSlip validation → deriveAttendance, live submitted work and final marks, reviewed DailyReview and pending count → snapshot current salary/profile/bank and computePayroll → employee/periodKey upsert → keyed notification/SSE → list refresh. Future/ongoing and period-length rules are code-derived, not approved policy.

Publish POST `/api/salary/publish` is strict admin despite route grant extension; employee MySalary then sees only own published/nonretracted records. PDF loads stored slip and requires owner or admin; salary grant alone does not read others' PDFs. Update recalculates with an incomplete attendance input set (D01). Regeneration can overwrite a published slip while remaining published (D03). Retraction is a status change with metadata, not hard delete; no automatic correction after historical leave/calendar changes.

## G. Notifications, reminders, history and external delivery

1. Primary write → direct notifyEvents helper or events.publish(type,payload). EventEmitter validates registered type; asynchronous subscribers are not durably awaited/retried.
2. notificationProjector/notify helpers choose recipients and persist Notification. `_upsertOne` keyed writer aims for unique recipient/event/variant, but declared index and rawResult contract have D14/D15. Legacy leave/assignment and manual send paths still use insertMany. No-op helpers intentionally produce no row.
3. reminderProjector creates/upserts Reminder with active hash; due scheduler emits reminder:changed and stamps lastFiredAt. Done/dismiss/snooze are owner actions; admin completion/cancellation differ. Alerts and timeline derive from source state and need no matching Notification.
4. realtime service pushes named SSE to current per-process user connections, heartbeat25 seconds. Browser EventSource connects with JWT query, reconnects without replay; `_wire` forwards only listed names into `hrms:rt:*` CustomEvents. Components refetch when their supported type arrives; dropped types need manual/other incidental refresh.
5. Email helper chooses Resend only when EMAIL_PROVIDER explicitly resend; otherwise SMTP. Reset/welcome sends and public email diagnostic use same seam. Missing delivery credentials may not prevent API boot, but password-reset approve can fail after state commit.
6. AuditLog writes actor/action/target/meta/IP best effort; ComplianceEvent records a separate ordered compliance history. Derived activity timeline merges business records on demand with own/admin/HOD scope. Logs, embedded review histories and durable compliance events do not constitute complete event sourcing or automatic data restoration.

## Cross-workflow invariants to test next

- A rejected/409 request should not change attendance/balance/suppression/effects; current paths violate this expectation.
- Same command twice and two simultaneous commands should have the same final balance and one logical consequence, across primary and secondary collections.
- HOD restriction applies equally to list, detail, export, individual and bulk mutation; fine permissions apply to each action.
- A payroll period regenerated/edited without changed inputs should preserve monetary values and publication policy.
- Terminal incident/effect/ledger/mirror states and finance deduction evidence should agree under approved business semantics.
- One source record must have deliberate, documented inclusion across attendance, work marks, pendency, template analytics and salary.
