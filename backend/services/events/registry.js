/**
 * Event Registry — the project's architectural contract for every
 * business event the HRMS publishes.
 *
 * Phase 2 cleanup: each entry carries ONLY:
 *   - owner        : the single module authorised to publish this event
 *   - notification : does this event write a Notification row?
 *   - timeline     : does this event appear in the Activity Timeline?
 *   - reminder     : does this event create / resolve a Reminder?
 *   - realtime     : does this event fan out a realtime frame?
 *
 * No metadata explosion, no execution logic.  The Dashboard is
 * derived from live queries and does not need per-event flags.
 *
 * Adding a new business event means adding an entry here + naming
 * exactly one owner.  Nothing else should ever emit the same event.
 */

const REGISTRY = Object.freeze({
  // ---- Attendance --------------------------------------------------
  'attendance.status_set': {
    owner: 'attendanceController.setForDay | dailyEngine.deriveAttendance',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'attendance_confirmation.confirmed': {
    owner: 'attendanceConfirmationController.confirm',
    notification: false, timeline: true,  reminder: true,  realtime: true,
  },
  'attendance_confirmation.reviewed': {
    owner: 'attendanceConfirmationController.actOne',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },

  // ---- Submissions -------------------------------------------------
  'submission.submitted': {
    owner: 'submissionController.submitOne',
    notification: false, timeline: true,  reminder: true,  realtime: true,
  },
  'submission.reviewed': {
    owner: 'dailyReviewController.finalizeDay | submissionController.review',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'submission.reopened': {
    owner: 'penaltyController.reopenDecision',
    notification: true,  timeline: true,  reminder: true,  realtime: true,
  },

  // ---- Penalties ---------------------------------------------------
  'penalty.applied': {
    owner: 'penaltyEngine._upsertAutoPenalty (created===true) | penaltyController.create',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'penalty.probable': {
    owner: 'penaltyEngine (probable rules — currently disabled)',
    notification: true,  timeline: false, reminder: false, realtime: true,
  },
  'penalty.resolved': {
    owner: 'penaltyController (auto on submit + manual) | penaltyEngine',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'penalty.cancelled': {
    owner: 'penaltyController.cancel',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'penalty.waived': {
    owner: 'penaltyController.waiveFinancial',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'penalty.deducted': {
    owner: 'penaltyController.markFinancialDeducted',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'penalty.recovery': {
    owner: 'performanceRecovery.applyRecovery',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'penalty.reopen_requested': {
    owner: 'penaltyController.requestReopen',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'penalty.reopen_decided': {
    owner: 'penaltyController.reopenDecision',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },

  // ---- Leaves ------------------------------------------------------
  'leave.applied': {
    owner: 'leaveController.create',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'leave.decided': {
    owner: 'leaveController.decide',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },

  // ---- Salary ------------------------------------------------------
  'salary_slip.generated': {
    owner: 'salaryController.generate | .generateAll',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },

  // ---- Employee Interactions ---------------------------------------
  'interaction.created': {
    owner: 'interactionController.create',
    notification: true,  timeline: true,  reminder: true,  realtime: true,
  },
  'interaction.updated': {
    owner: 'interactionController.update',
    notification: false, timeline: true,  reminder: true,  realtime: true,
  },
  'interaction.deleted': {
    owner: 'interactionController.remove',
    notification: false, timeline: true,  reminder: true,  realtime: true,
  },
  'interaction.cancelled': {
    owner: 'interactionController.update (status=cancelled)',
    notification: true,  timeline: true,  reminder: true,  realtime: true,
  },
  'interaction.participant_responded': {
    owner: 'interactionController.respond',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'interaction.attendance_marked': {
    owner: 'interactionController.setAttendance',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'interaction.note_added': {
    owner: 'interactionController.addNote',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'interaction.note_updated': {
    owner: 'interactionController.updateNote',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'interaction.tag_added': {
    owner: 'interactionController.update (tag added)',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'interaction.tag_removed': {
    owner: 'interactionController.update (tag removed)',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'interaction.followup_resolved': {
    owner: 'interactionController.resolveFollowUp',
    notification: false, timeline: true,  reminder: true,  realtime: true,
  },

  // ---- Meetings (alias namespace for interactions of type=meeting) -
  'meeting.created': {
    owner: 'interactionController.create (type=meeting)',
    notification: true,  timeline: true,  reminder: true,  realtime: true,
  },
  'meeting.updated': {
    owner: 'interactionController.update (type=meeting)',
    notification: false, timeline: true,  reminder: true,  realtime: true,
  },
  'meeting.attendance_confirmed': {
    owner: 'interactionController.respond',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'meeting.attendance_updated': {
    owner: 'interactionController.setAttendance',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'meeting.cancelled': {
    owner: 'interactionController.update (type=meeting, status=cancelled)',
    notification: true,  timeline: true,  reminder: true,  realtime: true,
  },

  // ---- Events & Holidays -------------------------------------------
  'holiday.created': {
    owner: 'holidayController.create',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'event.created': {
    owner: 'eventController.create',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },

  // ---- Employees ---------------------------------------------------
  'employee.created': {
    owner: 'employeeController.create',
    notification: false, timeline: true,  reminder: false, realtime: false,
  },
  'employee.role_changed': {
    owner: 'employeeController.update',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'password_reset.requested': {
    owner: 'passwordResetController.request',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'password_reset.approved': {
    owner: 'passwordResetController.approve',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },

  // ---- Assignments -------------------------------------------------
  'assignment.created': {
    owner: 'assignmentController.create',
    notification: true,  timeline: true,  reminder: true,  realtime: true,
  },
  'assignment.revoked': {
    owner: 'assignmentController.remove',
    notification: false, timeline: true,  reminder: true,  realtime: true,
  },

  // ---- Send Alerts (HR broadcast) ---------------------------------
  'alert.broadcast': {
    owner: 'notificationController.broadcast',
    notification: true,  timeline: false, reminder: false, realtime: true,
  },

  // ---- Reminder lifecycle -----------------------------------------
  'reminder.created': {
    owner: 'services/reminders.createOrUpdate (created===true)',
    notification: false, timeline: false, reminder: true,  realtime: true,
  },
  'reminder.completed': {
    owner: 'reminderController (done | dismiss | snooze | cancel | complete)',
    notification: false, timeline: true,  reminder: true,  realtime: true,
  },

  // ---- Compliance & Accountability v2 -----------------------------
  // Additive.  Every event below is written into ComplianceEvent AND
  // published on the existing realtime bus.  Notification / timeline
  // flags mirror the legacy `penalty.*` codes so consumers can move
  // over without changing behaviour.
  'compliance.incident_created': {
    owner: 'services/compliance/incidents.incidentService.recordIncident',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'compliance.incident_effective': {
    owner: 'services/compliance/incidents.incidentService.promoteToActive',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'compliance.action_applied': {
    owner: 'services/compliance/actions.actionEngine.apply',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'compliance.notification_sent': {
    owner: 'services/compliance/actions.executors.notificationExecutor',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'compliance.waiver_requested': {
    owner: 'services/compliance/waiver.waiverService.request',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'compliance.waiver_decided': {
    owner: 'services/compliance/waiver.waiverService.decide',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'compliance.recovery_applied': {
    owner: 'services/compliance/recovery.recoveryService.apply',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'compliance.incident_resolved': {
    owner: 'services/compliance/incidents.incidentService.resolveIncident',
    notification: false, timeline: true,  reminder: false, realtime: true,
  },
  'compliance.incident_cancelled': {
    owner: 'services/compliance/incidents.incidentService.cancelIncident',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'compliance.escalated': {
    owner: 'services/compliance/escalation.escalationRunner.run',
    notification: true,  timeline: true,  reminder: false, realtime: true,
  },
  'compliance.rule_updated': {
    owner: 'services/compliance/rules.ruleService.update',
    notification: false, timeline: false, reminder: false, realtime: true,
  },
});

/** Look up an event type; returns undefined if unknown. */
const describe = (type) => REGISTRY[type];

/** True if `type` is a registered event. */
const isKnown = (type) => Object.prototype.hasOwnProperty.call(REGISTRY, type);

/** Every registered event type, sorted. */
const list = () => Object.keys(REGISTRY).sort();

module.exports = { REGISTRY, describe, isKnown, list };
