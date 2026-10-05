const mongoose = require('mongoose');

/**
 * Disclosure
 *
 * Employee self-disclosure (Mistake / Exception / Other) filed from the
 * daily-task screen.  Day-level, like DailyReflection: ONE record per
 * (employee, business date).  `submission` points at the day's primary
 * Submission so the record can never float free of its work context;
 * nothing from the submission is copied here.
 *
 * Recording / review only -- no penalty, performance, compliance,
 * financial or attendance effect is derived from this collection.
 *
 * Conditional fields (enforced in services/disclosure.js, not here):
 *   mistake   -> details, correctable, corrected (only when correctable)
 *   exception -> details, authorizedBy
 *   other     -> details
 * Non-applicable fields are stored as null / '' so a type change can
 * never leave stale values behind.
 */
const disclosureSchema = new mongoose.Schema(
  {
    employee:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // UTC-midnight business date, identical to Submission.date.
    date:       { type: Date, required: true },
    submission: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true },
    type:       { type: String, enum: ['mistake', 'exception', 'other'], required: true },
    details:    { type: String, required: true, trim: true, maxlength: 2000 },
    correctable:  { type: Boolean, default: null },
    corrected:    { type: Boolean, default: null },
    authorizedBy: { type: String, default: '', trim: true, maxlength: 200 },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// One disclosure per employee per day; also serves the employee filter.
disclosureSchema.index({ employee: 1, date: 1 }, { unique: true });
// HR page: date-ordered listing and date + type filtering.
disclosureSchema.index({ date: -1 });
disclosureSchema.index({ type: 1, date: -1 });

module.exports = mongoose.model('Disclosure', disclosureSchema);
