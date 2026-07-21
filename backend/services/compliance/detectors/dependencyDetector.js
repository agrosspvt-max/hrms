/**
 * dependencyDetector.js -- Compliance v2 replacement for
 * penaltyEngine.enforceDependencyPending.
 *
 * One candidate per employee-day when the employee has ANY open
 * dependency older than `rule.trigger.thresholdDays` (default 3).
 * Detector is idempotent through the day-scoped naturalKey; recurring
 * daily behaviour is handled by Phase 5's action engine (each day's
 * effect gets its own row).
 */

const DependencyTask = require('../../../models/DependencyTask');
const Submission = require('../../../models/Submission');
const { startOfDay } = require('../../../utils/dateHelpers');
const { dependencyPendingKey } = require('../naturalKey');
const critical = require('../critical');

const DAY_MS = 24 * 60 * 60 * 1000;

const detect = async ({ rule, employee, day }) => {
  if (!rule || !employee) return [];
  const target = startOfDay(day);
  const thresholdDays = Math.max(0, Number(rule.trigger && rule.trigger.thresholdDays) || 0);
  const threshold = new Date(target.getTime() - thresholdDays * DAY_MS);

  const overdue = await DependencyTask.find({
    assignedTo: employee._id,
    status: { $in: ['pending', 'assigned'] },
    assignedAt: { $lte: threshold },
  }).select('_id sourceSubmissionId').lean();

  if (!overdue.length) return [];

  // Batch-1 fix #2 (Option A) -- derive criticality via each source
  // submission's Template.  A missing sourceSubmissionId means the
  // dep was HR-created directly; we cannot infer template criticality
  // and default to false.  Bounded lookup: unique template ids only.
  const subIds = [...new Set(overdue.map((d) => d.sourceSubmissionId).filter(Boolean).map(String))];
  let anyCritical = false;
  if (subIds.length) {
    const subs = await Submission.find({ _id: { $in: subIds } }).select('template').lean();
    for (const s of subs) {
      if (await critical.resolveCriticalByTemplateId(s.template)) {
        anyCritical = true; break;
      }
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
    },
  }];
};

module.exports = { detect, code: 'built_in.dependency_pending' };
