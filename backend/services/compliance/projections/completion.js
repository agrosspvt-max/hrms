/**
 * completion.js -- Compliance-based completion-score adjustment rows.
 *
 * Returns Penalty-shaped rows ({employee, category, status, completionPercent,
 * evaluationPeriod}) for `penaltyMath.applyCompletionAdjustment`, so the overlap
 * / stacking math stays in one place.  Counts only ACTIVE `percent_reduction`
 * effects of completion-adjustment rules (effectShape.COMPLETION_ADJUSTMENT_RULE_CODES),
 * matching the legacy rule that only manual completion adjustments touch the
 * percentage.  Cancelled / waived / resolved / expired effects drop out.
 */
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const { COMPLETION_ADJUSTMENT_RULE_CODES, toPenaltyShape } = require('./effectShape');

const fetchAdjustments = async ({ employeeIds, now = new Date() }) => {
  const effects = await ComplianceActionEffect.find({
    employee: { $in: employeeIds },
    actionType: 'percent_reduction',
    ruleCode: { $in: COMPLETION_ADJUSTMENT_RULE_CODES },
    status: 'active',
  }).lean();
  return effects
    .map((e) => ({ ...toPenaltyShape(e, now), category: 'completion_adjustment' }))
    .filter((p) => p.status === 'active');
};

module.exports = { fetchAdjustments };
