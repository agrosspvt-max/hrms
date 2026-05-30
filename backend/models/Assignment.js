const mongoose = require('mongoose');

/**
 * Maps a Template to a target (employee / department / designation)
 * and defines the frequency at which submissions should be generated.
 */
const assignmentSchema = new mongoose.Schema(
  {
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', required: true },

    targetType: {
      type: String,
      enum: ['employee', 'department', 'designation'],
      required: true,
    },
    targetRef: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    frequency: {
      type: String,
      enum: ['one-time', 'daily', 'weekly', 'monthly'],
      default: 'daily',
    },

    // Recurrence config (only meaningful for the matching frequency):
    //   weekly  -> weeklyDay  : 0 (Sun) .. 6 (Sat) the task recurs on
    //   monthly -> monthlyDate: 1 .. 31 day-of-month the task recurs on.
    //              If the month is shorter (e.g. 31 in February) the
    //              engine clamps to the last valid day of that month.
    weeklyDay: { type: Number, min: 0, max: 6 },
    monthlyDate: { type: Number, min: 1, max: 31 },

    // Human-readable schedule summary, e.g. "Daily", "Weekly • Every
    // Monday", "Monthly • Every 5th".  Cached for display; recomputed by
    // the controller whenever the schedule changes.
    scheduleLabel: { type: String, default: '' },

    startDate: { type: Date, default: Date.now },
    endDate: { type: Date },

    // Priority of this assignment (surfaced in dependency / dashboard views).
    priority: {
      type: String,
      enum: ['low', 'normal', 'high'],
      default: 'normal',
    },

    // ---- Manual "work on a non-working day" override ----
    // When true, this assignment is generated even when the target's day
    // would normally be skipped (Sunday / configured weekly off / Holiday
    // model entry / event with isHoliday=true).  Approved FULL-day leave is
    // NEVER overridden.  Used for explicit HR/Super Admin asks, like
    // weekend audits or festival-day production support.
    holidayOverride: { type: Boolean, default: false },
    // 'once' (default, safer): the override applies ONLY on the
    // assignment's startDate — recurring daily/weekly/monthly templates
    // don't bleed onto every future non-working day.
    // 'all': the override applies on every non-working day the assignment
    // recurs on (use sparingly).
    overrideScope: { type: String, enum: ['once', 'all'], default: 'once' },
    overrideReason: { type: String, default: '' },

    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

assignmentSchema.index({ targetType: 1, targetRef: 1, active: 1 });

module.exports = mongoose.model('Assignment', assignmentSchema);
