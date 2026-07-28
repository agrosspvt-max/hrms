/**
 * dependencyDetector.js -- Compliance v2 replacement for
 * penaltyEngine.enforceDependencyPending.
 *
 * One candidate per employee-day when the employee has ANY open
 * dependency older than `rule.trigger.thresholdDays` (default 3).
 * Detector is idempotent through the day-scoped naturalKey; recurring
 * daily behaviour is handled by Phase 5's action engine (each day's
 * effect gets its own row).
 *
 * Criticality (single source of truth): a candidate is marked
 * `detectorMeta.criticalTask = true` IFF at least one of the overdue
 * dependencies points at a specific task whose `isCritical === true`
 * on the source submission's snapshot (or, as a fallback, on the live
 * template).  No template-name / priority / heuristic inference.
 */

const { startOfDay } = require('../../../utils/dateHelpers');
const { dependencyPendingKey } = require('../naturalKey');
const critical = require('../critical');
const pendingState = require('../../pendingStateService');

const detect = async ({ rule, employee, day }) => {
  if (!rule || !employee) return [];
  const target = startOfDay(day);
  const thresholdDays = Math.max(0, Number(rule.trigger && rule.trigger.thresholdDays) || 0);

  // PendingStateService owns the canonical open-dependency query
  // (schema fields, not the legacy `status`/`assignedAt` pair).
  const overdue = await pendingState.listOpenDependencies({
    employeeId: employee._id,
    thresholdDays,
    asOf: target,
    overdueOnly: true,
  });

  if (!overdue.length) return [];

  // Per-dependency criticality.  We short-circuit on the first
  // critical hit; per-tick caching in `critical` makes the loop cheap
  // even with hundreds of dependencies.
  let anyCritical = false;
  const criticalDepIds = [];
  for (const dep of overdue) {
    // Only tasks pointing at a specific source task can be critical.
    // Direct HR-created deps (no sourceSubmissionId / sourceTaskId)
    // are treated as non-critical by contract.
    // eslint-disable-next-line no-await-in-loop
    const isCrit = await critical.resolveCriticalForDependency(dep);
    if (isCrit) {
      anyCritical = true;
      criticalDepIds.push(dep._id);
    }
  }

  return [{
    naturalKey: dependencyPendingKey({
      ruleCode: rule.code,
      employeeId: employee._id,
      day: target,
    }),
    incidentDate: target,
    context: {
      workDate: target,
      dependencyIds: overdue.map((d) => d._id),
      // Stabilization patch (C5): populate departmentId + designationId.
      departmentId: employee.department || null,
      designationId: employee.designation || null,
    },
    detectorMeta: {
      detector: 'built_in.dependency_pending',
      overdueCount: overdue.length,
      thresholdDays,
      criticalTask: anyCritical,
      criticalDependencyIds: criticalDepIds,
    },
  }];
};

module.exports = { detect, code: 'built_in.dependency_pending' };
