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
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },

    // Resolved by HR
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
    hrNote: { type: String, trim: true },

    // If approved but employee has no balance left, mark as unpaid.
    paid: { type: Boolean, default: true },
  },
  { timestamps: true }
);

leaveSchema.index({ employee: 1, fromDate: 1, toDate: 1 });

module.exports = mongoose.model('Leave', leaveSchema);
