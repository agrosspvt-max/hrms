# Data model and sources of truth

All persistence below is MongoDB/Mongoose. A `ref` is a population hint, not a foreign-key constraint. Indexes here are declared schema indexes, **not verified live indexes**. Forty-three exported models were loaded without connecting to a database to inspect paths, enums and indexes. Embedded arrays hold many historical snapshots; detailed field definitions remain in the linked schemas.

## Authoritative concepts and competing representations

| Concept | Authoritative input / updater | Duplicated or derived data; readers and consequences |
| --- | --- | --- |
| Identity, active status and role | `User`, employee/admin-account controllers; protect reloads User each request | JWT stores identity only; localStorage user is a stale UI cache. Deletion leaves referenced documents. No token-version revocation |
| Department/designation | User.department/designation references plus Department/Designation definitions | Submission does not snapshot department; historical analytics often group by current User department. Reporting manager is text, not an access relation |
| HOD relationship | Competing User.isHOD/hodDepartment and Department.hodEmployeeId | `syncHodAssignment` updates some pointers; department update has a separate path. Readers prefer different pointers. Fine permissions differ between per-submission and daily APIs |
| Feature access | User.featurePermissions Mixed object, featurePermissionsController | Frontend gates/cache and backend enabled-only guards; access level/subkeys mostly not enforced. Template analytics allowedTemplateIds and calling subkey are exceptions |
| Assignment definition | Assignment target/schedule/active, assignmentController | Submission snapshots template/type/frequency/schedule/override and assignment ref. Same employee/template/day coalesces multiple assignments, irrespective of assignment identity |
| Template definition | Template tasks, customFields, sheet, subtemplates and grading configuration | Task/sheet/product/extra-task snapshots on Submission; getToday synchronizes open rows. Current template controls some historical custom grading and analytics fallback. isActive does not uniformly stop generation |
| Daily expected work | `dailyEngine.ensureDailySubmissions`, scheduleHelpers and active assignments | Persisted Submission stubs are not equivalent to every expected assignment; expectedSubmissions service reconstructs some review membership. GET today can create/update data |
| Completion and pendency | Submission.tasks/status/completedAt plus pendingStateService | Cached earnedPoints/workEarnedPoints and percentages can lag backlog resolution. Excel/sheet/custom statuses have separate representations and age rules |
| Critical tasks | Snapshotted task.isCritical, with current Template fallback via compliance/critical | Template edits can affect legacy records missing a snapshot; extra tasks need explicit policy |
| Work marks | Per-template scoring in submit/review/daily task editors; Submission workEarnedPoints/workTotalPoints | earnedPoints/totalPoints legacy mirrors; customAvailable/Earned/Penalty/FinalMarks separate. Generic performance and salary do not consume every custom field representation |
| Reflection and innovation | DailyReflection employee/day for selfRating/selfNote/idea; DailyReview employee/day for ideaMarks/maxIdeaMarks | Legacy Submission reflection/idea fields and ideaMarks are compatibility copies; completion/salary adds reviewed daily innovation once, not once per submission |
| Submission lifecycle | submitted/submittedAt, reviewStatus, currentReviewStage; submission and dailyReview controllers | reviewHistory/editHistory plus hodReview/hodRecommendation; submitted != reviewed != finalized. Needs_changes does not reset submitted |
| Leave business intent | Leave range/type/dayType/paid/status and stored effective days | originalRequest/modification metadata; paid can diverge from leaveType after edits; current calendars/weekly offs can later change effective units |
| Leave units | dateHelpers.effectiveLeaveDays using employee weeklyOff and merged holidayDaySet | Leave.days snapshot recalculated by holiday sync; legacy calendar-only messages can show calendar span instead of effective units |
| Leave allowance/usage | User.leaveBalance allowance fields and used; approval/revoke/edit/manual accounting writes | No leave-balance ledger. Stored used is a mutable counter, not automatically reconstructible from one model because manual Attendance.leaveDelta also contributes. resetDate/yearlyAllowance/monthlyAllowance are not interchangeable accrued-balance rules |
| Persisted attendance | Attendance unique employee/day, status/source/setBy/leaveId/leaveDelta | deriveAttendance infers missing days from weekly offs, holidays, approved leaves, submitted work, mode/time. AttendanceConfirmation is intent/review status, not the attendance fact. AttendanceLedger is a compliance consequence, not calendar attendance |
| Paid override ownership | leaveAccounting.computeOverrideLeaveDelta; Attendance.leaveDelta for a manual row | Paid Leave approval owns its own debit; clearing a manual override refunds only its delta. Legacy confirmation review bypasses this arithmetic |
| Dependencies | DependencyTask.currentStatus, chain/parent, assignedTo/assignedBy, sourceSubmissionId/sourceTaskId | Names/template/department snapshots and old status compatibility. Resolution services also touch originating work/compliance; no unique source-to-dependency constraint |
| Legacy penalties | Penalty category/status/probable, penaltyMarks, targetDate/submission; penaltyEngine and penaltyController | financialStatus separate from penalty status; completionPercent/evaluationPeriod adjustments separate from mark reductions; reopen/evaluation modes are separate workflows |
| Display final marks | penaltyMath.attachFinalMarks/computeFinal over legacy Penalty and Submission scores | On-demand derived fields, not rewritten earnedPoints. Some reads sweep penalty state transitions. v2 MarksLedger is not the universal display source |
| Compliance rule and incident | ComplianceRule plus detector Registry; IncidentService creates/promotes incident, naturalKey | Incident stores ruleVersion/code/context, not a complete executable historical rule snapshot. actionEngine loads current rule |
| Applied consequences | ComplianceActionEffect + explicit ledgerRefs; actionEngine executors | Optional legacy Penalty mirror and incident status. Resolved incident can still have active effects; mirror coverage is not every action |
| Ledger amounts | Signed immutable-intent entries in Marks/Financial/Percentage/AttendanceLedger (`direction × quantity`) | runningBalance cached per append; backdating/concurrent inserts can break it. balance reader trusts latest cache. Reconciler reports drift, does not repair |
| Waiver/recovery | ComplianceWaiver decision, ComplianceRecovery operation and inverse ledger entries | Request/decision persistence is outside parts of consequence transaction. Partial IDs need relationship checks; approved status alone does not prove credit applied |
| Salary result | SalarySlip snapshot for employee/periodKey, computeSlip/computePayroll | Current User salary/attendance/leave are generation inputs, not retroactively applied to a stored slip. payroll object, grossSalary/netSalary and scalar/items have different meanings |
| Financial deduction completion | Competing legacy Penalty.financialStatus and SalarySlip deductionItems; v2 FinancialLedger | No unified proof of actual deducted money. Legacy mark-deducted endpoint can reference arbitrary slip IDs; v2 fine debit does not generate a payslip deduction |
| Dashboard metrics | Controller query scope + filters + current date range, generally on-demand | Different denominators: reviewed marks vs submitted pendency vs generated stubs, active-user scope vs stored payroll snapshot. Do not reconcile by labels alone |
| Notifications, reminders, alerts | Notification durable delivery/read state; Reminder actionable state; dashboardAlerts derived queries | EventEmitter/SSE are ephemeral delivery; eventKey dedupe only for keyed writers. Legacy leave/assignment helpers and manual broadcasts still insert without that key |
| History | Embedded review/edit metadata, AuditLog, ComplianceEvent, source records; timeline service derives a merged view | Audit failures often swallowed. Derived timeline is not a durable event store or complete restore mechanism |

## Integrity boundaries, retries and history

Most controllers use ordinary Mongoose save/update sequences. No universal request idempotency key exists. A unique index can reject a duplicate create but cannot repair an earlier balance update or a missing secondary document. Leave overlap is checked in application code; it is not protected by an overlap-exclusion constraint. Negative balances are often clamped, which can conceal inconsistent reversal history.

`withComplianceTransaction` probes replica-set/mongos support and passes sessions to participating writes. Standalone/offline capability falls back to serial operations; that is not transactional. Waiver decision, recovery creation, incident promotion, audits and external notifications are not all inside the same boundary. Append-only ledgers have no unique reversal operation key. Two independent inserts can still read the same cached prior balance even with sessions.

The duplicate-prevention keys are:

- User email and employeeId; Department name; Designation title; Product name; Holiday date; Dealer firmName/place; Quantity unit/label; NoteType and InteractionTag name/slug.
- Submission employee/template/date; Attendance, AttendanceConfirmation, DailyReflection and DailyReview employee/date.
- SalarySlip employee/periodKey. Its legacy month key is dropped/backfilled at boot; schema auto-indexing is disabled specifically for this model.
- ComplianceRule code; automatic ComplianceIncident naturalKey only; ActionEffect incident/action/effectiveDate; automatic legacy Penalty employee/category/day/submission with separate probable/nonprobable predicates.
- Notification recipient/eventKey/variant partial uniqueness has an unsupported `$ne` predicate; verify actual index before relying on it (D14).
- Active Reminder hash uniqueness excludes completed/dismissed records.

Soft deletion/testing/suppression flags preserve Submission history, but hard-delete APIs exist for users/templates/organization/catalogue/files/interactions. Salary regeneration and review edits can overwrite past interpretations. Birthdays use current active Users; yearly Event occurrences are expanded on read. Joining/deactivating/moving a User can change a historical analytics cohort. None of this is proof of immutable closed periods.

## Dates, formulas and inclusions

- `dateHelpers.startOfDay`, `formatYMD`, `parseDay` normalize UTC. `monthRange` is half-open `[monthStart,nextMonthStart)`; leave and event helpers take inclusive dates; analytics custom query dates usually convert to exclusive `to+1`. Stored timestamps (submittedAt, event ts) are instants, not normalized business days.
- `effectiveLeaveDays`: full counts inclusive working dates; half returns 0.5 only for a single working date. Empty weeklyOff currently falls back to Sunday in this utility.
- `workingDays.isWorkingDay` treats supplied approved leave-day sets as nonworking even for half leave, while generation keeps half-day work. This is a competing deadline/expected-day policy, not the effective leave unit formula.
- Override delta: `max(0,targetPaidUnits-approvedPaidUnits) - existingManualDelta`; store only the new incremental amount. This is arithmetic idempotence when persisted successfully, not concurrent atomicity.
- Task standard work: done/ongoing points earn; done/ongoing/pending points form denominator; work_not_available and pending_submit excluded. Added task awarded marks can enter both numerator and denominator. Excel/sheet use row/cell award configuration; custom uses separate computed grading caches.
- Live filter: `deleted != true`, `isTestData != true`, `hidden != true`; `onlyReviewed` adds reviewStatus reviewed. Legacy missing flags are included by `$ne`. HR/SA may request test/deleted inclusion via readReqFlags, not hidden inclusion by default.
- Completion performance: sum legacy penalty-adjusted work marks plus reviewed DailyReview idea marks once per employee/day, divided by corresponding totals. Percentage-point adjustment rules are separate. Task counts/pendency rate are not this marks percentage.
- Dynamic template analytics reads reviewed work and current template fields, numeric totals/averages/min/max, task/custom status buckets, extra work and product/farmer snapshots. GeneratedCount includes live persisted stubs, not a schedule expansion of expected work.
- Salary standard payable calculation uses inclusive period length minus known absent/unpaid/half-unpaid plus worked holidays/weekly offs. Payroll calculator uses structured salary components and stored bonus/deduction item lists; see D01–D03 before treating results as approved payroll policy.
- v2 financial dashboard sums debit entries for assessed total and does not subtract all recovery/waiver credits. That total should not be equated with outstanding balance. Legacy/v2 dashboards can count different incidents/statuses/periods.

## Schema catalogue

The following is a source-derived catalogue of every exported model. It omits credential/default values and documents declared fields rather than records. Field lists are schema paths; embedded document arrays have their own subfields in the linked source. Standard `_id`, `__v`, createdAt/updatedAt are omitted from lists. Ref columns identify schema-declared references; polymorphic IDs and some embedded refs require consulting the schema. No production records were read.

### Assignment

Schema: [backend/models/Assignment.js](../../backend/models/Assignment.js).

Fields: `template`, `subTemplateIds`, `subTemplateId`, `targetType`, `targetRef`, `frequency`, `weeklyDay`, `monthlyDate`, `scheduleLabel`, `startDate`, `endDate`, `priority`, `holidayOverride`, `overrideScope`, `overrideReason`, `active`, `revokedAt`, `revokedBy`, `revokeReason`, `createdBy`.

References: template → Template; revokedBy → User; createdBy → User

Enums: targetType = employee, department, designation; frequency = one-time, daily, weekly, monthly; priority = low, normal, high; overrideScope = once, all.

Declared indexes:

- `{"targetRef":1}`
- `{"targetType":1,"targetRef":1,"active":1}`

### Attendance

Schema: [backend/models/Attendance.js](../../backend/models/Attendance.js).

Fields: `employee`, `date`, `status`, `source`, `note`, `setBy`, `leaveId`, `leaveDelta`.

References: employee → User; setBy → User; leaveId → Leave

Enums: status = present, half_paid, half_unpaid, full_paid, full_unpaid, absent, weekly_off; source = auto, manual, leave.

Declared indexes:

- `{"employee":1}`
- `{"date":1}`
- `{"leaveId":1}` — `{"sparse":true}`
- `{"employee":1,"date":1}` — `{"unique":true}`

### AttendanceConfirmation

Schema: [backend/models/AttendanceConfirmation.js](../../backend/models/AttendanceConfirmation.js).

Fields: `employee`, `date`, `confirmedAt`, `status`, `reviewedBy`, `reviewedAt`, `remarks`.

References: employee → User; reviewedBy → User

Enums: status = pending, approved_present, marked_absent, marked_half_paid, marked_half_unpaid, marked_paid_leave, marked_unpaid_leave, marked_weekly_off.

Declared indexes:

- `{"employee":1}`
- `{"date":1}`
- `{"status":1}`
- `{"employee":1,"date":1}` — `{"unique":true}`

### AttendanceLedger

Schema: [backend/models/AttendanceLedger.js](../../backend/models/AttendanceLedger.js).

Fields: `employee`, `date`, `direction`, `quantity`, `runningBalance`, `type`, `reason`, `refIncidentId`, `refEffectId`, `refRecoveryId`, `refWaiverId`, `createdBy`.

References: employee → User; refIncidentId → ComplianceIncident; refEffectId → ComplianceActionEffect; refRecoveryId → ComplianceRecovery; refWaiverId → ComplianceWaiver; createdBy → User

Enums: type = action, recovery, waiver, manual, salary_deduct, reconciliation.

Declared indexes:

- `{"employee":1}`
- `{"date":1}`
- `{"employee":1,"date":1,"createdAt":1}`
- `{"refIncidentId":1}` — `{"sparse":true}`
- `{"refEffectId":1}` — `{"sparse":true}`

### AttendanceNote

Schema: [backend/models/AttendanceNote.js](../../backend/models/AttendanceNote.js).

Fields: `employee`, `date`, `title`, `description`, `priority`, `reminderTime`, `createdBy`, `createdByName`, `createdByRole`, `completed`, `completedAt`, `completedBy`, `archived`, `archivedAt`, `archivedBy`, `locked`, `lockedAt`, `lockedBy`, `attachments`, `checklist`, `recurrence`, `sharedWith`, `meta`.

References: employee → User; createdBy → User; completedBy → User; archivedBy → User; lockedBy → User; sharedWith → User

Enums: priority = normal, important; createdByRole = employee, hr, super_admin.

Declared indexes:

- `{"employee":1}`
- `{"date":1}`
- `{"priority":1}`
- `{"completed":1}`
- `{"archived":1}`
- `{"employee":1,"date":1}`
- `{"employee":1,"archived":1,"completed":1,"date":-1}`

### AuditLog

Schema: [backend/models/AuditLog.js](../../backend/models/AuditLog.js).

Fields: `actor`, `actorRole`, `action`, `targetType`, `targetId`, `targetLabel`, `meta`, `ip`.

References: actor → User

Declared indexes:

- `{"actor":1}`
- `{"actorRole":1}`
- `{"action":1}`
- `{"targetType":1}`
- `{"targetId":1}`

### CompanyDocument

Schema: [backend/models/CompanyDocument.js](../../backend/models/CompanyDocument.js).

Fields: `title`, `description`, `fileName`, `mimeType`, `size`, `data`, `effectiveDate`, `visibleToEmployees`, `isActive`, `uploadedBy`.

References: uploadedBy → User

Declared indexes:

- `{"visibleToEmployees":1}`
- `{"isActive":1}`
- `{"isActive":1,"visibleToEmployees":1,"createdAt":-1}`

### ComplianceActionEffect

Schema: [backend/models/ComplianceActionEffect.js](../../backend/models/ComplianceActionEffect.js).

Fields: `incidentId`, `ruleId`, `ruleActionId`, `actionType`, `employee`, `status`, `effectiveDate`, `expiryDate`, `amount`, `marks`, `percent`, `attendanceUnit`, `taskRef`, `penaltyId`, `ledgerRefs`, `resolvedAt`, `resolvedBy`, `resolvedReason`, `cancelledAt`, `cancelledBy`, `cancelReason`, `waivedAt`, `waivedBy`, `waiverId`, `waiverReason`.

References: incidentId → ComplianceIncident; ruleId → ComplianceRule; employee → User; penaltyId → Penalty; resolvedBy → User; cancelledBy → User; waivedBy → User; waiverId → ComplianceWaiver

Enums: status = pending, active, resolved, waived, cancelled, expired.

Declared indexes:

- `{"incidentId":1}`
- `{"actionType":1}`
- `{"employee":1}`
- `{"status":1}`
- `{"effectiveDate":1}`
- `{"incidentId":1,"ruleActionId":1,"effectiveDate":1}` — `{"unique":true,"name":"compliance_effect_natural_key"}`
- `{"penaltyId":1}` — `{"sparse":true}`
- `{"employee":1,"status":1}`

### ComplianceEvent

Schema: [backend/models/ComplianceEvent.js](../../backend/models/ComplianceEvent.js).

Fields: `employee`, `incidentId`, `ts`, `kind`, `payload`, `actor`.

References: employee → User; incidentId → ComplianceIncident

Enums: kind = incident_created, incident_effective, action_applied, notification_sent, waiver_requested, waiver_decided, recovery_applied, incident_resolved, incident_cancelled, escalated, rule_updated.

Declared indexes:

- `{"employee":1}`
- `{"incidentId":1}`
- `{"employee":1,"ts":-1}`
- `{"incidentId":1,"ts":1}`

### ComplianceIncident

Schema: [backend/models/ComplianceIncident.js](../../backend/models/ComplianceIncident.js).

Fields: `ruleId`, `ruleVersion`, `ruleCode`, `employee`, `severity`, `incidentDate`, `effectiveDate`, `status`, `naturalKey`, `context`, `detectorMeta`, `source`, `createdBy`, `resolvedAt`, `resolvedBy`, `cancelledAt`, `cancelledBy`, `cancelReason`, `waivedAt`, `waivedBy`, `waiverId`.

References: ruleId → ComplianceRule; employee → User; createdBy → User; resolvedBy → User; cancelledBy → User; waivedBy → User; waiverId → ComplianceWaiver

Enums: severity = low, medium, high, critical; status = candidate, active, resolved, waived, cancelled, expired; source = automatic, manual.

Declared indexes:

- `{"ruleId":1}`
- `{"employee":1}`
- `{"incidentDate":1}`
- `{"effectiveDate":1}`
- `{"status":1}`
- `{"source":1}`
- `{"naturalKey":1}` — `{"unique":true,"partialFilterExpression":{"source":"automatic"},"name":"compliance_incident_natural_key_auto"}`
- `{"employee":1,"incidentDate":-1}`
- `{"ruleId":1,"status":1}`
- `{"effectiveDate":1,"status":1}`
- `{"context.submissionId":1}` — `{"sparse":true}`

### ComplianceRecovery

Schema: [backend/models/ComplianceRecovery.js](../../backend/models/ComplianceRecovery.js).

Fields: `incidentId`, `employee`, `effectIds`, `mode`, `reason`, `createdBy`, `auditRefIds`.

References: incidentId → ComplianceIncident; employee → User; createdBy → User

Enums: mode = restore, information, neutral.

Declared indexes:

- `{"incidentId":1}`
- `{"employee":1}`
- `{"createdAt":-1}`

### ComplianceRule

Schema: [backend/models/ComplianceRule.js](../../backend/models/ComplianceRule.js).

Fields: `code`, `name`, `description`, `category`, `detector`, `enabled`, `version`, `severity`, `trigger.evaluationDelayDays`, `trigger.thresholdDays`, `trigger.workingDaysOnly`, `trigger.criticalTasksOnly`, `trigger.dedupeWindowHours`, `trigger.cutoffTime`, `scope.departments`, `scope.designations`, `scope.templates`, `scope.employeeIds`, `actions`, `notifications.onIncident`, `notifications.onEffective`, `notifications.onEscalation`, `notifications.onRecovery`, `notifications.onWaiver`, `recovery.allowed`, `recovery.modes`, `recovery.requiredEvidence`, `recovery.autoResolveOnSubmit`, `recovery.autoResolveOnResolve`, `waiver.allowed`, `waiver.partialAllowed`, `waiver.approverRoles`, `waiver.reasonRequired`, `escalation`, `createdBy`, `updatedBy`.

References: createdBy → User; updatedBy → User

Enums: category = submission, dependency, attendance, conduct, custom; severity = low, medium, high, critical.

Declared indexes:

- `{"code":1}` — `{"unique":true}`
- `{"category":1}`
- `{"enabled":1}`
- `{"enabled":1,"category":1}`

### ComplianceWaiver

Schema: [backend/models/ComplianceWaiver.js](../../backend/models/ComplianceWaiver.js).

Fields: `incidentId`, `employee`, `scope`, `effectIds`, `reason`, `evidenceUrl`, `requestedBy`, `requestedAt`, `status`, `decidedBy`, `decidedAt`, `decisionNote`.

References: incidentId → ComplianceIncident; employee → User; requestedBy → User; decidedBy → User

Enums: scope = full, partial; status = pending, approved, rejected, auto_approved.

Declared indexes:

- `{"incidentId":1}`
- `{"employee":1}`
- `{"status":1}`
- `{"status":1,"requestedAt":-1}`

### Contact

Schema: [backend/models/Contact.js](../../backend/models/Contact.js).

Fields: `kind`, `name`, `linkedEmployee`, `organization`, `contactType`, `phone`, `altPhone`, `email`, `roleTitle`, `departmentText`, `address`, `notes`, `scopeOfWork`, `category`, `viewCount`, `status`, `createdBy`.

References: linkedEmployee → User; createdBy → User

Enums: kind = employee, external; category = emergency, critical_support, management, general; status = active, inactive.

Declared indexes:

- `{"kind":1}`
- `{"name":1}`
- `{"linkedEmployee":1}`
- `{"category":1}`
- `{"status":1}`
- `{"kind":1,"status":1}`

### DailyReflection

Schema: [backend/models/DailyReflection.js](../../backend/models/DailyReflection.js).

Fields: `employee`, `date`, `selfRating`, `selfNote`, `idea`, `lastEditedBy`.

References: employee → User; lastEditedBy → User

Declared indexes:

- `{"employee":1}`
- `{"date":1}`
- `{"employee":1,"date":1}` — `{"unique":true}`

### DailyReview

Schema: [backend/models/DailyReview.js](../../backend/models/DailyReview.js).

Fields: `employee`, `date`, `ideaMarks`, `maxIdeaMarks`, `ideaFeedback`, `reviewedBy`, `reviewedAt`, `reviewStatus`, `primarySubmissionId`.

References: employee → User; reviewedBy → User; primarySubmissionId → Submission

Enums: reviewStatus = pending, reviewed.

Declared indexes:

- `{"employee":1}`
- `{"date":1}`
- `{"reviewStatus":1}`
- `{"employee":1,"date":1}` — `{"unique":true}`

### Dealer

Schema: [backend/models/Dealer.js](../../backend/models/Dealer.js).

Fields: `firmName`, `place`, `dealerName`, `name`, `active`.

References: No direct top-level schema ref paths; inspect embedded arrays/polymorphic IDs.

Declared indexes:

- `{"firmName":1}`
- `{"place":1}`
- `{"name":1}`
- `{"active":1}`
- `{"firmName":1,"place":1}` — `{"unique":true}`

### Department

Schema: [backend/models/Department.js](../../backend/models/Department.js).

Fields: `name`, `description`, `hodEmployeeId`, `analyticsType`.

References: hodEmployeeId → User

Enums: analyticsType = standard, calling.

Declared indexes:

- `{"name":1}` — `{"unique":true}`
- `{"analyticsType":1}`

### DependencyTask

Schema: [backend/models/DependencyTask.js](../../backend/models/DependencyTask.js).

Fields: `sourceSubmissionId`, `sourceTaskId`, `sourceKind`, `originalTaskName`, `assignedTo`, `assignedBy`, `assignedToName`, `assignedByName`, `previousEmployee`, `remark`, `chainId`, `parentDependencyTaskId`, `department`, `departmentName`, `template`, `templateTitle`, `currentStatus`, `priority`, `waitingSince`, `resolvedAt`, `resolvedBy`, `resolutionNote`.

References: sourceSubmissionId → Submission; assignedTo → User; assignedBy → User; previousEmployee → User; parentDependencyTaskId → DependencyTask; department → Department; template → Template; resolvedBy → User

Enums: sourceKind = task, excel, sheet; currentStatus = open, in_progress, resolved; priority = low, normal, high.

Declared indexes:

- `{"sourceSubmissionId":1}`
- `{"assignedTo":1}`
- `{"assignedBy":1}`
- `{"chainId":1}`
- `{"currentStatus":1}`
- `{"assignedTo":1,"currentStatus":1,"createdAt":-1}`
- `{"chainId":1,"createdAt":1}`

### Designation

Schema: [backend/models/Designation.js](../../backend/models/Designation.js).

Fields: `title`, `description`, `department`.

References: department → Department

Declared indexes:

- `{"title":1}` — `{"unique":true}`
- `{"department":1}`

### Event

Schema: [backend/models/Event.js](../../backend/models/Event.js).

Fields: `type`, `title`, `description`, `startDate`, `endDate`, `repeatYearly`, `isHoliday`, `notify`, `notifyOffsets`, `audience`, `audienceDepartment`, `audienceDesignation`, `audienceEmployees`, `linkedEmployee`, `createdBy`.

References: audienceDepartment → Department; audienceDesignation → Designation; linkedEmployee → User; createdBy → User

Enums: type = birthday, festival, company_event, custom; audience = everyone, department, designation, employees.

Declared indexes:

- `{"type":1}`
- `{"startDate":1}`
- `{"startDate":1,"endDate":1}`
- `{"repeatYearly":1}`

### FinancialLedger

Schema: [backend/models/FinancialLedger.js](../../backend/models/FinancialLedger.js).

Fields: `employee`, `date`, `direction`, `quantity`, `runningBalance`, `type`, `reason`, `refIncidentId`, `refEffectId`, `refRecoveryId`, `refWaiverId`, `createdBy`.

References: employee → User; refIncidentId → ComplianceIncident; refEffectId → ComplianceActionEffect; refRecoveryId → ComplianceRecovery; refWaiverId → ComplianceWaiver; createdBy → User

Enums: type = action, recovery, waiver, manual, salary_deduct, reconciliation.

Declared indexes:

- `{"employee":1}`
- `{"date":1}`
- `{"employee":1,"date":1,"createdAt":1}`
- `{"refIncidentId":1}` — `{"sparse":true}`
- `{"refEffectId":1}` — `{"sparse":true}`

### Holiday

Schema: [backend/models/Holiday.js](../../backend/models/Holiday.js).

Fields: `date`, `name`, `description`, `type`, `createdBy`.

References: createdBy → User

Enums: type = national, company, optional.

Declared indexes:

- `{"date":1}` — `{"unique":true}`

### Interaction

Schema: [backend/models/Interaction.js](../../backend/models/Interaction.js).

Fields: `type`, `title`, `description`, `meeting.date`, `meeting.time`, `meeting.durationMinutes`, `meeting.mode`, `meeting.location`, `meeting.meetingType`, `participants`, `tags`, `mentions`, `visibility`, `linkedRefs`, `followUp.required`, `followUp.dueDate`, `followUp.resolvedAt`, `followUp.resolvedBy`, `followUp.note`, `status`, `createdBy`, `department`, `designation`, `searchText`.

References: followUp.resolvedBy → User; createdBy → User; department → Department; designation → Designation

Enums: type = meeting, personal_note, warning, appreciation, follow_up, coaching, performance_discussion, salary_discussion, training, probation_review, exit_discussion, other; meeting.mode = online, offline; visibility = hr_only, managers_hr, employee_visible; status = scheduled, completed, cancelled.

Declared indexes:

- `{"type":1}`
- `{"meeting.date":1}`
- `{"participants.employee":1}`
- `{"tags":1}`
- `{"visibility":1}`
- `{"followUp.required":1}`
- `{"status":1}`
- `{"createdBy":1}`
- `{"department":1}`
- `{"designation":1}`
- `{"searchText":"text"}`
- `{"participants.employee":1,"createdAt":-1}`
- `{"type":1,"createdAt":-1}`
- `{"meeting.date":-1}`
- `{"followUp.required":1,"followUp.resolvedAt":1,"followUp.dueDate":1}`

### InteractionNote

Schema: [backend/models/InteractionNote.js](../../backend/models/InteractionNote.js).

Fields: `interaction`, `author`, `body`, `tags`, `mentions`, `visibility`, `lastEditedBy`, `lastEditedAt`, `searchText`.

References: interaction → Interaction; author → User; lastEditedBy → User

Enums: visibility = hr_only, managers_hr, employee_visible.

Declared indexes:

- `{"interaction":1}`
- `{"author":1}`
- `{"searchText":"text"}`
- `{"interaction":1,"createdAt":-1}`

### InteractionTag

Schema: [backend/models/InteractionTag.js](../../backend/models/InteractionTag.js).

Fields: `name`, `slug`, `category`, `color`, `icon`, `description`, `severity`, `countsAsWarning`, `countsInAnalytics`, `visibleToEmployee`, `archived`, `createdBy`.

References: createdBy → User

Enums: category = performance, behaviour, compliance, hr, warning, discipline, appreciation, attendance, development, information, reminder, complaint, customer, finance, management, training, custom; severity = info, low, medium, high, critical.

Declared indexes:

- `{"name":1}` — `{"unique":true}`
- `{"slug":1}` — `{"unique":true}`
- `{"category":1}`
- `{"archived":1}`
- `{"name":"text","description":"text"}`

### Leave

Schema: [backend/models/Leave.js](../../backend/models/Leave.js).

Fields: `employee`, `leaveType`, `fromDate`, `toDate`, `days`, `reason`, `dayType`, `status`, `decidedBy`, `decidedAt`, `hrNote`, `revokedBy`, `revokedAt`, `revokeReason`, `paid`, `originalRequest.leaveType`, `originalRequest.fromDate`, `originalRequest.toDate`, `originalRequest.dayType`, `originalRequest.days`, `originalRequest.capturedAt`, `modifiedOnApproval`, `modifiedBy`, `modifiedAt`, `modificationNote`.

References: employee → User; decidedBy → User; revokedBy → User; modifiedBy → User

Enums: leaveType = casual, sick, paid, unpaid, other; dayType = full, half; status = pending, approved, rejected, revoked.

Declared indexes:

- `{"employee":1}`
- `{"status":1}`
- `{"modifiedOnApproval":1}`
- `{"employee":1,"fromDate":1,"toDate":1}`

### LeaveAttachment

Schema: [backend/models/LeaveAttachment.js](../../backend/models/LeaveAttachment.js).

Fields: `leave`, `employee`, `uploadedBy`, `filename`, `mimeType`, `size`, `storageProvider`, `storageKey`, `data`, `status`, `parentAttachment`, `version`, `comments`, `metadata`, `deletedAt`, `deletedBy`.

References: leave → Leave; employee → User; uploadedBy → User; parentAttachment → LeaveAttachment; deletedBy → User

Enums: storageProvider = db, s3, gcs, local; status = active, requested, pending, approved, rejected.

Declared indexes:

- `{"leave":1}`
- `{"employee":1}`
- `{"status":1}`
- `{"leave":1,"deletedAt":1,"createdAt":1}`
- `{"createdAt":1}` — `{"expireAfterSeconds":86400,"partialFilterExpression":{"leave":null}}`

### LeaveConfig

Schema: [backend/models/LeaveConfig.js](../../backend/models/LeaveConfig.js).

Fields: `singleton`, `restrictedDuringProbation`.

References: No direct top-level schema ref paths; inspect embedded arrays/polymorphic IDs.

Declared indexes:

- `{"singleton":1}` — `{"unique":true}`

### MarksLedger

Schema: [backend/models/MarksLedger.js](../../backend/models/MarksLedger.js).

Fields: `employee`, `date`, `direction`, `quantity`, `runningBalance`, `type`, `reason`, `refIncidentId`, `refEffectId`, `refRecoveryId`, `refWaiverId`, `createdBy`.

References: employee → User; refIncidentId → ComplianceIncident; refEffectId → ComplianceActionEffect; refRecoveryId → ComplianceRecovery; refWaiverId → ComplianceWaiver; createdBy → User

Enums: type = action, recovery, waiver, manual, salary_deduct, reconciliation.

Declared indexes:

- `{"employee":1}`
- `{"date":1}`
- `{"employee":1,"date":1,"createdAt":1}`
- `{"refIncidentId":1}` — `{"sparse":true}`
- `{"refEffectId":1}` — `{"sparse":true}`

### Note

Schema: [backend/models/Note.js](../../backend/models/Note.js).

Fields: `noteType`, `personal`, `title`, `body`, `mentions`, `tags`, `attachments`, `visibility`, `createdBy`, `lastEditedBy`, `searchText`.

References: noteType → NoteType; createdBy → User; lastEditedBy → User

Enums: visibility = hr_only, managers_hr, employee_visible.

Declared indexes:

- `{"noteType":1}`
- `{"personal":1}`
- `{"createdBy":1}`
- `{"searchText":"text"}`
- `{"noteType":1,"createdAt":-1}`
- `{"personal":1,"createdBy":1,"createdAt":-1}`
- `{"mentions":1,"createdAt":-1}`

### NoteType

Schema: [backend/models/NoteType.js](../../backend/models/NoteType.js).

Fields: `name`, `slug`, `description`, `icon`, `color`, `visibility`, `archived`, `createdBy`.

References: createdBy → User

Enums: visibility = hr_only, managers_hr.

Declared indexes:

- `{"name":1}` — `{"unique":true}`
- `{"slug":1}` — `{"unique":true}`
- `{"archived":1}`

### Notification

Schema: [backend/models/Notification.js](../../backend/models/Notification.js).

Fields: `recipient`, `sender`, `type`, `title`, `message`, `relatedTaskIds`, `relatedTitles`, `eventKey`, `sourceRef.module`, `sourceRef.id`, `variant`, `archivedAt`, `priority`, `deadline`, `resolvedAt`, `dismissedFromDashboardAt`, `read`, `readAt`.

References: recipient → User; sender → User

Enums: type = backlog_alert, general, review_pending, leave_info, dependency_assigned, dependency_resolved, birthday_today, event_today, event_reminder, leave_applied, leave_decision, attendance_changed, work_assigned, work_revoked, submission_reviewed, password_reset_request, password_reset_approved, employee_created; priority = normal, important, urgent.

Declared indexes:

- `{"recipient":1}`
- `{"type":1}`
- `{"eventKey":1}`
- `{"priority":1}`
- `{"read":1}`
- `{"recipient":1,"read":1,"createdAt":-1}`
- `{"recipient":1,"type":1,"eventKey":1}`
- `{"recipient":1,"eventKey":1,"variant":1}` — `{"unique":true,"partialFilterExpression":{"eventKey":{"$exists":true,"$type":"string","$ne":""}},"name":"notif_dedupe_recipient_event_variant"}`

### PasswordResetRequest

Schema: [backend/models/PasswordResetRequest.js](../../backend/models/PasswordResetRequest.js).

Fields: `employeeId`, `employeeEmail`, `requestToken`, `status`, `requestedAt`, `approvedAt`, `approvedByHrId`, `rejectedAt`, `rejectReason`, `resetToken`, `resetTokenExpiry`, `isUsed`, `usedAt`, `emailSentAt`, `requestIp`, `userAgent`.

References: employeeId → User; approvedByHrId → User

Enums: status = PENDING, APPROVED, REJECTED, USED.

Declared indexes:

- `{"employeeId":1}`
- `{"employeeEmail":1}`
- `{"requestToken":1}` — `{"unique":true}`
- `{"status":1}`
- `{"resetToken":1}` — `{"sparse":true}`
- `{"isUsed":1}`
- `{"employeeEmail":1,"status":1}`

### Penalty

Schema: [backend/models/Penalty.js](../../backend/models/Penalty.js).

Fields: `employee`, `category`, `source`, `archivedPreRollout`, `probable`, `status`, `penaltyMarks`, `completionPercent`, `targetDate`, `submission`, `dependencyIds`, `effectiveDate`, `expiryDate`, `resolvedAt`, `rule`, `reason`, `createdBy`, `cancelledBy`, `cancelledAt`, `cancelReason`, `resolvedBy`, `restoredBy`, `restorationReason`, `restoredMarks`, `restoredFromFinalMarks`, `restoredToFinalMarks`, `acknowledgedAt`, `dismissedByEmployeeAt`, `employeeMessage`, `reopenRequest.requested`, `reopenRequest.reason`, `reopenRequest.requestedAt`, `reopenRequest.decision`, `reopenRequest.decidedBy`, `reopenRequest.decidedAt`, `reopenRequest.decisionNote`, `reopenRequest.completedAt`, `evaluationMode`, `overdueRef.submissionId`, `overdueRef.taskId`, `overdueRef.taskTitle`, `overdueRef.pendingSince`, `overdueRef.resolveBy`, `amount`, `dueDate`, `financialStatus`, `deductedInSalaryMonth`, `deductedBy`, `deductedAt`, `salarySlipId`, `evaluationPeriod.startDate`, `evaluationPeriod.endDate`, `incidentId`.

References: employee → User; submission → Submission; createdBy → User; cancelledBy → User; resolvedBy → User; restoredBy → User; reopenRequest.decidedBy → User; overdueRef.submissionId → Submission; deductedBy → User; salarySlipId → SalarySlip; incidentId → ComplianceIncident

Enums: category = absent_submission, dependency_pending, attendance_manual, critical_threshold, repeated_missing, manual_marks, manual_completion, missed_submission, performance_lock, completion_adjustment, marks_adjustment, financial_penalty; source = automatic, manual; status = pending, scheduled, active, resolved, cancelled, expired; reopenRequest.decision = pending, approved, rejected, completed, cancelled, ; evaluationMode = , restore, information, neutral; financialStatus = pending, deducted, waived, resolved, paid, .

Declared indexes:

- `{"employee":1}`
- `{"category":1}`
- `{"source":1}`
- `{"archivedPreRollout":1}`
- `{"probable":1}`
- `{"status":1}`
- `{"targetDate":1}`
- `{"submission":1}`
- `{"effectiveDate":1}`
- `{"expiryDate":1}`
- `{"incidentId":1}`
- `{"employee":1,"category":1,"targetDate":1,"submission":1}` — `{"unique":true,"partialFilterExpression":{"source":"automatic","probable":false},"name":"penalty_auto_dedupe"}`
- `{"employee":1,"category":1,"targetDate":1,"submission":1}` — `{"unique":true,"partialFilterExpression":{"source":"automatic","probable":true},"name":"penalty_probable_dedupe"}`
- `{"submission":1,"status":1}`
- `{"employee":1,"status":1,"effectiveDate":-1}`

### PercentageLedger

Schema: [backend/models/PercentageLedger.js](../../backend/models/PercentageLedger.js).

Fields: `employee`, `date`, `direction`, `quantity`, `runningBalance`, `type`, `reason`, `refIncidentId`, `refEffectId`, `refRecoveryId`, `refWaiverId`, `createdBy`.

References: employee → User; refIncidentId → ComplianceIncident; refEffectId → ComplianceActionEffect; refRecoveryId → ComplianceRecovery; refWaiverId → ComplianceWaiver; createdBy → User

Enums: type = action, recovery, waiver, manual, salary_deduct, reconciliation.

Declared indexes:

- `{"employee":1}`
- `{"date":1}`
- `{"employee":1,"date":1,"createdAt":1}`
- `{"refIncidentId":1}` — `{"sparse":true}`
- `{"refEffectId":1}` — `{"sparse":true}`

### Product

Schema: [backend/models/Product.js](../../backend/models/Product.js).

Fields: `name`, `pricePerUnit`, `nbvPercentage`, `unit`, `description`, `active`.

References: No direct top-level schema ref paths; inspect embedded arrays/polymorphic IDs.

Enums: unit = L, KG.

Declared indexes:

- `{"name":1}` — `{"unique":true}`
- `{"active":1}`

### Quantity

Schema: [backend/models/Quantity.js](../../backend/models/Quantity.js).

Fields: `label`, `value`, `unit`, `active`, `order`.

References: No direct top-level schema ref paths; inspect embedded arrays/polymorphic IDs.

Enums: unit = L, KG.

Declared indexes:

- `{"unit":1}`
- `{"active":1}`
- `{"unit":1,"label":1}` — `{"unique":true}`

### Reminder

Schema: [backend/models/Reminder.js](../../backend/models/Reminder.js).

Fields: `recipient`, `subject`, `actionKind`, `entityType`, `entityId`, `title`, `message`, `dueAt`, `cadence.every`, `cadence.until`, `cadence.maxRepeats`, `cadence.firedCount`, `priority`, `targetRoute`, `completedAt`, `dismissedAt`, `snoozedUntil`, `meta`, `hash`, `createdBy`, `lastFiredAt`.

References: recipient → User; subject → User; createdBy → User

Enums: actionKind = submit_today, confirm_attendance, meeting_prep, follow_up, custom; priority = low, normal, high, critical.

Declared indexes:

- `{"recipient":1}`
- `{"actionKind":1}`
- `{"dueAt":1}`
- `{"completedAt":1}`
- `{"recipient":1,"dueAt":1,"completedAt":1}`
- `{"subject":1,"actionKind":1,"dueAt":1}`
- `{"hash":1}` — `{"unique":true,"partialFilterExpression":{"completedAt":null,"dismissedAt":null},"name":"reminder_dedupe_hash_active"}`

### SalarySlip

Schema: [backend/models/SalarySlip.js](../../backend/models/SalarySlip.js).

Fields: `employee`, `employeeName`, `employeeEmpId`, `employeeEmail`, `month`, `year`, `monthNumber`, `periodStart`, `periodEnd`, `periodKey`, `workingDays`, `presentDays`, `paidLeaves`, `unpaidLeaves`, `absentDays`, `weeklyOffDays`, `holidayDays`, `halfPaidDays`, `halfUnpaidDays`, `payableDays`, `monthDays`, `holidayWorkedDays`, `completionPercentage`, `backlogCount`, `monthlySalary`, `perDaySalary`, `grossSalary`, `salaryStructure`, `bankName`, `bankAccount`, `uanNumber`, `designationTitle`, `departmentName`, `joiningDate`, `payroll`, `payslipNumber`, `bonusItems`, `deductionItems`, `bonuses`, `deductions`, `netSalary`, `bonusNote`, `deductionNote`, `generatedBy`, `status`, `retractedAt`, `retractedBy`, `retractionReason`, `publishStatus`, `publishedAt`, `publishedBy`.

References: employee → User; generatedBy → User; retractedBy → User; publishedBy → User

Enums: status = active, retracted, paid; publishStatus = draft, published.

Declared indexes:

- `{"employee":1}` — `{"_autoIndex":false}`
- `{"month":1}` — `{"_autoIndex":false}`
- `{"year":1}` — `{"_autoIndex":false}`
- `{"periodStart":1}` — `{"_autoIndex":false}`
- `{"periodKey":1}` — `{"_autoIndex":false}`
- `{"status":1}` — `{"_autoIndex":false}`
- `{"publishStatus":1}` — `{"_autoIndex":false}`
- `{"employee":1,"periodKey":1}` — `{"unique":true}`
- `{"employee":1,"month":1}`

### Submission

Schema: [backend/models/Submission.js](../../backend/models/Submission.js).

Fields: `employee`, `template`, `assignment`, `templateType`, `customKind`, `frequency`, `scheduleLabel`, `holidayOverride`, `overrideReason`, `date`, `tasks`, `excelResponses`, `sheet`, `customResponses`, `customAvailableMarks`, `customEarnedMarks`, `customPenaltyMarks`, `customFinalMarks`, `privateRemark`, `privateRemarkSubmittedAt`, `extraTasks`, `productSales`, `farmerRecords`, `submitted`, `submittedAt`, `lastDraftSavedAt`, `selfRating`, `selfNote`, `idea`, `earnedPoints`, `totalPoints`, `completionPercentage`, `workEarnedPoints`, `workTotalPoints`, `currentReviewStage`, `hodReview.reviewedBy`, `hodReview.reviewedAt`, `hodReview.remarks`, `hodReview.marksGiven`, `hodReview.recommend`, `hodRecommendation.text`, `hodRecommendation.createdBy`, `hodRecommendation.createdAt`, `hodRecommendation.updatedBy`, `hodRecommendation.updatedAt`, `reviewHistory`, `reviewStatus`, `ideaMarks`, `maxIdeaMarks`, `ideaFeedback`, `reviewedBy`, `reviewedAt`, `deleted`, `deletedBy`, `deletedAt`, `deleteReason`, `isTestData`, `testDataMarkedBy`, `testDataMarkedAt`, `hidden`, `hiddenReason`, `hiddenBy`, `hiddenAt`, `hiddenSource`, `editHistory`.

References: employee → User; template → Template; assignment → Assignment; hodReview.reviewedBy → User; hodRecommendation.createdBy → User; hodRecommendation.updatedBy → User; reviewedBy → User; deletedBy → User; testDataMarkedBy → User; hiddenBy → User

Enums: templateType = task, excel, sheet, custom; frequency = one-time, daily, weekly, monthly; currentReviewStage = submitted, under_hod, hod_reviewed, under_hr, under_super_admin, finalized; hodReview.recommend = , approve, needs_changes; reviewStatus = pending, reviewed.

Declared indexes:

- `{"employee":1}`
- `{"templateType":1}`
- `{"customKind":1}`
- `{"date":1}`
- `{"currentReviewStage":1}`
- `{"reviewStatus":1}`
- `{"deleted":1}`
- `{"isTestData":1}`
- `{"hidden":1}`
- `{"employee":1,"template":1,"date":1}` — `{"unique":true}`
- `{"employee":1,"date":1}`
- `{"deleted":1,"isTestData":1}`
- `{"employee":1,"tasks.status":1}` — `{"sparse":true}`

### Template

Schema: [backend/models/Template.js](../../backend/models/Template.js).

Fields: `title`, `description`, `templateType`, `tasks`, `excelColumns`, `sheet`, `customFields`, `extraTaskCatalog`, `customKind`, `customSections`, `department`, `analyticsName`, `reviewFlow`, `subTemplates`, `privateRemarkEnabled`, `privateRemarkLabel`, `privateRemarkRequired`, `isActive`, `analyticsHidden`, `statusTracking`, `createdBy`.

References: department → Department; createdBy → User

Enums: templateType = task, excel, sheet, custom; reviewFlow = direct_hr, hod_first.

Declared indexes:

- `{"title":1}`
- `{"templateType":1}`
- `{"customKind":1}`
- `{"department":1}`
- `{"analyticsHidden":1}`

### User

Schema: [backend/models/User.js](../../backend/models/User.js).

Fields: `name`, `employeeId`, `email`, `phone`, `password`, `role`, `department`, `designation`, `isHOD`, `hodDepartment`, `hodPermissions.canReview`, `hodPermissions.canRemark`, `hodPermissions.canMarks`, `hodPermissions.canRecommend`, `hodPermissions.canEditSubmissions`, `reviewFlow`, `featurePermissions`, `featurePermissionsUpdatedAt`, `featurePermissionsUpdatedBy`, `monthlySalary`, `salaryStructure.ctc`, `salaryStructure.grossSalary`, `salaryStructure.pf`, `salaryStructure.annualCTC`, `salaryStructure.monthlyGross`, `salaryStructure.basicSalary`, `salaryStructure.hra`, `salaryStructure.conveyance`, `salaryStructure.medicalAllowance`, `salaryStructure.specialAllowance`, `salaryStructure.otherAllowance`, `salaryStructure.bonus`, `salaryStructure.pfEnabled`, `salaryStructure.pfPercentage`, `salaryStructure.pfAmount`, `salaryStructure.employerPfPercentage`, `salaryStructure.esicEnabled`, `salaryStructure.esicPercentage`, `salaryStructure.esicAmount`, `salaryStructure.employerEsicPercentage`, `salaryStructure.ptEnabled`, `salaryStructure.ptAmount`, `salaryStructure.tdsEnabled`, `salaryStructure.tdsType`, `salaryStructure.tdsValue`, `salaryStructure.tdsAmount`, `salaryStructure.totalDeductions`, `salaryStructure.netSalary`, `bankName`, `bankAccount`, `uanNumber`, `panNumber`, `dateOfBirth`, `joiningDate`, `probation.enabled`, `probation.startDate`, `probation.endDate`, `lastLoginAt`, `createdByUser`, `status`, `leaveBalance.yearlyAllowance`, `leaveBalance.monthlyAllowance`, `leaveBalance.used`, `leaveBalance.resetDate`, `weeklyOff`, `attendanceMode`, `attendanceModeUpdatedAt`, `attendanceModeUpdatedBy`, `jobDescription`, `scopeOfWork`, `responsibilities`, `reportingManager`, `kpiNotes`, `salaryIncrements`, `lastIncrementDate`, `favoriteContacts`.

References: department → Department; designation → Designation; hodDepartment → Department; featurePermissionsUpdatedBy → User; createdByUser → User; attendanceModeUpdatedBy → User

Enums: role = super_admin, hr, employee; reviewFlow = direct_hr, hod_first; salaryStructure.tdsType = percentage, fixed; status = active, inactive; attendanceMode = submission_based, attendance_review, auto_attendance.

Declared indexes:

- `{"employeeId":1}` — `{"unique":true}`
- `{"email":1}` — `{"unique":true}`
- `{"role":1}`
- `{"isHOD":1}`
- `{"reviewFlow":1}`
- `{"status":1}`
- `{"attendanceMode":1}`
