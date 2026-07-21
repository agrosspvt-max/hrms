/**
 * penaltyProjectionService.js -- projects a legacy `Penalty` row into
 * the shape a `ComplianceIncident` + `ComplianceActionEffect` pair
 * would have if the new engine had created them.
 *
 * Two responsibilities:
 *
 *   1. `project(penalty)`  -- IN-MEMORY projection only.  Returns an
 *      Incident-like object + a list of Effect-like objects.  Never
 *      writes.  Used by the Phase 9 read shim so the old routes can
 *      return responses that look like the new API.
 *
 *   2. `mappingFor(penalty)` -- returns the natural key + rule code
 *      the batch backfill will use to CREATE real ComplianceIncident
 *      + ComplianceActionEffect rows for a legacy Penalty.  Called
 *      only by `backfillJob.js` in dry-run or committed mode.
 *
 * Neither function persists anything.  The backfill command is the
 * only writer, and it runs behind an explicit `--commit` flag.
 */

/**
 * Static mapping from legacy `Penalty.category` -> new
 * `ComplianceRule.code`.  Missing categories return null so a caller
 * can decide whether to skip or error.
 */
const CATEGORY_TO_RULE = Object.freeze({
  missed_submission:       'missed_submission_v2',
  absent_submission:       'missed_submission_v2',  // legacy alias
  dependency_pending:      'dependency_pending_v2',
  performance_lock:        'performance_lock_v2',
  attendance_manual:       'attendance_manual_v2',
  manual_marks:            'manual_marks_v2',
  marks_adjustment:        'manual_marks_v2',
  manual_completion:       'completion_adjustment_v2',
  completion_adjustment:   'completion_adjustment_v2',
  financial_penalty:       'financial_penalty_v2',
  critical_threshold:      null,   // no v2 rule seeded; skip
  repeated_missing:        null,
});

const CATEGORY_TO_ACTION = Object.freeze({
  missed_submission:     'zero_daily_marks',
  absent_submission:     'zero_daily_marks',
  dependency_pending:    'financial_fine',
  performance_lock:      'performance_lock',
  attendance_manual:     'zero_daily_marks',
  manual_marks:          'fixed_marks_reduction',
  marks_adjustment:      'fixed_marks_reduction',
  manual_completion:     'percent_reduction',
  completion_adjustment: 'percent_reduction',
  financial_penalty:     'financial_fine',
});

const _isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Natural key for the synthetic incident.  Prefixed with
 * `legacy_projection` so a Phase-10 rollback can safely
 * `deleteMany({naturalKey: /^legacy_projection\|/})`.
 */
const naturalKeyFor = (penalty) => {
  if (!penalty || !penalty._id) throw new Error('naturalKeyFor: penalty._id required');
  return [
    'legacy_projection',
    String(penalty._id),
  ].join('|');
};

const mappingFor = (penalty) => {
  if (!penalty) return null;
  const ruleCode   = CATEGORY_TO_RULE[penalty.category] || null;
  const actionType = CATEGORY_TO_ACTION[penalty.category] || null;
  if (!ruleCode || !actionType) return null;
  return {
    ruleCode, actionType,
    naturalKey: naturalKeyFor(penalty),
    incidentDate:  new Date(penalty.targetDate || penalty.effectiveDate || penalty.createdAt || new Date()),
    effectiveDate: new Date(penalty.effectiveDate || penalty.targetDate || penalty.createdAt || new Date()),
    context: {
      submissionId: penalty.submission || null,
      workDate:     penalty.targetDate || penalty.effectiveDate || null,
      taskId:       (penalty.overdueRef && penalty.overdueRef.taskId) || null,
      taskTitle:    (penalty.overdueRef && penalty.overdueRef.taskTitle) || '',
    },
    detectorMeta: { legacyPenaltyId: penalty._id, category: penalty.category },
    status:       ['resolved', 'cancelled', 'expired'].includes(penalty.status) ? penalty.status : 'active',
    // Effect-level amounts.
    amount:  Number(penalty.amount)          || 0,
    marks:   Number(penalty.penaltyMarks)    || 0,
    percent: Number(penalty.completionPercent) || 0,
  };
};

/**
 * Read shim -- returns an in-memory incident-shaped object for a
 * legacy Penalty row.  Used by the Phase 9 route shim to enrich
 * `/api/penalties/*` responses without persisting anything.
 */
const project = (penalty) => {
  const m = mappingFor(penalty);
  if (!m) return null;
  const incident = {
    _id: `synthetic:${penalty._id}`,
    ruleCode: m.ruleCode,
    ruleVersion: 0,        // marker: this is a projection, not a persisted row
    employee: penalty.employee,
    severity: 'medium',
    incidentDate:  m.incidentDate,
    effectiveDate: m.effectiveDate,
    status: m.status,
    naturalKey: m.naturalKey,
    context: m.context,
    detectorMeta: m.detectorMeta,
    source: 'automatic',
    __synthetic: true,
  };
  const effect = {
    _id: `synthetic:${penalty._id}:eff`,
    incidentId: incident._id,
    actionType: m.actionType,
    employee: penalty.employee,
    status: incident.status,
    effectiveDate: m.effectiveDate,
    amount:  m.amount,
    marks:   m.marks,
    percent: m.percent,
    penaltyId: penalty._id,
    __synthetic: true,
  };
  return { incident, effect };
};

module.exports = {
  project,
  mappingFor,
  naturalKeyFor,
  CATEGORY_TO_RULE,
  CATEGORY_TO_ACTION,
};
