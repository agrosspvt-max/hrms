/**
 * acknowledgementService.js -- employee acknowledgement of a compliance case.
 *
 * Belongs to the INCIDENT (the case the employee is told about), not to each
 * effect: one acknowledgement covers all of the incident's effects, matching
 * the single legacy Penalty.acknowledgedAt.
 *
 * Rules
 *   - Only the incident's own employee may acknowledge (HR sees the status on
 *     the incident; they do not acknowledge on someone's behalf).
 *   - Allowed on active | resolved incidents.  Candidate (not yet in force),
 *     cancelled, waived and expired incidents cannot be acknowledged.
 *   - Idempotent and race-safe: the first call wins an atomic compare-and-set
 *     on `acknowledgedAt: null`; later / concurrent calls return the stored
 *     acknowledgement unchanged and write NO second event or audit row.
 */
const ComplianceIncident = require('../../../models/ComplianceIncident');
const lifecycle = require('../lifecycle');
const { logAudit } = require('../../../utils/audit');

const ACKNOWLEDGEABLE = Object.freeze(['active', 'resolved']);

const _emit = async (args) => {
  try {
    const ComplianceEvent = require('../../../models/ComplianceEvent');
    await ComplianceEvent.create({ ts: new Date(), payload: {}, ...args });
  } catch (e) { console.error('[compliance/ack] event emit failed:', e.message); }
};

const acknowledge = async ({ incidentId, user, req = null }) => {
  if (!incidentId) throw new Error('acknowledge: incidentId is required.');
  if (!user || !user._id) throw new lifecycle.LifecycleError('Authentication required.', { httpStatus: 401, code: 'unauthenticated' });

  const inc = await ComplianceIncident.findById(incidentId).lean();
  if (!inc) throw new lifecycle.LifecycleError('Incident not found.', { httpStatus: 404, code: 'not_found' });
  if (String(inc.employee) !== String(user._id)) {
    throw new lifecycle.LifecycleError('Only the employee concerned can acknowledge this incident.', { httpStatus: 403, code: 'forbidden' });
  }
  if (inc.acknowledgedAt) return { ...inc, alreadyAcknowledged: true };
  if (!ACKNOWLEDGEABLE.includes(inc.status)) {
    throw new lifecycle.LifecycleError(`Cannot acknowledge: the incident is ${inc.status}.`, { code: `incident_${inc.status}` });
  }

  const won = await ComplianceIncident.findOneAndUpdate(
    { _id: incidentId, acknowledgedAt: null, status: { $in: ACKNOWLEDGEABLE } },
    { $set: { acknowledgedAt: new Date(), acknowledgedBy: user._id } },
    { new: true },
  );
  if (!won) {
    const cur = await ComplianceIncident.findById(incidentId).lean();
    if (cur && cur.acknowledgedAt) return { ...cur, alreadyAcknowledged: true };     // lost the race
    throw new lifecycle.LifecycleError(`Cannot acknowledge: the incident is ${cur ? cur.status : 'gone'}.`, { code: 'state_changed' });
  }

  await _emit({
    employee: inc.employee, incidentId: inc._id, kind: 'incident_acknowledged',
    payload: { status: inc.status }, actor: user._id,
  });
  if (req) {
    logAudit(req, {
      action: 'compliance.incident.acknowledge', targetType: 'ComplianceIncident', targetId: inc._id,
      targetLabel: inc.ruleCode, meta: { employee: String(inc.employee), status: inc.status },
    });
  }
  return won.toObject ? won.toObject() : { ...won };
};

module.exports = { acknowledge, ACKNOWLEDGEABLE };
