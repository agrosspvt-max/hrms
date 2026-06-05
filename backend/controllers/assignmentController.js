const asyncHandler = require('express-async-handler');
const Assignment = require('../models/Assignment');
const User = require('../models/User');
const Submission = require('../models/Submission');
const DependencyTask = require('../models/DependencyTask');
const { buildScheduleLabel } = require('../utils/scheduleHelpers');

/**
 * Normalise recurrence config based on the chosen frequency and return the
 * fields to persist (including a freshly-built scheduleLabel).  Clears the
 * irrelevant recurrence field so stale weekly/monthly values can't linger.
 */
const normaliseSchedule = ({ frequency, weeklyDay, monthlyDate, startDate, endDate }) => {
  const out = { frequency: frequency || 'daily', startDate, endDate };

  if (out.frequency === 'weekly') {
    out.weeklyDay = weeklyDay != null && weeklyDay !== '' ? Math.min(6, Math.max(0, Number(weeklyDay))) : 1; // default Monday
    out.monthlyDate = null;
  } else if (out.frequency === 'monthly') {
    out.monthlyDate = monthlyDate != null && monthlyDate !== '' ? Math.min(31, Math.max(1, Number(monthlyDate))) : 1;
    out.weeklyDay = null;
  } else {
    out.weeklyDay = null;
    out.monthlyDate = null;
  }

  out.scheduleLabel = buildScheduleLabel(out);
  return out;
};

const list = asyncHandler(async (req, res) => {
  // ?employee=<id> returns every assignment that APPLIES to that employee:
  // their direct employee-level assignments plus any inherited via their
  // department / designation (matching the daily-engine targeting rules).
  if (req.query.employee) {
    const emp = await User.findById(req.query.employee).select('department designation');
    if (!emp) { res.status(404); throw new Error('Employee not found'); }
    const or = [{ targetType: 'employee', targetRef: emp._id }];
    if (emp.department) or.push({ targetType: 'department', targetRef: emp.department });
    if (emp.designation) or.push({ targetType: 'designation', targetRef: emp.designation });
    const items = await Assignment.find({ $or: or })
      .populate('template', 'title templateType tasks')
      .sort({ createdAt: -1 });
    return res.json(items);
  }
  const items = await Assignment.find({})
    .populate('template', 'title templateType tasks')
    .sort({ createdAt: -1 });
  res.json(items);
});

/**
 * Guard: HR may not target HR / Super Admin users with a template,
 * and HR may not target themselves.  Super Admin has no such limits.
 */
const guardHRTarget = async (req, assignment) => {
  if (req.user.role !== 'hr') return null; // super_admin: no restrictions
  const { targetType, targetRef } = assignment;
  if (targetType !== 'employee') return null;
  if (String(targetRef) === String(req.user._id)) {
    return 'HR cannot assign or modify tasks for themselves.';
  }
  const target = await User.findById(targetRef).select('role');
  if (!target) return 'Target user not found.';
  if (target.role === 'hr' || target.role === 'super_admin') {
    return 'HR cannot assign or modify tasks targeting HR or Super Admin accounts.';
  }
  return null;
};

const create = asyncHandler(async (req, res) => {
  const { template, targetType, targetRef } = req.body;
  if (!template || !targetType || !targetRef) {
    res.status(400);
    throw new Error('template, targetType and targetRef are required');
  }
  const reason = await guardHRTarget(req, { targetType, targetRef });
  if (reason) { res.status(403); throw new Error(reason); }

  const schedule = normaliseSchedule(req.body);

  const a = await Assignment.create({
    template, targetType, targetRef,
    ...schedule,
    priority: ['low', 'normal', 'high'].includes(req.body.priority) ? req.body.priority : 'normal',
    holidayOverride: !!req.body.holidayOverride,
    overrideScope: req.body.overrideScope === 'all' ? 'all' : 'once',
    overrideReason: (req.body.overrideReason || '').trim(),
    createdBy: req.user._id,
  });
  res.status(201).json(await a.populate('template', 'title templateType tasks'));
});

const update = asyncHandler(async (req, res) => {
  const existing = await Assignment.findById(req.params.id);
  if (!existing) { res.status(404); throw new Error('Assignment not found'); }

  // Guard the *current* row first (so HR can't escape via updating
  // a row that targets them), then the proposed change.
  const before = await guardHRTarget(req, existing);
  if (before) { res.status(403); throw new Error(before); }
  if (req.body.targetType || req.body.targetRef) {
    const next = {
      targetType: req.body.targetType || existing.targetType,
      targetRef: req.body.targetRef || existing.targetRef,
    };
    const after = await guardHRTarget(req, next);
    if (after) { res.status(403); throw new Error(after); }
  }

  // Recompute the recurrence config + label whenever any scheduling field
  // is touched, merging the request over the existing values.
  const update = { ...req.body };
  const touchesSchedule = ['frequency', 'weeklyDay', 'monthlyDate', 'startDate', 'endDate']
    .some((k) => k in req.body);
  if (touchesSchedule) {
    Object.assign(update, normaliseSchedule({
      frequency: req.body.frequency ?? existing.frequency,
      weeklyDay: req.body.weeklyDay ?? existing.weeklyDay,
      monthlyDate: req.body.monthlyDate ?? existing.monthlyDate,
      startDate: req.body.startDate ?? existing.startDate,
      endDate: req.body.endDate ?? existing.endDate,
    }));
  }

  const a = await Assignment.findByIdAndUpdate(req.params.id, update, { new: true })
    .populate('template', 'title templateType tasks');
  res.json(a);
});

const remove = asyncHandler(async (req, res) => {
  const existing = await Assignment.findById(req.params.id);
  if (!existing) { res.status(404); throw new Error('Assignment not found'); }
  const reason = await guardHRTarget(req, existing);
  if (reason) { res.status(403); throw new Error(reason); }
  await Assignment.findByIdAndDelete(req.params.id);
  res.json({ message: 'Assignment deleted' });
});

/**
 * POST /api/assignments/:id/revoke    (HR / Super Admin)
 *
 * Soft revoke -- the assignment stays in the database for audit, but:
 *   1. `active` flips to false so the daily engine stops generating
 *      new submissions on subsequent days.
 *   2. Every UN-SUBMITTED submission tied to this assignment is
 *      deleted (employee instantly stops seeing the work).  Submitted
 *      history is preserved untouched.
 *   3. revokedAt / revokedBy / revokeReason are stamped.
 *   4. Audit log entry written.
 *
 * Body: { reason?: string }
 */
const revoke = asyncHandler(async (req, res) => {
  const a = await Assignment.findById(req.params.id).populate('template', 'title');
  if (!a) { res.status(404); throw new Error('Assignment not found'); }
  const denied = await guardHRTarget(req, a);
  if (denied) { res.status(403); throw new Error(denied); }
  if (!a.active && a.revokedAt) {
    res.status(400); throw new Error('Assignment is already revoked.');
  }

  const reason = (req.body?.reason || '').trim();

  // Snapshot how many un-submitted rows we're about to delete so the
  // audit log captures the impact.  Submitted submissions are kept.
  const unsubmittedDeleted = await Submission.deleteMany({
    assignment: a._id,
    submitted: false,
  });

  a.active = false;
  a.revokedAt = new Date();
  a.revokedBy = req.user._id;
  a.revokeReason = reason;
  await a.save();

  // Audit log -- captures who / when / what / impact.
  const { logAudit } = require('../utils/audit');
  logAudit(req, {
    action: 'assignment.revoke',
    targetType: 'Assignment',
    targetId: a._id,
    targetLabel: `${a.template?.title || '(template gone)'} → ${a.targetType}:${a.targetRef}`,
    meta: {
      reason,
      unsubmittedDeleted: unsubmittedDeleted?.deletedCount || 0,
      frequency: a.frequency,
    },
  });

  res.json({
    message: 'Assignment revoked',
    assignment: a,
    unsubmittedDeleted: unsubmittedDeleted?.deletedCount || 0,
  });
});

/**
 * GET /api/assignments/:id/stats
 * Per-assignment detail drawer payload: assignment + template + creator,
 * submission counts (done/pending units), reviewed share, dependency
 * count, and the most recent submissions.  Read-only.
 */
const stats = asyncHandler(async (req, res) => {
  const a = await Assignment.findById(req.params.id)
    .populate('template', 'title templateType tasks excelColumns sheet statusTracking')
    .populate('createdBy', 'name employeeId role');
  if (!a) { res.status(404); throw new Error('Assignment not found'); }

  const subs = await Submission.find({ assignment: a._id })
    .select('employee date submittedAt templateType tasks excelResponses sheet.scores reviewStatus')
    .populate('employee', 'name employeeId')
    .sort({ date: -1 }).limit(60).lean();

  let pendingUnits = 0, doneUnits = 0;
  for (const s of subs) {
    if (s.templateType === 'task') {
      for (const t of s.tasks || []) { if (t.status === 'done') doneUnits += 1; else if (t.status === 'pending') pendingUnits += 1; }
    } else if (s.templateType === 'excel') {
      for (const r of s.excelResponses || []) { if (r.rowStatus === 'done') doneUnits += 1; else if (r.rowStatus === 'pending') pendingUnits += 1; }
    } else if (s.templateType === 'sheet') {
      for (const sc of (s.sheet && s.sheet.scores) || []) { if (sc.rowStatus === 'done') doneUnits += 1; else if (sc.rowStatus === 'pending') pendingUnits += 1; }
    }
  }
  const reviewedCount = subs.filter((s) => s.reviewStatus === 'reviewed').length;
  const subIds = subs.map((s) => s._id);
  const dependencyCount = subIds.length ? await DependencyTask.countDocuments({ sourceSubmissionId: { $in: subIds } }) : 0;
  const recent = subs.slice(0, 8).map((s) => ({
    _id: s._id, employee: s.employee?.name || '', employeeId: s.employee?.employeeId || '',
    date: s.date, submittedAt: s.submittedAt, reviewStatus: s.reviewStatus,
  }));

  res.json({
    assignment: a,
    stats: { submissions: subs.length, pendingUnits, doneUnits, reviewedCount, dependencyCount },
    recent,
  });
});

module.exports = { list, create, update, remove, stats, revoke };
