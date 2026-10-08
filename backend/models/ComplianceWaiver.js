const mongoose = require('mongoose');

/**
 * ComplianceWaiver -- HR (or employee-initiated + HR-approved) waiver
 * of an incident or one/more of its ActionEffects.  `scope:'full'`
 * targets every effect; `scope:'partial'` targets only `effectIds`.
 *
 * Auto-approval is possible (e.g. rule policy says employee can
 * always cancel their own pending manual incident).
 */

const complianceWaiverSchema = new mongoose.Schema(
  {
    incidentId: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceIncident', required: true, index: true },
    employee:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    scope:      { type: String, enum: ['full','partial'], required: true },
    effectIds:  { type: [mongoose.Schema.Types.ObjectId], default: [] },
    reason:     { type: String, default: '', trim: true },
    evidenceUrl:{ type: String, default: '' },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, required: true, default: Date.now },

    status: {
      type: String,
      enum: ['pending','approved','rejected','auto_approved'],
      default: 'pending',
      index: true,
    },

    decidedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt:    { type: Date, default: null },
    decisionNote: { type: String, default: '', trim: true },

    /** incident|scope|sorted effectIds.  Backs the partial unique index
     *  below so two identical *pending* requests cannot coexist (double
     *  click / retry).  Not unique across decided rows. */
    requestKey: { type: String, default: null },
  },
  { timestamps: true },
);

complianceWaiverSchema.index({ status: 1, requestedAt: -1 });
complianceWaiverSchema.index(
  { requestKey: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending', requestKey: { $type: 'string' } },
    name: 'compliance_waiver_pending_request_key',
  },
);

module.exports = mongoose.models.ComplianceWaiver
  || mongoose.model('ComplianceWaiver', complianceWaiverSchema);
