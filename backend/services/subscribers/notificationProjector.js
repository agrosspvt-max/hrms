/**
 * notificationProjector.js
 *
 * Phase 2 -- domain events fan out into Notification rows here.
 * Every subscriber uses the Phase-1 dedupe writer (`_upsertOne` in
 * services/notifyEvents.js), so a duplicate publish can never
 * produce a duplicate Notification row.
 *
 * The existing notify.* helpers still exist and stay callable --
 * this projector is opt-in: publishers migrate to
 * `events.publish('penalty.applied', ctx)` and stop calling
 * `notify.notifyPenalty` directly.  Legacy callers keep working
 * during the migration ramp; the dedupe key collapses any overlap.
 */
const events = require('../events');
const notify = require('../notifyEvents');

const register = () => {
  // ---- Penalty lifecycle -------------------------------------------
  events.subscribe('penalty.applied', async (evt) => {
    if (!evt.penalty || !evt.recipient) return;
    await notify.notifyPenalty({
      employeeId: evt.recipient,
      penalty:    evt.penalty,
      mode:       'active',
      event:      'applied',
    });
  });
  events.subscribe('penalty.probable', async (evt) => {
    if (!evt.penalty || !evt.recipient) return;
    await notify.notifyPenalty({
      employeeId: evt.recipient,
      penalty:    evt.penalty,
      mode:       'probable',
      event:      'probable',
    });
  });
  events.subscribe('penalty.waived', async (evt) => {
    if (!evt.penalty || !evt.recipient) return;
    await notify.notifyPenalty({
      employeeId: evt.recipient, penalty: evt.penalty,
      mode: 'probable', event: 'waived',
    });
  });
  events.subscribe('penalty.resolved', async (evt) => {
    if (!evt.penalty || !evt.recipient) return;
    // Resolution is silent unless the caller specifically wants a
    // notification (e.g. manual HR resolve).
    if (evt.silent) return;
    await notify.notifyPenalty({
      employeeId: evt.recipient, penalty: evt.penalty,
      mode: 'probable', event: 'resolved',
    });
  });
  events.subscribe('penalty.deducted', async (evt) => {
    if (!evt.penalty || !evt.recipient || !evt.salaryMonth) return;
    await notify.notifyPenalty({
      employeeId: evt.recipient, penalty: evt.penalty,
      mode: 'active', event: `deducted.${evt.salaryMonth}`,
    });
  });
  events.subscribe('penalty.recovery', async (evt) => {
    if (!evt.penalty || !evt.recipient || !evt.mode) return;
    await notify.notifyPenalty({
      employeeId: evt.recipient, penalty: evt.penalty,
      mode: evt.mode === 'restore' ? 'probable' : 'active',
      event: `recovery.${evt.mode}`,
    });
  });

  // ---- Leaves ------------------------------------------------------
  events.subscribe('leave.applied', async (evt) => {
    if (!evt.leave || !evt.employee) return;
    await notify.notifyLeaveApplied({ leave: evt.leave, employee: evt.employee });
  });
  events.subscribe('leave.decided', async (evt) => {
    if (!evt.leave) return;
    await notify.notifyLeaveDecision({ leave: evt.leave, decidedBy: evt.decidedBy, decision: evt.decision });
  });

  // ---- Salary ------------------------------------------------------
  events.subscribe('salary_slip.generated', async (evt) => {
    if (!evt.slip || !evt.recipient) return;
    await notify.notifySalarySlipGenerated({
      employeeId: evt.recipient, slip: evt.slip, generatedBy: evt.generatedBy,
    });
  });

  // ---- Assignments -------------------------------------------------
  events.subscribe('assignment.created', async (evt) => {
    if (!evt.assignment || !evt.recipients?.length) return;
    await notify.notifyWorkAssigned({
      employeeIds: evt.recipients,
      assignment:  evt.assignment,
      assignedBy:  evt.assignedBy,
    });
  });

  // ---- Meetings (Employee Interactions type=meeting) ---------------
  // Phase-2 cleanup: meetings are on the approved notification flow.
  // One notification per participant, dedupe key includes the recipient
  // so each participant gets their own row without ever duplicating.
  events.subscribe('interaction.created', async (evt) => {
    const it = evt.interaction;
    if (!it || it.type !== 'meeting') return;
    const when = it.meeting?.date ? new Date(it.meeting.date) : null;
    const time = it.meeting?.time ? ` ${it.meeting.time}` : '';
    const message = `Meeting "${it.title}"${when ? ` on ${when.toISOString().slice(0,10)}${time}` : ''}${it.meeting?.location ? ` · ${it.meeting.location}` : ''}.`;
    for (const p of (it.participants || [])) {
      const recipient = p.employee?._id || p.employee;
      if (!recipient) continue;
      await notify._upsertOne({
        recipient,
        eventKey: `meeting.created:${String(it._id)}`,
        variant: 'default',
        sourceRef: { module: 'interaction', id: it._id },
        payload: {
          type: 'general',
          title: 'New meeting invitation',
          message,
          priority: 'normal',
          sender: evt.createdBy || null,
        },
      });
    }
  });

  events.subscribe('interaction.cancelled', async (evt) => {
    const it = evt.interaction;
    if (!it || it.type !== 'meeting') return;
    for (const p of (it.participants || [])) {
      const recipient = p.employee?._id || p.employee;
      if (!recipient) continue;
      await notify._upsertOne({
        recipient,
        eventKey: `meeting.cancelled:${String(it._id)}`,
        variant: 'default',
        sourceRef: { module: 'interaction', id: it._id },
        payload: {
          type: 'general',
          title: 'Meeting cancelled',
          message: `Meeting "${it.title}" was cancelled.`,
          priority: 'normal',
        },
      });
    }
  });

  console.log('[notification-projector] registered');
};

module.exports = { register };
