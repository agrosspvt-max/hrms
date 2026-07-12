/**
 * penaltyController.js  --  Phase 61 Fines & Penalties module.
 *
 * REST surface:
 *
 *   GET  /api/penalties/dashboard?employee=&from=&to=
 *        -> { active[], probable[], resolved[] }  for the caller
 *           when role === 'employee', or filterable by employee
 *           when role === 'hr' / 'super_admin' / permitted HOD.
 *
 *   GET  /api/penalties/mine
 *        -> convenience shim for the employee dashboard warning card.
 *
 *   POST /api/penalties/manual
 *        -> Create a manual penalty (HR / Super Admin).
 *           { employee, type: 'marks' | 'completion',
 *             marks?, completionPercent?, reason,
 *             graceHours?, durationDays? }
 *
 *   POST /api/penalties/:id/cancel
 *        -> Cancel (only pending/scheduled/active can be cancelled).
 *
 *   POST /api/penalties/:id/acknowledge
 *        -> Employee opened the dashboard warning card.
 *
 *   GET  /api/penalties/analytics/summary?from=&to=&department=
 *        -> Aggregations for Performance Analytics.
 */
const asyncHandler = require('express-async-handler');
const Penalty = require('../models/Penalty');
const User    = require('../models/User');
const { logAudit } = require('../utils/audit');
const { startOfDay } = require('../utils/dateHelpers');
const notify = require('../services/notifyEvents');
// Verification-audit fix -- state-transition sweep (scheduled ->
// active, active -> expired) on every dashboard/mine read so the
// UI never shows a stale bucket.
const { _sweepStateTransitions } = require('../services/penaltyMath');
const rt = require('../services/realtime');

const _isAdmin = (u) => u?.role === 'hr' || u?.role === 'super_admin';
const _isHOD   = (u) => u?.role === 'hod' || u?.isHOD === true;

/** HR/SA see everything; HOD sees only their department if permitted;
 *  employees see only their own penalties. */
const _scopeToUser = async (req) => {
  if (_isAdmin(req.user)) {
    const filter = {};
    if (req.query.employee) filter.employee = req.query.employee;
    if (req.query.department) {
      const emps = await User.find({ department: req.query.department }).select('_id').lean();
      filter.employee = { $in: emps.map((e) => e._id) };
    }
    return filter;
  }
  if (_isHOD(req.user) && req.user.hodDepartment) {
    // HOD-level access requires HR to explicitly grant it via
    // FeaturePermissions -- the route gate handles that check.  Scope
    // is always the HOD's own department.
    const emps = await User.find({ department: req.user.hodDepartment }).select('_id').lean();
    return { employee: { $in: emps.map((e) => e._id) } };
  }
  return { employee: req.user._id };
};

const _dateWindow = (req) => {
  const w = {};
  if (req.query.from) w.$gte = startOfDay(new Date(req.query.from));
  if (req.query.to)   w.$lte = startOfDay(new Date(req.query.to));
  return Object.keys(w).length ? w : null;
};

/**
 * GET /api/penalties/dashboard
 */
const dashboard = asyncHandler(async (req, res) => {
  const scope = await _scopeToUser(req);
  const window = _dateWindow(req);
  const where = { ...scope };
  if (window) where.targetDate = window;
  const rows = await Penalty.find(where)
    .populate('employee', 'name employeeId role department')
    .sort({ effectiveDate: -1, createdAt: -1 })
    .lean();
  // Verification-audit fix -- flush stale grace-period + expiry
  // transitions so buckets always match reality.
  await _sweepStateTransitions(rows);
  const out = { active: [], probable: [], resolved: [] };
  for (const p of rows) {
    if (p.probable && p.status === 'active') out.probable.push(p);
    else if (p.status === 'active' || p.status === 'pending' || p.status === 'scheduled') out.active.push(p);
    else if (p.status === 'resolved' || p.status === 'cancelled' || p.status === 'expired') out.resolved.push(p);
  }
  res.json(out);
});

/**
 * GET /api/penalties/mine  -- employee shortcut.
 */
const mine = asyncHandler(async (req, res) => {
  const rows = await Penalty.find({ employee: req.user._id })
    .sort({ effectiveDate: -1, createdAt: -1 })
    .lean();
  // Verification-audit fix -- same sweep as /dashboard so a
  // grace-period penalty auto-activates the moment the employee
  // reloads their dashboard after expiry.
  await _sweepStateTransitions(rows);
  const out = { active: [], probable: [], resolved: [] };
  for (const p of rows) {
    if (p.probable && p.status === 'active') out.probable.push(p);
    else if (p.status === 'active' || p.status === 'pending' || p.status === 'scheduled') out.active.push(p);
    else out.resolved.push(p);
  }
  res.json(out);
});

/**
 * POST /api/penalties/manual  (HR / Super Admin)
 */
const createManual = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only'); }
  const {
    employee, type,
    marks, completionPercent, reason,
    graceHours, durationDays,
    employeeMessage,
  } = req.body;

  if (!employee) { res.status(400); throw new Error('employee is required'); }
  const target = await User.findById(employee).select('_id name').lean();
  if (!target) { res.status(404); throw new Error('Employee not found'); }

  if (!['marks', 'completion'].includes(type)) {
    res.status(400); throw new Error(`type must be 'marks' or 'completion'`);
  }

  const now = new Date();
  const doc = {
    employee: target._id,
    category: type === 'marks' ? 'manual_marks' : 'manual_completion',
    source: 'manual',
    probable: false,
    penaltyMarks: type === 'marks' ? Math.max(0, Number(marks) || 0) : 0,
    completionPercent: type === 'completion' ? Math.max(0, Math.min(100, Number(completionPercent) || 0)) : 0,
    rule: type === 'marks' ? 'manual_marks_v1' : 'manual_completion_v1',
    reason: String(reason || '').trim(),
    employeeMessage: String(employeeMessage || '').trim(),
    createdBy: req.user._id,
    effectiveDate: now,
    targetDate: startOfDay(now),
    status: 'active',
  };

  // Grace period -> penalty is 'pending' until effectiveDate passes.
  const gh = Number(graceHours) || 0;
  if (gh > 0) {
    doc.effectiveDate = new Date(now.getTime() + gh * 60 * 60 * 1000);
    doc.status = 'scheduled';
  }
  // Duration (completion penalty) -> auto-expire.
  const dd = Number(durationDays) || 0;
  if (type === 'completion' && dd > 0) {
    const from = doc.effectiveDate;
    doc.expiryDate = new Date(from.getTime() + dd * 24 * 60 * 60 * 1000);
  }

  const created = await Penalty.create(doc);
  logAudit(req, {
    action: 'penalty.manual.create',
    targetType: 'Penalty',
    targetId: created._id,
    targetLabel: `${target.name} · ${type}`,
    meta: { type, marks: doc.penaltyMarks, completionPercent: doc.completionPercent, graceHours: gh, durationDays: dd, reason: doc.reason },
  });
  notify.notifyPenalty({ employeeId: target._id, penalty: created.toObject(), mode: 'active' });
  res.json(created);
});

/**
 * POST /api/penalties/:id/cancel   (HR / Super Admin)
 */
const cancel = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only'); }
  const p = await Penalty.findById(req.params.id);
  if (!p) { res.status(404); throw new Error('Penalty not found'); }
  if (!['pending', 'scheduled', 'active'].includes(p.status)) {
    res.status(400); throw new Error('Only active / scheduled penalties can be cancelled');
  }
  p.status = 'cancelled';
  p.cancelledBy = req.user._id;
  p.cancelledAt = new Date();
  p.cancelReason = String(req.body.reason || '').trim();
  await p.save();
  logAudit(req, {
    action: 'penalty.cancel',
    targetType: 'Penalty',
    targetId: p._id,
    targetLabel: `${p.category}`,
    meta: { reason: p.cancelReason },
  });
  // Verification-audit fix -- push a realtime event so the
  // employee's dashboard warning card + Fines & Penalties feed
  // refresh immediately; Final Marks are recomputed on next read.
  try { rt.publish(p.employee, 'penalty:changed', { penaltyId: p._id, status: 'cancelled' }); }
  catch (_) { /* never blocks */ }
  res.json(p);
});

/**
 * POST /api/penalties/:id/acknowledge
 * The employee opened the dashboard warning card.  Only the owning
 * employee can acknowledge.
 */
const acknowledge = asyncHandler(async (req, res) => {
  const p = await Penalty.findById(req.params.id);
  if (!p) { res.status(404); throw new Error('Penalty not found'); }
  if (String(p.employee) !== String(req.user._id) && !_isAdmin(req.user)) {
    res.status(403); throw new Error('Not your penalty');
  }
  if (!p.acknowledgedAt) {
    p.acknowledgedAt = new Date();
    await p.save();
    logAudit(req, {
      action: 'penalty.acknowledge',
      targetType: 'Penalty',
      targetId: p._id,
      targetLabel: `${p.category}`,
      meta: {},
    });
  }
  res.json(p);
});

/**
 * GET /api/penalties/analytics/summary
 * Aggregations for Performance Analytics.
 */
const analyticsSummary = asyncHandler(async (req, res) => {
  const scope = await _scopeToUser(req);
  const window = _dateWindow(req);
  const where = { ...scope, probable: false };
  if (window) where.targetDate = window;
  const rows = await Penalty.find(where).populate('employee', 'name employeeId department').lean();

  const byEmp = {};
  const byReason = {};
  let totalPenaltyMarks = 0;
  let totalCount = 0;
  for (const p of rows) {
    if (p.status !== 'active' && p.status !== 'resolved' && p.status !== 'expired') continue;
    totalCount += 1;
    totalPenaltyMarks += Number(p.penaltyMarks) || 0;
    const ek = String(p.employee?._id || '');
    if (!byEmp[ek]) byEmp[ek] = { employee: p.employee, count: 0, marks: 0 };
    byEmp[ek].count += 1;
    byEmp[ek].marks += Number(p.penaltyMarks) || 0;
    byReason[p.category] = (byReason[p.category] || 0) + 1;
  }
  const mostPenalized = Object.values(byEmp).sort((a, b) => b.marks - a.marks).slice(0, 10);
  res.json({
    totalCount,
    totalPenaltyMarks,
    byReason,
    mostPenalized,
  });
});

module.exports = {
  dashboard, mine, createManual, cancel, acknowledge, analyticsSummary,
};
