/**
 * pendingStateService.js -- SINGLE SOURCE OF TRUTH for "is this task
 * still pending?" across the entire HRMS.
 *
 * Historically each surface implemented its own Mongo query with
 * subtly different filters, producing four different "pending"
 * numbers for the same employee (Dashboard hid the row via a
 * today-only date filter, Global Pendency hid it via a 7-day range +
 * submitted:true, Performance counted it forever, and Compliance did
 * the same as Performance).  DependencyTask queries were also broken
 * -- readers filtered on `status` + `assignedAt` while the schema
 * stored `currentStatus` + `waitingSince`.
 *
 * This service replaces every ad-hoc query with a canonical predicate
 * pair (`isTaskPending`, `isDependencyOpen`) and a small set of
 * listers that all consumers share.  Callers can layer date /
 * template / recurrence filters on top for UI purposes, but the
 * definition of "pending" is uniform.
 *
 * ---------------------------------------------------------------
 * PENDING TASK CANONICAL PREDICATE (Submission.tasks[i])
 * ---------------------------------------------------------------
 *   A task is PENDING iff  status === 'pending' AND !completedAt
 *
 * `completedAt` is stamped by every writer that closes a backlog
 * row (`completeBacklogTask`, `autoResolveBacklog`), so the two-part
 * predicate makes stale rows impossible.
 *
 * A task is OVERDUE iff pending AND resolveBy exists AND resolveBy < asOf.
 *
 * ---------------------------------------------------------------
 * OPEN DEPENDENCY CANONICAL PREDICATE (DependencyTask)
 * ---------------------------------------------------------------
 *   A dep is OPEN iff  currentStatus !== 'resolved' AND !resolvedAt
 *
 * Both criteria are authoritative on the schema (see
 * models/DependencyTask.js).  The `status`/`assignedAt` fields the
 * old readers used were never written -- production queries returned
 * nothing.  Every reader now goes through
 * `listOpenDependencies({employeeIds})`.
 *
 * ---------------------------------------------------------------
 * WRITE APIS
 * ---------------------------------------------------------------
 *   resolveTask({submissionId, taskId, actor, reason})
 *     Definitive way to close a backlog task.  Flips
 *     status='done', stamps completedAt, saves the submission, and
 *     cascades to the legacy penalty engine + compliance v2
 *     incident service so mirrored state stays in sync.
 *
 *   autoResolveBacklog({employee, template, incomingTasks})
 *     Called from submitOne AFTER today's submission is saved.  For
 *     every task title/taskId the employee just marked Done/Ongoing,
 *     walk the employee's older still-pending Submission.tasks[] on
 *     the same template and close matching rows.  Employees no
 *     longer have to click "Complete backlog" if today's report
 *     already covered yesterday's carry-forward.
 *
 * ---------------------------------------------------------------
 * BACKWARD COMPATIBILITY
 * ---------------------------------------------------------------
 * Legacy DependencyTask rows that somehow carry the OLD `status` or
 * `assignedAt` fields are still tolerated: the reader OR-s the two
 * shapes so a mixed corpus keeps working through the migration.
 * Writers only produce the canonical shape, so over time the corpus
 * becomes uniform.
 *
 * ZERO writes on read paths.  All writes fan out through the
 * existing incident / penalty / event pipeline so Compliance's cancel
 * / resolve / recovery semantics are unchanged.
 */

const Submission = require('../models/Submission');
const DependencyTask = require('../models/DependencyTask');
const { startOfDay } = require('../utils/dateHelpers');
const { liveSubmissionFilter } = require('../utils/submissionFilter');

/* ================================================================ */
/*  PREDICATES                                                       */
/* ================================================================ */

/**
 * Canonical "is this task pending?" predicate.  Both criteria are
 * required so a row where the writer forgot to stamp `completedAt`
 * (legacy pre-Batch-2) is still treated correctly.
 */
const isTaskPending = (task) => {
  if (!task) return false;
  if (task.status !== 'pending') return false;
  if (task.completedAt) return false;
  return true;
};

/**
 * Canonical "is this task overdue?" predicate.
 * asOf defaults to today (UTC midnight).
 */
const isTaskOverdue = (task, asOf = new Date()) => {
  if (!isTaskPending(task)) return false;
  if (!task.resolveBy) return false;
  return new Date(task.resolveBy) < startOfDay(asOf);
};

/**
 * Canonical "is this dependency still open?" predicate.  Written to
 * the schema fields (`currentStatus`, `resolvedAt`); tolerant of the
 * legacy `status:'pending'|'assigned'` shape used by earlier
 * penalty-engine code paths and test fixtures.
 */
const isDependencyOpen = (dep) => {
  if (!dep) return false;
  if (dep.resolvedAt) return false;
  // Preferred (schema) field.
  if (dep.currentStatus && dep.currentStatus !== 'resolved') return true;
  // Legacy fallback -- rows that only ever had the wrong field
  // written (test fixtures, old imports).  Treated as open if the
  // value is in the historical open-state whitelist.
  if (dep.status && (dep.status === 'pending' || dep.status === 'assigned' || dep.status === 'open' || dep.status === 'in_progress')) {
    return true;
  }
  return false;
};

/**
 * Canonical "is this dependency overdue?" predicate.  Uses the
 * schema field `waitingSince` first, falling back to the legacy
 * `assignedAt` and finally to `createdAt`.
 */
const dependencyStartedAt = (dep) => {
  if (!dep) return null;
  return dep.waitingSince || dep.assignedAt || dep.createdAt || null;
};

const isDependencyOverdue = (dep, thresholdDays = 3, asOf = new Date()) => {
  if (!isDependencyOpen(dep)) return false;
  const started = dependencyStartedAt(dep);
  if (!started) return false;
  const cutoff = new Date(startOfDay(asOf).getTime() - Math.max(0, Number(thresholdDays) || 0) * 86400000);
  return new Date(started) <= cutoff;
};

/* ================================================================ */
/*  LISTERS                                                          */
/* ================================================================ */

/**
 * Build the Submission.find() query that selects EVERY submission
 * that CAN contribute a pending row for the given scope.  Explicit
 * options -- no silent date / submitted filter.
 */
const _buildSubmissionQuery = ({ employeeIds, employeeId, from, to, includeUnsubmitted = true, extraFilter = {} } = {}) => {
  const q = { 'tasks.status': 'pending', ...liveSubmissionFilter({}), ...extraFilter };
  if (employeeIds && employeeIds.length) q.employee = { $in: employeeIds };
  else if (employeeId) q.employee = employeeId;
  if (from || to) {
    q.date = {};
    if (from) q.date.$gte = from;
    if (to)   q.date.$lt  = to;
  }
  if (!includeUnsubmitted) q.submitted = true;
  return q;
};

/**
 * List every pending Submission.tasks[i] row for the given scope.
 * Returns rich objects (submission id + task snapshot) so callers
 * can render without another DB hop.
 *
 * Callers who need only a count can wrap this and take .length.
 *
 * Options:
 *   employeeId | employeeIds   -- scope (both optional; empty = all).
 *   from, to                    -- optional Submission.date window.
 *   includeUnsubmitted (bool)   -- default true.
 *   asOf                        -- default now(); drives overdue.
 *   overdueOnly (bool)          -- default false; when true filters
 *                                  by isTaskOverdue.
 *   templateId                  -- filter by template.
 *   projection                  -- Mongo projection override.
 */
const listPendingTasks = async (opts = {}) => {
  const q = _buildSubmissionQuery(opts);
  if (opts.templateId) q.template = opts.templateId;
  const projection = opts.projection || '_id date employee template templateType frequency scheduleLabel tasks';
  const subs = await Submission.find(q).select(projection).lean();
  const asOf = opts.asOf || new Date();
  const out = [];
  for (const s of subs) {
    for (const t of (s.tasks || [])) {
      if (!isTaskPending(t)) continue;
      if (opts.overdueOnly && !isTaskOverdue(t, asOf)) continue;
      out.push({
        submissionId: s._id,
        submissionDate: s.date,
        employee: s.employee,
        template: s.template,
        templateType: s.templateType,
        frequency: s.frequency || 'daily',
        scheduleLabel: s.scheduleLabel || '',
        taskId: t._id,
        templateTaskId: t.taskId || null,
        title: t.title,
        points: t.points || 0,
        isCritical: t.isCritical === true,
        pendingSince: t.pendingSince,
        resolveBy: t.resolveBy,
        addedByEmployee: !!t.addedByEmployee,
      });
    }
  }
  return out;
};

/**
 * Count-only fast path.  Same semantics as listPendingTasks but
 * returns { total, overdue }.  Used by Performance / Pendency
 * dashboards where full task snapshots are not needed.
 */
const countPendingTasks = async (opts = {}) => {
  const rows = await listPendingTasks({ ...opts, projection: '_id employee template tasks.status tasks.completedAt tasks.resolveBy tasks.pendingSince' });
  const asOf = opts.asOf || new Date();
  let overdue = 0;
  for (const r of rows) if (isTaskOverdue({ status: 'pending', resolveBy: r.resolveBy }, asOf)) overdue += 1;
  return { total: rows.length, overdue };
};

/**
 * List every OPEN DependencyTask for the given scope.  Uses the
 * canonical schema fields (`currentStatus`, `waitingSince`,
 * `resolvedAt`) so production rows are matched correctly.  Legacy
 * fixtures that use the old field names are tolerated via an OR.
 */
const listOpenDependencies = async ({ employeeId, employeeIds, thresholdDays = 0, asOf = new Date(), overdueOnly = false } = {}) => {
  const cutoff = new Date(startOfDay(asOf).getTime() - Math.max(0, Number(thresholdDays) || 0) * 86400000);
  const query = {
    $or: [
      { currentStatus: { $in: ['open', 'in_progress'] } },
      // Legacy shape written by early tests / imports.  Do NOT
      // introduce new writes in this shape.
      { status: { $in: ['pending', 'assigned', 'open', 'in_progress'] } },
    ],
    resolvedAt: { $in: [null, undefined] },
  };
  if (employeeIds && employeeIds.length) query.assignedTo = { $in: employeeIds };
  else if (employeeId) query.assignedTo = employeeId;

  const rows = await DependencyTask.find(query)
    .select('_id assignedTo assignedBy sourceSubmissionId sourceTaskId sourceKind currentStatus status waitingSince assignedAt createdAt resolvedAt template templateTitle originalTaskName priority')
    .lean();

  const out = [];
  for (const d of rows) {
    if (!isDependencyOpen(d)) continue;                   // belt + braces
    if (overdueOnly && !isDependencyOverdue(d, thresholdDays, asOf)) continue;
    if (!overdueOnly && thresholdDays > 0) {
      const started = dependencyStartedAt(d);
      if (started && new Date(started) > cutoff) continue;
    }
    out.push(d);
  }
  return out;
};

/**
 * Legacy compatibility shim -- returns the exact shape the old
 * `_overduePendingTasks` used to produce so the Performance Lock
 * detector can adopt this service with a minimal diff.
 */
const overduePendingTasksForEmployee = async (employeeId, day = new Date()) => {
  const rows = await listPendingTasks({ employeeId, overdueOnly: true, asOf: day });
  return rows.map((r) => ({
    submissionId: r.submissionId,
    taskId: r.taskId,
    title: r.title,
    pendingSince: r.pendingSince,
    resolveBy: r.resolveBy,
    isCritical: r.isCritical,
    templateTaskId: r.templateTaskId,
    templateId: r.template,
  }));
};

/* ================================================================ */
/*  WRITERS                                                          */
/* ================================================================ */

/**
 * Definitive way to close a backlog task.  Flips status → 'done',
 * stamps completedAt, saves the submission, and cascades to the
 * penalty engine + compliance v2 incident service so mirrored state
 * stays in sync.  Idempotent -- calling twice on an already-closed
 * task is a no-op.  Returns the updated task subdoc (or null when
 * the row wasn't found or wasn't pending).
 */
const resolveTask = async ({ submissionId, taskId, actor = null, reason = '' } = {}) => {
  if (!submissionId || !taskId) return null;
  const sub = await Submission.findById(submissionId);
  if (!sub) return null;
  const task = sub.tasks.id(taskId);
  if (!task) return null;
  if (task.status !== 'pending' || task.completedAt) return task;   // idempotent

  task.status = 'done';
  task.completedAt = new Date();
  if (reason) task.pendingReason = task.pendingReason || reason;
  await sub.save();

  // Cascade: legacy penalty engine + v2 incident service.  Failure
  // never rolls back the task closure -- the reconciler is the
  // safety net.
  try {
    const penaltyEngine = require('./penaltyEngine');
    await penaltyEngine.onPendingTaskResolved({ employeeId: sub.employee });
  } catch (e) { console.error('[pendingState] onPendingTaskResolved cascade failed:', e.message); }

  return task;
};

/**
 * Automatic backlog resolution.  Called from submissionController
 * AFTER today's submission is saved.  For every task the employee
 * just marked Done / Ongoing on today's report, walk older
 * still-pending Submission.tasks[] rows for the same template and
 * close matching titles / template task ids.
 *
 * Match strategy (in order):
 *   1) By snapshotted `taskId` (Template.tasks[i]._id).  Rock solid
 *      because a task template's task id is stable across days.
 *   2) By trimmed title (case-insensitive fallback for template
 *      shapes that don't carry a taskId, e.g. very old templates
 *      or employee-added rows).
 *
 * Never touches:
 *   - future-dated submissions
 *   - the SAME submission the employee just filed
 *   - custom (customResponses) fields -- those use a different
 *     status pipe (Phase 14)
 *   - unrelated templates
 *
 * Returns { resolved: [{submissionId, taskId, title}] }.
 */
const autoResolveBacklog = async ({ employee, template, incomingTasks = [], submissionId, asOf = new Date() } = {}) => {
  if (!employee || !template || !Array.isArray(incomingTasks) || incomingTasks.length === 0) {
    return { resolved: [] };
  }
  // Build the "just completed" match sets.
  const doneTaskIds = new Set();
  const doneTitles = new Set();
  for (const t of incomingTasks) {
    if (!t) continue;
    if (t.status !== 'done' && t.status !== 'ongoing') continue;
    if (t.taskId)  doneTaskIds.add(String(t.taskId));
    const title = String(t.title || '').trim().toLowerCase();
    if (title) doneTitles.add(title);
  }
  if (doneTaskIds.size === 0 && doneTitles.size === 0) return { resolved: [] };

  const today = startOfDay(asOf);
  const olderSubs = await Submission.find({
    employee,
    template,
    'tasks.status': 'pending',
    date: { $lt: today },
    _id: { $ne: submissionId || null },
    ...liveSubmissionFilter({}),
  });

  const resolved = [];
  let cascadeNeeded = false;
  for (const sub of olderSubs) {
    let dirty = false;
    for (const t of (sub.tasks || [])) {
      if (!isTaskPending(t)) continue;
      // Skip rows the employee added themselves -- those are
      // ad-hoc and don't map by template task id.
      if (t.addedByEmployee && !doneTitles.has(String(t.title || '').trim().toLowerCase())) continue;
      const idMatch = t.taskId && doneTaskIds.has(String(t.taskId));
      const titleMatch = doneTitles.has(String(t.title || '').trim().toLowerCase());
      if (!idMatch && !titleMatch) continue;
      t.status = 'done';
      t.completedAt = new Date();
      resolved.push({ submissionId: sub._id, taskId: t._id, title: t.title });
      dirty = true;
    }
    if (dirty) await sub.save();
    if (dirty) cascadeNeeded = true;
  }

  if (cascadeNeeded) {
    try {
      const penaltyEngine = require('./penaltyEngine');
      await penaltyEngine.onPendingTaskResolved({ employeeId: employee });
    } catch (e) { console.error('[pendingState] auto-resolve cascade failed:', e.message); }
  }
  return { resolved };
};

/**
 * Resolve a DependencyTask through the canonical schema fields.
 * Wraps the older `dependencyEngine.resolveDependencyTask` to keep
 * one entry point for callers that only know about the service.
 */
const resolveDependency = async ({ dependencyId, actor = null, note = '' } = {}) => {
  if (!dependencyId) return null;
  const dep = await DependencyTask.findById(dependencyId);
  if (!dep) return null;
  if (dep.resolvedAt) return dep;                                   // idempotent
  const { resolveDependencyTask } = require('./dependencyEngine');
  return resolveDependencyTask(dep, actor || { _id: null }, note);
};

module.exports = {
  // Predicates
  isTaskPending,
  isTaskOverdue,
  isDependencyOpen,
  isDependencyOverdue,
  dependencyStartedAt,
  // Listers
  listPendingTasks,
  countPendingTasks,
  listOpenDependencies,
  overduePendingTasksForEmployee,
  // Writers
  resolveTask,
  autoResolveBacklog,
  resolveDependency,
};
