/**
 * notifyEvents.js
 *
 * Lightweight, fire-and-forget notification emitter used by the
 * Phase 2.4 "global notification system" wire-up.  Every helper:
 *
 *   - Resolves recipients via a single Mongo query (HR + Super Admin
 *     when the audience is "management"; the employee themselves when
 *     the audience is "owner").
 *   - Inserts the notification rows with insertMany ({ ordered: false }
 *     so a single bad recipient doesn't kill the batch).
 *   - **Never throws.**  If the database hiccups or the recipient list
 *     is empty, the helper logs and returns; the caller's success path
 *     must never fail because a notification couldn't be queued.
 *
 * This pattern keeps controllers clean (one line at the bottom of the
 * happy path) and prevents notification bugs from cascading into HR
 * 500s, leave-application failures, or login regressions.
 */

const Notification = require('../models/Notification');
const User         = require('../models/User');

/** Bulk-insert helper.  Never throws. */
const _emit = async (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return { count: 0 };
  try {
    const created = await Notification.insertMany(rows, { ordered: false });
    return { count: created.length };
  } catch (err) {
    // insertMany with ordered:false may surface a write-errors envelope
    // even when *some* docs landed.  Best-effort: log & swallow.
    console.error('[notify] insertMany failed:', err.message);
    return { count: 0, error: err.message };
  }
};

/** Find every HR + Super Admin user id (active only). */
const _managementIds = async () => {
  const rows = await User.find({ role: { $in: ['hr', 'super_admin'] }, status: 'active' }).select('_id').lean();
  return rows.map((r) => r._id);
};

/**
 * notifyLeaveApplied: employee files a leave -> HR + Super Admin notified.
 */
const notifyLeaveApplied = async ({ leave, employee }) => {
  try {
    const recipients = await _managementIds();
    const days = Math.max(1, Math.round((new Date(leave.toDate) - new Date(leave.fromDate)) / 86400000) + 1);
    const rows = recipients.map((rid) => ({
      recipient: rid,
      sender: employee?._id,
      type: 'leave_applied',
      title: 'New leave application',
      message: `${employee?.name || 'An employee'} applied for ${days} day(s) of ${leave.leaveType || 'leave'} from ${String(leave.fromDate).slice(0, 10)} to ${String(leave.toDate).slice(0, 10)}.`,
    }));
    return _emit(rows);
  } catch (e) { console.error('[notify] leave_applied failed:', e.message); return { count: 0 }; }
};

/**
 * notifyLeaveDecision: HR approves / rejects a leave -> employee notified.
 */
const notifyLeaveDecision = async ({ leave, decidedBy, decision /* 'approved' | 'rejected' */ }) => {
  try {
    if (!leave?.employee) return { count: 0 };
    const verb = decision === 'approved' ? 'approved' : 'rejected';
    return _emit([{
      recipient: leave.employee,
      sender: decidedBy?._id,
      type: 'leave_decision',
      title: `Leave ${verb}`,
      message: `Your leave from ${String(leave.fromDate).slice(0, 10)} to ${String(leave.toDate).slice(0, 10)} was ${verb}${decidedBy?.name ? ` by ${decidedBy.name}` : ''}.`,
    }]);
  } catch (e) { console.error('[notify] leave_decision failed:', e.message); return { count: 0 }; }
};

/**
 * notifyAttendanceChanged: HR edits attendance -> employee notified.
 */
const notifyAttendanceChanged = async ({ employeeId, date, status, changedBy }) => {
  try {
    if (!employeeId) return { count: 0 };
    return _emit([{
      recipient: employeeId,
      sender: changedBy?._id,
      type: 'attendance_changed',
      title: 'Attendance updated',
      message: `Your attendance for ${String(date).slice(0, 10)} was set to "${status}"${changedBy?.name ? ` by ${changedBy.name}` : ''}.`,
    }]);
  } catch (e) { console.error('[notify] attendance_changed failed:', e.message); return { count: 0 }; }
};

/**
 * notifyWorkAssigned: HR/SA creates an assignment -> employees notified.
 * Accepts a single employeeId or an array.
 */
const notifyWorkAssigned = async ({ employeeIds, assignment, assignedBy }) => {
  try {
    const ids = Array.isArray(employeeIds) ? employeeIds : (employeeIds ? [employeeIds] : []);
    if (ids.length === 0) return { count: 0 };
    const title = `New work assigned: ${assignment?.title || 'untitled'}`;
    const message = `${assignedBy?.name || 'HR'} assigned you "${assignment?.title || 'a new task'}" (${assignment?.frequency || 'one-time'}).`;
    const rows = ids.map((rid) => ({
      recipient: rid,
      sender: assignedBy?._id,
      type: 'work_assigned',
      title,
      message,
    }));
    return _emit(rows);
  } catch (e) { console.error('[notify] work_assigned failed:', e.message); return { count: 0 }; }
};

/**
 * notifyWorkRevoked: HR/SA revokes an assignment -> employees notified.
 */
const notifyWorkRevoked = async ({ employeeIds, assignment, revokedBy }) => {
  try {
    const ids = Array.isArray(employeeIds) ? employeeIds : (employeeIds ? [employeeIds] : []);
    if (ids.length === 0) return { count: 0 };
    const rows = ids.map((rid) => ({
      recipient: rid,
      sender: revokedBy?._id,
      type: 'work_revoked',
      title: 'Assignment revoked',
      message: `${revokedBy?.name || 'HR'} revoked the assignment "${assignment?.title || ''}".`,
    }));
    return _emit(rows);
  } catch (e) { console.error('[notify] work_revoked failed:', e.message); return { count: 0 }; }
};

/**
 * notifySubmissionReviewed: HR finalises a submission -> owner notified.
 */
const notifySubmissionReviewed = async ({ employeeId, submission, reviewedBy }) => {
  try {
    if (!employeeId) return { count: 0 };
    return _emit([{
      recipient: employeeId,
      sender: reviewedBy?._id,
      type: 'submission_reviewed',
      title: 'Submission reviewed',
      message: `Your submission for ${String(submission?.date || '').slice(0, 10)} was reviewed${reviewedBy?.name ? ` by ${reviewedBy.name}` : ''}.`,
    }]);
  } catch (e) { console.error('[notify] submission_reviewed failed:', e.message); return { count: 0 }; }
};

/**
 * notifyPasswordResetRequest: employee asks for a password reset -> HR/SA.
 */
const notifyPasswordResetRequest = async ({ employee }) => {
  try {
    const recipients = await _managementIds();
    const rows = recipients.map((rid) => ({
      recipient: rid,
      sender: employee?._id,
      type: 'password_reset_request',
      title: 'Password reset request',
      message: `${employee?.name || 'A user'} (${employee?.email || ''}) requested a password reset.`,
    }));
    return _emit(rows);
  } catch (e) { console.error('[notify] password_reset_request failed:', e.message); return { count: 0 }; }
};

/**
 * notifyPasswordResetApproved: HR resets a password -> employee notified.
 */
const notifyPasswordResetApproved = async ({ employeeId, approvedBy }) => {
  try {
    if (!employeeId) return { count: 0 };
    return _emit([{
      recipient: employeeId,
      sender: approvedBy?._id,
      type: 'password_reset_approved',
      title: 'Password reset approved',
      message: `Your password was reset${approvedBy?.name ? ` by ${approvedBy.name}` : ''}. Please log in with the new credentials.`,
    }]);
  } catch (e) { console.error('[notify] password_reset_approved failed:', e.message); return { count: 0 }; }
};

/**
 * notifyEmployeeCreated: HR creates a new employee -> HR + Super Admin.
 */
const notifyEmployeeCreated = async ({ employee, createdBy }) => {
  try {
    const recipients = (await _managementIds()).filter((id) => String(id) !== String(createdBy?._id));
    if (recipients.length === 0) return { count: 0 };
    const rows = recipients.map((rid) => ({
      recipient: rid,
      sender: createdBy?._id,
      type: 'employee_created',
      title: 'New employee added',
      message: `${createdBy?.name || 'HR'} added a new employee: ${employee?.name || ''} (${employee?.employeeId || ''}).`,
    }));
    return _emit(rows);
  } catch (e) { console.error('[notify] employee_created failed:', e.message); return { count: 0 }; }
};

module.exports = {
  notifyLeaveApplied,
  notifyLeaveDecision,
  notifyAttendanceChanged,
  notifyWorkAssigned,
  notifyWorkRevoked,
  notifySubmissionReviewed,
  notifyPasswordResetRequest,
  notifyPasswordResetApproved,
  notifyEmployeeCreated,
};
