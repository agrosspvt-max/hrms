const mongoose = require('mongoose');

/**
 * DailyReview
 *
 * Phase 5 refactor: idea (innovation) marks moved from per-submission
 * to per (employee, date) so an employee with three assignments on
 * the same day is reviewed ONCE for soft skills.  HR / HOD still
 * grade work scoring (excel/sheet/task rows) per-submission via the
 * existing review pipeline.
 *
 *   ideaMarks            / maxIdeaMarks           (default 2)
 *   ideaFeedback                                  HR / HOD remarks
 *   reviewedBy, reviewedAt, reviewStatus          finalise audit
 *   primarySubmissionId                           the submission that
 *                                                  carries the day's
 *                                                  daily marks so
 *                                                  legacy analytics
 *                                                  sums stay correct.
 *
 * Unique key: (employee, date).
 */
const dailyReviewSchema = new mongoose.Schema(
  {
    employee:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date:               { type: Date, required: true, index: true },

    ideaMarks:          { type: Number, default: 0, min: 0 },
    maxIdeaMarks:       { type: Number, default: 2, min: 0 },
    ideaFeedback:       { type: String, default: '' },

    reviewedBy:         { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt:         { type: Date },
    reviewStatus:       { type: String, enum: ['pending', 'reviewed'], default: 'pending', index: true },

    // Submission that carries the day's idea marks so the per-employee
    // daily total surfaces in legacy analytics queries.  Deterministic:
    // first chronological submission by submittedAt.
    primarySubmissionId:{ type: mongoose.Schema.Types.ObjectId, ref: 'Submission' },
  },
  { timestamps: true },
);

dailyReviewSchema.index({ employee: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyReview', dailyReviewSchema);
