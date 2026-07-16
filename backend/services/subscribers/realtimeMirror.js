/**
 * realtimeMirror.js
 *
 * Standardised realtime frames.  All frames are state-oriented +
 * carry only IDs; clients respond by refetching the affected
 * projection.  Frames never carry business data that would encourage
 * a client-side write.
 */
const events = require('../events');
const rt = require('../realtime');

const register = () => {
  // Any event affecting a specific recipient's dashboard state
  // fires alert:changed so the dashboard refetches counts.
  const alertChangingTypes = [
    'penalty.applied', 'penalty.resolved', 'penalty.cancelled', 'penalty.waived',
    'penalty.probable', 'penalty.recovery',
    'leave.applied', 'leave.decided',
    'assignment.created', 'assignment.revoked',
    'interaction.created', 'interaction.cancelled',
    'salary_slip.generated',
    'submission.submitted', 'submission.reopened',
    'attendance.status_set', 'attendance_confirmation.confirmed',
    'attendance_confirmation.reviewed',
    'reminder.created', 'reminder.completed',
  ];
  for (const t of alertChangingTypes) {
    events.subscribe(t, (evt) => {
      const to = evt.recipient || evt.subject || (evt.leave && evt.leave.employee);
      if (to) rt.publish(to, 'alert:changed', { via: t });
    });
  }

  // Timeline: any event with a recipient/subject triggers timeline:appended.
  events.subscribe('*', (evt) => {
    const to = evt.recipient || evt.subject || (evt.leave && evt.leave.employee);
    if (to) rt.publish(to, 'timeline:appended', { type: evt.type });
  });

  console.log('[realtime-mirror] registered');
};

module.exports = { register };
