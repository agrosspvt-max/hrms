const mongoose = require('mongoose');

/**
 * Notification - an in-app message from HR (or the system) to an employee.
 *
 * Typical use cases:
 *   - HR pings an employee about pending backlog tasks
 *   - HR broadcasts a general announcement to one or more employees
 *
 * For traceability we record:
 *   - sender         : who fired it
 *   - type           : 'backlog_alert' | 'general'
 *   - relatedTaskIds : optional list of backlog task ids the alert refers to
 *   - relatedTitles  : human-readable task titles (denormalised so the
 *                       message still makes sense even if the source
 *                       submission is later deleted)
 */
const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    type: {
      type: String,
      enum: [
        'backlog_alert', 'general', 'review_pending', 'leave_info',
        'dependency_assigned', 'dependency_resolved',
        'birthday_today', 'event_today', 'event_reminder',
        // Global event-driven notifications (Phase 2.4).
        'leave_applied', 'leave_decision',
        'attendance_changed',
        'work_assigned', 'work_revoked',
        'submission_reviewed',
        'password_reset_request', 'password_reset_approved',
        'employee_created',
      ],
      default: 'general',
      index: true,
    },

    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },

    relatedTaskIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    relatedTitles: { type: [String], default: [] },

    // Stable de-dupe key used by event/birthday notification firing so the
    // same reminder is not sent twice (e.g. on repeated dashboard loads).
    eventKey: { type: String, default: '', index: true },

    // Phase 45 — Priority Notices.  HR / Super Admin may flag broadcasts
    // as 'important' or 'urgent'; the Employee Dashboard surfaces those
    // in a dedicated panel that the employee cannot dismiss until read
    // ('important') or resolved ('urgent').  'normal' (default) behaves
    // exactly as before — inbox-only.
    priority: {
      type: String,
      enum: ['normal', 'important', 'urgent'],
      default: 'normal',
      index: true,
    },

    // Phase 46 — Urgent / time-bound notices carry a hard deadline.  HR
    // sets a date + time; the employee sees it prominently on both the
    // Dashboard panel and the Notifications inbox.  Optional for
    // 'important' / 'normal'; the controller enforces required-ness on
    // 'urgent'.  Stored as a Date so timezone math is unambiguous.
    deadline: { type: Date },

    // Phase 46 — Time-bound resolution.  The employee clicks "Resolve"
    // AFTER finishing the requested work.  Distinct from `read` (which
    // just means "opened").  HR sees Sent / Read / Resolved / Status
    // columns on the Sent Alerts page.
    resolvedAt: { type: Date },

    // Phase 46 — Dashboard dismissal is separate from inbox deletion.
    // Clearing a notice from the Dashboard panel sets this timestamp so
    // the Dashboard hides the row; the underlying Notification document
    // STAYS in the inbox as permanent proof of delivery.  Employees can
    // no longer delete notifications outright (see controller.remove).
    dismissedFromDashboardAt: { type: Date },

    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, type: 1, eventKey: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
