/**
 * timelineController.js -- read-only ComplianceEvent stream endpoints.
 *
 *   GET /api/compliance/timeline/me
 *   GET /api/compliance/timeline/:employeeId    (HR / Super Admin)
 *   GET /api/compliance/timeline/incident/:id   (HR / Super Admin, or owner)
 */

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const ComplianceIncident = require('../../models/ComplianceIncident');
const { isEnabled } = require('../../config/featureFlags');
const timelineService = require('../../services/compliance/timeline/timelineService');

const _isAdmin = (u) => u && (u.role === 'hr' || u.role === 'super_admin');

const _flagGate = (res) => {
  if (!isEnabled('compliance.waiverRecovery')) {
    res.status(404);
    throw new Error('Compliance timeline endpoints are not enabled on this deployment.');
  }
};

const me = asyncHandler(async (req, res) => {
  _flagGate(res);
  const rows = await timelineService.forEmployee({
    employeeId: req.user._id,
    from: req.query.from, to: req.query.to,
    limit: req.query.limit,
  });
  res.json(rows);
});

const forEmployee = asyncHandler(async (req, res) => {
  _flagGate(res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  if (!mongoose.Types.ObjectId.isValid(req.params.employeeId)) {
    res.status(400); throw new Error('Invalid employeeId.');
  }
  const rows = await timelineService.forEmployee({
    employeeId: req.params.employeeId,
    from: req.query.from, to: req.query.to,
    limit: req.query.limit,
  });
  res.json(rows);
});

const forIncident = asyncHandler(async (req, res) => {
  _flagGate(res);
  const inc = await ComplianceIncident.findById(req.params.id).lean();
  if (!inc) { res.status(404); throw new Error('Incident not found.'); }
  if (!_isAdmin(req.user) && String(inc.employee) !== String(req.user._id)) {
    res.status(403); throw new Error('You may not view this timeline.');
  }
  const rows = await timelineService.forIncident({
    incidentId: inc._id, limit: req.query.limit,
  });
  res.json(rows);
});

module.exports = { me, forEmployee, forIncident };
