# Event Registry

Canonical documentation of every business event the HRMS publishes.
Kept in sync with `backend/services/events/registry.js`.

## Contract

- Every business event has **exactly one owner** module.
- No other module may emit an event owned by someone else.
- Read handlers (`router.get`) may never publish an event.
- Adding a new event requires adding an entry here AND to the
  executable registry, plus documenting the owner.

## Registered events

| Event | Owner | Notification | Dashboard | Reminder | Timeline | Realtime |
|---|---|---|---|---|---|---|
| `attendance.status_set` | `attendanceController.setForDay` / `dailyEngine.deriveAttendance` | — | yes | — | yes | yes |
| `attendance_confirmation.confirmed` | `attendanceConfirmationController.confirm` | — | yes | — | yes | yes |
| `attendance_confirmation.reviewed` | `attendanceConfirmationController.actOne` | yes | yes | — | yes | yes |
| `submission.submitted` | `submissionController.submitOne` | — | yes | resolves | yes | yes |
| `submission.reviewed` | `dailyReviewController.finalizeDay` / `submissionController.review` | — | — | — | yes | yes |
| `submission.reopened` | `penaltyController.reopenDecision` | yes | yes | creates | yes | yes |
| `penalty.applied` | `penaltyEngine._upsertAutoPenalty` (only when created===true) / `penaltyController.create` | yes | yes | — | yes | yes |
| `penalty.probable` | `penaltyEngine` (currently disabled) | yes | yes | — | — | yes |
| `penalty.resolved` | `penaltyController` (auto on submit + manual) / `penaltyEngine` | — | yes | — | yes | yes |
| `penalty.cancelled` | `penaltyController.cancel` | yes | yes | — | yes | yes |
| `penalty.waived` | `penaltyController.waiveFinancial` | yes | yes | — | yes | yes |
| `penalty.deducted` | `penaltyController.markFinancialDeducted` | yes | — | — | yes | yes |
| `penalty.recovery` | `performanceRecovery.applyRecovery` | yes | yes | — | yes | yes |
| `penalty.reopen_requested` | `penaltyController.requestReopen` | yes | yes | — | yes | yes |
| `penalty.reopen_decided` | `penaltyController.reopenDecision` | yes | yes | — | yes | yes |
| `leave.applied` | `leaveController.create` | yes | yes | — | yes | yes |
| `leave.decided` | `leaveController.decide` | yes | yes | — | yes | yes |
| `salary_slip.generated` | `salaryController.generate` / `.generateAll` | yes | yes | — | yes | yes |
| `interaction.created` | `interactionController.create` | yes | yes | creates | yes | yes |
| `interaction.participant_responded` | `interactionController.respond` | — | yes | — | yes | yes |
| `interaction.attendance_marked` | `interactionController.setAttendance` | — | — | — | yes | yes |
| `interaction.note_added` | `interactionController.addNote` | — | — | — | yes | yes |
| `interaction.followup_resolved` | `interactionController.resolveFollowUp` | — | yes | resolves | yes | yes |
| `holiday.created` | `holidayController.create` | — | yes | — | yes | yes |
| `event.created` | `eventController.create` | — | yes | — | yes | yes |
| `employee.created` | `employeeController.create` | — | — | — | yes | — |
| `employee.role_changed` | `employeeController.update` | yes | — | — | yes | yes |
| `password_reset.requested` | `passwordResetController.request` | yes | yes | — | yes | yes |
| `password_reset.approved` | `passwordResetController.approve` | yes | — | — | yes | yes |
| `assignment.created` | `assignmentController.create` | yes | yes | creates | yes | yes |
| `assignment.revoked` | `assignmentController.remove` | — | yes | resolves | yes | yes |
| `alert.broadcast` | `notificationController.broadcast` (HR Send Alerts) | yes | — | — | — | yes |

## Naming

`<module>.<verb>` (past tense). Verbs describe state transitions, not
UI intents. Example: `penalty.applied`, not `penalty.notify_employee`.

## Dedupe keys used by the Notification writer

- `penalty.<event>:<penaltyId>` — event ∈ `applied` | `probable` | `waived` | `resolved` | `deducted.<yyyy-mm>` | `recovery.<mode>` | `cancelled`.
- `salary.slip.generated:<slipId>`.
- (Phase 2) `leave.<decision>:<leaveId>`, `interaction.created:<interactionId>:<recipientRole>`, `assignment.created:<assignmentId>`, `alert.broadcast:<alertId>`.

The Notification collection has a **partial unique index** on
`(recipient, eventKey, variant)` where `eventKey` is a non-empty
string. Legacy rows (`eventKey: ''`) are ignored by the index so no
migration is required.
