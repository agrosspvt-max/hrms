const mongoose = require('mongoose');

/**
 * Reminder -- actionable prompts that MAY repeat until completed.
 *
 * Distinct from Notification (which describes a past event and never
 * repeats).  A reminder self-clears when the user acts (`done` /
 * `dismiss`) or when the underlying condition is resolved (e.g. the
 * "submit today" reminder disappears when the submission lands).
 *
 * Deduplication:
 *   Every reminder has a deterministic natural key `hash` derived
 *   from (recipient, actionKind, entityType, entityId, dueBucket).
 *   A partial unique index on `hash` where `completedAt: null` AND
 *   `dismissedAt: null` guarantees at most ONE active reminder per
 *   natural key -- restarts, cron double-ticks, and concurrent
 *   writers all collapse to a single row.
 */
const reminderSchema = new mongoose.Schema(
  {
    // The user who should see + act on the reminder.
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Who / what the reminder is about (usually === recipient, but
    // HR-facing reminders about an employee use { subject: employeeId }
    // and { recipient: hrUserId }).
    subject:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Phase-2 cleanup: only these five kinds are officially supported.
    // Sub-classifications live in `meta` -- the schema stays simple.
    //   submit_today       -- Submission reminder ("submit today's work").
    //   confirm_attendance -- Attendance reminder ("confirm today's attendance").
    //   meeting_prep       -- Meeting reminder ("meeting starts soon").
    //   follow_up          -- Follow-up reminder (HR-attached to a case).
    //   custom             -- Manual HR-created ad-hoc reminder.
    actionKind: {
      type: String,
      enum: ['submit_today', 'confirm_attendance', 'meeting_prep', 'follow_up', 'custom'],
      required: true,
      index: true,
    },

    // The entity the reminder relates to (Submission, Interaction,
    // Leave, Penalty, etc.).  Every deep link is built from this.
    entityType: { type: String, default: '' },       // 'submission' | 'interaction' | 'leave' | ...
    entityId:   { type: mongoose.Schema.Types.ObjectId },

    title:   { type: String, default: '' },
    message: { type: String, default: '' },

    dueAt:        { type: Date, required: true, index: true },
    cadence: {
      every:      { type: String, default: '' },    // '' | '15m' | '1h' | 'daily' -- purely for reminder scheduler
      until:      { type: Date },
      maxRepeats: { type: Number, default: 0 },
      firedCount: { type: Number, default: 0 },
    },
    priority: { type: String, enum: ['low', 'normal', 'high', 'critical'], default: 'normal' },

    // Deep-link target for the "Open" button.
    targetRoute: { type: String, default: '' },     // e.g. '/submissions/today'

    // Lifecycle -- all three are terminal states (only one may be set).
    completedAt:   { type: Date, index: true },
    dismissedAt:   { type: Date },
    snoozedUntil:  { type: Date },

    // Metadata is a small denormalised bag (deep-link params, cadence
    // context, etc.).  Never used for business logic.
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Idempotency key.  See partial unique index below.
    hash: { type: String, required: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    lastFiredAt: { type: Date },
  },
  { timestamps: true },
);

reminderSchema.index({ recipient: 1, dueAt: 1, completedAt: 1 });
reminderSchema.index({ subject: 1, actionKind: 1, dueAt: 1 });
// Partial unique -- an ACTIVE reminder (not completed, not dismissed)
// with the same natural key can only exist once.  Restarts, cron
// double-ticks, and concurrent writers all collapse into the same row.
reminderSchema.index(
  { hash: 1 },
  {
    unique: true,
    partialFilterExpression: { completedAt: null, dismissedAt: null },
    name: 'reminder_dedupe_hash_active',
  },
);

module.exports = mongoose.model('Reminder', reminderSchema);
