/**
 * services/reminder/service.js
 *
 * Domain-facing façade over the existing reminders helpers.  Every
 * controller / subscriber should import from HERE rather than the
 * lower-level services/reminders.js so we have a single place to
 * extend later (e.g. adding a bulk operation, or a policy check).
 */
const reminders = require('../reminders');

module.exports = {
  createOrUpdate:   reminders.createOrUpdate,
  applyAction:      reminders.applyAction,
  resolveByEntity:  reminders.resolveByEntity,
  hashFor:          reminders.hashFor,
};
