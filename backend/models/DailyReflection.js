const mongoose = require('mongoose');

/**
 * DailyReflection
 *
 * Phase 5 refactor: self-observation (rating + note) and the business
 * idea were previously stored per-submission.  An employee with three
 * assignments on the same day was filling the same form three times.
 *
 * This collection stores them ONCE per (employee, date).  All
 * submissions on that day reference the same reflection in HR's
 * review UI.
 *
 *   selfRating   0..10
 *   selfNote     free text
 *   idea         employee-submitted business idea / innovation
 *   lastEditedBy who last touched the row (employee themselves, or
 *                HR via Submission Control)
 *
 * Unique key: (employee, date).  Date is normalised to 00:00 UTC of
 * the local day by the controller before write so duplicates are
 * impossible.
 */
const dailyReflectionSchema = new mongoose.Schema(
  {
    employee:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date:      { type: Date, required: true, index: true },
    selfRating:{ type: Number, min: 0, max: 10 },
    selfNote:  { type: String, default: '' },
    idea:      { type: String, default: '' },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

dailyReflectionSchema.index({ employee: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyReflection', dailyReflectionSchema);
