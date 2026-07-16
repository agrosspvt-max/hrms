/**
 * services/notification/service.js
 *
 * Phase-2 cleanup: domain-facing façade over the existing
 * notification helpers.  Callers (controllers, subscribers) that
 * need the "official" API import from HERE instead of the low-level
 * services/notifyEvents.js so we have a single place to swap out
 * the writer later if we ever need to.
 *
 * No new logic; every export is a re-export of the working helper.
 */
const notifyEvents = require('../notifyEvents');

module.exports = {
  // Single-source dedupe writer (the Phase-1 seam).
  upsertOne:                notifyEvents._upsertOne,
  // Notifier facades kept for backward compat.
  notifyPenalty:            notifyEvents.notifyPenalty,
  notifyLeaveApplied:       notifyEvents.notifyLeaveApplied,
  notifyLeaveDecision:      notifyEvents.notifyLeaveDecision,
  notifySalarySlipGenerated: notifyEvents.notifySalarySlipGenerated,
  notifyWorkAssigned:       notifyEvents.notifyWorkAssigned,
};
