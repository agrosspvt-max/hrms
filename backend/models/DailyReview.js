const mongoose = require('mongoose');

/**
 * DailyReview
 *
 * Phase 5 refactor: discipline + idea marks moved from per-submission
 * to per (employee, date) so an employee with three assignments on
 * the same day is reviewed ONCE for soft skills.  HR / HOD still
 * grade work scoring (excel/sheet/task rows) per-submission via the
 * existing review pipeline.
 *
 *   disciplineMarks      / maxDisciplineMarks     (default 3)
 *   ideaMarks            / maxIdeaMarks           (default 2)
 *   disciplineNote, ideaFeedback                  HR / HOD remarks
 *   reviewedBy, reviewedAt, reviewStatus          finalise audit
 *   primarySubmissionId                           the submission that
 *                                                  carries the day's
 *                                                  daily marks in its
 *                                                  earnedPoints so
 *                                                  legacy analytics
 *                                                  sums stay correct.
 *
 * Unique key: (employee, date).
 */
const dailyReviewSchema = new mongoose.Schema(
  {
    employee:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date:               { type: Date, required: true, index: true },

    disciplineMarks:    { type: Number, default: 0, min: 0 },
    maxDisciplineMarks: { type: Number, default: 3, min: 0 },
    disciplineNote:     { type: String, default: '' },

    ideaMarks:          { type: Number, default: 0, min: 0 },
    maxIdeaMarks:       { type: Number, default: 2, min: 0 },
    ideaFeedback:       { type: String, default: '' },

    reviewedBy:         { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt:         { type: Date },
    reviewStatus:       { type: String, enum: ['pending', 'reviewed'], default: 'pending', index: true },

    // Submission that carries the day's discipline + idea in its own
    // disciplineMarks / ideaMarks fields, so the per-employee daily
    // total surfaces in legacy analytics queries that sum earnedPoints
    // without joining to this collection.  Deterministic: first
    // chronological submission by submittedAt.
    primarySubmissionId:{ type: mongoose.Schema.Types.ObjectId, ref: 'Submission' },
  },
  { timestamps: true },
);

dailyReviewSchema.index({ employee: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyReview', dailyReviewSchema);
