const mongoose = require('mongoose');

/**
 * ComplianceRule -- the single source of truth for every automated
 * (and manual) compliance rule the org runs.  Every rule is:
 *   - configurable  (thresholds, delays, actions, notifications, scope)
 *   - versioned     (bumped on every edit -- snapshot stored on each
 *                    ComplianceIncident so history is stable)
 *   - detector-backed (a code in DetectorRegistry decides when the
 *                    rule fires)
 *
 * Actions are stored in-line as an ORDERED array.  Each action carries
 * a stable ObjectId so a ComplianceWaiver can target a single action
 * without ambiguity.
 */

const _actionTypes = [
  'zero_daily_marks',
  'add_daily_total',
  'half_day_lwp',
  'full_day_lwp',
  'financial_fine',
  'percent_reduction',
  'fixed_marks_reduction',
  'warning',
  'notification',
  'manager_notification',
  'performance_lock',
  'suspend_incentive',
  'custom',
];

const _marksStrategies = [
  'last_n_avg',
  'template_default',
  'department_avg',
  'admin_defined',
];

const complianceRuleActionSchema = new mongoose.Schema(
  {
    type:    { type: String, enum: _actionTypes, required: true },
    enabled: { type: Boolean, default: true },
    // Free-form so future action types don't need a schema migration.
    // Executors validate the fields they read.
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: true },
);

const notificationBlockSchema = new mongoose.Schema(
  {
    employee: { type: Boolean, default: false },
    manager:  { type: Boolean, default: false },
    hr:       { type: Boolean, default: false },
    template: { type: String, default: '' },
  },
  { _id: false },
);

const complianceRuleSchema = new mongoose.Schema(
  {
    code:        { type: String, required: true, unique: true, trim: true },
    name:        { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    category: {
      type: String,
      enum: ['submission', 'dependency', 'attendance', 'conduct', 'custom'],
      required: true,
      index: true,
    },
    detector: { type: String, required: true, trim: true },
    enabled:  { type: Boolean, default: false, index: true },
    version:  { type: Number, default: 1, min: 1 },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },

    trigger: {
      evaluationDelayDays: { type: Number, default: 0, min: 0 },
      thresholdDays:       { type: Number, default: 0, min: 0 },
      workingDaysOnly:     { type: Boolean, default: true },
      criticalTasksOnly:   { type: Boolean, default: false },
      dedupeWindowHours:   { type: Number, default: 24, min: 1 },
      cutoffTime:          { type: String, default: '' }, // 'HH:MM' for late_reporting
    },

    scope: {
      departments:  { type: [mongoose.Schema.Types.ObjectId], default: [] },
      designations: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      templates:    { type: [mongoose.Schema.Types.ObjectId], default: [] },
      employeeIds:  { type: [mongoose.Schema.Types.ObjectId], default: [] },
    },

    actions: { type: [complianceRuleActionSchema], default: [] },

    notifications: {
      onIncident:   { type: notificationBlockSchema, default: () => ({}) },
      onEffective:  { type: notificationBlockSchema, default: () => ({}) },
      onEscalation: { type: notificationBlockSchema, default: () => ({}) },
      onRecovery:   { type: notificationBlockSchema, default: () => ({}) },
      onWaiver:     { type: notificationBlockSchema, default: () => ({}) },
    },

    recovery: {
      allowed:              { type: Boolean, default: true },
      modes: {
        type: [{ type: String, enum: ['restore', 'information', 'neutral'] }],
        default: ['restore', 'information', 'neutral'],
      },
      requiredEvidence:     { type: Boolean, default: false },
      autoResolveOnSubmit:  { type: Boolean, default: false },
      autoResolveOnResolve: { type: Boolean, default: false },
    },

    waiver: {
      allowed:        { type: Boolean, default: true },
      partialAllowed: { type: Boolean, default: true },
      approverRoles: {
        type: [{ type: String, enum: ['hr', 'super_admin', 'hod'] }],
        default: ['hr', 'super_admin'],
      },
      reasonRequired: { type: Boolean, default: true },
    },

    escalation: {
      type: [new mongoose.Schema(
        {
          afterDays:  { type: Number, required: true, min: 1 },
          actionsAdd: { type: [complianceRuleActionSchema], default: [] },
        },
        { _id: true },
      )],
      default: [],
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

complianceRuleSchema.index({ enabled: 1, category: 1 });

module.exports = mongoose.models.ComplianceRule
  || mongoose.model('ComplianceRule', complianceRuleSchema);

module.exports.ACTION_TYPES = _actionTypes;
module.exports.MARKS_STRATEGIES = _marksStrategies;
