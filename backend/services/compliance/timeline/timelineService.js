/**
 * timelineService.js -- read helpers over the ComplianceEvent stream.
 *
 * Employee timeline: newest first, filterable by incident + date
 * window.  Every entry carries kind + payload + actor.  Zero writes.
 */

const ComplianceEvent = require('../../../models/ComplianceEvent');

const forEmployee = async ({ employeeId, from = null, to = null, limit = 200 }) => {
  if (!employeeId) throw new Error('timeline.forEmployee: employeeId is required.');
  const where = { employee: employeeId };
  if (from || to) {
    where.ts = {};
    if (from) where.ts.$gte = new Date(from);
    if (to)   where.ts.$lte = new Date(to);
  }
  return ComplianceEvent.find(where)
    .sort({ ts: -1 })
    .limit(Math.max(1, Math.min(1000, Number(limit) || 200)))
    .lean();
};

const forIncident = async ({ incidentId, limit = 500 }) => {
  if (!incidentId) throw new Error('timeline.forIncident: incidentId is required.');
  return ComplianceEvent.find({ incidentId })
    .sort({ ts: 1 })
    .limit(Math.max(1, Math.min(1000, Number(limit) || 500)))
    .lean();
};

module.exports = { forEmployee, forIncident };
