/**
 * performanceLockDetector.js -- Compliance v2 replacement for
 * penaltyEngine.enforcePerformanceLock.
 *
 * One candidate per employee-day when the employee has at least one
 * pending task past its `resolveBy` deadline AND the day is a working
 * day for that employee.  detectorMeta carries the oldest overdue
 * task snapshot so Phase 5's UI can render the same "Performance Lock
 * Active" card the current dashboard shows.
 */

const Submission = require('../../../models/Submission');
const { startOfDay } = require('../../../utils/dateHelpers');
const { performanceLockKey } = require('../naturalKey');
const critical = require('../critical');
const workingDayContext = require('../workingDayContext');
const { isWorkingDay } = require('../../../utils/workingDays');

/**
 * Batch-2 fix #11 (rework) -- working-day context is now supplied by
 * the scheduler, not loaded inside the detector.  The scheduler
 * loads the company-wide `globalCtx` (holidaySet) once per tick and
 * builds an `employeeLeaveMap` (Map<empIdString, Set<YYYY-MM-DD>>)
 * for every rule's scope in a SINGLE `Leave.find({employee:{$in:...}})`
 * query.  We compose those two pieces per employee here -- the map
 * lookup is keyed by the exact employee id, so employee B can never
 * inherit employee A's leaveDaySet.
 *
 * Backward-compat fallback: when either `globalCtx` or
 * `employeeLeaveMap` is missing (e.g. a caller invoking `detect`
 * directly from a unit test or an ad-hoc trigger), we fall through
 * to a single-employee `loadWorkingDayContext` call.  Slightly slower
 * but correct.
 */
const _isWorkingDayForEmployee = async ({ employee, day, workingDaysOnly, globalCtx, employeeLeaveMap }) => {
  if (!workingDaysOnly) return true;
  try {
    if (globalCtx && employeeLeaveMap) {
      const ctx = workingDayContext.composeContext({ globalCtx, employee, employeeLeaveMap });
      return isWorkingDay(day, ctx);
    }
    // Fallback for callers that don't pass preloaded context (unit
    // tests, manual triggers).  One-off per-employee load.
    const { loadWorkingDayContext } = require('../../../utils/workingDays');
    const ctx = await loadWorkingDayContext({ employee, from: day, to: day });
    return isWorkingDay(day, ctx);
  } catch (e) {
    // Fail-open: don't silently drop performance-lock incidents just
    // because holiday/leave resolution had a transient error.
    return true;
  }
};

const _overduePendingTasks = async (employeeId, day) => {
  const target = startOfDay(day);
  const subs = await Submission.find({
    employee: employeeId,
    'tasks.status': 'pending',
    deleted: { $ne: true },
  }).select('_id date template tasks').lean();
  const out = [];
  for (const s of subs) {
    for (const t of (s.tasks || [])) {
      if (t.status !== 'pending') continue;
      if (!t.resolveBy) continue;
      if (new Date(t.resolveBy) < target) {
        out.push({
          submissionId: s._id,
          taskId: t._id,
          title: t.title,
          pendingSince: t.pendingSince,
          resolveBy: t.resolveBy,
          // Snapshot of Template.tasks[i].isCritical taken at
          // submission-creation.  Single source of truth for this
          // detector; the live template is consulted only as a
          // fallback for legacy submissions that pre-date the flag.
          isCritical: t.isCritical === true,
          templateTaskId: t.taskId || null,
          templateId: s.template,
        });
      }
    }
  }
  return out;
};

const detect = async ({ rule, employee, day, globalCtx = null, employeeLeaveMap = null }) => {
  if (!rule || !employee) return [];
  const target = startOfDay(day);

  const workingDaysOnly = !!(rule.trigger && rule.trigger.workingDaysOnly);
  if (workingDaysOnly && !(await _isWorkingDayForEmployee({
    employee, day: target, workingDaysOnly, globalCtx, employeeLeaveMap,
  }))) {
    return [];
  }

  const overdue = await _overduePendingTasks(employee._id, target);
  if (!overdue.length) return [];

  const oldest = overdue.reduce(
    (min, o) => (!min || new Date(o.pendingSince) < new Date(min.pendingSince)) ? o : min,
    null,
  );

  // Per-task criticality.  Prefer the snapshot carried on each
  // submission task (Template.tasks[i].isCritical at creation).  For
  // legacy submissions without a snapshot, fall back to a per-task
  // lookup against the live template.  No template-wide inference,
  // no name/priority heuristics.
  let anyCritical = false;
  for (const o of overdue) {
    if (o.isCritical === true) { anyCritical = true; break; }
    // eslint-disable-next-line no-await-in-loop
    if (o.templateId && o.templateTaskId
        && await critical.resolveCriticalByTaskId(o.templateId, o.templateTaskId)) {
      anyCritical = true; break;
    }
  }
  return [{
    naturalKey: performanceLockKey({
      ruleCode: rule.code,
      employeeId: employee._id,
      day: target,
    }),
    incidentDate: target,
    context: {
      workDate: target,
      submissionId: oldest ? oldest.submissionId : null,
      taskId:       oldest ? oldest.taskId       : null,
      taskTitle:    oldest ? oldest.title        : '',
      // Stabilization patch (C5): departmentId + designationId.
      departmentId:  employee.department  || null,
      designationId: employee.designation || null,
    },
    detectorMeta: {
      detector: 'built_in.performance_lock',
      overdueCount: overdue.length,
      // Stabilization patch (C6): criticalTask flag for financial_fine.
      criticalTask: anyCritical,
      oldest: oldest ? {
        submissionId: oldest.submissionId,
        taskId:       oldest.taskId,
        taskTitle:    oldest.title,
        pendingSince: oldest.pendingSince,
        resolveBy:    oldest.resolveBy,
        templateId:   oldest.templateId || null,
      } : null,
    },
  }];
};

module.exports = {
  detect,
  code: 'built_in.performance_lock',
  // Batch-2 fix #11 (rework) -- detector-side per-tick cache has
  // been removed; the scheduler now supplies `globalCtx` +
  // `employeeLeaveMap` on every detect() call.  `beginTick` is
  // retained as a no-op so any caller that still invokes it does
  // not break, but it is no longer needed for correctness.
  beginTick: () => {},
  // Advertise the context inputs so the scheduler knows to preload.
  needsWorkingDayContext: true,
};
