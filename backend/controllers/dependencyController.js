const asyncHandler = require('express-async-handler');
const DependencyTask = require('../models/DependencyTask');
const User = require('../models/User');
const { resolveDependencyTask } = require('../services/dependencyEngine');

const isReviewer = (user) => ['hr', 'super_admin'].includes(user.role);

/**
 * GET /api/dependencies/assignable
 * Every active account that can receive a dependency hand-off
 * (employees, HODs, HR, super admin).  Lightweight for a searchable picker.
 */
const assignable = asyncHandler(async (req, res) => {
  const users = await User.find({ status: 'active' })
    .select('name employeeId role isHOD department')
    .populate('department', 'name')
    .sort({ name: 1 })
    .lean();
  res.json(users.map((u) => ({
    _id: u._id,
    name: u.name,
    employeeId: u.employeeId,
    role: u.role,
    isHOD: u.isHOD,
    department: u.department?.name || '',
  })));
});

/**
 * GET /api/dependencies/mine?status=open|in_progress|resolved|all
 * Dependency work assigned TO the current user ("Dependency Work" inbox).
 */
const mine = asyncHandler(async (req, res) => {
  const where = { assignedTo: req.user._id };
  if (req.query.status && req.query.status !== 'all') where.currentStatus = req.query.status;
  const items = await DependencyTask.find(where)
    .populate('assignedBy', 'name employeeId role')
    .populate('department', 'name')
    .sort({ currentStatus: 1, priority: -1, createdAt: -1 });
  res.json(items);
});

/**
 * GET /api/dependencies/mine/count
 * Open dependency-work count for the dashboard badge.
 */
const mineCount = asyncHandler(async (req, res) => {
  const count = await DependencyTask.countDocuments({
    assignedTo: req.user._id,
    currentStatus: { $ne: 'resolved' },
  });
  res.json({ count });
});

/**
 * GET /api/dependencies/created
 * Dependency work the current user has handed off to others.
 */
const created = asyncHandler(async (req, res) => {
  const items = await DependencyTask.find({ assignedBy: req.user._id })
    .populate('assignedTo', 'name employeeId role')
    .sort({ createdAt: -1 });
  res.json(items);
});

/**
 * GET /api/dependencies  (HR / Super Admin)
 * All dependency tasks with optional filters: status, department, assignedTo.
 * Returns who forwarded, who owns it now, and whether it's unresolved.
 */
const listAll = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.status && req.query.status !== 'all') where.currentStatus = req.query.status;
  if (req.query.department) where.department = req.query.department;
  if (req.query.assignedTo) where.assignedTo = req.query.assignedTo;
  const items = await DependencyTask.find(where)
    .populate('assignedTo', 'name employeeId role')
    .populate('assignedBy', 'name employeeId role')
    .populate('department', 'name')
    .sort({ createdAt: -1 });
  res.json(items);
});

/**
 * GET /api/dependencies/chain/:chainId  (HR / Super Admin)
 * Full ordered history of one dependency chain (the escalation path).
 */
const chain = asyncHandler(async (req, res) => {
  const items = await DependencyTask.find({ chainId: req.params.chainId })
    .populate('assignedTo', 'name employeeId role')
    .populate('assignedBy', 'name employeeId role')
    .sort({ createdAt: 1 });
  res.json(items);
});

/**
 * POST /api/dependencies/:id/status   Body: { status: 'in_progress' }
 * The current owner marks the work in progress.
 */
const setStatus = asyncHandler(async (req, res) => {
  const dep = await DependencyTask.findById(req.params.id);
  if (!dep) { res.status(404); throw new Error('Dependency task not found'); }
  const owner = String(dep.assignedTo) === String(req.user._id);
  if (!owner && !isReviewer(req.user)) { res.status(403); throw new Error('Not your dependency task'); }

  const status = req.body.status;
  if (!['open', 'in_progress'].includes(status)) { res.status(400); throw new Error('Invalid status'); }
  dep.currentStatus = status;
  await dep.save();
  res.json(dep);
});

/**
 * POST /api/dependencies/:id/resolve   Body: { note? }
 * The owner (or HR/Super Admin) resolves the dependency, notifying the
 * person who handed it off.
 */
const resolve = asyncHandler(async (req, res) => {
  const dep = await DependencyTask.findById(req.params.id);
  if (!dep) { res.status(404); throw new Error('Dependency task not found'); }
  const owner = String(dep.assignedTo) === String(req.user._id);
  if (!owner && !isReviewer(req.user)) { res.status(403); throw new Error('Not your dependency task'); }
  if (dep.currentStatus === 'resolved') return res.json(dep);

  await resolveDependencyTask(dep, req.user, req.body.note || '');
  res.json(dep);
});

module.exports = {
  assignable, mine, mineCount, created, listAll, chain, setStatus, resolve,
  isReviewer,
};
