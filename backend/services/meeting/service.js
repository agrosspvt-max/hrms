/**
 * services/meeting/service.js
 *
 * Meetings are Interactions with type=meeting.  This façade wraps
 * the small subset of Interaction operations that meeting-specific
 * controllers / subscribers care about.  No new logic -- keeps
 * meeting call-sites decoupled from the raw Interaction model.
 */
const Interaction = require('../../models/Interaction');

const listUpcomingForEmployee = async ({ employeeId, from, to }) => Interaction.find({
  'participants.employee': employeeId,
  type: 'meeting',
  'meeting.date': { $gte: from, $lte: to },
  status: { $ne: 'cancelled' },
}).sort({ 'meeting.date': 1 }).lean();

const countUpcomingForEmployee = async ({ employeeId, from, to }) => Interaction.countDocuments({
  'participants.employee': employeeId,
  type: 'meeting',
  'meeting.date': { $gte: from, $lte: to },
  status: { $ne: 'cancelled' },
});

module.exports = { listUpcomingForEmployee, countUpcomingForEmployee };
