# API and permissions

Source-derived snapshot, 2026-10-03, `91aae29`. Exact methods/routes are inventoried below. Backend guards establish authority; page visibility is secondary. [Known issues](KNOWN_ISSUES_AND_RISKS.md) records exceptions with scenarios.

## Authentication and error contract

`middleware/auth.js:protect` accepts Authorization bearer or `req.query.token`, verifies JWT_SECRET, then loads User excluding password and checks active status. Role/permission changes therefore affect new HTTP requests immediately; an already-open SSE stream does not repeat this check. Missing/invalid/expired token returns401. Inactive-user403 thrown within protect is caught and converted to generic401. `authorize('hr')` also admits super_admin; requireHOD permits an HOD overlay or Super Admin; requireReviewer accepts HR/SA or HOD with canReview. requireRoleOrFeature checks a requested role/SA inheritance or any selected `.enabled` grant, not its configured level.

Controller validation generally sets400, missing records404, scope violations403, overlaps/work conflicts409. Unset status becomes500. Error JSON includes `message` and development stack; production still exposes the raw error message. ObjectId casts/schema errors are not uniformly mapped to400. No versioned API contract or comprehensive OpenAPI spec was identified.

## Verified role/capability matrix

E = ordinary employee; H = employee with HOD overlay; G = employee with relevant enabled grant. HR/SA can also use own endpoints unless a business controller blocks them. “Any” below remains subject to target/self rules and lifecycle state.

| Capability | E | H | G | HR | Super Admin |
| --- | --- | --- | --- | --- | --- |
| Login/me/change password | Own | Own | Own | Own | Own |
| Employee directory | No | `/team` scoped; ordinary directory not by HOD alone | Enabled directory-consuming grant; broad profile response S04 | List excluding SA; employee management | All; administrator accounts |
| Create/change account roles | No | No | No | Employee targets only in normal CRUD | Employee/HR/SA targets; final-SA protection has D23 gap |
| Feature access configuration | No | No | No | Yes | Yes |
| Department/designation read | Authenticated | Authenticated | Authenticated | Yes | Yes |
| Organization writes | No | No | Department feature applies to Department routes; Designation writes remain HR-only | Yes | Yes |
| Templates read | Authenticated | Authenticated | Authenticated | Yes | Yes |
| Templates/assignments writes | No | No by HOD alone | assignments enabled, level not enforced | Direct employee targets restricted for HR/admin/self; group targeting differs | Yes |
| Own submission/reflection/backlog | Own | Own | Own | Own | Own, except business-route restrictions |
| Per-submission review | No | Dept + canReview/fine permissions | submissionReviews; controller target/self checks | Employee targets, not own/HR/SA | Broad, self exceptions vary by handler |
| Daily review/edit | No | Dept on many paths; fine-permission omissions S05 | submissionReviews; some day-detail paths still reject | Employee targets, no self | Broad; self finalization restrictions still apply |
| Performance | No, own dashboard only | Dept in main pendency/completion | analytics guard accepts performance OR templateAnalytics; endpoint checks differ | Org/filter | Org/filter |
| Dynamic template analytics | No | Dept cohort; picker global/dept templates | templateAnalytics plus allowedTemplateIds; org employee cohort | Org/filter | Org/filter |
| Self-review analytics | No | Intended dept; scope override S03 | Gate accepts but controller rejects ordinary G | Org/filter | Org/filter |
| Leave application | Own | Own | Own | Own | Apply blocked by controller |
| Leave approval/edit/revoke/balance | No | No by HOD alone | leaveApprovals, no general department clamp; self forbidden | No self/HR/SA leave decisions except SA | Broad, self decision restricted |
| Attendance calendar own | Own | Own | Own | Own + management | Broad |
| Manual attendance | No | Confirmation review path only; department gap S02 | attendance enabled for management endpoints | Broad | Broad |
| Salary own published/PDF | Own | Own | Own | Own + management PDF | Broad |
| Salary generate/list/update/export | No | No by HOD alone | salary enabled; org access | Yes | Yes |
| Salary retract/publish/bulk-selected | No | No | Route gate allows; controller rejects nonadmin | Yes | Yes |
| Legacy penalties | Own reads/actions | Dept reads where controller allows | penalties flag does not replace controller admin write checks | Org management | Org management |
| v2 compliance | Own reads/request, flag-dependent | Own reads; no generic department reviewer authority | penalties opens page, not v2 admin controller | Org writes/admin dashboards, flag-dependent | Same |
| Dependencies | Assigned/created own, authorized resolution | Same + role-specific controller behavior | Same | Oversight/list/chain and actions | Same |
| Contacts/events/products catalogue reads | Authenticated | Authenticated | Authenticated | Yes | Yes |
| Catalogue/contact/calendar writes | No | No by HOD alone | Relevant enabled feature | Yes | Yes |
| Company documents | Active employee-visible only | Same | Same | All/write | All/write |
| Leave attachments | Own uploaded/own leave list | Same, not team attachment access | Leave grant alone does not grant attachment reads | All | All |
| Notifications | Own inbox/read/resolve/dismiss; cannot delete | Same | sendAlerts send/shared history | Send/shared history, own inbox | Same + delete own notification |
| Interactions | Participant-visible detail/response/mine | Protect-only detail/timeline treats HOD reviewer without department clamp | employeeInteractions admin-like writes | Org reviewer | Org reviewer |
| Notes | No | Global nonpersonal + own personal; visibility gap | employeeInteractions | Global nonpersonal + own personal | Same personal author restriction |
| Reminders/timeline | Own/action ownership | Own; timeline others dept | No special generic reminder administration | Create/manage others; timeline org | Same |
| Audit log | No | No | auditLog enabled | Only if auditLog grant | Yes |
| Password-reset decisions | Request/validate/use token | Same | Same | Employee approval with no-self guard; rejection weaker | Admin approval excluding self |

HOD permissions (`canReview`, `canRemark`, `canMarks`, `canRecommend`, `canEditSubmissions`) are not consistently enforced across all daily, attendance and interaction endpoints. There is no role `manager` or `hod` in User enum; legacy helper comparisons and rule waiver approver string `hod` do not add stored roles.

## Page/API differences

[App.jsx](../../frontend/src/App.jsx) exposes role/feature routes for organization, assignments, products, backlog, reviews, submission control, template analytics, alerts, leave, attendance, holiday, salary, penalties/compliance, audit and interactions. `/team` and `/team-reviews` use HOD gates; own pages use generic authenticated gates. Employee/HR home selection uses role only. Super Admin inherits HR page gates.

- FeatureAccess offers levels/suboptions; most routes enforce enabled only (S08).
- `/hr/compliance` is visible with penalties grant; v2 writes/dashboard remain strict HR/SA and flag-gated. Legacy penalty controllers also enforce their own scope.
- Organization page can open with departments grant, but designation writes remain authorize HR.
- Interactions write middleware does not accept the HOD overlay alone, while detail/timeline and Notes controller checks do.
- Daily review grouped access can accept a feature employee while getDay rejects it; fine HOD permissions differ between single-submission and daily review.
- Analytics guard allows either analytics feature, but dynamic template analytics demands its own feature/scope and self-review controller demands HR/SA/HOD.
- Login caches a profile missing featurePermissions/attendanceMode; mount-only `/auth/me` refresh means fresh-login navigation can be stale until reload (R04).
- CompanyDocument management source exists but has no direct App route; dashboard/widgets may consume documents. Do not infer an accessible `/company-documents` page from the file alone.

## Significant request/response and controller scopes

| API family | Important validation, state and response behavior beyond router guard |
| --- | --- |
| auth / password-reset | Login checks active account/bcrypt; token expires JWT_EXPIRES_IN default7d. Change-password uses User save hook. Reset PENDING→APPROVED/REJECTED→USED; crypto random token+expiry; approval is saved before email. Public validate returns identity for valid token. No server logout/revocation endpoint |
| employees / admin-accounts | employeeId/email uniqueness, role target limits, CSV/XLSX5MB import, normalized HOD/weekly offs, scalar/profile whitelist on update; create spreads supported User fields. Profile/list return broad User fields. Import rollback is compensating deletes, not a transaction |
| departments/designations | Name/title uniqueness; delete reassigns some User/organization refs, not all polymorphic Assignment targets. HOD pointer can be updated independently |
| templates/assignments | Multipart parser5MB; template four types and custom grading normalization; recurring schedule validation; conflict/force revocation; update/delete paths differ from revoke. Read template definitions are authenticated, not owner-scoped |
| submissions/daily-review | Own submit/draft/history; selfRating0–10 and required private remark checks; stage routing based on User.reviewFlow; review marks/daily innovation; raw mutation responses can leak private fields. GET today generates/synchronizes. Owner key on submission does not itself reject hidden/deleted/test rows |
| leaves/leave-config/probation | Inclusive UTC range, approved/pending overlap application checks, one-day half logic, probation restricted types, effective units, separate paid flag; edit force/conflicts, balance setting; controller target/self checks. Attachment linkage verifies upload owner |
| attendance/confirmation/notes | Enum statuses, manual source/delta, bulk results can partially succeed; confirm only own eligible work day; review mode/target checks vary; notes owner/author/lock and admin rules differ |
| salary | Inclusive period or month inputs; stored snapshot, same-period upsert; employee mine/PDF only published/nonretracted; admin-only retraction/publish despite feature gate; update payroll input differences |
| dependency/pending-management | Own assignee/assigner access vs admin oversight; status enum open/in_progress/resolved. Pending-management strict admin+reason and source ownership; no generic feature override |
| analytics/dashboard | UTC ranges/filter cohorts; completion/template analytics reviewed-only; pendency submitted-live; own dashboard scoped; HOD clamp in main endpoints but self-review override. Exports reuse selected datasets, not every API's exact filter |
| penalties/compliance | Legacy mine/HR/HOD scoping + controller admin mutations; separate probable/status/financialStatus. v2 flag-off generally404 for enabled surfaces; config authenticated and returns flags; incident/ledger nonadmin reads own only, administrative operations strict HR/SA |
| contacts/products/quantities/dealers | Authenticated catalogue reads; enabled feature write gate; contact favorites stored on current User; active/status filters and delete semantics vary |
| events/holidays | Unified occurrences combine Holiday, Event and active User birthdays; classification birthday→holiday→event; birthday forced nonholiday; event holiday writes fan out into leave recalculation |
| files | Leave attachment ID/owner checks,10MB each/max20, buffer-in-Mongo and inline/download. Policy PDF10MB MIME and employee-visible/active filter; auth query token enables iframe/download. PDF payslips owner-or-admin; feature salary cannot download arbitrary others' PDF |
| notification/reminder/timeline/audit | Recipient-specific inbox/actions; urgent deadline required; resolve stamps read implicitly; important dismissal needs read, urgent needs resolved; SA delete still own-recipient. Reminder actions check recipient; admin create/update/cancel/complete. Timeline own/admin/HODdept subject scope, but private source projection gap S10; derived source history. Audit logs preserve actor/target metadata but best-effort writes |

Controller scope must be evaluated per handler. Do not generalize a safe list filter to mutation or detail routes. Finding S02, S03 and S06 show that distinction.

## Complete mounted route declaration inventory

Derived from server mounts and all router declarations in source order, including nested compliance routers and inherited `router.use` middleware. Alias gates are expanded. “protect” means authentication, not unrestricted controller access: apply the controller scope table above as well. Upload middleware in the guard column is parsing/limits, not authorization. Repeated protect inherited by compliance routers is shown once. Paths omit cosmetic trailing slashes. No server was started to produce this inventory.

317 router endpoints plus three inline server GET endpoints.

### /api/auth

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/login` | `Public (no route guard)` | `backend/controllers/authController.js:login` | [backend/routes/authRoutes.js:5](../../backend/routes/authRoutes.js) |
| GET | `/api/auth/me` | `protect` | `backend/controllers/authController.js:me` | [backend/routes/authRoutes.js:6](../../backend/routes/authRoutes.js) |
| POST | `/api/auth/change-password` | `protect` | `backend/controllers/authController.js:changePassword` | [backend/routes/authRoutes.js:7](../../backend/routes/authRoutes.js) |

### /api/employees

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/employees/team` | `protect; requireHOD` | `backend/controllers/employeeController.js:teamList` | [backend/routes/employeeRoutes.js:37](../../backend/routes/employeeRoutes.js) |
| GET | `/api/employees` | `protect; requireRoleOrFeature('hr', [ 'attendance', 'salary', 'submissionReviews', 'assignments', 'leaveApprovals', 'sendAlerts', 'performance', 'templateAnalytics', 'contacts', 'submissionControl', 'globalPendency', 'departments', ])` | `backend/controllers/employeeController.js:listEmployees` | [backend/routes/employeeRoutes.js:42](../../backend/routes/employeeRoutes.js) |
| GET | `/api/employees/export.csv` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:exportCsv` | [backend/routes/employeeRoutes.js:46](../../backend/routes/employeeRoutes.js) |
| GET | `/api/employees/import-template` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:importTemplate` | [backend/routes/employeeRoutes.js:47](../../backend/routes/employeeRoutes.js) |
| POST | `/api/employees/import` | `protect; authorize('hr'); upload.single('file')` | `backend/controllers/employeeController.js:importBulk` | [backend/routes/employeeRoutes.js:48](../../backend/routes/employeeRoutes.js) |
| POST | `/api/employees/bulk-action` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:bulkAction` | [backend/routes/employeeRoutes.js:49](../../backend/routes/employeeRoutes.js) |
| GET | `/api/employees/:id` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:getEmployee` | [backend/routes/employeeRoutes.js:50](../../backend/routes/employeeRoutes.js) |
| GET | `/api/employees/:id/work-history` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:workHistory` | [backend/routes/employeeRoutes.js:51](../../backend/routes/employeeRoutes.js) |
| GET | `/api/employees/:id/attendance` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:attendanceSummary` | [backend/routes/employeeRoutes.js:52](../../backend/routes/employeeRoutes.js) |
| GET | `/api/employees/:id/leaves` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:leaveHistory` | [backend/routes/employeeRoutes.js:53](../../backend/routes/employeeRoutes.js) |
| POST | `/api/employees` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:createEmployee` | [backend/routes/employeeRoutes.js:54](../../backend/routes/employeeRoutes.js) |
| PUT | `/api/employees/:id` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:updateEmployee` | [backend/routes/employeeRoutes.js:55](../../backend/routes/employeeRoutes.js) |
| DELETE | `/api/employees/:id` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:deleteEmployee` | [backend/routes/employeeRoutes.js:56](../../backend/routes/employeeRoutes.js) |
| PATCH | `/api/employees/:id/status` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:toggleStatus` | [backend/routes/employeeRoutes.js:57](../../backend/routes/employeeRoutes.js) |
| POST | `/api/employees/:id/reset-password` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:resetPassword` | [backend/routes/employeeRoutes.js:58](../../backend/routes/employeeRoutes.js) |
| POST | `/api/employees/:id/increments` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:addIncrement` | [backend/routes/employeeRoutes.js:59](../../backend/routes/employeeRoutes.js) |
| PUT | `/api/employees/:id/increments/:incId` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:editIncrement` | [backend/routes/employeeRoutes.js:60](../../backend/routes/employeeRoutes.js) |
| DELETE | `/api/employees/:id/increments/:incId` | `protect; authorize('hr')` | `backend/controllers/employeeController.js:deleteIncrement` | [backend/routes/employeeRoutes.js:61](../../backend/routes/employeeRoutes.js) |

### /api/admin-accounts

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/admin-accounts` | `protect; authorize('super_admin')` | `backend/controllers/employeeController.js:adminAccounts` | [backend/routes/adminAccountsRoutes.js:8](../../backend/routes/adminAccountsRoutes.js) |

### /api/departments

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/departments/org-structure` | `protect; requireRoleOrFeature('hr', 'departments')` | `backend/controllers/departmentController.js:orgStructure` | [backend/routes/departmentRoutes.js:9](../../backend/routes/departmentRoutes.js) |
| GET | `/api/departments` | `protect` | `backend/controllers/departmentController.js:list` | [backend/routes/departmentRoutes.js:10](../../backend/routes/departmentRoutes.js) |
| POST | `/api/departments` | `protect; requireRoleOrFeature('hr', 'departments')` | `backend/controllers/departmentController.js:create` | [backend/routes/departmentRoutes.js:11](../../backend/routes/departmentRoutes.js) |
| PUT | `/api/departments/:id` | `protect; requireRoleOrFeature('hr', 'departments')` | `backend/controllers/departmentController.js:update` | [backend/routes/departmentRoutes.js:12](../../backend/routes/departmentRoutes.js) |
| DELETE | `/api/departments/:id` | `protect; requireRoleOrFeature('hr', 'departments')` | `backend/controllers/departmentController.js:remove` | [backend/routes/departmentRoutes.js:13](../../backend/routes/departmentRoutes.js) |

### /api/designations

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/designations` | `protect` | `backend/controllers/designationController.js:list` | [backend/routes/designationRoutes.js:6](../../backend/routes/designationRoutes.js) |
| POST | `/api/designations` | `protect; authorize('hr')` | `backend/controllers/designationController.js:create` | [backend/routes/designationRoutes.js:7](../../backend/routes/designationRoutes.js) |
| PUT | `/api/designations/:id` | `protect; authorize('hr')` | `backend/controllers/designationController.js:update` | [backend/routes/designationRoutes.js:8](../../backend/routes/designationRoutes.js) |
| DELETE | `/api/designations/:id` | `protect; authorize('hr')` | `backend/controllers/designationController.js:remove` | [backend/routes/designationRoutes.js:9](../../backend/routes/designationRoutes.js) |

### /api/templates

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/templates` | `protect` | `backend/controllers/templateController.js:list` | [backend/routes/templateRoutes.js:17](../../backend/routes/templateRoutes.js) |
| POST | `/api/templates/excel/parse` | `protect; requireRoleOrFeature('hr', 'assignments'); upload.single('file')` | `backend/controllers/templateController.js:excelParse` | [backend/routes/templateRoutes.js:18](../../backend/routes/templateRoutes.js) |
| POST | `/api/templates/sheet/parse` | `protect; requireRoleOrFeature('hr', 'assignments'); upload.single('file')` | `backend/controllers/templateController.js:sheetParse` | [backend/routes/templateRoutes.js:19](../../backend/routes/templateRoutes.js) |
| GET | `/api/templates/:id` | `protect` | `backend/controllers/templateController.js:get` | [backend/routes/templateRoutes.js:20](../../backend/routes/templateRoutes.js) |
| POST | `/api/templates` | `protect; requireRoleOrFeature('hr', 'assignments')` | `backend/controllers/templateController.js:create` | [backend/routes/templateRoutes.js:21](../../backend/routes/templateRoutes.js) |
| PUT | `/api/templates/:id` | `protect; requireRoleOrFeature('hr', 'assignments')` | `backend/controllers/templateController.js:update` | [backend/routes/templateRoutes.js:22](../../backend/routes/templateRoutes.js) |
| DELETE | `/api/templates/:id` | `protect; requireRoleOrFeature('hr', 'assignments')` | `backend/controllers/templateController.js:remove` | [backend/routes/templateRoutes.js:23](../../backend/routes/templateRoutes.js) |
| POST | `/api/templates/:id/clone` | `protect; requireRoleOrFeature('hr', 'assignments')` | `backend/controllers/templateController.js:clone` | [backend/routes/templateRoutes.js:25](../../backend/routes/templateRoutes.js) |

### /api/assignments

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/assignments` | `protect; requireRoleOrFeature('hr', 'assignments')` | `backend/controllers/assignmentController.js:list` | [backend/routes/assignmentRoutes.js:9](../../backend/routes/assignmentRoutes.js) |
| GET | `/api/assignments/:id/stats` | `protect; requireRoleOrFeature('hr', 'assignments')` | `backend/controllers/assignmentController.js:stats` | [backend/routes/assignmentRoutes.js:10](../../backend/routes/assignmentRoutes.js) |
| POST | `/api/assignments` | `protect; requireRoleOrFeature('hr', 'assignments')` | `backend/controllers/assignmentController.js:create` | [backend/routes/assignmentRoutes.js:11](../../backend/routes/assignmentRoutes.js) |
| PUT | `/api/assignments/:id` | `protect; requireRoleOrFeature('hr', 'assignments')` | `backend/controllers/assignmentController.js:update` | [backend/routes/assignmentRoutes.js:12](../../backend/routes/assignmentRoutes.js) |
| DELETE | `/api/assignments/:id` | `protect; requireRoleOrFeature('hr', 'assignments')` | `backend/controllers/assignmentController.js:remove` | [backend/routes/assignmentRoutes.js:13](../../backend/routes/assignmentRoutes.js) |
| POST | `/api/assignments/:id/revoke` | `protect; requireRoleOrFeature('hr', 'assignments')` | `backend/controllers/assignmentController.js:revoke` | [backend/routes/assignmentRoutes.js:14](../../backend/routes/assignmentRoutes.js) |

### /api/submissions

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/submissions/today` | `protect` | `backend/controllers/submissionController.js:getToday` | [backend/routes/submissionRoutes.js:10](../../backend/routes/submissionRoutes.js) |
| GET | `/api/submissions/history` | `protect` | `backend/controllers/submissionController.js:history` | [backend/routes/submissionRoutes.js:11](../../backend/routes/submissionRoutes.js) |
| GET | `/api/submissions/hod/reviews` | `protect; requireReviewer` | `backend/controllers/submissionController.js:listForHodReview` | [backend/routes/submissionRoutes.js:15](../../backend/routes/submissionRoutes.js) |
| POST | `/api/submissions/:id/hod-review` | `protect; requireReviewer` | `backend/controllers/submissionController.js:hodReviewSubmission` | [backend/routes/submissionRoutes.js:16](../../backend/routes/submissionRoutes.js) |
| POST | `/api/submissions/:id/submit` | `protect` | `backend/controllers/submissionController.js:submitOne` | [backend/routes/submissionRoutes.js:18](../../backend/routes/submissionRoutes.js) |
| PUT | `/api/submissions/:id/draft` | `protect` | `backend/controllers/submissionController.js:saveDraft` | [backend/routes/submissionRoutes.js:23](../../backend/routes/submissionRoutes.js) |
| POST | `/api/submissions/backlog/complete` | `protect` | `backend/controllers/submissionController.js:completeBacklogTask` | [backend/routes/submissionRoutes.js:24](../../backend/routes/submissionRoutes.js) |
| GET | `/api/submissions/reviews` | `protect; requireRoleOrFeature('hr', 'submissionReviews')` | `backend/controllers/submissionController.js:listForReview` | [backend/routes/submissionRoutes.js:27](../../backend/routes/submissionRoutes.js) |
| POST | `/api/submissions/:id/review` | `protect; requireRoleOrFeature('hr', 'submissionReviews')` | `backend/controllers/submissionController.js:reviewSubmission` | [backend/routes/submissionRoutes.js:28](../../backend/routes/submissionRoutes.js) |
| POST | `/api/submissions/review/bulk` | `protect; requireRoleOrFeature('hr', 'submissionReviews')` | `backend/controllers/submissionController.js:bulkReview` | [backend/routes/submissionRoutes.js:31](../../backend/routes/submissionRoutes.js) |

### /api/leaves

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| POST | `/api/leaves/attachments` | `protect; uploadMw.array('files', 20)` | `backend/controllers/leaveAttachmentController.js:upload` | [backend/routes/leaveRoutes.js:33](../../backend/routes/leaveRoutes.js) |
| GET | `/api/leaves/:leaveId/attachments` | `protect` | `backend/controllers/leaveAttachmentController.js:listForLeave` | [backend/routes/leaveRoutes.js:34](../../backend/routes/leaveRoutes.js) |
| GET | `/api/leaves/attachments/:id` | `protect` | `backend/controllers/leaveAttachmentController.js:getMeta` | [backend/routes/leaveRoutes.js:35](../../backend/routes/leaveRoutes.js) |
| GET | `/api/leaves/attachments/:id/download` | `protect` | `backend/controllers/leaveAttachmentController.js:download` | [backend/routes/leaveRoutes.js:36](../../backend/routes/leaveRoutes.js) |
| GET | `/api/leaves/attachments/:id/inline` | `protect` | `backend/controllers/leaveAttachmentController.js:inline` | [backend/routes/leaveRoutes.js:37](../../backend/routes/leaveRoutes.js) |
| GET | `/api/leaves/mine` | `protect` | `backend/controllers/leaveController.js:myLeaves` | [backend/routes/leaveRoutes.js:39](../../backend/routes/leaveRoutes.js) |
| POST | `/api/leaves` | `protect` | `backend/controllers/leaveController.js:apply` | [backend/routes/leaveRoutes.js:40](../../backend/routes/leaveRoutes.js) |
| GET | `/api/leaves` | `protect; requireRoleOrFeature('hr', 'leaveApprovals')` | `backend/controllers/leaveController.js:listAll` | [backend/routes/leaveRoutes.js:42](../../backend/routes/leaveRoutes.js) |
| GET | `/api/leaves/calendar` | `protect; requireRoleOrFeature('hr', 'leaveApprovals')` | `backend/controllers/leaveController.js:calendar` | [backend/routes/leaveRoutes.js:43](../../backend/routes/leaveRoutes.js) |
| PATCH | `/api/leaves/:id/decision` | `protect; requireRoleOrFeature('hr', 'leaveApprovals')` | `backend/controllers/leaveController.js:decide` | [backend/routes/leaveRoutes.js:44](../../backend/routes/leaveRoutes.js) |
| POST | `/api/leaves/:id/revoke` | `protect; requireRoleOrFeature('hr', 'leaveApprovals')` | `backend/controllers/leaveController.js:revoke` | [backend/routes/leaveRoutes.js:45](../../backend/routes/leaveRoutes.js) |
| PUT | `/api/leaves/:id` | `protect; requireRoleOrFeature('hr', 'leaveApprovals')` | `backend/controllers/leaveController.js:edit` | [backend/routes/leaveRoutes.js:50](../../backend/routes/leaveRoutes.js) |
| PUT | `/api/leaves/balance/:id` | `protect; requireRoleOrFeature('hr', 'leaveApprovals')` | `backend/controllers/leaveController.js:setBalance` | [backend/routes/leaveRoutes.js:51](../../backend/routes/leaveRoutes.js) |

### /api/leave-config

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/leave-config` | `protect` | `backend/controllers/leaveConfigController.js:get` | [backend/routes/leaveConfigRoutes.js:10](../../backend/routes/leaveConfigRoutes.js) |
| PUT | `/api/leave-config` | `protect` | `backend/controllers/leaveConfigController.js:update` | [backend/routes/leaveConfigRoutes.js:11](../../backend/routes/leaveConfigRoutes.js) |

### /api/probation

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/probation/mine` | `protect` | `backend/controllers/probationController.js:mine` | [backend/routes/probationRoutes.js:10](../../backend/routes/probationRoutes.js) |
| GET | `/api/probation/employee/:id` | `protect` | `backend/controllers/probationController.js:ofEmployee` | [backend/routes/probationRoutes.js:11](../../backend/routes/probationRoutes.js) |

### /api/salary

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/salary/mine` | `protect` | `backend/controllers/salaryController.js:mySlips` | [backend/routes/salaryRoutes.js:10](../../backend/routes/salaryRoutes.js) |
| GET | `/api/salary/:id/pdf` | `protect` | `backend/controllers/salaryController.js:downloadPdf` | [backend/routes/salaryRoutes.js:11](../../backend/routes/salaryRoutes.js) |
| GET | `/api/salary/export.csv` | `protect; requireRoleOrFeature('hr', 'salary')` | `backend/controllers/salaryController.js:exportCsv` | [backend/routes/salaryRoutes.js:13](../../backend/routes/salaryRoutes.js) |
| GET | `/api/salary` | `protect; requireRoleOrFeature('hr', 'salary')` | `backend/controllers/salaryController.js:listSlips` | [backend/routes/salaryRoutes.js:14](../../backend/routes/salaryRoutes.js) |
| POST | `/api/salary/generate` | `protect; requireRoleOrFeature('hr', 'salary')` | `backend/controllers/salaryController.js:generate` | [backend/routes/salaryRoutes.js:15](../../backend/routes/salaryRoutes.js) |
| POST | `/api/salary/generate-all` | `protect; requireRoleOrFeature('hr', 'salary')` | `backend/controllers/salaryController.js:generateAll` | [backend/routes/salaryRoutes.js:16](../../backend/routes/salaryRoutes.js) |
| PATCH | `/api/salary/:id` | `protect; requireRoleOrFeature('hr', 'salary')` | `backend/controllers/salaryController.js:updateSlip` | [backend/routes/salaryRoutes.js:17](../../backend/routes/salaryRoutes.js) |
| POST | `/api/salary/:id/retract` | `protect; requireRoleOrFeature('hr', 'salary')` | `backend/controllers/salaryController.js:retract` | [backend/routes/salaryRoutes.js:19](../../backend/routes/salaryRoutes.js) |
| POST | `/api/salary/retract-bulk` | `protect; requireRoleOrFeature('hr', 'salary')` | `backend/controllers/salaryController.js:bulkRetract` | [backend/routes/salaryRoutes.js:21](../../backend/routes/salaryRoutes.js) |
| POST | `/api/salary/generate-bulk-selected` | `protect; requireRoleOrFeature('hr', 'salary')` | `backend/controllers/salaryController.js:bulkGenerateForEmployees` | [backend/routes/salaryRoutes.js:22](../../backend/routes/salaryRoutes.js) |
| POST | `/api/salary/publish` | `protect; requireRoleOrFeature('hr', 'salary')` | `backend/controllers/salaryController.js:publishSlips` | [backend/routes/salaryRoutes.js:24](../../backend/routes/salaryRoutes.js) |

### /api/dependencies

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/dependencies/assignable` | `protect` | `backend/controllers/dependencyController.js:assignable` | [backend/routes/dependencyRoutes.js:8](../../backend/routes/dependencyRoutes.js) |
| GET | `/api/dependencies/mine` | `protect` | `backend/controllers/dependencyController.js:mine` | [backend/routes/dependencyRoutes.js:9](../../backend/routes/dependencyRoutes.js) |
| GET | `/api/dependencies/mine/count` | `protect` | `backend/controllers/dependencyController.js:mineCount` | [backend/routes/dependencyRoutes.js:10](../../backend/routes/dependencyRoutes.js) |
| GET | `/api/dependencies/created` | `protect` | `backend/controllers/dependencyController.js:created` | [backend/routes/dependencyRoutes.js:11](../../backend/routes/dependencyRoutes.js) |
| GET | `/api/dependencies` | `protect; authorize('hr')` | `backend/controllers/dependencyController.js:listAll` | [backend/routes/dependencyRoutes.js:14](../../backend/routes/dependencyRoutes.js) |
| GET | `/api/dependencies/chain/:chainId` | `protect; authorize('hr')` | `backend/controllers/dependencyController.js:chain` | [backend/routes/dependencyRoutes.js:15](../../backend/routes/dependencyRoutes.js) |
| POST | `/api/dependencies/:id/status` | `protect` | `backend/controllers/dependencyController.js:setStatus` | [backend/routes/dependencyRoutes.js:18](../../backend/routes/dependencyRoutes.js) |
| POST | `/api/dependencies/:id/resolve` | `protect` | `backend/controllers/dependencyController.js:resolve` | [backend/routes/dependencyRoutes.js:19](../../backend/routes/dependencyRoutes.js) |

### /api/dashboard

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/dashboard/employee/summary` | `protect` | `backend/controllers/dashboardController.js:employeeSummary` | [backend/routes/dashboardRoutes.js:12](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/alerts` | `protect` | `backend/controllers/dashboardAlertsController.js:mine` | [backend/routes/dashboardRoutes.js:18](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/hr/today` | `protect; authorize('hr')` | `backend/controllers/dashboardController.js:hrToday` | [backend/routes/dashboardRoutes.js:20](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/hr/backlog` | `protect; requireRoleOrFeature('hr', 'globalPendency')` | `backend/controllers/dashboardController.js:hrBacklog` | [backend/routes/dashboardRoutes.js:21](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/hr/performance` | `protect; authorize('hr')` | `backend/controllers/dashboardController.js:hrPerformance` | [backend/routes/dashboardRoutes.js:22](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/hr/pendency` | `protect; requireAnalyticsAccess` | `backend/controllers/analyticsController.js:pendency` | [backend/routes/dashboardRoutes.js:25](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/hr/completion` | `protect; requireAnalyticsAccess` | `backend/controllers/analyticsController.js:completion` | [backend/routes/dashboardRoutes.js:26](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/hr/scope-options` | `protect; requireAnalyticsAccess` | `backend/controllers/analyticsController.js:scopeOptions` | [backend/routes/dashboardRoutes.js:31](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/hr/assignment-analytics` | `protect; requireRoleOrFeature('hr', 'assignments')` | `backend/controllers/analyticsController.js:assignmentAnalytics` | [backend/routes/dashboardRoutes.js:32](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/hr/summary` | `protect; authorize('hr')` | `backend/controllers/dashboardController.js:hrSummary` | [backend/routes/dashboardRoutes.js:33](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/calling/analytics` | `protect; requireAnalyticsAccess` | `backend/controllers/analyticsController.js:callingAnalytics` | [backend/routes/dashboardRoutes.js:37](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/calling/analytics/export` | `protect; requireAnalyticsAccess` | `backend/controllers/analyticsController.js:exportCallingAnalytics` | [backend/routes/dashboardRoutes.js:40](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/calling/roster` | `protect; requireAnalyticsAccess` | `backend/controllers/analyticsController.js:callingRoster` | [backend/routes/dashboardRoutes.js:45](../../backend/routes/dashboardRoutes.js) |
| GET | `/api/dashboard/calling/mine` | `protect` | `backend/controllers/analyticsController.js:myCallingAnalytics` | [backend/routes/dashboardRoutes.js:47](../../backend/routes/dashboardRoutes.js) |

### /api/attendance

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/attendance/mine` | `protect` | `backend/controllers/attendanceController.js:mine` | [backend/routes/attendanceRoutes.js:12](../../backend/routes/attendanceRoutes.js) |
| GET | `/api/attendance/employee/:id` | `protect; requireRoleOrFeature('hr', 'attendance')` | `backend/controllers/attendanceController.js:ofEmployee` | [backend/routes/attendanceRoutes.js:13](../../backend/routes/attendanceRoutes.js) |
| PUT | `/api/attendance/employee/:id/status` | `protect; requireRoleOrFeature('hr', 'attendance')` | `backend/controllers/attendanceController.js:setStatus` | [backend/routes/attendanceRoutes.js:16](../../backend/routes/attendanceRoutes.js) |
| DELETE | `/api/attendance/employee/:id/status` | `protect; requireRoleOrFeature('hr', 'attendance')` | `backend/controllers/attendanceController.js:clearStatus` | [backend/routes/attendanceRoutes.js:17](../../backend/routes/attendanceRoutes.js) |
| POST | `/api/attendance/bulk` | `protect; requireRoleOrFeature('hr', 'attendance')` | `backend/controllers/attendanceController.js:bulkSetStatus` | [backend/routes/attendanceRoutes.js:21](../../backend/routes/attendanceRoutes.js) |
| POST | `/api/attendance/bulk-range/preview` | `protect; requireRoleOrFeature('hr', 'attendance')` | `backend/controllers/attendanceController.js:bulkRangePreview` | [backend/routes/attendanceRoutes.js:24](../../backend/routes/attendanceRoutes.js) |
| POST | `/api/attendance/bulk-range/apply` | `protect; requireRoleOrFeature('hr', 'attendance')` | `backend/controllers/attendanceController.js:bulkRangeApply` | [backend/routes/attendanceRoutes.js:25](../../backend/routes/attendanceRoutes.js) |

### /api/attendance-confirmation

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/attendance-confirmation/today` | `protect` | `backend/controllers/attendanceConfirmationController.js:todayMine` | [backend/routes/attendanceConfirmationRoutes.js:8](../../backend/routes/attendanceConfirmationRoutes.js) |
| POST | `/api/attendance-confirmation/confirm` | `protect` | `backend/controllers/attendanceConfirmationController.js:confirm` | [backend/routes/attendanceConfirmationRoutes.js:9](../../backend/routes/attendanceConfirmationRoutes.js) |
| GET | `/api/attendance-confirmation/queue` | `protect` | `backend/controllers/attendanceConfirmationController.js:queueForDay` | [backend/routes/attendanceConfirmationRoutes.js:14](../../backend/routes/attendanceConfirmationRoutes.js) |
| POST | `/api/attendance-confirmation/:id/review` | `protect` | `backend/controllers/attendanceConfirmationController.js:review` | [backend/routes/attendanceConfirmationRoutes.js:18](../../backend/routes/attendanceConfirmationRoutes.js) |
| POST | `/api/attendance-confirmation/act` | `protect` | `backend/controllers/attendanceConfirmationController.js:actOne` | [backend/routes/attendanceConfirmationRoutes.js:23](../../backend/routes/attendanceConfirmationRoutes.js) |
| POST | `/api/attendance-confirmation/bulk-act` | `protect` | `backend/controllers/attendanceConfirmationController.js:bulkAct` | [backend/routes/attendanceConfirmationRoutes.js:24](../../backend/routes/attendanceConfirmationRoutes.js) |

### /api/feature-permissions

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/feature-permissions/employees` | `protect; authorize('hr')` | `backend/controllers/featurePermissionsController.js:listEmployees` | [backend/routes/featurePermissionsRoutes.js:11](../../backend/routes/featurePermissionsRoutes.js) |
| GET | `/api/feature-permissions/:id` | `protect; authorize('hr')` | `backend/controllers/featurePermissionsController.js:getOne` | [backend/routes/featurePermissionsRoutes.js:12](../../backend/routes/featurePermissionsRoutes.js) |
| PUT | `/api/feature-permissions/:id` | `protect; authorize('hr')` | `backend/controllers/featurePermissionsController.js:update` | [backend/routes/featurePermissionsRoutes.js:13](../../backend/routes/featurePermissionsRoutes.js) |
| POST | `/api/feature-permissions/:id/copy-from/:sourceId` | `protect; authorize('hr')` | `backend/controllers/featurePermissionsController.js:copyFrom` | [backend/routes/featurePermissionsRoutes.js:14](../../backend/routes/featurePermissionsRoutes.js) |
| POST | `/api/feature-permissions/:id/reset` | `protect; authorize('hr')` | `backend/controllers/featurePermissionsController.js:reset` | [backend/routes/featurePermissionsRoutes.js:15](../../backend/routes/featurePermissionsRoutes.js) |

### /api/notifications

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/notifications/mine` | `protect` | `backend/controllers/notificationController.js:myInbox` | [backend/routes/notificationRoutes.js:11](../../backend/routes/notificationRoutes.js) |
| GET | `/api/notifications/priority` | `protect` | `backend/controllers/notificationController.js:myPriority` | [backend/routes/notificationRoutes.js:15](../../backend/routes/notificationRoutes.js) |
| GET | `/api/notifications/unread-count` | `protect` | `backend/controllers/notificationController.js:unreadCount` | [backend/routes/notificationRoutes.js:16](../../backend/routes/notificationRoutes.js) |
| PATCH | `/api/notifications/read-all` | `protect` | `backend/controllers/notificationController.js:markAllRead` | [backend/routes/notificationRoutes.js:17](../../backend/routes/notificationRoutes.js) |
| PATCH | `/api/notifications/:id/read` | `protect` | `backend/controllers/notificationController.js:markRead` | [backend/routes/notificationRoutes.js:18](../../backend/routes/notificationRoutes.js) |
| POST | `/api/notifications/:id/resolve` | `protect` | `backend/controllers/notificationController.js:resolve` | [backend/routes/notificationRoutes.js:21](../../backend/routes/notificationRoutes.js) |
| POST | `/api/notifications/:id/dismiss-dashboard` | `protect` | `backend/controllers/notificationController.js:dismissDashboard` | [backend/routes/notificationRoutes.js:25](../../backend/routes/notificationRoutes.js) |
| DELETE | `/api/notifications/:id` | `protect` | `backend/controllers/notificationController.js:remove` | [backend/routes/notificationRoutes.js:29](../../backend/routes/notificationRoutes.js) |
| POST | `/api/notifications` | `protect; requireRoleOrFeature('hr', 'sendAlerts')` | `backend/controllers/notificationController.js:send` | [backend/routes/notificationRoutes.js:32](../../backend/routes/notificationRoutes.js) |
| GET | `/api/notifications/sent` | `protect; requireRoleOrFeature('hr', 'sendAlerts')` | `backend/controllers/notificationController.js:sentList` | [backend/routes/notificationRoutes.js:36](../../backend/routes/notificationRoutes.js) |
| GET | `/api/notifications/senders` | `protect; requireRoleOrFeature('hr', 'sendAlerts')` | `backend/controllers/notificationController.js:listSenders` | [backend/routes/notificationRoutes.js:38](../../backend/routes/notificationRoutes.js) |

### /api/contacts

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/contacts/export.csv` | `protect; requireRoleOrFeature('hr', 'contacts')` | `backend/controllers/contactController.js:exportCsv` | [backend/routes/contactRoutes.js:11](../../backend/routes/contactRoutes.js) |
| GET | `/api/contacts/analytics` | `protect; requireRoleOrFeature('hr', 'contacts')` | `backend/controllers/contactController.js:analytics` | [backend/routes/contactRoutes.js:12](../../backend/routes/contactRoutes.js) |
| GET | `/api/contacts/favorites` | `protect` | `backend/controllers/contactController.js:myFavorites` | [backend/routes/contactRoutes.js:13](../../backend/routes/contactRoutes.js) |
| GET | `/api/contacts` | `protect` | `backend/controllers/contactController.js:list` | [backend/routes/contactRoutes.js:14](../../backend/routes/contactRoutes.js) |
| GET | `/api/contacts/:id` | `protect` | `backend/controllers/contactController.js:get` | [backend/routes/contactRoutes.js:15](../../backend/routes/contactRoutes.js) |
| POST | `/api/contacts/:id/view` | `protect` | `backend/controllers/contactController.js:view` | [backend/routes/contactRoutes.js:16](../../backend/routes/contactRoutes.js) |
| POST | `/api/contacts/:id/favorite` | `protect` | `backend/controllers/contactController.js:favorite` | [backend/routes/contactRoutes.js:17](../../backend/routes/contactRoutes.js) |
| DELETE | `/api/contacts/:id/favorite` | `protect` | `backend/controllers/contactController.js:unfavorite` | [backend/routes/contactRoutes.js:18](../../backend/routes/contactRoutes.js) |
| POST | `/api/contacts` | `protect; requireRoleOrFeature('hr', 'contacts')` | `backend/controllers/contactController.js:create` | [backend/routes/contactRoutes.js:21](../../backend/routes/contactRoutes.js) |
| PUT | `/api/contacts/:id` | `protect; requireRoleOrFeature('hr', 'contacts')` | `backend/controllers/contactController.js:update` | [backend/routes/contactRoutes.js:22](../../backend/routes/contactRoutes.js) |
| PATCH | `/api/contacts/:id/status` | `protect; requireRoleOrFeature('hr', 'contacts')` | `backend/controllers/contactController.js:toggleStatus` | [backend/routes/contactRoutes.js:23](../../backend/routes/contactRoutes.js) |
| DELETE | `/api/contacts/:id` | `protect; requireRoleOrFeature('hr', 'contacts')` | `backend/controllers/contactController.js:remove` | [backend/routes/contactRoutes.js:24](../../backend/routes/contactRoutes.js) |

### /api/company-documents

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/company-documents` | `protect` | `backend/controllers/companyDocumentController.js:list` | [backend/routes/companyDocumentRoutes.js:25](../../backend/routes/companyDocumentRoutes.js) |
| GET | `/api/company-documents/:id/inline` | `protect` | `backend/controllers/companyDocumentController.js:inline` | [backend/routes/companyDocumentRoutes.js:26](../../backend/routes/companyDocumentRoutes.js) |
| POST | `/api/company-documents` | `protect; authorize('hr'); upload.single('file')` | `backend/controllers/companyDocumentController.js:upload` | [backend/routes/companyDocumentRoutes.js:30](../../backend/routes/companyDocumentRoutes.js) |
| PATCH | `/api/company-documents/:id` | `protect; authorize('hr')` | `backend/controllers/companyDocumentController.js:update` | [backend/routes/companyDocumentRoutes.js:31](../../backend/routes/companyDocumentRoutes.js) |
| PUT | `/api/company-documents/:id/file` | `protect; authorize('hr'); upload.single('file')` | `backend/controllers/companyDocumentController.js:replaceFile` | [backend/routes/companyDocumentRoutes.js:32](../../backend/routes/companyDocumentRoutes.js) |
| DELETE | `/api/company-documents/:id` | `protect; authorize('hr')` | `backend/controllers/companyDocumentController.js:remove` | [backend/routes/companyDocumentRoutes.js:33](../../backend/routes/companyDocumentRoutes.js) |

### /api/events

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/events` | `protect` | `backend/controllers/eventController.js:list` | [backend/routes/eventRoutes.js:11](../../backend/routes/eventRoutes.js) |
| GET | `/api/events/upcoming` | `protect` | `backend/controllers/eventController.js:upcoming` | [backend/routes/eventRoutes.js:12](../../backend/routes/eventRoutes.js) |
| GET | `/api/events/birthdays/today` | `protect` | `backend/controllers/eventController.js:birthdaysToday` | [backend/routes/eventRoutes.js:13](../../backend/routes/eventRoutes.js) |
| GET | `/api/events/analytics` | `protect; requireRoleOrFeature('hr', 'eventsHolidays')` | `backend/controllers/eventController.js:analytics` | [backend/routes/eventRoutes.js:14](../../backend/routes/eventRoutes.js) |
| GET | `/api/events/:id` | `protect` | `backend/controllers/eventController.js:get` | [backend/routes/eventRoutes.js:15](../../backend/routes/eventRoutes.js) |
| POST | `/api/events` | `protect; requireRoleOrFeature('hr', 'eventsHolidays')` | `backend/controllers/eventController.js:create` | [backend/routes/eventRoutes.js:23](../../backend/routes/eventRoutes.js) |
| PUT | `/api/events/:id` | `protect; requireRoleOrFeature('hr', 'eventsHolidays')` | `backend/controllers/eventController.js:update` | [backend/routes/eventRoutes.js:24](../../backend/routes/eventRoutes.js) |
| DELETE | `/api/events/:id` | `protect; requireRoleOrFeature('hr', 'eventsHolidays')` | `backend/controllers/eventController.js:remove` | [backend/routes/eventRoutes.js:25](../../backend/routes/eventRoutes.js) |

### /api/holidays

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/holidays` | `protect` | `backend/controllers/holidayController.js:list` | [backend/routes/holidayRoutes.js:10](../../backend/routes/holidayRoutes.js) |
| POST | `/api/holidays` | `protect; requireRoleOrFeature('hr', 'eventsHolidays')` | `backend/controllers/holidayController.js:create` | [backend/routes/holidayRoutes.js:11](../../backend/routes/holidayRoutes.js) |
| PUT | `/api/holidays/:id` | `protect; requireRoleOrFeature('hr', 'eventsHolidays')` | `backend/controllers/holidayController.js:update` | [backend/routes/holidayRoutes.js:12](../../backend/routes/holidayRoutes.js) |
| DELETE | `/api/holidays/:id` | `protect; requireRoleOrFeature('hr', 'eventsHolidays')` | `backend/controllers/holidayController.js:remove` | [backend/routes/holidayRoutes.js:13](../../backend/routes/holidayRoutes.js) |

### /api/password-reset

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| POST | `/api/password-reset/request` | `Public (no route guard)` | `backend/controllers/passwordResetController.js:requestReset` | [backend/routes/passwordResetRoutes.js:6](../../backend/routes/passwordResetRoutes.js) |
| GET | `/api/password-reset/validate` | `Public (no route guard)` | `backend/controllers/passwordResetController.js:validateToken` | [backend/routes/passwordResetRoutes.js:7](../../backend/routes/passwordResetRoutes.js) |
| POST | `/api/password-reset/reset` | `Public (no route guard)` | `backend/controllers/passwordResetController.js:resetPassword` | [backend/routes/passwordResetRoutes.js:8](../../backend/routes/passwordResetRoutes.js) |
| GET | `/api/password-reset` | `protect; authorize('hr')` | `backend/controllers/passwordResetController.js:listRequests` | [backend/routes/passwordResetRoutes.js:11](../../backend/routes/passwordResetRoutes.js) |
| GET | `/api/password-reset/pending-count` | `protect; authorize('hr')` | `backend/controllers/passwordResetController.js:pendingCount` | [backend/routes/passwordResetRoutes.js:12](../../backend/routes/passwordResetRoutes.js) |
| POST | `/api/password-reset/:id/approve` | `protect; authorize('hr')` | `backend/controllers/passwordResetController.js:approve` | [backend/routes/passwordResetRoutes.js:13](../../backend/routes/passwordResetRoutes.js) |
| POST | `/api/password-reset/:id/reject` | `protect; authorize('hr')` | `backend/controllers/passwordResetController.js:reject` | [backend/routes/passwordResetRoutes.js:14](../../backend/routes/passwordResetRoutes.js) |

### /api/audit

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/audit` | `protect; requireRoleOrFeature('super_admin', 'auditLog')` | `backend/controllers/auditController.js:list` | [backend/routes/auditRoutes.js:8](../../backend/routes/auditRoutes.js) |

### /api

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/products` | `protect` | `backend/controllers/productController.js:listProducts` | [backend/routes/productRoutes.js:20](../../backend/routes/productRoutes.js) |
| GET | `/api/quantities` | `protect` | `backend/controllers/productController.js:listQuantities` | [backend/routes/productRoutes.js:21](../../backend/routes/productRoutes.js) |
| GET | `/api/products/import-sample` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/productController.js:importSample` | [backend/routes/productRoutes.js:25](../../backend/routes/productRoutes.js) |
| GET | `/api/products/export` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/productController.js:exportProducts` | [backend/routes/productRoutes.js:26](../../backend/routes/productRoutes.js) |
| POST | `/api/products/import` | `protect; requireRoleOrFeature('hr', 'products'); upload.single('file')` | `backend/controllers/productController.js:importBulk` | [backend/routes/productRoutes.js:29](../../backend/routes/productRoutes.js) |
| POST | `/api/products` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/productController.js:createProduct` | [backend/routes/productRoutes.js:32](../../backend/routes/productRoutes.js) |
| PUT | `/api/products/:id` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/productController.js:updateProduct` | [backend/routes/productRoutes.js:33](../../backend/routes/productRoutes.js) |
| DELETE | `/api/products/:id` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/productController.js:deactivateProduct` | [backend/routes/productRoutes.js:34](../../backend/routes/productRoutes.js) |
| POST | `/api/quantities` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/productController.js:createQuantity` | [backend/routes/productRoutes.js:35](../../backend/routes/productRoutes.js) |
| PUT | `/api/quantities/:id` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/productController.js:updateQuantity` | [backend/routes/productRoutes.js:36](../../backend/routes/productRoutes.js) |
| DELETE | `/api/quantities/:id` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/productController.js:deactivateQuantity` | [backend/routes/productRoutes.js:37](../../backend/routes/productRoutes.js) |
| GET | `/api/dealers` | `protect` | `backend/controllers/dealerController.js:listDealers` | [backend/routes/productRoutes.js:41](../../backend/routes/productRoutes.js) |
| GET | `/api/dealers/import-sample` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/dealerController.js:importSample` | [backend/routes/productRoutes.js:44](../../backend/routes/productRoutes.js) |
| GET | `/api/dealers/export` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/dealerController.js:exportDealers` | [backend/routes/productRoutes.js:45](../../backend/routes/productRoutes.js) |
| POST | `/api/dealers/import` | `protect; requireRoleOrFeature('hr', 'products'); upload.single('file')` | `backend/controllers/dealerController.js:importBulk` | [backend/routes/productRoutes.js:48](../../backend/routes/productRoutes.js) |
| POST | `/api/dealers` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/dealerController.js:createDealer` | [backend/routes/productRoutes.js:49](../../backend/routes/productRoutes.js) |
| PUT | `/api/dealers/:id` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/dealerController.js:updateDealer` | [backend/routes/productRoutes.js:50](../../backend/routes/productRoutes.js) |
| DELETE | `/api/dealers/:id` | `protect; requireRoleOrFeature('hr', 'products')` | `backend/controllers/dealerController.js:deactivateDealer` | [backend/routes/productRoutes.js:51](../../backend/routes/productRoutes.js) |

### /api/submission-control

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/submission-control/filter-options` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:filterOptions` | [backend/routes/submissionControlRoutes.js:10](../../backend/routes/submissionControlRoutes.js) |
| POST | `/api/submission-control/bulk/delete` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:bulkDelete` | [backend/routes/submissionControlRoutes.js:13](../../backend/routes/submissionControlRoutes.js) |
| POST | `/api/submission-control/bulk/restore` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:bulkRestore` | [backend/routes/submissionControlRoutes.js:14](../../backend/routes/submissionControlRoutes.js) |
| POST | `/api/submission-control/bulk/mark-test` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:bulkMarkTest` | [backend/routes/submissionControlRoutes.js:15](../../backend/routes/submissionControlRoutes.js) |
| POST | `/api/submission-control/rebuild-scores` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:rebuildScores` | [backend/routes/submissionControlRoutes.js:18](../../backend/routes/submissionControlRoutes.js) |
| POST | `/api/submission-control/rebuild-analytics` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:rebuildAnalytics` | [backend/routes/submissionControlRoutes.js:19](../../backend/routes/submissionControlRoutes.js) |
| POST | `/api/submission-control/rebuild-carry-forward` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:rebuildCarryForward` | [backend/routes/submissionControlRoutes.js:20](../../backend/routes/submissionControlRoutes.js) |
| GET | `/api/submission-control/export` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:exportFiltered` | [backend/routes/submissionControlRoutes.js:23](../../backend/routes/submissionControlRoutes.js) |
| GET | `/api/submission-control/:id` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:get` | [backend/routes/submissionControlRoutes.js:26](../../backend/routes/submissionControlRoutes.js) |
| PUT | `/api/submission-control/:id` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:update` | [backend/routes/submissionControlRoutes.js:27](../../backend/routes/submissionControlRoutes.js) |
| POST | `/api/submission-control/:id/delete` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:remove` | [backend/routes/submissionControlRoutes.js:28](../../backend/routes/submissionControlRoutes.js) |
| POST | `/api/submission-control/:id/restore` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:restore` | [backend/routes/submissionControlRoutes.js:29](../../backend/routes/submissionControlRoutes.js) |
| POST | `/api/submission-control/:id/mark-test` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:markTest` | [backend/routes/submissionControlRoutes.js:30](../../backend/routes/submissionControlRoutes.js) |
| GET | `/api/submission-control` | `protect; requireRoleOrFeature('hr', 'submissionControl')` | `backend/controllers/submissionControlController.js:list` | [backend/routes/submissionControlRoutes.js:33](../../backend/routes/submissionControlRoutes.js) |

### /api/daily-review

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| POST | `/api/daily-review/reflection` | `protect` | `backend/controllers/dailyReviewController.js:saveReflection` | [backend/routes/dailyReviewRoutes.js:9](../../backend/routes/dailyReviewRoutes.js) |
| GET | `/api/daily-review/my-reflection` | `protect` | `backend/controllers/dailyReviewController.js:getMyReflection` | [backend/routes/dailyReviewRoutes.js:15](../../backend/routes/dailyReviewRoutes.js) |
| GET | `/api/daily-review/grouped` | `protect` | `backend/controllers/dailyReviewController.js:listGrouped` | [backend/routes/dailyReviewRoutes.js:19](../../backend/routes/dailyReviewRoutes.js) |
| GET | `/api/daily-review/day` | `protect` | `backend/controllers/dailyReviewController.js:getDay` | [backend/routes/dailyReviewRoutes.js:20](../../backend/routes/dailyReviewRoutes.js) |
| POST | `/api/daily-review/finalize` | `protect` | `backend/controllers/dailyReviewController.js:finalizeDay` | [backend/routes/dailyReviewRoutes.js:21](../../backend/routes/dailyReviewRoutes.js) |
| POST | `/api/daily-review/bulk-finalize` | `protect` | `backend/controllers/dailyReviewController.js:bulkFinalize` | [backend/routes/dailyReviewRoutes.js:24](../../backend/routes/dailyReviewRoutes.js) |
| POST | `/api/daily-review/task-status` | `protect` | `backend/controllers/dailyReviewController.js:editTaskStatus` | [backend/routes/dailyReviewRoutes.js:26](../../backend/routes/dailyReviewRoutes.js) |
| POST | `/api/daily-review/task-marks` | `protect` | `backend/controllers/dailyReviewController.js:editTaskMarks` | [backend/routes/dailyReviewRoutes.js:28](../../backend/routes/dailyReviewRoutes.js) |
| POST | `/api/daily-review/edit-value` | `protect` | `backend/controllers/dailyReviewController.js:editSubmissionValue` | [backend/routes/dailyReviewRoutes.js:33](../../backend/routes/dailyReviewRoutes.js) |

### /api/self-review

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/self-review/overview` | `protect; requireAnalyticsAccess` | `backend/controllers/dailySelfReviewController.js:overview` | [backend/routes/dailySelfReviewRoutes.js:10](../../backend/routes/dailySelfReviewRoutes.js) |
| GET | `/api/self-review/breakdown` | `protect; requireAnalyticsAccess` | `backend/controllers/dailySelfReviewController.js:breakdown` | [backend/routes/dailySelfReviewRoutes.js:13](../../backend/routes/dailySelfReviewRoutes.js) |
| GET | `/api/self-review/employee/:id` | `protect; requireAnalyticsAccess` | `backend/controllers/dailySelfReviewController.js:employeeDetail` | [backend/routes/dailySelfReviewRoutes.js:14](../../backend/routes/dailySelfReviewRoutes.js) |
| GET | `/api/self-review/ideas` | `protect; requireAnalyticsAccess` | `backend/controllers/dailySelfReviewController.js:ideasLibrary` | [backend/routes/dailySelfReviewRoutes.js:15](../../backend/routes/dailySelfReviewRoutes.js) |
| GET | `/api/self-review/notes` | `protect; requireAnalyticsAccess` | `backend/controllers/dailySelfReviewController.js:notesLibrary` | [backend/routes/dailySelfReviewRoutes.js:16](../../backend/routes/dailySelfReviewRoutes.js) |
| GET | `/api/self-review/export.csv` | `protect; requireAnalyticsAccess` | `backend/controllers/dailySelfReviewController.js:exportCsv` | [backend/routes/dailySelfReviewRoutes.js:17](../../backend/routes/dailySelfReviewRoutes.js) |

### /api/template-analytics

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/template-analytics` | `protect; requireAnalyticsAccess` | `backend/controllers/templateAnalyticsController.js:list` | [backend/routes/templateAnalyticsRoutes.js:14](../../backend/routes/templateAnalyticsRoutes.js) |
| POST | `/api/template-analytics/hide-bulk` | `protect; requireRoleOrFeature('hr', 'templateAnalytics')` | `backend/controllers/templateAnalyticsController.js:removeBulk` | [backend/routes/templateAnalyticsRoutes.js:17](../../backend/routes/templateAnalyticsRoutes.js) |
| GET | `/api/template-analytics/:templateId/assigned-employees` | `protect; requireAnalyticsAccess` | `backend/controllers/templateAnalyticsController.js:assignedEmployees` | [backend/routes/templateAnalyticsRoutes.js:22](../../backend/routes/templateAnalyticsRoutes.js) |
| GET | `/api/template-analytics/:templateId` | `protect; requireAnalyticsAccess` | `backend/controllers/templateAnalyticsController.js:generate` | [backend/routes/templateAnalyticsRoutes.js:24](../../backend/routes/templateAnalyticsRoutes.js) |
| DELETE | `/api/template-analytics/:templateId` | `protect; requireRoleOrFeature('hr', 'templateAnalytics')` | `backend/controllers/templateAnalyticsController.js:remove` | [backend/routes/templateAnalyticsRoutes.js:27](../../backend/routes/templateAnalyticsRoutes.js) |

### /api/pending-management

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/pending-management/:employeeId` | `protect` | `backend/controllers/pendingManagementController.js:list` | [backend/routes/pendingManagementRoutes.js:9](../../backend/routes/pendingManagementRoutes.js) |
| POST | `/api/pending-management/:employeeId/resolve` | `protect` | `backend/controllers/pendingManagementController.js:resolve` | [backend/routes/pendingManagementRoutes.js:10](../../backend/routes/pendingManagementRoutes.js) |

### /api/attendance-notes

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/attendance-notes/day-summary` | `protect` | `backend/controllers/attendanceNoteController.js:daySummary` | [backend/routes/attendanceNoteRoutes.js:20](../../backend/routes/attendanceNoteRoutes.js) |
| GET | `/api/attendance-notes` | `protect` | `backend/controllers/attendanceNoteController.js:list` | [backend/routes/attendanceNoteRoutes.js:21](../../backend/routes/attendanceNoteRoutes.js) |
| POST | `/api/attendance-notes` | `protect` | `backend/controllers/attendanceNoteController.js:create` | [backend/routes/attendanceNoteRoutes.js:22](../../backend/routes/attendanceNoteRoutes.js) |
| PATCH | `/api/attendance-notes/:id` | `protect` | `backend/controllers/attendanceNoteController.js:patch` | [backend/routes/attendanceNoteRoutes.js:23](../../backend/routes/attendanceNoteRoutes.js) |
| DELETE | `/api/attendance-notes/:id` | `protect` | `backend/controllers/attendanceNoteController.js:remove` | [backend/routes/attendanceNoteRoutes.js:24](../../backend/routes/attendanceNoteRoutes.js) |

### /api/penalties

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/penalties/mine` | `protect` | `backend/controllers/penaltyController.js:mine` | [backend/routes/penaltyRoutes.js:20](../../backend/routes/penaltyRoutes.js) |
| POST | `/api/penalties/:id/acknowledge` | `protect` | `backend/controllers/penaltyController.js:acknowledge` | [backend/routes/penaltyRoutes.js:21](../../backend/routes/penaltyRoutes.js) |
| POST | `/api/penalties/:id/dismiss` | `protect` | `backend/controllers/penaltyController.js:dismissNotification` | [backend/routes/penaltyRoutes.js:23](../../backend/routes/penaltyRoutes.js) |
| POST | `/api/penalties/:id/reopen-request` | `protect` | `backend/controllers/penaltyController.js:requestReopening` | [backend/routes/penaltyRoutes.js:24](../../backend/routes/penaltyRoutes.js) |
| GET | `/api/penalties/dashboard` | `protect` | `backend/controllers/penaltyController.js:dashboard` | [backend/routes/penaltyRoutes.js:27](../../backend/routes/penaltyRoutes.js) |
| GET | `/api/penalties/analytics/summary` | `protect` | `backend/controllers/penaltyController.js:analyticsSummary` | [backend/routes/penaltyRoutes.js:28](../../backend/routes/penaltyRoutes.js) |
| POST | `/api/penalties/manual` | `protect` | `backend/controllers/penaltyController.js:createManual` | [backend/routes/penaltyRoutes.js:31](../../backend/routes/penaltyRoutes.js) |
| POST | `/api/penalties/:id/cancel` | `protect` | `backend/controllers/penaltyController.js:cancel` | [backend/routes/penaltyRoutes.js:32](../../backend/routes/penaltyRoutes.js) |
| POST | `/api/penalties/:id/reopen-decision` | `protect` | `backend/controllers/penaltyController.js:decideReopen` | [backend/routes/penaltyRoutes.js:34](../../backend/routes/penaltyRoutes.js) |
| PATCH | `/api/penalties/pending-task/deadline` | `protect` | `backend/controllers/penaltyController.js:overridePendingDeadline` | [backend/routes/penaltyRoutes.js:36](../../backend/routes/penaltyRoutes.js) |
| POST | `/api/penalties/restore-range` | `protect` | `backend/controllers/penaltyController.js:restoreRange` | [backend/routes/penaltyRoutes.js:38](../../backend/routes/penaltyRoutes.js) |
| GET | `/api/penalties/financial/pending` | `protect` | `backend/controllers/penaltyController.js:listPendingFinancial` | [backend/routes/penaltyRoutes.js:41](../../backend/routes/penaltyRoutes.js) |
| POST | `/api/penalties/financial/mark-deducted` | `protect` | `backend/controllers/penaltyController.js:markFinancialDeducted` | [backend/routes/penaltyRoutes.js:42](../../backend/routes/penaltyRoutes.js) |
| POST | `/api/penalties/:id/waive` | `protect` | `backend/controllers/penaltyController.js:waiveFinancial` | [backend/routes/penaltyRoutes.js:43](../../backend/routes/penaltyRoutes.js) |
| POST | `/api/penalties/:id/resolve-fin` | `protect` | `backend/controllers/penaltyController.js:resolveFinancial` | [backend/routes/penaltyRoutes.js:44](../../backend/routes/penaltyRoutes.js) |

### /api/realtime

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/realtime/stream` | `protect` | `Inline SSE handler in realtimeRoutes.js` | [backend/routes/realtimeRoutes.js:15](../../backend/routes/realtimeRoutes.js) |
| GET | `/api/realtime/stats` | `protect` | `Inline diagnostic: rt.stats()` | [backend/routes/realtimeRoutes.js:47](../../backend/routes/realtimeRoutes.js) |

### /api/interactions

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/interactions/mine` | `protect` | `backend/controllers/interactionController.js:mine` | [backend/routes/interactionRoutes.js:9](../../backend/routes/interactionRoutes.js) |
| GET | `/api/interactions/mentions` | `protect` | `backend/controllers/interactionController.js:mentions` | [backend/routes/interactionRoutes.js:10](../../backend/routes/interactionRoutes.js) |
| GET | `/api/interactions/timeline/:employee` | `protect` | `backend/controllers/interactionController.js:timeline` | [backend/routes/interactionRoutes.js:11](../../backend/routes/interactionRoutes.js) |
| POST | `/api/interactions/:id/respond` | `protect` | `backend/controllers/interactionController.js:respond` | [backend/routes/interactionRoutes.js:12](../../backend/routes/interactionRoutes.js) |
| GET | `/api/interactions/analytics` | `protect; requireRoleOrFeature('hr', 'employeeInteractions')` | `backend/controllers/interactionController.js:analytics` | [backend/routes/interactionRoutes.js:17](../../backend/routes/interactionRoutes.js) |
| GET | `/api/interactions` | `protect; requireRoleOrFeature('hr', 'employeeInteractions')` | `backend/controllers/interactionController.js:list` | [backend/routes/interactionRoutes.js:18](../../backend/routes/interactionRoutes.js) |
| POST | `/api/interactions` | `protect; requireRoleOrFeature('hr', 'employeeInteractions')` | `backend/controllers/interactionController.js:create` | [backend/routes/interactionRoutes.js:19](../../backend/routes/interactionRoutes.js) |
| GET | `/api/interactions/:id` | `protect` | `backend/controllers/interactionController.js:getOne` | [backend/routes/interactionRoutes.js:20](../../backend/routes/interactionRoutes.js) |
| PUT | `/api/interactions/:id` | `protect; requireRoleOrFeature('hr', 'employeeInteractions')` | `backend/controllers/interactionController.js:update` | [backend/routes/interactionRoutes.js:21](../../backend/routes/interactionRoutes.js) |
| DELETE | `/api/interactions/:id` | `protect; requireRoleOrFeature('hr', 'employeeInteractions')` | `backend/controllers/interactionController.js:remove` | [backend/routes/interactionRoutes.js:22](../../backend/routes/interactionRoutes.js) |
| POST | `/api/interactions/:id/notes` | `protect; requireRoleOrFeature('hr', 'employeeInteractions')` | `backend/controllers/interactionController.js:addNote` | [backend/routes/interactionRoutes.js:24](../../backend/routes/interactionRoutes.js) |
| PUT | `/api/interactions/:id/notes/:noteId` | `protect; requireRoleOrFeature('hr', 'employeeInteractions')` | `backend/controllers/interactionController.js:updateNote` | [backend/routes/interactionRoutes.js:25](../../backend/routes/interactionRoutes.js) |
| DELETE | `/api/interactions/:id/notes/:noteId` | `protect; requireRoleOrFeature('hr', 'employeeInteractions')` | `backend/controllers/interactionController.js:removeNote` | [backend/routes/interactionRoutes.js:26](../../backend/routes/interactionRoutes.js) |
| PUT | `/api/interactions/:id/participants` | `protect; requireRoleOrFeature('hr', 'employeeInteractions')` | `backend/controllers/interactionController.js:setParticipants` | [backend/routes/interactionRoutes.js:28](../../backend/routes/interactionRoutes.js) |
| PUT | `/api/interactions/:id/attendance` | `protect; requireRoleOrFeature('hr', 'employeeInteractions')` | `backend/controllers/interactionController.js:setAttendance` | [backend/routes/interactionRoutes.js:29](../../backend/routes/interactionRoutes.js) |
| POST | `/api/interactions/:id/follow-up/resolve` | `protect; requireRoleOrFeature('hr', 'employeeInteractions')` | `backend/controllers/interactionController.js:resolveFollowUp` | [backend/routes/interactionRoutes.js:30](../../backend/routes/interactionRoutes.js) |

### /api/interaction-tags

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/interaction-tags` | `protect` | `backend/controllers/interactionTagController.js:list` | [backend/routes/interactionTagRoutes.js:9](../../backend/routes/interactionTagRoutes.js) |
| POST | `/api/interaction-tags` | `protect; authorize('hr', 'super_admin')` | `backend/controllers/interactionTagController.js:create` | [backend/routes/interactionTagRoutes.js:12](../../backend/routes/interactionTagRoutes.js) |
| PUT | `/api/interaction-tags/:id` | `protect; authorize('hr', 'super_admin')` | `backend/controllers/interactionTagController.js:update` | [backend/routes/interactionTagRoutes.js:13](../../backend/routes/interactionTagRoutes.js) |
| DELETE | `/api/interaction-tags/:id` | `protect; authorize('hr', 'super_admin')` | `backend/controllers/interactionTagController.js:remove` | [backend/routes/interactionTagRoutes.js:14](../../backend/routes/interactionTagRoutes.js) |

### /api/notes

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/notes/types` | `protect` | `backend/controllers/noteController.js:listTypes` | [backend/routes/noteRoutes.js:8](../../backend/routes/noteRoutes.js) |
| POST | `/api/notes/types` | `protect` | `backend/controllers/noteController.js:createType` | [backend/routes/noteRoutes.js:9](../../backend/routes/noteRoutes.js) |
| PATCH | `/api/notes/types/:id` | `protect` | `backend/controllers/noteController.js:updateType` | [backend/routes/noteRoutes.js:10](../../backend/routes/noteRoutes.js) |
| DELETE | `/api/notes/types/:id` | `protect` | `backend/controllers/noteController.js:deleteType` | [backend/routes/noteRoutes.js:11](../../backend/routes/noteRoutes.js) |
| GET | `/api/notes` | `protect` | `backend/controllers/noteController.js:list` | [backend/routes/noteRoutes.js:14](../../backend/routes/noteRoutes.js) |
| POST | `/api/notes` | `protect` | `backend/controllers/noteController.js:create` | [backend/routes/noteRoutes.js:15](../../backend/routes/noteRoutes.js) |
| GET | `/api/notes/:id` | `protect` | `backend/controllers/noteController.js:getOne` | [backend/routes/noteRoutes.js:16](../../backend/routes/noteRoutes.js) |
| PATCH | `/api/notes/:id` | `protect` | `backend/controllers/noteController.js:update` | [backend/routes/noteRoutes.js:17](../../backend/routes/noteRoutes.js) |
| DELETE | `/api/notes/:id` | `protect` | `backend/controllers/noteController.js:remove` | [backend/routes/noteRoutes.js:18](../../backend/routes/noteRoutes.js) |

### /api/compliance

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| POST | `/api/compliance/refresh` | `protect` | `backend/controllers/complianceController.js:refresh` | [backend/routes/complianceRoutes.js:10](../../backend/routes/complianceRoutes.js) |
| POST | `/api/compliance/refresh/all` | `protect` | `backend/controllers/complianceController.js:refreshAll` | [backend/routes/complianceRoutes.js:11](../../backend/routes/complianceRoutes.js) |
| GET | `/api/compliance/rules` | `protect` | `backend/controllers/compliance/ruleController.js:list` | [backend/routes/compliance/ruleRoutes.js:11](../../backend/routes/compliance/ruleRoutes.js) |
| GET | `/api/compliance/rules/:id` | `protect` | `backend/controllers/compliance/ruleController.js:get` | [backend/routes/compliance/ruleRoutes.js:12](../../backend/routes/compliance/ruleRoutes.js) |
| POST | `/api/compliance/rules` | `protect` | `backend/controllers/compliance/ruleController.js:create` | [backend/routes/compliance/ruleRoutes.js:13](../../backend/routes/compliance/ruleRoutes.js) |
| PATCH | `/api/compliance/rules/:id` | `protect` | `backend/controllers/compliance/ruleController.js:update` | [backend/routes/compliance/ruleRoutes.js:14](../../backend/routes/compliance/ruleRoutes.js) |
| POST | `/api/compliance/rules/:id/enable` | `protect` | `backend/controllers/compliance/ruleController.js:enable` | [backend/routes/compliance/ruleRoutes.js:15](../../backend/routes/compliance/ruleRoutes.js) |
| POST | `/api/compliance/rules/:id/disable` | `protect` | `backend/controllers/compliance/ruleController.js:disable` | [backend/routes/compliance/ruleRoutes.js:16](../../backend/routes/compliance/ruleRoutes.js) |
| GET | `/api/compliance/rules/:id/history` | `protect` | `backend/controllers/compliance/ruleController.js:history` | [backend/routes/compliance/ruleRoutes.js:17](../../backend/routes/compliance/ruleRoutes.js) |
| GET | `/api/compliance/config` | `protect` | `backend/controllers/compliance/configController.js:get` | [backend/routes/compliance/incidentRoutes.js:11](../../backend/routes/compliance/incidentRoutes.js) |
| GET | `/api/compliance/incidents` | `protect` | `backend/controllers/compliance/incidentController.js:list` | [backend/routes/compliance/incidentRoutes.js:14](../../backend/routes/compliance/incidentRoutes.js) |
| GET | `/api/compliance/incidents/:id` | `protect` | `backend/controllers/compliance/incidentController.js:get` | [backend/routes/compliance/incidentRoutes.js:15](../../backend/routes/compliance/incidentRoutes.js) |
| POST | `/api/compliance/incidents` | `protect` | `backend/controllers/compliance/incidentController.js:create` | [backend/routes/compliance/incidentRoutes.js:16](../../backend/routes/compliance/incidentRoutes.js) |
| POST | `/api/compliance/incidents/:id/cancel` | `protect` | `backend/controllers/compliance/incidentController.js:cancel` | [backend/routes/compliance/incidentRoutes.js:17](../../backend/routes/compliance/incidentRoutes.js) |
| POST | `/api/compliance/incidents/:id/recover` | `protect` | `backend/controllers/compliance/incidentController.js:recover` | [backend/routes/compliance/incidentRoutes.js:18](../../backend/routes/compliance/incidentRoutes.js) |
| POST | `/api/compliance/incidents/:id/activate` | `protect` | `backend/controllers/compliance/incidentController.js:activate` | [backend/routes/compliance/incidentRoutes.js:19](../../backend/routes/compliance/incidentRoutes.js) |
| POST | `/api/compliance/incidents/:id/resolve` | `protect` | `backend/controllers/compliance/incidentController.js:resolve` | [backend/routes/compliance/incidentRoutes.js:20](../../backend/routes/compliance/incidentRoutes.js) |
| POST | `/api/compliance/incidents/:id/waive` | `protect` | `backend/controllers/compliance/incidentController.js:waiveDirect` | [backend/routes/compliance/incidentRoutes.js:21](../../backend/routes/compliance/incidentRoutes.js) |
| POST | `/api/compliance/incidents/:id/waive/request` | `protect` | `backend/controllers/compliance/incidentController.js:waiveRequest` | [backend/routes/compliance/incidentRoutes.js:22](../../backend/routes/compliance/incidentRoutes.js) |
| POST | `/api/compliance/incidents/:id/waive/decide` | `protect` | `backend/controllers/compliance/incidentController.js:waiveDecide` | [backend/routes/compliance/incidentRoutes.js:23](../../backend/routes/compliance/incidentRoutes.js) |
| GET | `/api/compliance/timeline/me` | `protect` | `backend/controllers/compliance/timelineController.js:me` | [backend/routes/compliance/incidentRoutes.js:26](../../backend/routes/compliance/incidentRoutes.js) |
| GET | `/api/compliance/timeline/incident/:id` | `protect` | `backend/controllers/compliance/timelineController.js:forIncident` | [backend/routes/compliance/incidentRoutes.js:27](../../backend/routes/compliance/incidentRoutes.js) |
| GET | `/api/compliance/timeline/:employeeId` | `protect` | `backend/controllers/compliance/timelineController.js:forEmployee` | [backend/routes/compliance/incidentRoutes.js:28](../../backend/routes/compliance/incidentRoutes.js) |
| GET | `/api/compliance/ledgers/:name` | `protect` | `backend/controllers/compliance/ledgerController.js:get` | [backend/routes/compliance/incidentRoutes.js:32](../../backend/routes/compliance/incidentRoutes.js) |
| GET | `/api/compliance/dashboard/summary` | `protect` | `backend/controllers/compliance/dashboardController.js:summary` | [backend/routes/compliance/dashboardRoutes.js:7](../../backend/routes/compliance/dashboardRoutes.js) |
| GET | `/api/compliance/dashboard/most-penalised` | `protect` | `backend/controllers/compliance/dashboardController.js:mostPenalised` | [backend/routes/compliance/dashboardRoutes.js:8](../../backend/routes/compliance/dashboardRoutes.js) |
| GET | `/api/compliance/dashboard/common-violations` | `protect` | `backend/controllers/compliance/dashboardController.js:commonViolations` | [backend/routes/compliance/dashboardRoutes.js:9](../../backend/routes/compliance/dashboardRoutes.js) |
| GET | `/api/compliance/dashboard/pending-waivers` | `protect` | `backend/controllers/compliance/dashboardController.js:pendingWaivers` | [backend/routes/compliance/dashboardRoutes.js:10](../../backend/routes/compliance/dashboardRoutes.js) |
| GET | `/api/compliance/dashboard/financial-totals` | `protect` | `backend/controllers/compliance/dashboardController.js:financialTotals` | [backend/routes/compliance/dashboardRoutes.js:11](../../backend/routes/compliance/dashboardRoutes.js) |
| GET | `/api/compliance/dashboard/trends` | `protect` | `backend/controllers/compliance/dashboardController.js:trends` | [backend/routes/compliance/dashboardRoutes.js:12](../../backend/routes/compliance/dashboardRoutes.js) |

### /api/reminders

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/reminders/mine` | `protect` | `backend/controllers/reminderController.js:mine` | [backend/routes/reminderRoutes.js:8](../../backend/routes/reminderRoutes.js) |
| PATCH | `/api/reminders/:id/done` | `protect` | `backend/controllers/reminderController.js:done` | [backend/routes/reminderRoutes.js:9](../../backend/routes/reminderRoutes.js) |
| PATCH | `/api/reminders/:id/dismiss` | `protect` | `backend/controllers/reminderController.js:dismiss` | [backend/routes/reminderRoutes.js:10](../../backend/routes/reminderRoutes.js) |
| PATCH | `/api/reminders/:id/snooze` | `protect` | `backend/controllers/reminderController.js:snooze` | [backend/routes/reminderRoutes.js:11](../../backend/routes/reminderRoutes.js) |
| POST | `/api/reminders` | `protect` | `backend/controllers/reminderController.js:create` | [backend/routes/reminderRoutes.js:14](../../backend/routes/reminderRoutes.js) |
| PATCH | `/api/reminders/:id` | `protect` | `backend/controllers/reminderController.js:update` | [backend/routes/reminderRoutes.js:15](../../backend/routes/reminderRoutes.js) |
| POST | `/api/reminders/:id/cancel` | `protect` | `backend/controllers/reminderController.js:cancel` | [backend/routes/reminderRoutes.js:16](../../backend/routes/reminderRoutes.js) |
| POST | `/api/reminders/:id/complete` | `protect` | `backend/controllers/reminderController.js:complete` | [backend/routes/reminderRoutes.js:17](../../backend/routes/reminderRoutes.js) |

### /api/timeline

| Method | Path | Route middleware | Handler | Declaration |
| --- | --- | --- | --- | --- |
| GET | `/api/timeline/mine` | `protect` | `backend/controllers/timelineController.js:mine` | [backend/routes/timelineRoutes.js:7](../../backend/routes/timelineRoutes.js) |
| GET | `/api/timeline/employee/:id` | `protect` | `backend/controllers/timelineController.js:forEmployee` | [backend/routes/timelineRoutes.js:8](../../backend/routes/timelineRoutes.js) |

### Inline server routes

| Method | Path | Authentication | Behavior |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | Returns ok and current time; does not prove indexes/migrations/SMTP readiness |
| GET | `/api/company-documents-test` | Public | Static ok diagnostic, no document data |
| GET | `/api/test-email` | Public | Arbitrary `to` recipient query triggers configured email delivery and returns diagnostics; S01 |
