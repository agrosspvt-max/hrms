/**
 * AttendanceNote — Phase 50.
 *
 * A per-employee, per-day note on the Attendance calendar.  Notes are
 * intentionally decoupled from Assignments / Submissions / Tasks — the
 * spec says they are "reminders only" and must NOT affect performance,
 * task completion, submission reviews, or analytics.
 *
 * Authorship:
 *   - Employees create notes on their own calendar.
 *   - HR / Super Admin create notes on any employee's calendar
 *     ("assigned notes" per the spec).
 *   - Notes never generate notifications.
 *
 * Future-compat fields (attachments / checklist / recurrence /
 * sharedWith / meta) are declared up-front as `Mixed` so we can layer
 * on file uploads, checklists, RRULE-style recurrence, shared /
 * team notes, and calendar export without a schema migration.
 */
const mongoose = require('mongoose');

const attendanceNoteSchema = new mongoose.Schema(
  {
    // Whose calendar this note belongs on.
    employee:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Calendar day (stored as UTC start-of-day, same convention as
    // Attendance / Submission / Leave documents).
    date:       { type: Date, required: true, index: true },

    title:       { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },

    // 'normal' behaves as a soft reminder; 'important' surfaces with
    // a warmer badge on the dashboard + calendar.
    priority: {
      type: String,
      enum: ['normal', 'important'],
      default: 'normal',
      index: true,
    },

    // Optional 'HH:MM' string.  Kept as string (not Date) because the
    // reminder is a wall-clock time attached to the note's calendar
    // day rather than a distinct timestamp.
    reminderTime: { type: String, default: '' },

    /* ---------------------------------------------------------------- */
    /* Authorship                                                        */
    /* ---------------------------------------------------------------- */
    createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Denormalised so the display "Created by … (HR)" stays intact
    // even when the source user is renamed / deactivated.
    createdByName:  { type: String, default: '' },
    createdByRole:  {
      type: String,
      enum: ['employee', 'hr', 'super_admin'],
      required: true,
    },

    /* ---------------------------------------------------------------- */
    /* Completion + archive                                              */
    /* ---------------------------------------------------------------- */
    completed:   { type: Boolean, default: false, index: true },
    completedAt: { type: Date },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    archived:    { type: Boolean, default: false, index: true },
    archivedAt:  { type: Date },
    archivedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    /* ---------------------------------------------------------------- */
    /* HR/SA lock — prevents the employee from editing / deleting.       */
    /* Locking is purely an ownership signal; the employee can still     */
    /* mark the note complete / archived from their own calendar.        */
    /* ---------------------------------------------------------------- */
    locked:    { type: Boolean, default: false },
    lockedAt:  { type: Date },
    lockedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    /* ---------------------------------------------------------------- */
    /* Future-compat placeholders — never populated by the initial       */
    /* controller.  Declared here so upgrades are additive.              */
    /* ---------------------------------------------------------------- */
    attachments: { type: [mongoose.Schema.Types.Mixed], default: [] },
    checklist:   { type: [mongoose.Schema.Types.Mixed], default: [] },
    recurrence:  { type: mongoose.Schema.Types.Mixed,   default: null },
    sharedWith:  { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },
    meta:        { type: mongoose.Schema.Types.Mixed,   default: {} },
  },
  { timestamps: true },
);

// Composite indexes to keep the two hot queries (per-employee day list,
// per-employee range list) index-covered even at scale.
attendanceNoteSchema.index({ employee: 1, date: 1 });
attendanceNoteSchema.index({ employee: 1, archived: 1, completed: 1, date: -1 });

module.exports = mongoose.model('AttendanceNote', attendanceNoteSchema);
