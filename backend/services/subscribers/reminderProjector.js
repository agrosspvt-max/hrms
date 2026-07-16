/**
 * reminderProjector.js
 *
 * Domain events -> reminder lifecycle.  Every reminder is created
 * through services/reminders.createOrUpdate (upsert-by-hash) and
 * resolved through services/reminders.resolveByEntity.
 *
 * Publishers just say "meeting created" / "submission submitted";
 * we decide whether that creates or resolves a reminder.
 */
const events = require('../events');
const reminders = require('../reminders');
const rt = require('../realtime');

const _hour = 60 * 60 * 1000;

const register = () => {
  // ---- Meetings ----------------------------------------------------
  events.subscribe('interaction.created', async (evt) => {
    const it = evt.interaction;
    if (!it || it.type !== 'meeting' || !it.meeting?.date) return;
    const when = new Date(it.meeting.date);
    // Compose "meeting starts soon" reminder 30 min before start.
    const dueAt = new Date(when.getTime() - 30 * 60 * 1000);
    for (const p of (it.participants || [])) {
      const recipient = p.employee?._id || p.employee;
      if (!recipient) continue;
      const { doc, created } = await reminders.createOrUpdate({
        recipient,
        actionKind: 'meeting_prep',
        entityType: 'interaction',
        entityId: it._id,
        title: `Meeting: ${it.title}`,
        message: it.description || '',
        dueAt,
        priority: 'normal',
        targetRoute: `/interactions?open=${it._id}`,
        meta: { meetingAt: when, mode: it.meeting.mode, location: it.meeting.location || '' },
        granularity: 'hour',
      });
      if (created) rt.publish(recipient, 'reminder:changed', { reminderId: doc._id });
    }
  });

  // Cancel meeting -> resolve reminder.
  events.subscribe('interaction.cancelled', async (evt) => {
    const it = evt.interaction;
    if (!it) return;
    for (const p of (it.participants || [])) {
      const recipient = p.employee?._id || p.employee;
      if (!recipient) continue;
      await reminders.resolveByEntity({
        recipient, actionKind: 'meeting_prep',
        entityType: 'interaction', entityId: it._id,
      });
      rt.publish(recipient, 'reminder:changed', {});
    }
  });

  // ---- Submissions -------------------------------------------------
  // "please submit today" reminder is created by a daily scheduler
  // rather than here (the scheduler already runs); when the
  // employee actually submits, we resolve any open reminders.
  events.subscribe('submission.submitted', async (evt) => {
    if (!evt.recipient) return;
    await reminders.resolveByEntity({
      recipient: evt.recipient,
      actionKind: 'submit_today',
    });
    rt.publish(evt.recipient, 'reminder:changed', {});
  });

  // ---- Attendance --------------------------------------------------
  events.subscribe('attendance_confirmation.confirmed', async (evt) => {
    if (!evt.recipient) return;
    await reminders.resolveByEntity({
      recipient: evt.recipient,
      actionKind: 'confirm_attendance',
    });
    rt.publish(evt.recipient, 'reminder:changed', {});
  });

  // Leave-decision reminders are intentionally NOT modelled -- the
  // approved reminder kinds list (Phase 2 cleanup) covers only
  // submit_today / confirm_attendance / meeting_prep / follow_up /
  // custom.  HR sees pending leaves on the Dashboard alerts widget
  // instead.

  console.log('[reminder-projector] registered');
};

module.exports = { register };
