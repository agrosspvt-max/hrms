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
// Phase 47 -- realtime fan-out.  Every meaningful notification helper
// also pushes a typed SSE event so the affected user's UI re-fetches
// the relevant slice instead of waiting for a manual refresh.
const rt           = require('./realtime');

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
    const result = await _emit(rows);
    // Phase 47 -- push inbox refresh to every recipient + 'leave:applied'
    // so the HR/SA Leaves page can re-fetch its queue immediately.
    rt.publishMany(recipients, 'notification:new', { priority: 'normal' });
    rt.publishMany(recipients, 'leave:applied', { leaveId: leave?._id, employeeId: employee?._id });
    return result;
  } catch (e) { console.error('[notify] leave_applied failed:', e.message); return { count: 0 }; }
};

/**
 * notifyLeaveDecision: HR approves / rejects a leave -> employee notified.
 */
const notifyLeaveDecision = async ({ leave, decidedBy, decision /* 'approved' | 'rejected' */ }) => {
  try {
    if (!leave?.employee) return { count: 0 };
    const verb = decision === 'approved' ? 'approved' : 'rejected';
    const result = await _emit([{
      recipient: leave.employee,
      sender: decidedBy?._id,
      type: 'leave_decision',
      title: `Leave ${verb}`,
      message: `Your leave from ${String(leave.fromDate).slice(0, 10)} to ${String(leave.toDate).slice(0, 10)} was ${verb}${decidedBy?.name ? ` by ${decidedBy.name}` : ''}.`,
    }]);
    // Phase 47 -- employee's My Leaves + Dashboard refresh; HR sees the
    // queue shrink via the broadcast to management.
    rt.publish(leave.employee, 'notification:new', { priority: 'normal' });
    rt.publish(leave.employee, 'leave:decision', { leaveId: leave?._id, decision: verb });
    const mgmt = await _managementIds();
    rt.publishMany(mgmt, 'leave:decision', { leaveId: leave?._id, decision: verb });
    return result;
  } catch (e) { console.error('[notify] leave_decision failed:', e.message); return { count: 0 }; }
};

/**
 * notifyAttendanceChanged
 * Phase 45 -- DISABLED.  Attendance edits no longer create
 * notifications (too noisy; the employee can see their own attendance
 * from the My Attendance page).  Kept as a no-op so existing controller
 * call-sites continue to compile without changes.
 */
// eslint-disable-next-line no-unused-vars
const notifyAttendanceChanged = async (_args) => ({ count: 0 });

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
    const result = await _emit(rows);
    // Phase 47 -- each assigned employee gets a Dashboard refresh.
    rt.publishMany(ids, 'notification:new', { priority: 'normal' });
    rt.publishMany(ids, 'assignment:created', { assignmentId: assignment?._id });
    return result;
  } catch (e) { console.error('[notify] work_assigned failed:', e.message); return { count: 0 }; }
};

/**
 * Phase 45 -- DISABLED helpers (kept as no-ops so existing call-sites
 * continue to work).  The Reduce-Notification-Noise initiative limits
 * notifications to leave events, salary slip generation, new
 * assignments, and HR/Super Admin broadcasts (Send Alerts).  Everything
 * below was reclassified as background / progress noise.
 */
// eslint-disable-next-line no-unused-vars
const notifyWorkRevoked          = async (_args) => ({ count: 0 });
// eslint-disable-next-line no-unused-vars
const notifySubmissionReviewed   = async (_args) => ({ count: 0 });
// eslint-disable-next-line no-unused-vars
const notifyPasswordResetRequest = async (_args) => ({ count: 0 });
// eslint-disable-next-line no-unused-vars
const notifyPasswordResetApproved = async (_args) => ({ count: 0 });
// eslint-disable-next-line no-unused-vars
const notifyEmployeeCreated      = async (_args) => ({ count: 0 });

/**
 * Phase 45 -- NEW.  Salary slip generated -> the employee whose slip
 * was generated is notified.  Called once per slip from
 * salaryController.generate / generateAll so a bulk run produces one
 * notification per employee.  Stays silent if `employeeId` is missing.
 */
const notifySalarySlipGenerated = async ({ employeeId, slip, generatedBy }) => {
  try {
    if (!employeeId) return { count: 0 };
    const period = slip?.periodKey || (slip?.month ? String(slip.month) : '');
    const result = await _emit([{
      recipient: employeeId,
      sender: generatedBy?._id,
      type: 'general',
      title: 'Salary slip generated',
      message: `Your salary slip${period ? ` for ${period}` : ''} is now available${generatedBy?.name ? ` (generated by ${generatedBy.name})` : ''}.`,
    }]);
    // Phase 47 -- employee's My Salary refreshes; HR sees the generation
    // counter tick up on their salary management page.
    rt.publish(employeeId, 'notification:new', { priority: 'normal' });
    rt.publish(employeeId, 'salary:slip:generated', { slipId: slip?._id, periodKey: slip?.periodKey });
    if (generatedBy?._id) {
      rt.publish(generatedBy._id, 'salary:slip:generated', { slipId: slip?._id, periodKey: slip?.periodKey, forEmployeeId: employeeId });
    }
    return result;
  } catch (e) {
    console.error('[notify] salary_slip_generated failed:', e.message);
    return { count: 0 };
  }
};

/**
 * Phase 61 -- Penalty Engine notifier.  Called for both PROBABLE
 * (warning) and ACTIVE (enforced) penalties.  The Reduce-Noise
 * initiative in Phase 45 disabled most background notifications --
 * penalties are the exception because employees MUST see them.
 * Dashboard warnings live until the employee acknowledges them,
 * so the notification message is intentionally terse.
 */
const notifyPenalty = async ({ employeeId, penalty, mode /* 'probable' | 'active' */ }) => {
  try {
    if (!employeeId || !penalty) return { count: 0 };
    const isProbable = mode === 'probable';
    const title = isProbable ? 'Warning: possible penalty' : 'Performance penalty applied';
    const message = penalty.employeeMessage || penalty.reason
      || (isProbable
          ? 'You may receive a penalty tomorrow if this issue is not resolved.'
          : 'A performance penalty has been applied to your record.');
    // Priority: warnings are 'normal' inbox pings; enforced penalties are
    // 'important' so the Dashboard's Priority Notices panel surfaces them
    // and the employee can't dismiss them until they've read them.
    const priority = isProbable ? 'normal' : 'important';
    const result = await _emit([{
      recipient: employeeId,
      type: 'general',
      title,
      message,
      priority,
    }]);
    rt.publish(employeeId, 'notification:new', { priority });
    rt.publish(employeeId, 'penalty:changed', {
      penaltyId: penalty._id,
      category: penalty.category,
      probable: !!penalty.probable,
    });
    return result;
  } catch (e) {
    console.error('[notify] penalty failed:', e.message);
    return { count: 0 };
  }
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
  notifySalarySlipGenerated,
  notifyPenalty,
};
