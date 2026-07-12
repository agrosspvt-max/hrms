/**
 * leaveConfigController.js  --  Phase 62 Leave Configuration.
 *
 * Currently exposes only the "restricted-during-probation" list.
 * Kept in its own controller so future org-wide leave settings
 * can be added without touching the existing leaveController.
 *
 * Endpoints:
 *   GET    /api/leave-config           -- any authenticated user
 *                                         (employees need it to render
 *                                         the info card on their
 *                                         dashboard).
 *   PUT    /api/leave-config           -- HR / Super Admin only.
 */
const asyncHandler = require('express-async-handler');
const LeaveConfig = require('../models/LeaveConfig');
const { logAudit } = require('../utils/audit');
const { invalidateRestrictedTypesCache } = require('../services/probation');

const ALLOWED_TYPES = ['casual', 'sick', 'paid', 'unpaid', 'other'];

const _isAdmin = (u) => u?.role === 'hr' || u?.role === 'super_admin';

/** GET /api/leave-config */
const get = asyncHandler(async (req, res) => {
  let cfg = await LeaveConfig.findOne({ singleton: true }).lean();
  if (!cfg) {
    // First-read seed with the spec's default (Paid Leave restricted).
    const created = await LeaveConfig.create({ singleton: true });
    cfg = created.toObject();
  }
  res.json({
    restrictedDuringProbation: Array.isArray(cfg.restrictedDuringProbation)
      ? cfg.restrictedDuringProbation
      : ['paid'],
  });
});

/** PUT /api/leave-config  (HR / Super Admin) */
const update = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) {
    res.status(403);
    throw new Error('HR / Super Admin only');
  }
  const input = Array.isArray(req.body.restrictedDuringProbation)
    ? req.body.restrictedDuringProbation
    : [];
  const clean = input
    .map((t) => String(t || '').trim().toLowerCase())
    .filter((t) => ALLOWED_TYPES.includes(t));
  const cfg = await LeaveConfig.findOneAndUpdate(
    { singleton: true },
    { $set: { restrictedDuringProbation: clean } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  invalidateRestrictedTypesCache();
  logAudit(req, {
    action: 'leaveConfig.update',
    targetType: 'LeaveConfig',
    targetId: cfg._id,
    targetLabel: 'restricted-during-probation',
    meta: { restrictedDuringProbation: clean },
  });
  res.json({ restrictedDuringProbation: clean });
});

module.exports = { get, update };
