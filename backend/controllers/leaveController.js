const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Leave = require('../models/Leave');
const User = require('../models/User');
const Department = require('../models/Department');
const Notification = require('../models/Notification');
const { startOfDay, daysBetween, addDays, effectiveLeaveDays } = require('../utils/dateHelpers');
const Holiday = require('../models/Holiday');
const { logAudit } = require('../utils/audit');
const notify = require('../services/notifyEvents');
// Phase 54 -- supporting documents.  Never required; if the employee
// sends `attachmentIds[]` we link matching orphan attachments to the
// new leave.  Nothing else in the leave flow depends on this.
const LeaveAttachment = require('../models/LeaveAttachment');
// Phase 62 -- Probation validation.  Consulted BEFORE Leave.create so
// blocked requests never touch Leave History (spec item 9).  Nothing
// about approvals, balances, attendance or payroll is touched.
const probation = require('../services/probation');

/**
 * Phase 54 -- attach metadata for a batch of leaves.  Returns a Map
 * keyed by leave._id (as String) so callers can splice attachments
 * into their response without extra loops.  Attachment BYTES are
 * never returned here — only metadata.
 */
const _attachmentsForLeaves = async (leaveIds) => {
  const map = new Map();
  if (!Array.isArray(leaveIds) || leaveIds.length === 0) return map;
  const rows = await LeaveAttachment.find({
    leave: { $in: leaveIds },
    deletedAt: { $in: [null, undefined] },
  })
    .populate('uploadedBy', 'name role employeeId')
    .select('leave filename mimeType size status version uploadedBy createdAt')
    .sort({ createdAt: 1 })
    .lean();
  for (const a of rows) {
    const k = String(a.leave);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({
      _id: a._id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      status: a.status,
      version: a.version,
      uploadedBy: a.uploadedBy,
      createdAt: a.createdAt,
    });
  }
  return map;
};

/**
 * Employee applies for a leave.
 */
const apply = asyncHandler(async (req, res) => {
  // Super Admin has no approver above them, so they cannot create
  // leave requests through the standard workflow.
  if (req.user.role === 'super_admin') {
    res.status(403);
    throw new Error('Super Admin accounts cannot raise leave requests.');
  }

  const { fromDate, toDate, leaveType, reason } = req.body;
  if (!fromDate || !toDate) {
    res.status(400);
    throw new Error('fromDate and toDate are required');
  }
  const from = startOfDay(new Date(fromDate));
  const to = startOfDay(new Date(toDate));
  if (to < from) {
    res.status(400);
    throw new Error('toDate must be after fromDate');
  }

  // Half-day leave is only valid for a single-day request.
  const isSingleDay = from.getTime() === to.getTime();
  const dayType = req.body.dayType === 'half' && isSingleDay ? 'half' : 'full';

  // Effective leave-day count: excludes the employee's weekly-off days
  // and any company holidays that fall in the requested range so the
  // balance is never deducted for non-working days.  The employee's
  // weeklyOff config (default [0] = Sunday) is the source of truth.
  const requester = await User.findById(req.user._id).select('weeklyOff');
  const holidays = await Holiday.find({
    date: { $gte: from, $lte: to },
  }).select('date').lean();
  const { formatYMD } = require('../utils/dateHelpers');
  const holidaySet = new Set(holidays.map((h) => formatYMD(h.date)));
  const days = effectiveLeaveDays({
    from, to,
    weeklyOff: requester?.weeklyOff || [0],
    dayType,
    holidaySet,
  });
  if (days <= 0) {
    res.status(400);
    throw new Error('Requested period contains no working days (weekly off / holidays only). No leave to apply.');
  }

  // Phase 62 -- Probation Period gate.  ONLY the employee's own
  // apply is gated; HR / Super Admin acting through other routes
  // are untouched.  When probation is active AND the selected
  // leaveType is in the org-wide restricted list, we throw before
  // Leave.create so nothing lands in Leave History (spec item 9).
  try {
    // We need the joiningDate + probation sub-doc to derive the window.
    const empForProbation = await User.findById(req.user._id)
      .select('joiningDate probation role').lean();
    if (empForProbation && empForProbation.role === 'employee'
        && probation.isOnProbation(empForProbation)) {
      const restricted = await probation.getRestrictedTypes();
      if (Array.isArray(restricted) && restricted.includes(leaveType)) {
        const { endDate } = probation.getProbationWindow(empForProbation);
        const until = probation.formatEndDate(endDate);
        // Human-friendly label so the message reads naturally.
        const LABEL = { paid: 'Paid Leave', casual: 'Casual Leave', sick: 'Sick Leave', unpaid: 'Unpaid Leave', other: 'Other Leave' };
        const label = LABEL[leaveType] || leaveType;
        res.status(400);
        throw new Error(
          `You are currently under probation until ${until}. `
          + `${label} is not available during the probation period. `
          + `Please apply using Unpaid Leave or another eligible leave type.`,
        );
      }
    }
  } catch (e) {
    // If the check itself throws (400 for probation) we surface it;
    // any other error (DB hiccup) is logged and the request proceeds
    // to the existing pipeline so probation never becomes a hard
    // dependency on the leave apply path.
    if (res.statusCode === 400) throw e;
    if (String(e && e.message || '').startsWith('You are currently under probation')) throw e;
    console.error('[leave.apply] probation check failed (soft):', e.message);
  }

  // Paid-leave balance gate (Phase 2.5).
  //   - leaveType in { paid, casual, sick, other } counts as PAID.
  //   - leaveType === 'unpaid' bypasses the balance entirely.
  // Employees are blocked here when their balance is insufficient; HR /
  // Super Admin acting on behalf of an employee may over-allocate, the
  // payroll engine will handle any overflow.
  const isPaidRequest = leaveType !== 'unpaid';
  if (isPaidRequest) {
    const u = await User.findById(req.user._id).select('leaveBalance role');
    const allowance = Number(u?.leaveBalance?.yearlyAllowance) || 0;
    const used      = Number(u?.leaveBalance?.used) || 0;
    const remaining = Math.max(0, allowance - used);
    if (remaining < days && req.user.role === 'employee') {
      res.status(400);
      throw new Error(
        `You do not have sufficient leave balance (${remaining} day(s) remaining, ${days} requested). ` +
        `Please apply as Unpaid Leave or contact HR.`,
      );
    }
  }

  const lv = await Leave.create({
    employee: req.user._id,
    fromDate: from,
    toDate: to,
    leaveType,
    reason,
    days,
    dayType,
    // Lock paid flag at apply-time based on the requested type so the
    // decide() flow respects the employee's explicit choice instead of
    // silently flipping paid → unpaid on no-balance approvals.
    paid: isPaidRequest,
  });

  // Phase 54 -- link any orphan attachments the employee uploaded
  // during the two-phase apply flow.  Silent no-op when the client
  // didn't send any; strict ownership check on the update filter so
  // one employee can never re-parent another's attachments.
  const rawIds = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds : [];
  const attachmentIds = rawIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  let linkedCount = 0;
  if (attachmentIds.length > 0) {
    try {
      const r = await LeaveAttachment.updateMany(
        {
          _id: { $in: attachmentIds },
          employee: req.user._id,
          leave: null,
        },
        { $set: { leave: lv._id } },
      );
      linkedCount = r.modifiedCount || 0;
    } catch (e) {
      // Non-fatal: leave stays created even if the link step fails.
      // The employee can re-upload from an HR-requested doc flow
      // once we add that endpoint.
      console.error('[leaveAttachments] link failed:', e.message);
    }
  }

  // Phase 45 -- HOD informational copy DISABLED (reclassified as noise;
  // HR + Super Admin still get the canonical "leave applied" alert
  // below, and the HOD sees pending leaves in their Leave panel).

  // Global notification: HR + Super Admin see every new leave request.
  notify.notifyLeaveApplied({ leave: lv, employee: req.user });

  // Enrich the response with attachment metadata so the client can
  // update its list without a second round-trip.
  const attMap = await _attachmentsForLeaves([lv._id]);
  const withAttachments = {
    ...lv.toObject(),
    attachments: attMap.get(String(lv._id)) || [],
    attachmentsLinked: linkedCount,
  };
  res.status(201).json(withAttachments);
});

/**
 * Employee lists own leaves.
 */
const myLeaves = asyncHandler(async (req, res) => {
  const items = await Leave.find({ employee: req.user._id }).sort({ createdAt: -1 }).lean();
  // Phase 54 -- splice attachment metadata into each leave so the
  // history view can render "Supporting Documents" without a second
  // fetch per row.
  const attMap = await _attachmentsForLeaves(items.map((i) => i._id));
  const enriched = items.map((i) => ({
    ...i,
    attachments: attMap.get(String(i._id)) || [],
  }));
  res.json(enriched);
});

/**
 * HR lists all leaves.
 */
const listAll = asyncHandler(async (req, res) => {
  const { status, employee, audience } = req.query;
  const where = {};
  if (status) where.status = status;
  if (employee) where.employee = employee;

  let items = await Leave.find(where)
    .populate('employee', 'name employeeId email role')
    .sort({ createdAt: -1 })
    .lean();

  // RBAC-aware scoping:
  //   - HR: only sees employee-role leaves (cannot decide HR leaves)
  //   - Super Admin: chooses audience (default = ALL, including legacy
  //                  leaves where the populated role might be missing)
  if (req.user.role === 'hr') {
    items = items.filter((l) => l.employee?.role === 'employee' || !l.employee?.role);
  } else if (audience === 'hr') {
    items = items.filter((l) => l.employee?.role === 'hr' || l.employee?.role === 'super_admin');
  } else if (audience === 'employee') {
    items = items.filter((l) => l.employee?.role === 'employee' || !l.employee?.role);
  }
  // audience omitted (or 'all') for Super Admin -> return everything

  // Phase 54 -- attach supporting-document metadata (bytes NOT included).
  const attMap = await _attachmentsForLeaves(items.map((i) => i._id));
  const enriched = items.map((i) => ({
    ...i,
    attachments: attMap.get(String(i._id)) || [],
  }));
  res.json(enriched);
});

/**
 * HR approves / rejects.  Determines paid vs unpaid based on
 * current leave balance.
 */
const decide = asyncHandler(async (req, res) => {
  const { decision, hrNote } = req.body;
  if (!['approved', 'rejected'].includes(decision)) {
    res.status(400);
    throw new Error('decision must be approved or rejected');
  }
  const lv = await Leave.findById(req.params.id);
  if (!lv) { res.status(404); throw new Error('Leave not found'); }
  if (lv.status !== 'pending') { res.status(400); throw new Error('Leave already decided'); }

  // Role-aware routing: HR leaves can only be decided by a Super Admin.
  // HR cannot approve their own leave or another HR's leave.
  const requester = await User.findById(lv.employee).select('role');
  if (requester?.role === 'hr' && req.user.role !== 'super_admin') {
    res.status(403);
    throw new Error('Only a Super Admin can approve HR leave requests.');
  }
  if (String(lv.employee) === String(req.user._id)) {
    res.status(403);
    throw new Error('You cannot decide on your own leave request.');
  }

  if (decision === 'approved') {
    // Phase 2.5 rule: respect the employee's chosen leaveType.
    //   - 'unpaid' -> never deducts balance, marked unpaid attendance.
    //   - everything else -> deducts balance.  If the balance is short
    //     (HR over-allocated on behalf of the employee), the excess
    //     spills into negative `used` so the payroll engine can see and
    //     deduct salary for the uncovered days.
    const user = await User.findById(lv.employee);
    if (lv.leaveType === 'unpaid') {
      lv.paid = false;
    } else {
      lv.paid = true;
      user.leaveBalance.used = (user.leaveBalance.used || 0) + lv.days;
      await user.save();
    }
  }

  lv.status = decision;
  lv.decidedBy = req.user._id;
  lv.decidedAt = new Date();
  lv.hrNote = hrNote;
  await lv.save();

  // Mirror the approval into Attendance so the calendar reflects the
  // leave days immediately + HR can revoke from there.  Fire-and-forget
  // shape so a transient Attendance write error never undoes the approval.
  if (decision === 'approved') {
    try {
      const { syncAttendanceForLeave } = require('../services/leaveAttendance');
      const result = await syncAttendanceForLeave(lv);
      console.log(`[leave→att] approved ${lv._id}: created ${result.created} / kept ${result.kept}`);
    } catch (e) {
      console.error(`[leave→att] sync failed for ${lv._id}: ${e.message}`);
    }
  }

  logAudit(req, {
    action: requester?.role === 'hr' ? 'leave.decide.hr' : 'leave.decide.employee',
    targetType: 'Leave',
    targetId: lv._id,
    targetLabel: `${requester?.role || 'user'} ${lv.fromDate.toISOString().slice(0, 10)} → ${lv.toDate.toISOString().slice(0, 10)}`,
    meta: { decision, paid: lv.paid, hrNote: hrNote || '' },
  });

  // Notify the leave owner of the HR decision.
  notify.notifyLeaveDecision({ leave: lv, decidedBy: req.user, decision });

  res.json(lv);
});

/**
 * HR updates leave-balance config for an employee.
 */
const setBalance = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) { res.status(404); throw new Error('Employee not found'); }
  const { yearlyAllowance, monthlyAllowance, used, resetDate } = req.body;
  if (yearlyAllowance !== undefined) user.leaveBalance.yearlyAllowance = yearlyAllowance;
  if (monthlyAllowance !== undefined) user.leaveBalance.monthlyAllowance = monthlyAllowance;
  if (used !== undefined) user.leaveBalance.used = used;
  if (resetDate !== undefined) user.leaveBalance.resetDate = resetDate;
  await user.save();
  res.json(user);
});

/**
 * Calendar view (HR): all approved leaves in a month.
 */
const calendar = asyncHandler(async (req, res) => {
  const { year, month } = req.query;
  const y = Number(year) || new Date().getFullYear();
  const m = Number(month) || new Date().getMonth() + 1;
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const items = await Leave.find({
    status: 'approved',
    fromDate: { $lt: to },
    toDate: { $gte: from },
  }).populate('employee', 'name employeeId');
  res.json(items);
});

/**
 * POST /api/leaves/:id/revoke
 * HR / Super Admin can pull back an already-approved leave.  Restores
 * the consumed paid-leave units onto the employee's balance, marks the
 * leave 'revoked' (so attendance derive + leave analytics ignore it),
 * notifies the employee, and writes an audit log entry.
 *
 * Role guards mirror the decide() flow:
 *   - HR cannot revoke an HR / Super Admin leave (Super Admin only).
 *   - Caller cannot revoke their own leave.
 *
 * Attendance auto-clears: deriveAttendance() filters on status:'approved',
 * so the day-by-day calendar reverts to its derived state (present /
 * weekly off / etc.) without further action.
 */
const revoke = asyncHandler(async (req, res) => {
  const lv = await Leave.findById(req.params.id);
  if (!lv) { res.status(404); throw new Error('Leave not found'); }
  if (lv.status !== 'approved') {
    res.status(400);
    throw new Error(`Only an approved leave can be revoked (current status: ${lv.status}).`);
  }

  const requester = await User.findById(lv.employee).select('role name email');
  if (requester?.role === 'hr' && req.user.role !== 'super_admin') {
    res.status(403);
    throw new Error('Only a Super Admin can revoke HR leave approvals.');
  }
  if (String(lv.employee) === String(req.user._id)) {
    res.status(403);
    throw new Error('You cannot revoke your own leave.');
  }

  const reason = (req.body?.reason || '').trim();
  // Reason is encouraged but not strictly required so HR can act quickly.

  // Restore the exact units consumed (lv.days), but only if the leave
  // was paid -- unpaid approvals never touched the balance.
  if (lv.paid) {
    const user = await User.findById(lv.employee);
    if (user) {
      const cur = Number(user.leaveBalance?.used) || 0;
      // Math.max with 0 protects against accidental negatives if the
      // balance was manually edited downstream.
      user.leaveBalance.used = Math.max(0, Math.round((cur - lv.days) * 100) / 100);
      await user.save();
    }
  }

  lv.status = 'revoked';
  lv.revokedBy = req.user._id;
  lv.revokedAt = new Date();
  lv.revokeReason = reason;
  await lv.save();

  // Drop every leave-linked Attendance record so the calendar reverts to
  // its derived state (Present / Absent / Weekly Off / etc.).  Manual
  // overrides HR may have authored separately on the same days are NOT
  // touched -- those records have leaveId=null.
  try {
    const { clearAttendanceForLeave } = require('../services/leaveAttendance');
    const r = await clearAttendanceForLeave(lv._id);
    console.log(`[leave→att] revoked ${lv._id}: deleted ${r.deleted} attendance record(s)`);
  } catch (e) {
    console.error(`[leave→att] clear failed for ${lv._id}: ${e.message}`);
  }

  // Phase 45 -- DISABLED.  Spec keeps only "leave approved" / "leave
  // rejected" notifications; revocation is not in that meaningful set.
  // The leave will visibly disappear from the employee's My Leaves
  // page, which is the canonical place to learn about it.

  logAudit(req, {
    action: requester?.role === 'hr' ? 'leave.revoke.hr' : 'leave.revoke.employee',
    targetType: 'Leave',
    targetId: lv._id,
    targetLabel: `${requester?.name || 'user'} ${lv.fromDate.toISOString().slice(0, 10)} → ${lv.toDate.toISOString().slice(0, 10)}`,
    meta: { days: lv.days, paid: lv.paid, reason, restored: lv.paid ? lv.days : 0 },
  });

  res.json(lv);
});

module.exports = { apply, myLeaves, listAll, decide, setBalance, calendar, revoke };
