const mongoose = require('mongoose');

const leaveSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    leaveType: {
      type: String,
      enum: ['casual', 'sick', 'paid', 'unpaid', 'other'],
      default: 'casual',
    },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    days: { type: Number, default: 1 }, // supports decimals (0.5 for half-day)
    reason: { type: String, trim: true },

    // Half-day leave is only allowed on single-day requests (fromDate==toDate).
    dayType: { type: String, enum: ['full', 'half'], default: 'full' },

    status: {
      type: String,
      // 'revoked' = HR pulled back an already-approved leave; balance
      // refunded, attendance auto-clears (since derive() only looks at
      // status='approved' rows).  Distinct from 'rejected' so analytics
      // can tell the two apart.
      enum: ['pending', 'approved', 'rejected', 'revoked'],
      default: 'pending',
      index: true,
    },

    // Resolved by HR
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
    hrNote: { type: String, trim: true },

    // Revocation audit
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date },
    revokeReason: { type: String, trim: true },

    // If approved but employee has no balance left, mark as unpaid.
    paid: { type: Boolean, default: true },

    /* ----------------------------------------------------------------
     * Phase 77 -- HR-controlled approval changes.
     *
     * HR may modify leaveType / fromDate / toDate BEFORE approving a
     * pending request.  When any of those three fields differ from
     * what the employee submitted, the original values are snapshotted
     * into `originalRequest` and `modifiedOnApproval:true` is stamped
     * so the audit trail and the employee-facing "Modified by HR"
     * chip can never be lost.  `originalRequest` is written EXACTLY
     * ONCE (on the first approval that mutates the request) and is
     * treated as immutable thereafter.  Subsequent post-approval
     * edits (proper Leave Edit flow) update the top-level fields but
     * leave `originalRequest` intact so the employee always sees the
     * initial request.
     * ---------------------------------------------------------------- */
    originalRequest: {
      leaveType:  { type: String, default: null },
      fromDate:   { type: Date, default: null },
      toDate:     { type: Date, default: null },
      dayType:    { type: String, default: null },
      days:       { type: Number, default: null },
      capturedAt: { type: Date, default: null },
    },
    modifiedOnApproval: { type: Boolean, default: false, index: true },
    modifiedBy:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    modifiedAt:         { type: Date, default: null },
    modificationNote:   { type: String, default: '' },
  },
  { timestamps: true }
);

leaveSchema.index({ employee: 1, fromDate: 1, toDate: 1 });

module.exports = mongoose.model('Leave', leaveSchema);
