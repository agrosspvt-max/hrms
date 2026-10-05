# Architecture diagrams

Eight source-based Mermaid views, snapshot `91aae29`. Solid arrows denote direct calls/data relationships; dotted arrows denote best-effort/derived/conditional effects. They do not imply a transaction. Detailed state, guard and failure semantics are in [Workflows](BUSINESS_WORKFLOWS.md), [Data](DATA_MODEL_AND_SOURCES_OF_TRUTH.md) and [API](API_AND_PERMISSIONS.md).

## 1. High-level architecture

```mermaid
flowchart LR
  Browser["React 18 SPA\nmain.jsx and App.jsx"] --> Axios["Axios bearer requests\nVITE_API_URL or /api"]
  Axios --> Proxy["Vite dev proxy :5001\nor separately hosted API"]
  Proxy --> API["Express API\nserver.js default :5000"]
  API --> Auth["JWT + current User\nrole/feature/controller scope"]
  Auth --> Controllers["Controllers and services"]
  Controllers --> Mongo[("MongoDB\n43 Mongoose models")]
  API --> Boot["Boot backfills/index sync\nand seeds"]
  Boot --> Mongo
  API --> Scheduler["Per-process daily compliance\nreminder and optional reconciler"]
  Scheduler --> Controllers
  Controllers -.-> Bus["In-process EventEmitter"]
  Bus -.-> Projectors["Notification/reminder\nrealtime projectors"]
  Projectors --> Mongo
  Controllers -.-> Mail["SMTP or Resend HTTPS\nwelcome/reset/diagnostic"]
  Controllers -.-> SSE["Per-process SSE client map"]
  Projectors -.-> SSE
  SSE -.-> Browser
```

Evidence: server.js, config/db.js, frontend api/axios.js and realtime.js, event subscribers and scheduler services. Render/Vercel are intended hosting assumptions in comments/config, not audited infrastructure. No durable queue/shared realtime bus appears in this runtime.

## 2. Frontend-to-backend request flow

```mermaid
sequenceDiagram
  participant Page as React page
  participant HTTP as Axios
  participant Route as Express router
  participant Guard as auth.js + controller guards
  participant Logic as Controller / orchestrator
  participant DB as MongoDB
  participant RT as Event bus / SSE
  Page->>HTTP: action with JSON or multipart data
  HTTP->>Route: API call + bearer JWT
  Route->>Guard: protect then declared gates
  Guard->>DB: load current active User
  DB-->>Guard: role / HOD / feature configuration
  alt unauthorized or invalid payload
    Guard-->>HTTP: 401 / 403 / validation error
    HTTP-->>Page: error; 401 clears local session
  else permitted
    Guard->>Logic: authenticated request
    Logic->>DB: primary read/write
    DB-->>Logic: saved primary state
    Logic->>DB: secondary writes, often best effort
    Logic-->>RT: domain event / named SSE
    Logic-->>HTTP: JSON or export bytes
    HTTP-->>Page: update/refetch
    RT-->>Page: client forwards supported event types
    Page->>HTTP: refetch current projection
  end
```

Controller ownership/department checks often run inside Logic; the sequence compresses them into Guard for readability. Public auth/reset and diagnostics bypass protect. An accepted primary write can precede a failed secondary operation.

## 3. Module dependency map

```mermaid
flowchart TD
  Account["User / organization / grants"] --> Leave["Leave / probation / balance"]
  Account --> Work["Template / Assignment"]
  Account --> Attendance["Attendance / confirmation"]
  Calendar["Holiday + Event + birthdays"] --> Days["eventOccurrences / workingDays"]
  Days --> Leave
  Days --> Daily["dailyEngine generation + inference"]
  Work --> Daily
  Leave --> Sync["businessStateSync orchestration"]
  Work --> Sync
  Sync --> Daily
  Sync --> LeaveAtt["leaveAttendance"]
  LeaveAtt --> Attendance
  Daily --> Submission["Submission / review / reflection"]
  Submission --> Pending["pendingStateService"]
  Submission --> Deps["dependencyEngine"]
  Deps --> Pending
  Pending -.-> Legacy["penaltyEngine / Penalty"]
  Legacy -.-> Pending
  Sync -.-> Compliance["v2 detector / incident / actions"]
  Pending --> Compliance
  Legacy --> Final["penaltyMath legacy final marks"]
  Submission --> Final
  Final --> Analytics["Performance and reports"]
  Submission --> Analytics
  Attendance --> Salary["computeSlip / computePayroll"]
  Final --> Salary
  Account --> Salary
  Compliance --> Ledgers["Four compliance ledgers"]
  Compliance -.-> Legacy
  Submission -.-> Delivery["Notifications / reminders / SSE"]
  Leave -.-> Delivery
  Salary -.-> Delivery
  Compliance -.-> Delivery
```

The dotted two-way Pending/Legacy relationship is an actual lazy require cycle: penaltyEngine requires pendingStateService inside evaluation helpers; pendingStateService requires penaltyEngine inside resolution helpers. A static local-require scan across228 production backend files found751 edges and this one multi-file strongly connected component. It is not evidence of immediate CommonJS initialization failure because imports are lazy.

Tight coupling: User changes affect assignment cohorts, leave policy, attendance inference, analytics history and payroll. Calendar edits affect balances, stored attendance and work eligibility. Submission status/points affect pendency, sanctions, performance and salary. Shared helpers reduce duplication but do not eliminate different controller formulas.

## 4. Database relationship overview

```mermaid
erDiagram
  USER ||--o{ ASSIGNMENT : "employee target polymorphic"
  DEPARTMENT ||--o{ USER : "current department"
  DESIGNATION ||--o{ USER : "current designation"
  DEPARTMENT ||--o{ DESIGNATION : contains
  USER o|--o{ DEPARTMENT : "hodEmployeeId"
  TEMPLATE ||--o{ ASSIGNMENT : defines
  TEMPLATE ||--o{ SUBMISSION : "snapshot origin"
  ASSIGNMENT o|--o{ SUBMISSION : "assignment ref"
  USER ||--o{ SUBMISSION : owns
  USER ||--o{ DAILY_REFLECTION : "one per day"
  USER ||--o{ DAILY_REVIEW : "one per day"
  USER ||--o{ ATTENDANCE : "one per day"
  USER ||--o{ ATTENDANCE_CONFIRMATION : "one per day"
  USER ||--o{ LEAVE : applies
  LEAVE o|--o{ LEAVE_ATTACHMENT : "orphan then linked"
  LEAVE o|--o{ ATTENDANCE : "leaveId"
  USER ||--o{ SALARY_SLIP : "one per periodKey"
  SUBMISSION o|--o{ DEPENDENCY_TASK : source
  USER ||--o{ DEPENDENCY_TASK : assignedTo
  USER ||--o{ PENALTY : legacy
  SUBMISSION o|--o{ PENALTY : target
  COMPLIANCE_RULE ||--o{ COMPLIANCE_INCIDENT : ruleId
  USER ||--o{ COMPLIANCE_INCIDENT : employee
  COMPLIANCE_INCIDENT ||--o{ ACTION_EFFECT : consequence
  COMPLIANCE_INCIDENT ||--o{ COMPLIANCE_EVENT : history
  COMPLIANCE_INCIDENT ||--o{ WAIVER : request
  COMPLIANCE_INCIDENT ||--o{ RECOVERY : operation
  ACTION_EFFECT ||--o{ LEDGER_ENTRY : "four collections"
  USER ||--o{ NOTIFICATION : recipient
  USER ||--o{ REMINDER : recipient
  USER ||--o{ INTERACTION : "embedded participant"
  INTERACTION ||--o{ INTERACTION_NOTE : notes
  NOTE_TYPE ||--o{ NOTE : classifies
  USER ||--o{ AUDIT_LOG : actor
```

Conceptual cardinalities describe intended refs, not referential constraints. ASSIGNMENT targetRef can instead point to Department or Designation. HOD relationship is stored in both directions with different update paths. LEDGER_ENTRY denotes MarksLedger, FinancialLedger, PercentageLedger and AttendanceLedger. CompanyDocument, AttendanceNote, Contact, Product, Quantity, Dealer, Holiday, Event, InteractionTag, PasswordResetRequest and LeaveConfig are catalogued in the data document; they are omitted here to keep the core relation diagram readable.

## 5. Leave → attendance → submission synchronization

```mermaid
flowchart TD
  Action["Apply / approve / edit / revoke\nor holiday recalculation"] --> Validate["Dates, type, overlap, effective units\nrole/target/self checks"]
  Validate --> Balance["User.leaveBalance.used save"]
  Balance --> Persist["Leave save / status metadata"]
  Persist --> Att["leaveAttendance clear/rebuild\nsource=leave rows"]
  Persist --> Sync["businessStateSync range / union\ncap 400 days"]
  Sync --> Full{"Approved full leave?"}
  Full -->|yes| Work{"Started work?"}
  Work -->|no| Hide["Hide untouched stubs\nhiddenSource=leave"]
  Work -->|yes without force| Conflict["Retain started work\nreport conflict"]
  Work -->|force| Force["Hide started work\nwith reason"]
  Full -->|no or half| Ensure["Generate eligible work\nunhide leave-origin rows"]
  Hide --> Pending["Recompute pending/dependencies"]
  Conflict --> Pending
  Force --> Pending
  Ensure --> Pending
  Pending -.-> Compliance["Resolve/re-evaluate sanctions\nincident and effect differ"]
  Sync -.-> SSE["working_day:changed"]
  Persist -.-> Notify["Approval/apply notice + audit\nrevoke notice disabled"]
```

Balance, Leave and secondary models are separate writes. The diagram describes the general controller pattern; rejection has no debit and setBalance is independent. Half→full preflight is defective (D04); a conflict is not always a no-write outcome. LeaveAttendance reads Holiday only while effective units also consume Event holidays.

## 6. Assignment → submission → review → scoring

```mermaid
flowchart LR
  Template["Template definition\ntask / excel / sheet / custom"] --> Assignment["Assignment target and recurrence"]
  Assignment --> Daily["ensureDailySubmissions\nschedule + leave + holiday override"]
  Daily --> Stub["Unique employee/template/day\nsnapshots and unsubmitted stub"]
  Stub --> Draft["Own draft / self reflection"]
  Draft --> Submit["submitOne validates + scores\nsets submitted + stage"]
  Submit --> HOD{"User.reviewFlow hod_first?"}
  HOD -->|yes| HReview["HOD marks/remark/recommend\nstage hod_reviewed"]
  HOD -->|no| HR["HR / Super Admin review"]
  HReview --> HR
  HReview -.-> Return["needs_changes recommendation\nsubmitted remains true"]
  HR --> WorkScore["Submission work marks\nreviewStatus reviewed"]
  DailyReview["DailyReview innovation marks\none employee/day"] --> Aggregate["Completion / salary aggregation"]
  WorkScore --> Legacy["penaltyMath reads legacy Penalty"]
  Legacy --> Aggregate
  Custom["custom grading caches\ncurrent template formulas"] --> TemplateAnalytics["Dynamic template analytics"]
  Submit --> Custom
  Submit -.-> Deps["Dependencies / backlog resolution"]
  Submit -.-> Attendance["Attendance helper"]
  Aggregate --> Slip["SalarySlip snapshot"]
```

Custom score caches are not uniformly consumed by generic scoring/payroll. Multiple assignments can coalesce into one daily row. Ordinary HOD needs_changes has no complete return-to-editability transition; penalty reopening is separate. Daily edit/finalization routes have different permission checks from per-submission HOD review.

## 7. Compliance → penalty → ledgers

```mermaid
flowchart TD
  LegacyRun["Legacy daily sweep"] --> Penalty[("Penalty\nmarks / percent / financial state")]
  LegacyRun --> V2{"newEngine flag?"}
  V2 -->|enabled| Rules["Enabled ComplianceRule\nscope + detector + critical context"]
  Rules --> Candidate["Incident candidate\nautomatic naturalKey dedupe"]
  Candidate --> Promote["Claim active at effectiveDate"]
  Promote --> ActionFlag{"actionEngine flag?"}
  ActionFlag -->|enabled| Action["Current rule action execution"]
  Action --> Txn{"Replica set / mongos?"}
  Txn -->|yes| Atomic["Session transaction\nparticipating effect/ledger writes"]
  Txn -->|no| Serial["Serial fallback\npartial writes possible"]
  Atomic --> Effect[("ActionEffect unique\nincident/action/day")]
  Serial --> Effect
  Effect --> Ledger[("Marks / Financial /\nPercentage / Attendance ledger")]
  Effect -.-> Mirror["Selected legacy mirror\nflag/action dependent"]
  Mirror --> Penalty
  Waiver["Approved waiver / recovery / cancel"] --> Credit["Inverse ledger entries\neffect terminal state"]
  Credit --> Ledger
  Resolve["Generic incident resolve"] --> OnlyIncident["Incident status only\neffects may remain active"]
  Penalty --> Final["Legacy final marks / adjustment readers"]
  Ledger --> V2View["V2 ledger/dashboard views"]
  Ledger -.-> Gap["No direct actual salary or\ncalendar attendance write"]
```

Waiver/recovery request records and incident promotion are not all in the effect transaction. Partial waiver target relationship checks are missing. A cached runningBalance is not a proven sum. Recurring/escalation loops and backfill/read-shim compatibility are flag-dependent; a completed legacy cutover was not verified.

## 8. Notifications and realtime event flow

```mermaid
flowchart TD
  Controller["Controller after primary save"] --> Direct["notifyEvents direct helper"]
  Controller --> Bus["events.publish\nEventEmitter, no replay"]
  Bus --> NP["notificationProjector"]
  Bus --> RP["reminderProjector"]
  Bus --> Mirror["realtimeMirror"]
  Direct --> Writer["insertMany or keyed _upsertOne"]
  NP --> Writer
  Writer --> N[("Notification\nrecipient/read/resolve/dismiss")]
  RP --> R[("Reminder\nactive hash/due/snooze/done")]
  R --> Timer["15-minute due sweep\n20-minute catch-up window"]
  Writer -.-> RT["realtime.publish\nper-user local connections"]
  Mirror -.-> RT
  Timer -.-> RT
  RT --> Stream["SSE stream\nJWT query at handshake"]
  Stream --> Wire["frontend realtime.js\nallowlisted named events"]
  Wire --> Browser["window hrms:rt events\nsubscribers refetch API"]
  Stream -.-> Drop["Unlisted event types dropped\ncompliance/penalty/alert/reminder/timeline"]
  Controller -.-> Audit[("AuditLog / ComplianceEvent\nseparate durable histories")]
```

`rawResult`/Mongoose8 and notification partial-index incompatibilities affect keyed delivery and reminder create results. No-op helpers intentionally skip many legacy event notifications. Failed subscriber promises are logged; publish does not wait for them or persist retry work.

## Orchestration versus rule ownership

- **Orchestration:** businessStateSync coordinates attendance/work/pending/compliance and SSE; dailyComplianceScheduler/ruleEvaluationScheduler coordinate detection and execution; controllers coordinate request validation and writes; projectors coordinate downstream delivery.
- **Rules:** dateHelpers/effectiveLeaveDays and eventOccurrences define calendar/unit semantics; leaveAccounting defines paid-override arithmetic; scheduleHelpers defines recurrence; pendingStateService defines task pending predicates; customTemplate/payroll/penaltyMath define different scoring/money calculations; detector/action registries define compliance behavior.
- **Duplication/conflicts:** submission/review/daily edit score recalculation; custom caches versus legacy points; Holiday-only synchronization versus unified calendar; legacy and v2 sanction readers; salary generation versus editing; enabled-only route gate versus configured action permissions. A shared helper's presence does not guarantee all call sites use it.
