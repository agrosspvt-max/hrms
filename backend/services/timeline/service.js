/**
 * services/timeline/service.js
 *
 * Domain-facing façade over services/timeline.js.  Timeline is a
 * derived, read-only projection; this file exists so future
 * additions (new entity types, richer deep links) live in one
 * place instead of leaking into controllers.
 */
const timeline = require('../timeline');

module.exports = {
  getFor:       timeline.getFor,
  deepLinkFor:  timeline.deepLinkFor,
};
