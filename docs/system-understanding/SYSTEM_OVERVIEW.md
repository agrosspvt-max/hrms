# HRMS system overview

Audit date: 2026-10-03. Source baseline: Git `91aae29`, branch `main`. This is a documentation-only, bounded source audit. No application changes, database connections to configured data, server startup, migrations, seeds, or external email sends were performed. Evidence classifications and unresolved scope are in [Known issues](KNOWN_ISSUES_AND_RISKS.md) and [Testing](TESTING_AND_DEPLOYMENT.md).

## Start here

| Document | Purpose |
| --- | --- |
| [Module reference](MODULE_REFERENCE.md) | Feature ownership, frontend/backend locations, dependencies, lifecycle and coverage |
| [Business workflows](BUSINESS_WORKFLOWS.md) | Request-to-persistence traces and failure branches |
| [Data model and sources of truth](DATA_MODEL_AND_SOURCES_OF_TRUTH.md) | Authoritative records, snapshots, indexes and competing representations |
| [API and permissions](API_AND_PERMISSIONS.md) | Route-derived inventory and actual authorization differences |
| [Architecture diagrams](ARCHITECTURE_DIAGRAMS.md) | Eight Mermaid views of the implementation |
| [Testing and deployment](TESTING_AND_DEPLOYMENT.md) | Executed checks, coverage, configuration and startup risks |
| [Known issues and risks](KNOWN_ISSUES_AND_RISKS.md) | Ranked findings, evidence, confidence and next steps |

## Product and architecture

The application manages employees and organization structure, recurring work assignments, daily submissions and reviews, attendance and leave, performance and pendency reporting, payroll slips, legacy penalties and a configurable compliance engine. It also provides contacts, product/dealer catalogues, calendar events, policy documents, employee interactions, notes, notifications, reminders and history.

It is a JavaScript React SPA plus a CommonJS Express API backed by MongoDB through Mongoose. There is no shared application package, separate durable worker queue, Redis bus, or relational database in the inspected runtime. Most business logic lives in large controllers and services. Controllers save primary documents and then invoke secondary services; these operations are commonly best-effort and nontransactional. Compliance has a conditional Mongo transaction wrapper, but standalone Mongo falls back to sequential writes.

### Stack from manifests and lockfiles

| Layer | Declared major / locked version |
| --- | --- |
| Frontend | React/React DOM 18 / 18.3.1; React Router 6 / 6.30.3; Vite 5 / 5.4.21 |
| UI/data | Tailwind 3 / 3.4.19; Axios 1 / 1.16.1; Recharts 2 / 2.15.4; react-data-grid 7 beta / 7.0.0-beta.47 |
| API | Express 4 / 4.22.2; Mongoose 8 / 8.24.0; jsonwebtoken 9 / 9.0.3; bcryptjs 2 / 2.4.3 |
| Files/email | Multer memory storage, XLSX, ExcelJS, JSZip, PDFKit, Nodemailer; optional Resend HTTPS through global fetch |
| Tooling | nodemon, concurrently; Node 23.3.0 available in audit environment, no pinned runtime version identified |

Sources: [root manifest](../../package.json), [API manifest](../../backend/package.json), [frontend manifest](../../frontend/package.json) and adjacent lockfiles. Locked versions are not a guarantee that deployed or existing local dependencies match.

## Repository map and entry points

| Path | Responsibility |
| --- | --- |
| `backend/server.js` | Express construction, route mounting, event subscribers, Mongo connection, startup data transformations, schedulers and HTTP listener; importing it starts the application |
| `backend/config/` | Database connection, feature flags and compliance rollout configuration |
| `backend/routes/` | HTTP methods, route ordering and middleware composition, including nested compliance routers |
| `backend/middleware/` | JWT authentication, role/feature guards and error responses |
| `backend/controllers/` | Request handling, validation, scope, business writes, exports and secondary effects |
| `backend/services/` | Daily generation, leave/attendance synchronization, pending/dependencies, penalties, events, reminders, timeline, migrations |
| `backend/services/compliance/` | Rules/detectors, incidents, actions, ledgers, waiver/recovery, escalation, optional legacy backfill and reconciliation |
| `backend/models/` | 43 Mongoose models plus a shared ledger-schema builder; fields and declared indexes are catalogued in the data document |
| `backend/utils/` | UTC dates, working days, leave accounting, payroll, file parsers/exporters, email, audit, private field scrubbing |
| `frontend/src/main.jsx` | Browser bootstrap and React providers |
| `frontend/src/App.jsx` | Routes, protected page gates and HR/employee home selection |
| `frontend/src/api/axios.js`, `context/AuthContext.jsx`, `realtime.js` | API base URL, bearer injection, local session state and SSE singleton |
| `frontend/src/pages/{employee,hr,hod,superadmin}/`, `components/` | Screens and reusable forms, tables, grids, calendars and review panels |
| `docs/ADR/`, `docs/EVENT_REGISTRY.md` | Existing design intentions; linked rather than duplicated; implementation differences are recorded here |
| `backend/services/compliance/__tests__/` | 31 standalone Node regression scripts plus Mongo stub helper |
| Root scripts, `backend/seed.js`, diagnostic scripts | Development orchestration and separately invoked seeding/diagnostics; do not treat as safe read commands |

`node_modules/`, frontend `dist*` directories, Vite timestamp configuration bundles, bundled assets and lockfiles are generated/dependency material. Root-level backend inspection/debug scripts are operational scratch material, not mounted API code. Their incidental presence does not prove they are safe to execute. Generated output and employee-specific diagnostic filenames are deliberately not copied into this report.

## Request and data path

1. A React page calls the shared Axios instance. `VITE_API_URL` defaults to `/api`; the request interceptor adds the JWT from `localStorage`.
2. In development, Vite proxies `/api` to port **5001**. Express defaults to **5000**, so configuration must explicitly align those ports.
3. `server.js` mounts the router. `protect` validates a bearer token or query token, loads the current active User and attaches it to the request. Role and feature middleware runs where declared; controller checks apply additional ownership/department rules.
4. Controllers read/write Mongoose documents, invoke orchestrators and publish bus/SSE events. Unique indexes provide selected duplicate prevention, not atomicity across collections or foreign-key enforcement.
5. A JSON result returns to the page. Pages also subscribe to typed browser events and refetch. SSE and the domain EventEmitter exist only inside one API process, with no durable replay.

Public endpoints include login and password-reset request/validate/reset, health, a document diagnostic and an email diagnostic. The email diagnostic can send to an arbitrary query recipient without authentication (issue S01).

## Actual identities and permissions

The only persisted role enum is `employee`, `hr`, `super_admin`. HOD is an overlay (`isHOD`, `hodDepartment`, `hodPermissions`) on a User, not a fourth stored role. `reportingManager` is descriptive text; no separate manager role or reporting-tree authorization is implemented. Names such as “manager” in notification/configuration metadata do not create a new account role.

Employees authenticate with the same login and JWT flow as administrators. They have own work, attendance, leave, salary, inbox and interactions views. HODs add team/review/analytics access, with inconsistent controller enforcement of department and fine permissions. HR can manage employee accounts and many organization-wide workflows; selected HR/SA targets and self-review actions are restricted. Super Admin inherits HR guards and controls administrator account/access management. Feature grants can open administrative screens/APIs to employee accounts. Most such backend gates check `.enabled` only; configured access levels and sub-options are not universally enforced. See the backend-derived matrix and exceptions in [API and permissions](API_AND_PERMISSIONS.md).

## Important rules and authoritative data

- UTC midnight is the common business-day representation; server-local scheduler timing and browser-local displays introduce timezone boundaries that require operational validation.
- Effective leave units exclude weekly offs and merged Holiday/Event holidays; half days consume 0.5 only on one working day. Paid approval increments `User.leaveBalance.used`, revocation reverses stored units. Manual overrides own only their incremental `Attendance.leaveDelta`.
- Assignments target an employee, department or designation and generate recurring Submission snapshots. The daily unique key is `(employee, template, date)`, not assignment. Generation is also invoked by GET `/submissions/today`.
- Task `done` and `ongoing` both earn standard task points. Pending, work-unavailable and untouched states differ. Daily self-rating/reflection and daily innovation marks are separate from per-submission work marks.
- `Submission.submitted`, `reviewStatus`, `currentReviewStage`, flags and review history are distinct facts. “Needs changes” alone does not reset submission editability.
- Default live analytics exclude deleted/test/hidden rows; completion and dynamic template analytics additionally require reviewed work. Attendance does not consistently use that filter.
- Payroll saves a SalarySlip snapshot; later attendance/leave changes do not automatically regenerate it. Regeneration can overwrite an existing period; editing uses a different payroll input set.
- Legacy Penalty and v2 ComplianceIncident/ActionEffect/four ledgers coexist. A v2 financial or LWP action is not proof of an actual salary deduction or Attendance change. Legacy final-marks readers still read Penalty.

## Build, deployment and audit boundary

Root `npm run dev` orchestrates backend and frontend; `npm run build` builds only the SPA. `npm --prefix backend start` launches API startup with data mutations and schedulers. Vercel's SPA rewrite is present; comments assume a separate Render API, but infrastructure, actual environment, backups and deployment health were not verified. A production frontend needs an API base URL pointing to the separately hosted `/api` unless another verified proxy is provided.

Executed: 30 regression scripts passed, one Mongo integration script was environment-blocked, 228 production backend files passed syntax checking, and the frontend build was blocked by an existing wrong-platform esbuild binary. A synthetic collection stub verified the notification metadata incompatibility without a database. No browser end-to-end verification was possible from these checks. Exact commands and limitations appear in [Testing](TESTING_AND_DEPLOYMENT.md).

This pass deeply traced the critical account, leave, attendance, assignment/submission/review, payroll and compliance paths; inspected all route declarations and model metadata; and selectively followed secondary controllers/UI/services. It is not an exhaustive line-by-line audit of roughly 87,000 source lines. Detailed visual UI behavior, every export formatting branch, every diagnostic script and deployed-state correctness remain unverified. Follow-up work is ranked in [Known issues](KNOWN_ISSUES_AND_RISKS.md).
