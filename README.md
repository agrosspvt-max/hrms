# HRMS - Enterprise Workflow & Salary Management

A complete, production-ready Human Resource Management System that unifies:

- Employee & organisation management (departments, designations, leave balances)
- Reusable daily-work **templates** + flexible **assignments** (employee / department / designation)
- **Daily task submission** with three statuses (`done` / `pending` / `work not available`)
- **Backlog system** with delay tracking, color-coded urgency, and auto carry-forward
- **Attendance automation** derived directly from submissions
- **Leave management** with paid/unpaid logic and weekly-off configuration
- **Performance analytics** with rankings, department charts, and backlog growth
- **Salary management** with auto-generated PDF salary slips, bonuses, deductions, and CSV export
- **Self-observation / self-rating** system (informational, never affects scoring)
- HR + Employee role-based dashboards in a modern Tailwind UI

Built like real SaaS — clean architecture, JWT auth, RBAC, indexes, validation, seed data.

---

## Tech stack

| Layer    | Tech                                                                  |
| -------- | --------------------------------------------------------------------- |
| Frontend | React 18, React Router 6, Axios, Tailwind CSS, Recharts, Vite         |
| Backend  | Node.js, Express, Mongoose / MongoDB, JWT, bcrypt, PDFKit             |
| Tooling  | Nodemon, Morgan, dotenv                                               |

---

## Project structure

```
HRMS/
├── backend/                     # Express + Mongoose API
│   ├── config/db.js
│   ├── models/                  # User, Department, Designation, Template,
│   │                            # Assignment, Submission, Leave, SalarySlip
│   ├── controllers/             # 10 controllers (auth, employees, dashboards, salary, ...)
│   ├── routes/                  # REST route files mounted under /api/*
│   ├── middleware/              # protect (JWT), authorize (RBAC), error handler
│   ├── services/dailyEngine.js  # core business logic (backlog/attendance/daily gen)
│   ├── utils/                   # pdfGenerator, csvExporter, dateHelpers, generateToken
│   ├── seed.js                  # one-command demo data
│   └── server.js                # entry
├── frontend/                    # React + Vite + Tailwind app
│   ├── src/
│   │   ├── components/          # Sidebar, Topbar, Layout, Modal, Collapsible, StatCard, ...
│   │   ├── context/             # AuthContext, ToastContext
│   │   ├── api/axios.js
│   │   ├── pages/
│   │   │   ├── Login.jsx, ChangePassword.jsx
│   │   │   ├── hr/              # HRDashboard, Employees, Departments, Designations,
│   │   │   │                    # Templates, Assignments, GlobalBacklog, Performance,
│   │   │   │                    # HRLeaves, HRSalary
│   │   │   └── employee/        # EmployeeDashboard, MyAttendance, MyLeaves, MySalary
│   │   ├── App.jsx, main.jsx, index.css, utils/helpers.js
│   ├── tailwind.config.js, postcss.config.js, vite.config.js, index.html
│   └── package.json
├── package.json                 # workspace-level convenience scripts
└── README.md
```

---

## Quick start

### Prerequisites

- Node.js 18+
- MongoDB running locally (or a connection string to Atlas)

### Install

```bash
# From the repo root
npm run install:all
```

(Equivalent to running `npm install` inside both `backend/` and `frontend/`.)

### Configure env

```bash
cp backend/.env.example backend/.env
# edit MONGO_URI, JWT_SECRET, COMPANY_* if needed
# for password-reset emails, also set SMTP_EMAIL + SMTP_PASSWORD (see below)
```

### Gmail SMTP setup (for password-reset emails)

The HR-approved password-reset workflow emails employees via Gmail SMTP.

1. Enable **2-Step Verification** on the Gmail account that will send mail.
2. Visit <https://myaccount.google.com/apppasswords> and generate a new App Password (16 chars).
3. In `backend/.env`, set:

   ```
   SMTP_EMAIL=supportagross@gmail.com
   SMTP_PASSWORD=xxxxxxxxxxxxxxxx   # paste the 16-char App Password, no spaces
   ```

4. Optional: tweak `PASSWORD_RESET_TOKEN_TTL_MIN` (default 30 minutes).

### Seed demo data

```bash
npm run seed
```

This creates 4 departments, 4 designations, 1 HR + 3 employees and 3 daily templates.
Demo accounts (password `password123` for all):

| Role     | Email             | Notes                  |
|----------|-------------------|------------------------|
| HR/Admin | hr@hrms.local     | Full HR dashboard      |
| Employee | aarav@hrms.local  | Accounts dept          |
| Employee | priya@hrms.local  | Engineering, off Sat+Sun |
| Employee | rohit@hrms.local  | Sales / Manager        |

### Run the dev servers

In two terminals:

```bash
npm run dev:server     # API on :5000
npm run dev:client     # UI on :5173 (proxies /api -> :5000)
```

Open <http://localhost:5173> and sign in with one of the demo accounts.

### Build for production

```bash
npm run build          # builds the React app into frontend/dist
```

You can serve `frontend/dist/` from any static host or behind the same Express
server in production.

---

## REST API overview

All endpoints sit under `/api`. JWT goes in `Authorization: Bearer <token>`.

| Resource     | Endpoints                                                                                  |
|--------------|--------------------------------------------------------------------------------------------|
| Auth         | `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password`                           |
| Employees    | `GET/POST /employees`, `PUT/DELETE /employees/:id`, `PATCH /employees/:id/status`, ...     |
| Departments  | full CRUD `/departments`                                                                   |
| Designations | full CRUD `/designations`                                                                  |
| Templates    | full CRUD `/templates`                                                                     |
| Assignments  | full CRUD `/assignments`                                                                   |
| Submissions  | `GET /submissions/today`, `POST /submissions/:id/submit`, `POST /submissions/backlog/complete`, `GET /submissions/history` |
| Leaves       | `POST /leaves`, `GET /leaves/mine`, `GET /leaves` (HR), `PATCH /leaves/:id/decision`, `GET /leaves/calendar`, `PUT /leaves/balance/:id` |
| Attendance   | `GET /attendance/mine`, `GET /attendance/employee/:id`                                     |
| Salary       | `POST /salary/generate`, `POST /salary/generate-all`, `GET /salary`, `GET /salary/mine`, `GET /salary/:id/pdf`, `GET /salary/export.csv`, `PATCH /salary/:id` |
| Dashboard    | `GET /dashboard/hr/{today,backlog,performance,summary}`, `GET /dashboard/employee/summary` |

---

## Core business rules (reference)

**Task statuses** (per spec):

- `done` -> earned += pts, total += pts; removed from today.
- `pending` -> earned 0, total += pts, **requires reason**, becomes backlog.
- `work_not_available` -> earned 0, total **unchanged**; removed.

**Backlog**: lives on its original submission (preserves `pendingSince` + reason),
carried forward in dashboard queries every day. Late completion gives **no** marks.

**Delay colors**: 0 days = gray, 1 day = amber, 2+ days = red.

**Attendance**: derived from submissions:
- submitted -> present
- approved leave -> paid_leave or unpaid_leave
- weekly off -> weekly_off
- otherwise -> absent

**Salary formula**:

```
perDay   = monthlySalary / workingDays
paidDays = presentDays + paidLeaves
gross    = perDay * paidDays
net      = gross + bonuses - deductions
```

Unpaid leaves and absents deduct one day each via the working-day denominator.
Weekly offs never deduct salary.

**Self-observation**: visible to HR; never affects earned points, totals,
percentage, rankings, or salary.

---

## Notes & extensibility

- Daily submissions are generated lazily when the employee opens their
  dashboard (`/api/submissions/today`). The endpoint is idempotent thanks to a
  unique `(employee, template, date)` index.
- Salary slip generation is idempotent per `(employee, month)` so HR can
  re-generate after adjustments without duplicates.
- The seed data is the fastest way to explore - run `npm run seed` whenever
  you want to reset the database to a clean state.

Happy shipping!
