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

/** UTC-midnight equality helper used by the edit-half-day validator. */
const _dayEq = (a, b) => {
  const x = startOfDay(new Date(a)); const y = startOfDay(new Date(b));
  return x.getTime() === y.getTime();
};

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
  // Phase 73 -- unified holiday set (Holiday collection + Event.isHoliday).
  const { holidayDaySet } = require('../services/eventOccurrences');
  const holidaySet = await holidayDaySet(from, to);
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
  //
  // businessStateSync then walks every date in the leave window and
  // brings Submissions + Compliance + Realtime nudges into sync as
  // well.  ensureDailySubmissions/incidentService are idempotent, so
  // this stays safe under retries.
  let syncSummary = null;
  if (decision === 'approved') {
    try {
      const { syncAttendanceForLeave } = require('../services/leaveAttendance');
      const result = await syncAttendanceForLeave(lv);
      console.log(`[leave→att] approved ${lv._id}: created ${result.created} / kept ${result.kept}`);
    } catch (e) {
      console.error(`[leave→att] sync failed for ${lv._id}: ${e.message}`);
    }
    try {
      const businessStateSync = require('../services/businessStateSync');
      syncSummary = await businessStateSync.syncForLeave(lv, {
        trigger: 'leave_changed', actor: req.user._id,
        reason: `leave approved (${lv.dayType})`,
      });
    } catch (e) {
      console.error(`[leave→sync] approved ${lv._id}: ${e.message}`);
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

  // Emit the domain event for future subscribers (compliance re-tick,
  // analytics warm, etc.).  Existing subscribers already fan out via
  // notifyEvents above; the bus emission is additive.
  try {
    require('../services/events').publish('leave.status.changed', {
      leaveId: String(lv._id),
      employeeId: String(lv.employee),
      previousStatus: 'pending',
      newStatus: decision,
      dayType: lv.dayType,
      fromDate: lv.fromDate,
      toDate: lv.toDate,
      trigger: 'decide',
      actor: String(req.user._id),
    });
  } catch (_) { /* silent */ }

  res.json({ ...lv.toObject(), sync: syncSummary });
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

  // Bring Submissions + Compliance + Realtime nudges back into sync.
  // Every day previously covered by the revoked leave needs to be
  // re-materialised (or, if a full-day suppression had been applied,
  // un-hidden) via businessStateSync.
  let syncSummary = null;
  try {
    const businessStateSync = require('../services/businessStateSync');
    syncSummary = await businessStateSync.syncForLeave(lv, {
      trigger: 'leave_changed', actor: req.user._id,
      reason: `leave revoked: ${reason || 'no reason'}`,
    });
  } catch (e) {
    console.error(`[leave→sync] revoke ${lv._id}: ${e.message}`);
  }

  try {
    require('../services/events').publish('leave.status.changed', {
      leaveId: String(lv._id),
      employeeId: String(lv.employee),
      previousStatus: 'approved',
      newStatus: 'revoked',
      dayType: lv.dayType,
      fromDate: lv.fromDate,
      toDate: lv.toDate,
      trigger: 'revoke',
      actor: String(req.user._id),
    });
  } catch (_) { /* silent */ }

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

  res.json({ ...lv.toObject(), sync: syncSummary });
});

/* ================================================================
 *  Phase 76 -- Proper Leave Edit (PUT /leaves/:id)
 *
 *  Preserves the original document so audit history / attachments /
 *  linked references stay intact.  Recognised mutations:
 *
 *    dayType     ('full' <-> 'half')  -- must remain a single-day
 *                                         leave when 'half'.
 *    fromDate    -- clamped to <= toDate; only allowed to move.
 *    toDate      -- clamped to >= fromDate.
 *    leaveType   -- casual / sick / paid / unpaid / other.
 *    reason      -- free text.
 *    hrNote      -- free text.
 *    paid        -- explicit override (unpaid <-> paid).
 *
 *  A body of shape { force: true, forceReason: '...' } will suppress
 *  in-progress submissions when the new state is a full-day leave.
 *  Without `force`, the endpoint returns 409 with a conflict payload
 *  the frontend renders as the "Options" prompt from the spec.
 *
 *  Balance is reconciled based on days-delta so the ledger stays
 *  correct across full<->half + date-range edits.  ONE syncForLeave
 *  call fires at the end; ONE audit log entry captures the diff.
 * ================================================================ */
const edit = asyncHandler(async (req, res) => {
  const lv = await Leave.findById(req.params.id);
  if (!lv) { res.status(404); throw new Error('Leave not found'); }
  if (lv.status !== 'approved') {
    res.status(400);
    throw new Error(`Only an approved leave can be edited (current status: ${lv.status}).`);
  }

  const requester = await User.findById(lv.employee).select('role name');
  if (requester?.role === 'hr' && req.user.role !== 'super_admin') {
    res.status(403); throw new Error('Only a Super Admin can edit HR leave.');
  }
  if (String(lv.employee) === String(req.user._id)) {
    res.status(403); throw new Error('You cannot edit your own leave.');
  }

  // Capture the pre-image so businessStateSync can walk the UNION of
  // the old and new day ranges (edits that shrink the window need to
  // sync the days that dropped off).
  const previous = {
    fromDate: lv.fromDate, toDate: lv.toDate,
    dayType:  lv.dayType,  leaveType: lv.leaveType,
    days:     lv.days,     paid: lv.paid,
    reason:   lv.reason,   hrNote: lv.hrNote,
  };

  const body = req.body || {};
  const patch = {};
  if (body.dayType   && ['full', 'half'].includes(body.dayType))   patch.dayType   = body.dayType;
  if (body.leaveType && ['casual', 'sick', 'paid', 'unpaid', 'other'].includes(body.leaveType)) patch.leaveType = body.leaveType;
  if (body.reason    !== undefined) patch.reason    = String(body.reason || '').trim();
  if (body.hrNote    !== undefined) patch.hrNote    = String(body.hrNote || '').trim();
  if (body.fromDate  !== undefined) patch.fromDate  = startOfDay(new Date(body.fromDate));
  if (body.toDate    !== undefined) patch.toDate    = startOfDay(new Date(body.toDate));
  if (body.paid      !== undefined) patch.paid      = !!body.paid;

  const forced = !!body.force;
  const forceReason = String(body.forceReason || '').trim();

  // Apply the patch to a working copy and validate.
  const next = {
    fromDate:  patch.fromDate  || lv.fromDate,
    toDate:    patch.toDate    || lv.toDate,
    dayType:   patch.dayType   || lv.dayType,
    leaveType: patch.leaveType || lv.leaveType,
    paid:      patch.paid      !== undefined ? patch.paid : lv.paid,
  };
  const isSingleDay = _dayEq(next.fromDate, next.toDate);
  if (next.dayType === 'half' && !isSingleDay) {
    res.status(400); throw new Error('Half-day leave is only allowed on a single-day request.');
  }
  if (new Date(next.fromDate).getTime() > new Date(next.toDate).getTime()) {
    res.status(400); throw new Error('fromDate must be <= toDate.');
  }

  // Days delta = new units - old units.  Balance is only touched on
  // paid leaves.  Unpaid <-> paid transitions credit / debit the full
  // new day count.
  const nextDays = next.dayType === 'half'
    ? 0.5
    : (Math.max(1, Math.round((new Date(next.toDate).getTime() - new Date(next.fromDate).getTime()) / 86400000) + 1));

  // Conflict pre-check (before mutating anything): if the NEW state
  // is a full-day leave, dry-run the sync to see whether any day now
  // suppresses a Submission with employee work.
  const bss = require('../services/businessStateSync');
  const willBeFullDay = next.dayType === 'full';
  if (willBeFullDay && !forced) {
    try {
      const dry = await bss.syncEmployeeRange({
        employeeId: lv.employee,
        from: new Date(Math.min(new Date(previous.fromDate).getTime(), new Date(next.fromDate).getTime())),
        to:   new Date(Math.max(new Date(previous.toDate).getTime(),   new Date(next.toDate).getTime())),
        trigger: 'leave_changed',
        actor: req.user._id,
        dryRun: true,
      });
      const workConflicts = (dry.conflicts || []).filter((c) => c.code === 'submission_has_work');
      // We DRY-RAN against the CURRENT leave state.  To predict the
      // NEW state, we also need to consider the days that will now be
      // covered by a full-day leave but currently are not (e.g. half
      // -> full).  Simplest correct: also dry-run each new-window day
      // via a shim leave override.
      if (patch.dayType === 'full' && lv.dayType !== 'full') {
        // For same-day edits, check today's existing sub for work.
        const dayStart = startOfDay(next.fromDate);
        const existing = await Submission.find({
          employee: lv.employee, date: dayStart,
          deleted: { $ne: true }, hidden: { $ne: true },
        });
        for (const sub of existing) {
          if (bss._hasEmployeeWork(sub)) {
            workConflicts.push({
              code: 'submission_has_work', submissionId: sub._id,
              template: sub.template,
              message: 'Employee has already started work on this submission.',
              date: startOfDay(next.fromDate).toISOString().slice(0, 10),
            });
          }
        }
      }
      if (workConflicts.length > 0) {
        res.status(409).json({
          conflict: true,
          code: 'submission_has_work',
          message: 'Employee has already started today\'s work. Provide force:true with forceReason to proceed.',
          conflicts: workConflicts,
        });
        return;
      }
    } catch (e) { console.error('[leave.edit conflict pre-check]', e.message); }
  }

  // Apply the patch to the persistent doc.
  Object.assign(lv, patch);
  lv.days = nextDays;
  await lv.save();

  // Reconcile balance: adjust user.leaveBalance.used by (new - old) IF
  // paid; unpaid -> paid transitions debit fully; paid -> unpaid credits
  // fully.
  const user = await User.findById(lv.employee);
  if (user) {
    const wasPaid = previous.paid;
    const isPaid  = lv.paid;
    let delta = 0;
    if (wasPaid && isPaid)  delta = nextDays - (Number(previous.days) || 0);
    else if (!wasPaid && isPaid) delta = nextDays;
    else if (wasPaid && !isPaid) delta = -(Number(previous.days) || 0);
    if (delta !== 0) {
      const cur = Number(user.leaveBalance?.used) || 0;
      user.leaveBalance.used = Math.max(0, Math.round((cur + delta) * 100) / 100);
      await user.save();
    }
  }

  // Attendance sync -- reuse existing helper.  Clear the old rows
  // (leave-linked) then re-materialise via syncAttendanceForLeave so
  // shrunk / moved windows drop old days.
  try {
    const leaveAtt = require('../services/leaveAttendance');
    await leaveAtt.clearAttendanceForLeave(lv._id);
    await leaveAtt.syncAttendanceForLeave(lv);
  } catch (e) { console.error('[leave.edit attendance]', e.message); }

  // Business-state sync across the UNION of previous + new window.
  let syncSummary = null;
  try {
    syncSummary = await bss.syncForLeave(lv, {
      trigger: 'leave_changed', actor: req.user._id, previous,
      force: forced, reason: forceReason || `edit: ${previous.dayType} -> ${lv.dayType}`,
    });
  } catch (e) { console.error('[leave.edit sync]', e.message); }

  // Audit + event bus.
  logAudit(req, {
    action: 'leave.edit',
    targetType: 'Leave', targetId: lv._id,
    targetLabel: `edit ${lv.fromDate.toISOString().slice(0, 10)} → ${lv.toDate.toISOString().slice(0, 10)}`,
    meta: {
      previous: {
        fromDate: previous.fromDate, toDate: previous.toDate,
        dayType: previous.dayType, leaveType: previous.leaveType,
        days: previous.days, paid: previous.paid, reason: previous.reason, hrNote: previous.hrNote,
      },
      next: {
        fromDate: lv.fromDate, toDate: lv.toDate,
        dayType: lv.dayType, leaveType: lv.leaveType,
        days: lv.days, paid: lv.paid, reason: lv.reason, hrNote: lv.hrNote,
      },
      forced, forceReason: forced ? forceReason : '',
    },
  });
  try {
    require('../services/events').publish('leave.status.changed', {
      leaveId: String(lv._id),
      employeeId: String(lv.employee),
      previousStatus: 'approved',
      newStatus: 'approved',
      previous: {
        fromDate: previous.fromDate, toDate: previous.toDate,
        dayType: previous.dayType, days: previous.days, paid: previous.paid,
      },
      next: {
        fromDate: lv.fromDate, toDate: lv.toDate,
        dayType: lv.dayType, days: lv.days, paid: lv.paid,
      },
      trigger: 'edit',
      actor: String(req.user._id),
    });
  } catch (_) { /* silent */ }

  res.json({ ...lv.toObject(), sync: syncSummary });
});

module.exports = { apply, myLeaves, listAll, decide, setBalance, calendar, revoke, edit };
