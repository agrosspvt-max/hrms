/**
 * featurePermissionsController.js
 *
 * Phase 43 -- per-employee feature access management.
 *
 *   GET    /api/feature-permissions/employees
 *          -> list every employee with their current permission map.
 *   GET    /api/feature-permissions/:id
 *          -> fetch one employee's permission map.
 *   PUT    /api/feature-permissions/:id
 *          -> replace one employee's permission map.  Audited.
 *   POST   /api/feature-permissions/:id/copy-from/:sourceId
 *          -> copy permissions from one employee to another.  Audited.
 *   POST   /api/feature-permissions/:id/reset
 *          -> wipe customised permissions; falls back to defaults.
 *          Audited.
 *
 * HR + Super Admin only.  The route file enforces the gate; this
 * controller mirrors it defensively for safety.
 */

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const User = require('../models/User');
const { logAudit } = require('../utils/audit');

const _assertAdmin = (req, res) => {
  const role = req.user?.role;
  if (role !== 'hr' && role !== 'super_admin') {
    res.status(403);
    throw new Error('Only HR / Super Admin can manage feature permissions.');
  }
};

const _diffSummary = (oldMap = {}, newMap = {}) => {
  const keys = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);
  const changes = [];
  for (const k of keys) {
    const a = oldMap[k], b = newMap[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ module: k, from: a || null, to: b || null });
    }
  }
  return changes;
};

const listEmployees = asyncHandler(async (req, res) => {
  _assertAdmin(req, res);
  const where = {};
  if (req.query.role) where.role = req.query.role;
  if (req.query.department && mongoose.Types.ObjectId.isValid(req.query.department)) {
    where.department = req.query.department;
  }
  if (req.query.q) {
    const q = String(req.query.q).trim();
    where.$or = [
      { name: { $regex: q, $options: 'i' } },
      { email: { $regex: q, $options: 'i' } },
      { employeeId: { $regex: q, $options: 'i' } },
    ];
  }
  const items = await User.find(where)
    .select('_id name email employeeId role isHOD department designation featurePermissions featurePermissionsUpdatedAt')
    .populate('department', 'name')
    .populate('designation', 'title')
    .sort({ name: 1 })
    .lean();
  res.json(items);
});

const getOne = asyncHandler(async (req, res) => {
  _assertAdmin(req, res);
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) { res.status(400); throw new Error('Invalid id.'); }
  const u = await User.findById(id)
    .select('_id name email employeeId role isHOD department designation featurePermissions featurePermissionsUpdatedAt featurePermissionsUpdatedBy')
    .populate('department', 'name')
    .populate('designation', 'title')
    .populate('featurePermissionsUpdatedBy', 'name email')
    .lean();
  if (!u) { res.status(404); throw new Error('Employee not found.'); }
  res.json(u);
});

const update = asyncHandler(async (req, res) => {
  _assertAdmin(req, res);
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) { res.status(400); throw new Error('Invalid id.'); }
  const incoming = req.body?.featurePermissions;
  if (incoming == null || typeof incoming !== 'object' || Array.isArray(incoming)) {
    res.status(400); throw new Error('featurePermissions must be an object.');
  }
  const u = await User.findById(id).select('name email employeeId featurePermissions');
  if (!u) { res.status(404); throw new Error('Employee not found.'); }
  const prev = (u.featurePermissions && (u.featurePermissions.toObject
    ? u.featurePermissions.toObject() : { ...u.featurePermissions })) || {};
  u.featurePermissions = incoming;
  u.featurePermissionsUpdatedAt = new Date();
  u.featurePermissionsUpdatedBy = req.user._id;
  u.markModified('featurePermissions');
  await u.save();

  const changes = _diffSummary(prev, incoming);
  logAudit(req, {
    action: 'feature_permissions.update',
    targetType: 'User',
    targetId: u._id,
    targetLabel: `${u.name} (${u.employeeId || u.email || ''})`,
    meta: { changeCount: changes.length, changes },
  });

  res.json({ ok: true, featurePermissions: u.featurePermissions });
});

const copyFrom = asyncHandler(async (req, res) => {
  _assertAdmin(req, res);
  const { id, sourceId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(sourceId)) {
    res.status(400); throw new Error('Invalid id.');
  }
  if (String(id) === String(sourceId)) {
    res.status(400); throw new Error('Source and target must be different.');
  }
  const [target, source] = await Promise.all([
    User.findById(id).select('name email employeeId featurePermissions'),
    User.findById(sourceId).select('name featurePermissions'),
  ]);
  if (!target) { res.status(404); throw new Error('Target employee not found.'); }
  if (!source) { res.status(404); throw new Error('Source employee not found.'); }
  const copy = (source.featurePermissions && (source.featurePermissions.toObject
    ? source.featurePermissions.toObject() : { ...source.featurePermissions })) || {};
  const prev = (target.featurePermissions && (target.featurePermissions.toObject
    ? target.featurePermissions.toObject() : { ...target.featurePermissions })) || {};
  target.featurePermissions = copy;
  target.featurePermissionsUpdatedAt = new Date();
  target.featurePermissionsUpdatedBy = req.user._id;
  target.markModified('featurePermissions');
  await target.save();

  logAudit(req, {
    action: 'feature_permissions.copy',
    targetType: 'User',
    targetId: target._id,
    targetLabel: `${target.name} ← ${source.name}`,
    meta: {
      sourceId: String(sourceId),
      sourceName: source.name,
      moduleCount: Object.keys(copy).length,
      previousCount: Object.keys(prev).length,
    },
  });
  res.json({ ok: true, featurePermissions: target.featurePermissions });
});

const reset = asyncHandler(async (req, res) => {
  _assertAdmin(req, res);
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) { res.status(400); throw new Error('Invalid id.'); }
  const u = await User.findById(id).select('name email employeeId featurePermissions');
  if (!u) { res.status(404); throw new Error('Employee not found.'); }
  const prev = (u.featurePermissions && (u.featurePermissions.toObject
    ? u.featurePermissions.toObject() : { ...u.featurePermissions })) || {};
  u.featurePermissions = {};
  u.featurePermissionsUpdatedAt = new Date();
  u.featurePermissionsUpdatedBy = req.user._id;
  u.markModified('featurePermissions');
  await u.save();

  logAudit(req, {
    action: 'feature_permissions.reset',
    targetType: 'User',
    targetId: u._id,
    targetLabel: `${u.name} (${u.employeeId || u.email || ''})`,
    meta: { previousModules: Object.keys(prev) },
  });
  res.json({ ok: true });
});

/* ====================================================================
 * Middleware factory -- mount on any route to enforce that an employee
 * has the requested module + (optionally) the requested access level.
 *
 *   router.get('/products', requireFeature('products', 'view'), handler);
 *
 * Rules (matches the spec's role hierarchy):
 *   - HR + Super Admin bypass entirely.
 *   - HOD bypasses for HOD-allowed modules (caller decides via the
 *     middleware that gates the route -- this fn does not infer HOD
 *     privileges, it stays employee-feature focused).
 *   - Employee: must have featurePermissions[module].enabled === true
 *     AND, when `level` is specified, the granted level must be at
 *     least the requested level.
 * ================================================================== */
const LEVEL_RANK = { view: 1, edit: 2, full: 3 };
const requireFeature = (moduleKey, level = null) => (req, res, next) => {
  const u = req.user;
  if (!u) { res.status(401); return next(new Error('Not authenticated')); }
  if (u.role === 'hr' || u.role === 'super_admin') return next();
  const perms = (u.featurePermissions && (u.featurePermissions.toObject
    ? u.featurePermissions.toObject() : u.featurePermissions)) || {};
  const cfg = perms[moduleKey];
  if (!cfg || !cfg.enabled) {
    res.status(403);
    return next(new Error(`Forbidden: ${moduleKey} access not granted.`));
  }
  if (level && cfg.level) {
    const have = LEVEL_RANK[cfg.level] || 0;
    const need = LEVEL_RANK[level] || 0;
    if (have < need) {
      res.status(403);
      return next(new Error(`Forbidden: ${moduleKey} requires ${level} access.`));
    }
  }
  return next();
};

module.exports = {
  listEmployees, getOne, update, copyFrom, reset,
  requireFeature,
};
