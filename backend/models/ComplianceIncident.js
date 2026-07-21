const mongoose = require('mongoose');

/**
 * ComplianceIncident -- one per violation.  Immutable identity via
 * `naturalKey` + partial-unique index on {source:'automatic'} so
 * automated detectors are safely re-runnable.
 *
 * Two dates:
 *   incidentDate   -- when the violation happened.
 *   effectiveDate  -- when consequences begin (incidentDate + rule.trigger.evaluationDelayDays).
 *
 * `context` is a small SCALAR snapshot -- never a foreign-key soup.
 * Actions and ledgers link back via `incidentId`.
 */

const contextSchema = new mongoose.Schema(
  {
    submissionId:  { type: mongoose.Schema.Types.ObjectId, default: null },
    templateId:    { type: mongoose.Schema.Types.ObjectId, default: null },
    templateTitle: { type: String, default: '' },
    assignmentId:  { type: mongoose.Schema.Types.ObjectId, default: null },
    scheduleLabel: { type: String, default: '' },
    workDate:      { type: Date,   default: null },
    dependencyIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    taskId:        { type: mongoose.Schema.Types.ObjectId, default: null },
    taskTitle:     { type: String, default: '' },
    departmentId:  { type: mongoose.Schema.Types.ObjectId, default: null },
    designationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const complianceIncidentSchema = new mongoose.Schema(
  {
    ruleId:      { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRule', required: true, index: true },
    ruleVersion: { type: Number, required: true, min: 1 },
    ruleCode:    { type: String, required: true, trim: true },
    employee:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    severity:    { type: String, enum: ['low','medium','high','critical'], default: 'medium' },

    incidentDate:  { type: Date, required: true, index: true },
    effectiveDate: { type: Date, required: true, index: true },

    status: {
      type: String,
      enum: ['candidate', 'active', 'resolved', 'waived', 'cancelled', 'expired'],
      default: 'candidate',
      index: true,
    },

    naturalKey: { type: String, required: true, trim: true },
    context:    { type: contextSchema, default: () => ({}) },
    detectorMeta: { type: mongoose.Schema.Types.Mixed, default: {} },

    source:    { type: String, enum: ['automatic','manual'], default: 'automatic', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    cancelledAt:  { type: Date, default: null },
    cancelledBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: '', trim: true },

    waivedAt: { type: Date, default: null },
    waivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    waiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceWaiver', default: null },
  },
  { timestamps: true },
);

// Idempotency: automatic detectors are safely re-runnable.
complianceIncidentSchema.index(
  { naturalKey: 1 },
  {
    unique: true,
    partialFilterExpression: { source: 'automatic' },
    name: 'compliance_incident_natural_key_auto',
  },
);
complianceIncidentSchema.index({ employee: 1, incidentDate: -1 });
complianceIncidentSchema.index({ ruleId: 1, status: 1 });
complianceIncidentSchema.index({ effectiveDate: 1, status: 1 });
// Prod-patch H5 -- resolveIncidentsBySubmission (called from
// penaltyEngine.resolveAbsentSubmissionOnSubmit on every submit
// event) filters on `context.submissionId`.  Without this sparse
// index the query devolves to a collection scan as the incident
// collection grows.  Sparse: incidents whose context has no
// submissionId (e.g. manual conduct incidents) don't waste
// index entries.
complianceIncidentSchema.index({ 'context.submissionId': 1 }, { sparse: true });

module.exports = mongoose.models.ComplianceIncident
  || mongoose.model('ComplianceIncident', complianceIncidentSchema);
