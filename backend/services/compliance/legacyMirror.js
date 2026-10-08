/**
 * legacyMirror.js -- resolves the legacy `Penalty` row(s) that mirror a
 * v2 incident, so cancel / waive / recover keep the pre-v2 surfaces
 * (employee `PenaltyWarnings` via /penalties/mine, Final Marks via
 * penaltyMath) consistent with the v2 state.
 *
 * Why this exists: the legacy penaltyEngine and the v2 tick run
 * side by side and each creates its own record for the same event.
 * Only `performance_lock` ever got an explicit `effect.penaltyId` link
 * (actionEngine's BC shim).  For missed_submission / dependency_pending
 * the legacy Penalty was never linked, so cancelling the v2 incident
 * left it `active` -- the employee kept seeing it and Final Marks kept
 * being deducted.
 *
 * Resolution order:
 *   1. effect.penaltyId (explicit link), when present.
 *   2. The legacy natural key the engines share:
 *        (employee, category, targetDate = incident.incidentDate
 *         [, submission for missed submissions]).
 *
 * Read-only: callers perform the status update themselves, guarded by
 * `status NOT IN (cancelled, resolved, expired)` so repeats are no-ops.
 */
const Penalty = require('../../models/Penalty');
const ComplianceIncident = require('../../models/ComplianceIncident');

const RULE_TO_CATEGORIES = Object.freeze({
  missed_submission_v2: ['missed_submission', 'absent_submission'],
  dependency_pending_v2: ['dependency_pending'],
  performance_lock_v2: ['performance_lock'],
  attendance_manual_v2: ['attendance_manual'],
});

const TERMINAL = ['cancelled', 'resolved', 'expired'];

/**
 * @param {{effect:Object, incident?:Object, session?:Object}} args
 * @returns {Promise<Array>} Penalty _ids (may be empty)
 */
const penaltyIdsFor = async ({ effect, incident = null, session = null }) => {
  const ids = [];
  if (effect && effect.penaltyId) ids.push(effect.penaltyId);

  let inc = incident;
  if (!inc && effect && effect.incidentId) {
    const q = ComplianceIncident.findById(effect.incidentId);
    if (session) q.session(session);
    inc = await q.lean();
  }
  const categories = inc && RULE_TO_CATEGORIES[inc.ruleCode];
  if (!inc || !categories) return ids;

  const where = {
    employee: inc.employee,
    category: { $in: categories },
    targetDate: inc.incidentDate,
    probable: false,
  };
  const sub = inc.context && inc.context.submissionId;
  if (inc.ruleCode === 'missed_submission_v2' && sub) where.submission = sub;
  const q = Penalty.find(where).select('_id');
  if (session) q.session(session);
  const rows = await q.lean();
  for (const r of rows) {
    if (!ids.some((x) => String(x) === String(r._id))) ids.push(r._id);
  }
  return ids;
};

module.exports = { penaltyIdsFor, TERMINAL, RULE_TO_CATEGORIES };
