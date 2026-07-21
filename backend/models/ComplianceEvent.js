const mongoose = require('mongoose');

/**
 * ComplianceEvent -- append-only timeline stream.  Every business
 * transition emits one row.  Employee timeline UI + HR dashboards
 * read this stream; nothing writes back to it.
 *
 * Kind enum matches services/events/registry.js `compliance.*` codes
 * so a consumer can freely cross-reference.
 */

const complianceEventSchema = new mongoose.Schema(
  {
    employee:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    incidentId: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceIncident', default: null, index: true },
    ts:         { type: Date, required: true, default: Date.now },
    kind: {
      type: String,
      enum: [
        'incident_created',
        'incident_effective',
        'action_applied',
        'notification_sent',
        'waiver_requested',
        'waiver_decided',
        'recovery_applied',
        'incident_resolved',
        'incident_cancelled',
        'escalated',
        'rule_updated',
      ],
      required: true,
    },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    actor:   { type: mongoose.Schema.Types.Mixed, default: 'system' }, // ObjectId or 'system'
  },
  { timestamps: false },
);

complianceEventSchema.index({ employee: 1, ts: -1 });
complianceEventSchema.index({ incidentId: 1, ts: 1 });

module.exports = mongoose.models.ComplianceEvent
  || mongoose.model('ComplianceEvent', complianceEventSchema);
