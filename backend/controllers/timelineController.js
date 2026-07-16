/**
 * timelineController.js -- read-only HTTP surface for the derived
 * Activity Timeline.  Every request runs timeline.getFor with
 * subject scoped by the caller's identity + role.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const timeline = require('../services/timeline');
const User = require('../models/User');

const _isAdmin = (u) => u && (u.role === 'hr' || u.role === 'super_admin');

const _rangeFrom = (q) => {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 90 * 86400000);
  return { from, to };
};

const _types = (q) => {
  if (!q.type) return null;
  return Array.isArray(q.type) ? q.type : String(q.type).split(',').map((t) => t.trim()).filter(Boolean);
};

const mine = asyncHandler(async (req, res) => {
  const { from, to } = _rangeFrom(req.query);
  const out = await timeline.getFor({
    subject: req.user._id,
    from, to,
    types: _types(req.query),
    search: req.query.search || '',
    page: Number(req.query.page) || 1,
    perPage: Math.min(200, Number(req.query.perPage) || 40),
  });
  res.json(out);
});

const forEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) { res.status(400); throw new Error('Invalid id.'); }
  // Employees can only see their own timeline via this route.  HR /
  // Super Admin see any employee.  HOD is auto-clamped to their
  // department.
  if (String(req.user._id) !== String(id)) {
    if (!_isAdmin(req.user)) {
      if (!(req.user.isHOD && req.user.hodDepartment)) { res.status(403); throw new Error('Forbidden.'); }
      const emp = await User.findById(id).select('department').lean();
      if (String(emp?.department) !== String(req.user.hodDepartment)) {
        res.status(403); throw new Error('Forbidden.');
      }
    }
  }
  const { from, to } = _rangeFrom(req.query);
  const out = await timeline.getFor({
    subject: id, from, to,
    types: _types(req.query),
    search: req.query.search || '',
    page: Number(req.query.page) || 1,
    perPage: Math.min(200, Number(req.query.perPage) || 40),
  });
  res.json(out);
});

module.exports = { mine, forEmployee };
