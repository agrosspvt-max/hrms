const mongoose = require('mongoose');

/**
 * Event
 *
 * The new Events layer sits ALONGSIDE the existing Holiday model - the
 * Holiday flow + its work-generation rules continue to work unchanged.
 * Events add richer scheduling on top: typed (birthday / festival /
 * company / custom), audience-aware notifications, and an opt-in
 * `isHoliday` flag that the daily engine treats the same way as a Holiday.
 *
 * Work-generation rules (also enforced by the controller):
 *   - Birthdays      NEVER stop work generation.  isHoliday is forced false.
 *   - Festivals      Only stop work when isHoliday = true.
 *   - Company events Only stop work when isHoliday = true (a.k.a. "Work Stops").
 *   - Custom events  HR chooses isHoliday.
 *
 * Recurrence: `repeatYearly` re-fires the event on the same MM-DD each
 * year (the date helper expands occurrences over a query range).
 */
const eventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['birthday', 'festival', 'company_event', 'custom'],
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    // Inclusive on both ends.  startDate stores the canonical (first
    // occurrence) date; for recurring events the calendar expands.
    startDate: { type: Date, required: true, index: true },
    endDate: { type: Date },

    repeatYearly: { type: Boolean, default: false },
    // When true the daily engine treats this day as a holiday (no work
    // generation, attendance reads as 'holiday').  Forced false for
    // birthdays at the controller layer.
    isHoliday: { type: Boolean, default: false },

    // Notifications
    notify: { type: Boolean, default: true },
    notifyOffsets: { type: [Number], default: [0] }, // days before (0 = on event day)
    audience: {
      type: String,
      enum: ['everyone', 'department', 'designation', 'employees'],
      default: 'everyone',
    },
    audienceDepartment: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    audienceDesignation: { type: mongoose.Schema.Types.ObjectId, ref: 'Designation' },
    audienceEmployees: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },

    // For type='birthday', the employee whose birthday this is.  When the
    // event is auto-derived from User.dateOfBirth we never persist a row -
    // birthdays are computed by the controller from User records.
    linkedEmployee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

eventSchema.index({ startDate: 1, endDate: 1 });
eventSchema.index({ repeatYearly: 1 });

module.exports = mongoose.model('Event', eventSchema);
