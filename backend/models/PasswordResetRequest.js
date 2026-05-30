const mongoose = require('mongoose');

/**
 * PasswordResetRequest - HR-approved password reset workflow.
 *
 * Lifecycle:
 *   PENDING   -> employee submits "forgot password"
 *   APPROVED  -> HR approves, reset_token generated, email dispatched
 *   USED      -> employee uses the link, password updated (is_used=true)
 *   REJECTED  -> HR rejects (optional reason)
 *
 * Tokens:
 *   - requestToken: opaque ID for internal tracking
 *   - resetToken:  64-char hex used in the one-time reset URL.  Created
 *                  only at approval time.  Has an expiry (default 30
 *                  minutes) and is invalidated after a single use.
 */
const passwordResetRequestSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeEmail: { type: String, required: true, lowercase: true, trim: true, index: true },

    requestToken: { type: String, required: true, unique: true },

    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED', 'USED'],
      default: 'PENDING',
      index: true,
    },

    requestedAt: { type: Date, default: Date.now },

    approvedAt: { type: Date },
    approvedByHrId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    rejectedAt: { type: Date },
    rejectReason: { type: String, default: '' },

    resetToken: { type: String, index: true, sparse: true },
    resetTokenExpiry: { type: Date },

    isUsed: { type: Boolean, default: false, index: true },
    usedAt: { type: Date },

    emailSentAt: { type: Date },

    // For light rate-limit + abuse audit
    requestIp: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true }
);

passwordResetRequestSchema.index({ employeeEmail: 1, status: 1 });

module.exports = mongoose.model('PasswordResetRequest', passwordResetRequestSchema);
