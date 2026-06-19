const mongoose = require('mongoose');

/**
 * AttendanceConfirmation
 *
 * Phase 29 — daily attendance confirmation record for employees whose
 * `attendanceMode === 'attendance_review'`.  An employee clicks
 * "Confirm Present" on a working day; a record lands in this collection
 * with `status='pending'` and `confirmedAt = now`.  HR / Super Admin
 * later opens the Attendance Reviews section and acts on it (Approve
 * Present / Mark Absent / Mark Half Day / Mark Leave), which flips the
 * record's `status` and writes an Attendance document so the existing
 * deriveAttendance / payroll pipelines see the finalised state.
 *
 * Intentionally a separate collection from Submission so the daily
 * submission pipeline + analytics stay completely untouched — this
 * record has no scoring, no points, no review marks.
 *
 * Unique key: (employee, date).
 */
const attendanceConfirmationSchema = new mongoose.Schema(
  {
    employee:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date:        { type: Date, required: true, index: true },

    // Employee confirms — sets confirmedAt, status flips to 'pending'.
    confirmedAt: { type: Date, default: Date.now },

    // Lifecycle:
    //   pending          — employee confirmed, waiting on HR review.
    //   approved_present — HR approved as Present.
    //   marked_absent    — HR marked Absent.
    //   marked_half_paid / marked_half_unpaid — HR marked Half Day.
    //   marked_paid_leave / marked_unpaid_leave — HR marked Leave.
    status: {
      type: String,
      enum: [
        'pending',
        'approved_present',
        'marked_absent',
        'marked_half_paid', 'marked_half_unpaid',
        'marked_paid_leave', 'marked_unpaid_leave',
      ],
      default: 'pending',
      index: true,
    },

    // Audit trail of the reviewer's action.
    reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt:  { type: Date },
    remarks:     { type: String, default: '' },
  },
  { timestamps: true },
);

attendanceConfirmationSchema.index({ employee: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('AttendanceConfirmation', attendanceConfirmationSchema);
