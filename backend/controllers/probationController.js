/**
 * probationController.js  --  Phase 62 Employee Probation Period.
 *
 * Read-only endpoints for the frontend to render Probation cards.
 * Never mutates -- HR edits go through the standard employeeController
 * update path.
 *
 * Endpoints:
 *   GET /api/probation/mine
 *     Employee's own probation window + restricted leave types.
 *
 *   GET /api/probation/employee/:id
 *     HR / Super Admin view of another employee's window.
 */
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const probation = require('../services/probation');

const _isAdmin = (u) => u?.role === 'hr' || u?.role === 'super_admin';

const _buildResponse = async (u) => {
  const window = probation.getProbationWindow(u);
  const status = probation.probationStatus(u);
  const restricted = await probation.getRestrictedTypes();
  return {
    enabled:   window.enabled,
    startDate: window.startDate,
    endDate:   window.endDate,
    status,
    onProbation:   probation.isOnProbation(u),
    daysRemaining: probation.daysRemaining(u),
    restrictedLeaveTypes: restricted,
  };
};

const mine = asyncHandler(async (req, res) => {
  const u = await User.findById(req.user._id)
    .select('joiningDate probation role').lean();
  if (!u) { res.status(404); throw new Error('User not found'); }
  res.json(await _buildResponse(u));
});

const ofEmployee = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) {
    res.status(403); throw new Error('HR / Super Admin only');
  }
  const u = await User.findById(req.params.id)
    .select('name employeeId joiningDate probation role').lean();
  if (!u) { res.status(404); throw new Error('Employee not found'); }
  res.json({
    employee: { _id: u._id, name: u.name, employeeId: u.employeeId },
    ...(await _buildResponse(u)),
  });
});

module.exports = { mine, ofEmployee };
