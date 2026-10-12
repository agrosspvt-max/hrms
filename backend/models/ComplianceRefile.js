const mongoose = require('mongoose');

/**
 * ComplianceRefile -- explicit authorization for an employee to re-submit a
 * previously missed day ("re-file grant").
 *
 * It is NOT a waiver (it reverses nothing), NOT a cancellation and NOT a
 * recovery.  It answers one question: "may this employee submit THIS missed
 * submission after its day has passed?"  The legacy equivalent was
 * `Penalty.reopenRequest` on the missed-day Penalty.
 *
 * Identity is the missed-day Submission stub (`submissionId`: one row per
 * employee + template + date), so a grant can never authorize another
 * employee, another date or another task.  It is deliberately independent of
 * ComplianceIncident (an incident may not exist when the rule is off);
 * `incidentId` is only a convenience link when one does.
 *
 * State machine
 *   pending  --approve-->  approved --submit--> consumed   (one-time, = legacy 'completed')
 *   pending  --reject-->   rejected
 *   pending|approved --revoke--> revoked
 * rejected / consumed / revoked are terminal; a NEW request may follow a
 * rejected or revoked one (as in the legacy flow).
 *
 * At most ONE open (pending|approved) row per stub: `open` is true only in
 * those two states and a partial unique index enforces it, so concurrent
 * identical requests collapse and an approval cannot create a second grant.
 */
const complianceRefileSchema = new mongoose.Schema(
  {
    employee:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true, index: true },
    targetDate:   { type: Date, required: true, index: true },
    incidentId:   { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceIncident', default: null },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'consumed', 'revoked'],
      default: 'pending',
      index: true,
    },
    open: { type: Boolean, default: true },

    source:      { type: String, enum: ['employee', 'hr'], required: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, default: Date.now },
    reason:      { type: String, default: '', trim: true },

    decidedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt:      { type: Date, default: null },
    decisionNote:   { type: String, default: '', trim: true },
    // Recovery mode HR picked when sending the day back (same three modes as
    // ComplianceRecovery / the legacy Penalty.evaluationMode).
    evaluationMode: { type: String, enum: ['', 'restore', 'information', 'neutral'], default: '' },

    consumedAt: { type: Date, default: null },
    consumedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    revokedAt:    { type: Date, default: null },
    revokedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    revokeReason: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

complianceRefileSchema.index(
  { submissionId: 1 },
  { unique: true, partialFilterExpression: { open: true }, name: 'compliance_refile_one_open_per_submission' },
);
complianceRefileSchema.index({ employee: 1, targetDate: 1 });

module.exports = mongoose.models.ComplianceRefile
  || mongoose.model('ComplianceRefile', complianceRefileSchema);
