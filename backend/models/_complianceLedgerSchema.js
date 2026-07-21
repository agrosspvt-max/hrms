const mongoose = require('mongoose');

/**
 * _complianceLedgerSchema.js -- builder shared by all four
 * compliance ledgers (Marks / Financial / Percentage / Attendance).
 *
 * Every ledger row is append-only.  `runningBalance` is materialised
 * on write for O(1) reads; a nightly reconciler re-derives the
 * previous day and alerts on drift.
 *
 * Direction convention:
 *    -1  the entry represents a debit against the employee
 *    +1  the entry represents a credit (recovery / waiver / refund)
 *
 * `quantity` is always non-negative; the sign is carried by
 * `direction` so index queries can pivot on `direction` cheaply.
 */

const build = (name) => {
  const schema = new mongoose.Schema(
    {
      employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      date:     { type: Date, required: true, index: true },
      direction:{ type: Number, enum: [-1, 1], required: true },
      quantity: { type: Number, required: true, min: 0 },
      runningBalance: { type: Number, default: 0 },
      type: {
        type: String,
        enum: ['action', 'recovery', 'waiver', 'manual', 'salary_deduct', 'reconciliation'],
        required: true,
      },
      reason: { type: String, default: '', trim: true },

      // Sparse indexes on refIncidentId + refEffectId are declared via
      // schema.index() below, so `index: true` here would produce a
      // duplicate-index warning at boot.
      refIncidentId: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceIncident', default: null },
      refEffectId:   { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceActionEffect', default: null },
      refRecoveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRecovery', default: null },
      refWaiverId:   { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceWaiver', default: null },

      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true },
  );

  schema.index({ employee: 1, date: 1, createdAt: 1 });
  schema.index({ refIncidentId: 1 }, { sparse: true });
  schema.index({ refEffectId: 1 }, { sparse: true });

  return mongoose.models[name] || mongoose.model(name, schema);
};

module.exports = { build };
