const mongoose = require('mongoose');

/**
 * ComplianceRecovery -- an HR-initiated recovery / restore action.
 * Reuses the existing `performanceRecovery.applyEvaluationMode`
 * modes (`restore` / `information` / `neutral`) so semantics stay
 * identical for legacy consumers.
 *
 * A recovery may target the whole incident or a subset of effect
 * ids.  `auditRefIds` links to AuditLog rows so a trace scanner
 * can jump to the underlying entries.
 */

const complianceRecoverySchema = new mongoose.Schema(
  {
    incidentId: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceIncident', required: true, index: true },
    employee:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    effectIds:  { type: [mongoose.Schema.Types.ObjectId], default: [] },

    mode:    { type: String, enum: ['restore','information','neutral'], required: true },
    reason:  { type: String, default: '', trim: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    auditRefIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true },
);

complianceRecoverySchema.index({ createdAt: -1 });

module.exports = mongoose.models.ComplianceRecovery
  || mongoose.model('ComplianceRecovery', complianceRecoverySchema);
