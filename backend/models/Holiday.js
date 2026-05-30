const mongoose = require('mongoose');

/**
 * A company-wide holiday.  Dates are stored at UTC midnight (the same
 * normalisation Submission uses) so equality comparisons work cleanly.
 *
 * Effects:
 *   - Daily submissions are NOT generated on holidays.
 *   - Employees cannot submit work on holidays (server-enforced).
 *   - Attendance for that day is labelled 'holiday' and contributes
 *     neither to working days nor to absent days.
 *   - Salary calculation skips holidays in the working-days denominator,
 *     so the in-hand salary stays whole even with multiple holidays.
 */
const holidaySchema = new mongoose.Schema(
  {
    date: { type: Date, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    type: {
      type: String,
      enum: ['national', 'company', 'optional'],
      default: 'company',
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Holiday', holidaySchema);
