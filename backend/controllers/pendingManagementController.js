/**
 * pendingManagementController.js
 *
 * HR / Super-Admin investigation + recovery surface for the Pending
 * Management tab inside the employee profile.  Every read goes
 * through PendingStateService so this screen is guaranteed to agree
 * with Dashboard, HR Performance, Global Pendency, and the
 * Compliance detectors.  Writes only touch business data (the
 * originating Submission task or DependencyTask row) via the same
 * service; compliance state is never manipulated directly here --
 * cancel / waive / recover incidents remain on the compliance tab.
 *
 * Endpoints
 * ---------
 *   GET  /api/pending-management/:employeeId
 *     Returns { employee, pending: [...rich rows], dependencies: [...],
 *               diagnostics: { dashboard, performance, globalPendency,
 *                              complianceEligible, inconsistency } }.
 *
 *   POST /api/pending-management/:employeeId/resolve
 *     Body: { source: 'submission'|'dependency', submissionId?,
 *             taskId?, dependencyId?, reason }
 *     Resolves ONE pending row.  Requires a non-empty reason.  Writes
 *     an AuditLog entry.  Idempotent -- resolving an already-resolved
 *     row is a no-op.
 *
 * Access control
 * --------------
 *   Route-level middleware clamps this to super_admin + hr.  Regular
 *   employees never see the tab (frontend) or reach the endpoints
 *   (backend gate).
 */

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const User = require('../models/User');
const Submission = require('../models/Submission');
const pendingState = require('../services/pendingStateService');
const { startOfDay, addDays } = require('../utils/dateHelpers');
const { logAudit } = require('../utils/audit');

const _isPrivileged = (u) =>
  u && (u.role === 'super_admin' || u.role === 'hr');

/* ================================================================
 *  GET /api/pending-management/:employeeId
 * ================================================================ */
const list = asyncHandler(async (req, res) => {
  if (!_isPrivileged(req.user)) {
    res.status(403); throw new Error('Forbidden: Pending Management is HR / Super Admin only.');
  }
  const { employeeId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(employeeId)) {
    res.status(400); throw new Error('Valid employeeId required.');
  }
  const emp = await User.findById(employeeId)
    .select('name employeeId email role department designation')
    .populate('department', 'name')
    .populate('designation', 'title')
    .lean();
  if (!emp) { res.status(404); throw new Error('Employee not found.'); }

  const asOf = new Date();

  /* ---------- pending Submission.tasks[] rows ---------- */
  const pendingRows = await pendingState.listPendingTasks({
    employeeId: emp._id, asOf,
  });

  /* ---------- enrich with template titles + dep pointers ---------- */
  const tplIds = [...new Set(pendingRows.map((r) => String(r.template)).filter(Boolean))];
  const Template = require('../models/Template');
  const tpls = tplIds.length
    ? await Template.find({ _id: { $in: tplIds } }).select('title customKind').lean()
    : [];
  const tplById = new Map(tpls.map((t) => [String(t._id), t]));

  /* ---------- open dependencies pointing AT this employee ---------- */
  const depsIncoming = await pendingState.listOpenDependencies({ employeeId: emp._id, asOf });

  /* ---------- Populate assignedBy names for dep display ---------- */
  const assignerIds = [...new Set(depsIncoming.map((d) => String(d.assignedBy)).filter(Boolean))];
  const assignerRows = assignerIds.length
    ? await User.find({ _id: { $in: assignerIds } }).select('name employeeId').lean()
    : [];
  const assignerById = new Map(assignerRows.map((r) => [String(r._id), r]));

  /* ---------- Build the unified pending list ---------- */
  const rows = [];
  const today = startOfDay(asOf);
  for (const r of pendingRows) {
    const tpl = tplById.get(String(r.template));
    const daysPending = Math.max(0, Math.floor(
      (today - startOfDay(r.pendingSince || r.submissionDate)) / 86400000,
    ));
    const overdue = r.resolveBy && new Date(r.resolveBy) < today;
    // Source: a task on today's submission is "Daily Submission";
    // one carrying over from a prior day is "Carry Forward".  Manual
    // rows (added by HR or by the employee via extraTasks) surface
    // as "Manual".
    let source = 'Daily Submission';
    if (r.addedByEmployee) source = 'Manual';
    else if (r.submissionDate && startOfDay(r.submissionDate).getTime() < today.getTime()) source = 'Carry Forward';
    rows.push({
      kind: 'submission',
      submissionId: r.submissionId,
      taskId: r.taskId,
      templateTaskId: r.templateTaskId,
      template: {
        _id: r.template,
        title: tpl?.title || '(unknown template)',
        customKind: tpl?.customKind || '',
      },
      taskName: r.title,
      submissionDate: r.submissionDate,
      pendingSince: r.pendingSince,
      resolveBy: r.resolveBy,
      daysPending,
      overdue,
      status: 'pending',
      source,
      isCritical: r.isCritical === true,
      assignment: null,               // assignment id not projected -- kept null
      department: emp.department?.name || null,
      blockedBy: null,
      waitingFor: null,
      sourceEmployee: null,
    });
  }
  for (const d of depsIncoming) {
    const startedAt = pendingState.dependencyStartedAt(d);
    const daysPending = startedAt
      ? Math.max(0, Math.floor((today - startOfDay(startedAt)) / 86400000))
      : 0;
    const from = assignerById.get(String(d.assignedBy));
    rows.push({
      kind: 'dependency',
      dependencyId: d._id,
      submissionId: d.sourceSubmissionId || null,
      taskId: d.sourceTaskId || null,
      template: {
        _id: d.template || null,
        title: d.templateTitle || '(unknown template)',
        customKind: '',
      },
      taskName: d.originalTaskName || 'Dependency task',
      submissionDate: null,
      pendingSince: startedAt,
      resolveBy: null,
      daysPending,
      overdue: daysPending >= 3,
      status: d.currentStatus || d.status || 'open',
      source: 'Dependency',
      assignment: null,
      department: emp.department?.name || null,
      blockedBy: from ? `${from.name} (${from.employeeId})` : null,
      waitingFor: `${emp.name} (${emp.employeeId})`,
      sourceEmployee: from ? { _id: from._id, name: from.name, employeeId: from.employeeId } : null,
      priority: d.priority || 'normal',
    });
  }

  /* ---------- diagnostic banner ---------- */
  // "Dashboard" = the backlog widget (getBacklog), scope-free.
  // "Performance" = HR Performance overdue counter -- same predicate.
  // "Global Pendency" = the same predicate BUT restricted to the
  //    default 7-day submission window.
  // "Compliance Eligible" = tasks whose resolveBy is in the past.
  const globalWindowFrom = addDays(today, -7);
  const inWindow = pendingRows.filter((r) => {
    if (!r.submissionDate) return false;
    return new Date(r.submissionDate) >= globalWindowFrom;
  });
  const complianceEligible = pendingRows.filter((r) => r.resolveBy && new Date(r.resolveBy) < today);

  const diagnostics = {
    dashboard:         pendingRows.length,
    performance:       pendingRows.length,
    globalPendency:    inWindow.length,
    complianceEligible: complianceEligible.length,
    openDependencies:  depsIncoming.length,
  };
  diagnostics.inconsistency = !(
    diagnostics.dashboard === diagnostics.performance
    && diagnostics.dashboard === diagnostics.globalPendency
    && diagnostics.dashboard === diagnostics.complianceEligible
  );

  res.json({
    employee: {
      _id: emp._id,
      name: emp.name,
      employeeId: emp.employeeId,
      role: emp.role,
      department: emp.department?.name || null,
      designation: emp.designation?.title || null,
    },
    generatedAt: asOf,
    diagnostics,
    pending: rows,
  });
});

/* ================================================================
 *  POST /api/pending-management/:employeeId/resolve
 * ================================================================ */
const resolve = asyncHandler(async (req, res) => {
  if (!_isPrivileged(req.user)) {
    res.status(403); throw new Error('Forbidden: Pending Management is HR / Super Admin only.');
  }
  const { employeeId } = req.params;
  const { source, submissionId, taskId, dependencyId, reason } = req.body || {};

  if (!mongoose.Types.ObjectId.isValid(employeeId)) {
    res.status(400); throw new Error('Valid employeeId required.');
  }
  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 5) {
    res.status(400); throw new Error('A reason (min 5 characters) is required.');
  }

  let outcome = null;
  let oldStatus = null;
  let newStatus = null;
  let auditTargetType = null;
  let auditTargetId = null;
  let auditTargetLabel = '';

  if (source === 'submission') {
    if (!submissionId || !taskId) {
      res.status(400); throw new Error('submissionId + taskId required for submission source.');
    }
    // Guardrail: ensure the row belongs to the employee in the URL.
    const sub = await Submission.findOne({ _id: submissionId, employee: employeeId })
      .select('_id employee tasks template').lean();
    if (!sub) { res.status(404); throw new Error('Submission not found for employee.'); }
    const task = (sub.tasks || []).find((t) => String(t._id) === String(taskId));
    if (!task) { res.status(404); throw new Error('Task not found on submission.'); }
    oldStatus = task.status;
    if (task.status !== 'pending' || task.completedAt) {
      // Idempotent: already resolved.
      outcome = { changed: false, message: 'Task already resolved.' };
      newStatus = task.status;
    } else {
      const updated = await pendingState.resolveTask({
        submissionId, taskId, actor: req.user._id, reason: cleanReason,
      });
      outcome = { changed: true, task: updated };
      newStatus = 'done';
    }
    auditTargetType = 'Submission';
    auditTargetId = submissionId;
    auditTargetLabel = `Pending task "${task.title}" (submission ${submissionId})`;
  } else if (source === 'dependency') {
    if (!dependencyId) {
      res.status(400); throw new Error('dependencyId required for dependency source.');
    }
    const DependencyTask = require('../models/DependencyTask');
    const dep = await DependencyTask.findOne({ _id: dependencyId, assignedTo: employeeId })
      .select('_id assignedTo currentStatus status resolvedAt originalTaskName').lean();
    if (!dep) { res.status(404); throw new Error('DependencyTask not found for employee.'); }
    oldStatus = dep.currentStatus || dep.status || 'open';
    if (dep.resolvedAt) {
      outcome = { changed: false, message: 'Dependency already resolved.' };
      newStatus = 'resolved';
    } else {
      const updated = await pendingState.resolveDependency({
        dependencyId, actor: req.user, note: cleanReason,
      });
      outcome = { changed: true, dependency: updated };
      newStatus = 'resolved';
    }
    auditTargetType = 'DependencyTask';
    auditTargetId = dependencyId;
    auditTargetLabel = `Pending dependency "${dep.originalTaskName || 'dependency'}"`;
  } else {
    res.status(400); throw new Error("source must be one of: 'submission', 'dependency'.");
  }

  /* ---------- audit ---------- */
  try {
    logAudit(req, {
      action: 'pending.resolve',
      targetType: auditTargetType,
      targetId: auditTargetId,
      targetLabel: auditTargetLabel,
      meta: {
        employee: String(employeeId),
        source,
        submissionId: submissionId || null,
        taskId: taskId || null,
        dependencyId: dependencyId || null,
        reason: cleanReason,
        oldStatus,
        newStatus,
      },
    });
  } catch (e) { console.error('[pendingManagement] audit failed:', e.message); }

  res.json({
    ok: true,
    employee: employeeId,
    source,
    oldStatus,
    newStatus,
    reason: cleanReason,
    outcome,
  });
});

module.exports = { list, resolve };
