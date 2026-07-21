/**
 * dates.js -- date helpers scoped to the compliance engine.
 *
 * Only two things live here: (a) computing the Effective Date for a
 * given incident + rule (respects trigger.evaluationDelayDays), and
 * (b) a small utility for adding calendar days that always returns
 * a UTC-midnight anchor.  Working-day math continues to live in
 * `utils/workingDays.js` -- we call it directly when needed.
 */

const { startOfDay, addDays } = require('../../utils/dateHelpers');

/**
 * Effective date = incidentDate + rule.trigger.evaluationDelayDays.
 * A rule with delay 0 becomes effective the same day it is detected
 * (matches the existing `dependency_pending` renewal behaviour); a
 * delay of 1 gives the day-after semantics used by `missed_submission`.
 * Returns a UTC-midnight Date so downstream comparisons match every
 * other date column in the system.
 */
const computeEffectiveDate = (rule, incidentDate) => {
  const base = startOfDay(incidentDate);
  const days = Math.max(0, Number(rule?.trigger?.evaluationDelayDays) || 0);
  return startOfDay(addDays(base, days));
};

module.exports = { computeEffectiveDate };
