const mongoose = require('mongoose');

/**
 * AuditLog - records sensitive HR / Super-Admin actions for traceability.
 *
 * Schema is intentionally generic - `meta` is a free-form payload so we
 * can capture whatever context a specific action needs (e.g. leave id,
 * decision, rejection reason, target user id).
 */
const auditLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actorRole: { type: String, index: true },
    action: { type: String, required: true, index: true }, // e.g. 'hr.create'
    targetType: { type: String, index: true },             // e.g. 'User', 'Leave', 'PasswordResetRequest'
    targetId: { type: mongoose.Schema.Types.ObjectId, index: true },
    targetLabel: { type: String, default: '' },            // human-readable (e.g. user email, leave dates)
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AuditLog', auditLogSchema);
