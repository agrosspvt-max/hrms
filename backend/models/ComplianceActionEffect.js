const mongoose = require('mongoose');

/**
 * ComplianceActionEffect -- one row per (incident, ruleAction,
 * effectiveDate).  Represents the concrete consequence that was
 * applied (marks removed, ₹ fined, LWP unit, etc.).  Ledgers hold the
 * running balance; this row is the "why" behind each ledger entry.
 *
 * `penaltyId` (nullable) links to the legacy Penalty row during
 * the dual-write phase.  Phase 9's `compliance.dualWrite` flag turns
 * the mirror-write off; new effects then leave `penaltyId` null.
 *
 * `ruleActionId` is the ObjectId of the specific action inside
 * ComplianceRule.actions[]; keeps waivers targeting-safe across
 * rule edits.
 */

const ledgerRefsSchema = new mongoose.Schema(
  {
    marks:      { type: mongoose.Schema.Types.ObjectId, ref: 'MarksLedger',       default: null },
    financial:  { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialLedger',   default: null },
    percentage: { type: mongoose.Schema.Types.ObjectId, ref: 'PercentageLedger',  default: null },
    attendance: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceLedger',  default: null },
  },
  { _id: false },
);

const complianceActionEffectSchema = new mongoose.Schema(
  {
    incidentId:   { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceIncident', required: true, index: true },
    ruleId:       { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRule',     required: true },
    ruleActionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    actionType:   { type: String, required: true, trim: true, index: true },

    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    status: {
      type: String,
      enum: ['pending','active','resolved','waived','cancelled','expired'],
      default: 'pending',
      index: true,
    },

    effectiveDate: { type: Date, required: true, index: true },
    expiryDate:    { type: Date, default: null },

    amount:         { type: Number, default: 0, min: 0 },   // financial_fine
    marks:          { type: Number, default: 0, min: 0 },   // marks-flavour actions
    percent:        { type: Number, default: 0, min: 0 },   // percent_reduction
    attendanceUnit: { type: Number, default: 0, min: 0 },   // half=0.5 / full=1.0
    taskRef:        { type: mongoose.Schema.Types.Mixed, default: {} },

    penaltyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Penalty', default: null },

    ledgerRefs: { type: ledgerRefsSchema, default: () => ({}) },

    resolvedAt:     { type: Date, default: null },
    resolvedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedReason: { type: String, default: '', trim: true },

    cancelledAt:  { type: Date, default: null },
    cancelledBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: '', trim: true },

    waivedAt:     { type: Date, default: null },
    waivedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    waiverId:     { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceWaiver', default: null },
    waiverReason: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

// One effect per (incident, ruleAction, effectiveDate).  Recurring
// actions re-fire on subsequent days with a new effectiveDate -- the
// natural-key covers both single-shot and recurring cases.
complianceActionEffectSchema.index(
  { incidentId: 1, ruleActionId: 1, effectiveDate: 1 },
  { unique: true, name: 'compliance_effect_natural_key' },
);
complianceActionEffectSchema.index({ penaltyId: 1 }, { sparse: true });
complianceActionEffectSchema.index({ employee: 1, status: 1 });

module.exports = mongoose.models.ComplianceActionEffect
  || mongoose.model('ComplianceActionEffect', complianceActionEffectSchema);
