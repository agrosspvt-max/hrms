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

    /**
     * Canonical effect -> Submission relationship (marks effects).  Set once at
     * creation by services/compliance/submissionLink (explicit id, else the
     * day's primary LIVE submission; never an arbitrary match).  Final Marks
     * are projected per submission from effects carrying this id.  `marks` on
     * a submission-scoped effect is the amount frozen at creation, exactly
     * like the legacy Penalty.penaltyMarks.
     */
    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', default: null },
    /** Denormalised rule code ("missed_submission_v2"); drives UI grouping and the
     *  completion-adjustment projection without a join. */
    ruleCode: { type: String, default: '', trim: true },

    /** Recovery mode stamped by recoveryService (same three values as the legacy
     *  Penalty.evaluationMode).  'restore' also records the marks given back. */
    evaluationMode: { type: String, enum: ['', 'restore', 'information', 'neutral'], default: '' },
    restoredMarks:  { type: Number, default: 0, min: 0 },

    /** Window a completion-percentage adjustment applies to (legacy
     *  Penalty.evaluationPeriod).  Absent => applied at full weight. */
    evaluationPeriod: {
      startDate: { type: Date, default: null },
      endDate:   { type: Date, default: null },
    },

    /**
     * Payroll lifecycle of a financial_fine.  Independent of `status`:
     *   pending  -- owed, not yet taken into a salary slip
     *   deducted -- HR included it in a slip (salarySlipId recorded; one-way)
     *   '' (empty) for non-financial effects.
     * `refundDue` is raised if an already-deducted fine is later cancelled /
     * waived / recovered, so HR can refund it; nothing refunds automatically.
     */
    payroll: {
      status:        { type: String, enum: ['', 'pending', 'deducted'], default: '' },
      salarySlipId:  { type: mongoose.Schema.Types.ObjectId, ref: 'SalarySlip', default: null },
      salaryMonth:   { type: String, default: '' },
      deductedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      deductedAt:    { type: Date, default: null },
      refundDue:     { type: Boolean, default: false },
    },

    /**
     * Business identity of a RECURRING effect produced by an AUTOMATIC
     * incident: rule action + employee + effective day.  Detectors raise a
     * new day-scoped incident every day a condition persists, so several
     * still-active incidents can exist for the same employee; the daily
     * recurring effect belongs to the employee-day, not to each incident.
     * Null for one-shot actions and manual incidents (separate events).
     */
    recurringKey: { type: String, default: null },

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
// Cross-incident guard for recurring effects (see recurringKey above).
// Partial, so historical rows without the field never collide.
complianceActionEffectSchema.index(
  { recurringKey: 1 },
  { unique: true, partialFilterExpression: { recurringKey: { $type: 'string' } }, name: 'compliance_effect_recurring_key' },
);
complianceActionEffectSchema.index({ penaltyId: 1 }, { sparse: true });
complianceActionEffectSchema.index({ submissionId: 1, status: 1 }, { sparse: true });
complianceActionEffectSchema.index({ 'payroll.status': 1, employee: 1 }, { sparse: true });
complianceActionEffectSchema.index({ employee: 1, status: 1 });

module.exports = mongoose.models.ComplianceActionEffect
  || mongoose.model('ComplianceActionEffect', complianceActionEffectSchema);
