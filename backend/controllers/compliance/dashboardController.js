/**
 * dashboardController.js -- aggregation endpoints for the HR
 * Compliance Dashboard (Phase 8).  Every handler is HR / Super Admin
 * only and gated by `compliance.dashboardV2`.
 *
 * Aggregations run against the in-memory Mongo query planner; caching
 * is intentionally not added here (60s LRU is Phase 8+ optional).
 */

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const ComplianceIncident = require('../../models/ComplianceIncident');
const ComplianceWaiver = require('../../models/ComplianceWaiver');
const FinancialLedger = require('../../models/FinancialLedger');
const User = require('../../models/User');
const { isEnabled } = require('../../config/featureFlags');

const _isAdmin = (u) => u && (u.role === 'hr' || u.role === 'super_admin');

const _flagGate = (res) => {
  if (!isEnabled('compliance.dashboardV2')) {
    res.status(404);
    throw new Error('Compliance dashboards are not enabled on this deployment.');
  }
};

const _adminGate = (req, res) => {
  _flagGate(res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
};

const _range = (req) => {
  const from = req.query.from ? new Date(req.query.from) : null;
  const to   = req.query.to   ? new Date(req.query.to)   : null;
  return { from, to };
};

const _dateClause = ({ from, to }, field = 'incidentDate') => {
  const c = {};
  if (from) c.$gte = from;
  if (to)   c.$lte = to;
  return Object.keys(c).length ? { [field]: c } : {};
};

// -----------------------------------------------------------
// Overview summary tiles.
// -----------------------------------------------------------
const summary = asyncHandler(async (req, res) => {
  _adminGate(req, res);
  const range = _range(req);
  const where = { ..._dateClause(range) };
  const [total, active, waived, resolved, cancelled, pendingWaivers, financialTotalRow] = await Promise.all([
    ComplianceIncident.countDocuments(where),
    ComplianceIncident.countDocuments({ ...where, status: 'active' }),
    ComplianceIncident.countDocuments({ ...where, status: 'waived' }),
    ComplianceIncident.countDocuments({ ...where, status: 'resolved' }),
    ComplianceIncident.countDocuments({ ...where, status: 'cancelled' }),
    ComplianceWaiver.countDocuments({ status: 'pending' }),
    FinancialLedger.aggregate([
      { $match: {
        ...(range.from || range.to ? { date: { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lte: range.to } : {}) } } : {}),
        direction: -1,
      } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]),
  ]);
  res.json({
    total, active, waived, resolved, cancelled,
    pendingWaivers,
    financialTotal: financialTotalRow.length ? financialTotalRow[0].total : 0,
  });
});

// -----------------------------------------------------------
// Most-penalised employees over the window.
// -----------------------------------------------------------
const mostPenalised = asyncHandler(async (req, res) => {
  _adminGate(req, res);
  const range = _range(req);
  const rows = await ComplianceIncident.aggregate([
    { $match: { ..._dateClause(range) } },
    { $group: { _id: '$employee', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: Math.max(5, Math.min(100, Number(req.query.limit) || 20)) },
  ]);
  const ids = rows.map((r) => r._id);
  const users = await User.find({ _id: { $in: ids } })
    .select('_id name employeeId department').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  res.json(rows.map((r) => ({
    employee: byId.get(String(r._id)) || null,
    incidentCount: r.count,
  })));
});

// -----------------------------------------------------------
// Most common violations.
// -----------------------------------------------------------
const commonViolations = asyncHandler(async (req, res) => {
  _adminGate(req, res);
  const range = _range(req);
  const rows = await ComplianceIncident.aggregate([
    { $match: { ..._dateClause(range) } },
    { $group: { _id: '$ruleCode', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: Math.max(5, Math.min(50, Number(req.query.limit) || 15)) },
  ]);
  res.json(rows.map((r) => ({ ruleCode: r._id, count: r.count })));
});

// -----------------------------------------------------------
// Pending waivers queue.
// -----------------------------------------------------------
const pendingWaivers = asyncHandler(async (req, res) => {
  _adminGate(req, res);
  const rows = await ComplianceWaiver.find({ status: 'pending' })
    .sort({ requestedAt: 1 }).limit(200).lean();
  const empIds = [...new Set(rows.map((r) => String(r.employee)))];
  const incIds = [...new Set(rows.map((r) => String(r.incidentId)))];
  const [emps, incs] = await Promise.all([
    User.find({ _id: { $in: empIds } }).select('_id name employeeId department').lean(),
    ComplianceIncident.find({ _id: { $in: incIds } }).select('_id ruleCode incidentDate').lean(),
  ]);
  const empById = new Map(emps.map((e) => [String(e._id), e]));
  const incById = new Map(incs.map((i) => [String(i._id), i]));
  res.json(rows.map((r) => ({
    ...r,
    employee: empById.get(String(r.employee)) || null,
    incident: incById.get(String(r.incidentId)) || null,
  })));
});

// -----------------------------------------------------------
// Financial totals per department.
// -----------------------------------------------------------
const financialTotals = asyncHandler(async (req, res) => {
  _adminGate(req, res);
  const range = _range(req);
  const match = { direction: -1 };
  if (range.from || range.to) {
    match.date = {};
    if (range.from) match.date.$gte = range.from;
    if (range.to)   match.date.$lte = range.to;
  }
  const rows = await FinancialLedger.aggregate([
    { $match: match },
    { $lookup: { from: 'users', localField: 'employee', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $group: { _id: '$user.department', total: { $sum: '$quantity' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);
  const deptIds = rows.map((r) => r._id).filter(Boolean);
  const Department = require('../../models/Department');
  const depts = await Department.find({ _id: { $in: deptIds } }).select('name').lean();
  const byId = new Map(depts.map((d) => [String(d._id), d]));
  res.json(rows.map((r) => ({
    departmentId: r._id, department: byId.get(String(r._id)) || null,
    total: r.total, entryCount: r.count,
  })));
});

// -----------------------------------------------------------
// Trends (incidents per day).
// -----------------------------------------------------------
const trends = asyncHandler(async (req, res) => {
  _adminGate(req, res);
  const range = _range(req);
  const rows = await ComplianceIncident.aggregate([
    { $match: { ..._dateClause(range) } },
    { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$incidentDate' } },
        count: { $sum: 1 },
      } },
    { $sort: { _id: 1 } },
  ]);
  res.json(rows.map((r) => ({ day: r._id, count: r.count })));
});

module.exports = {
  summary, mostPenalised, commonViolations, pendingWaivers,
  financialTotals, trends,
};
