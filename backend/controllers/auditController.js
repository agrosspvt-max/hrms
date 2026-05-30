const asyncHandler = require('express-async-handler');
const AuditLog = require('../models/AuditLog');

/**
 * GET /api/audit?action=&actor=&limit=&from=&to=
 * Super-Admin only.  Returns most-recent entries first.
 */
const list = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.action) where.action = req.query.action;
  if (req.query.actor) where.actor = req.query.actor;
  if (req.query.from || req.query.to) {
    where.createdAt = {};
    if (req.query.from) where.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) where.createdAt.$lte = new Date(req.query.to);
  }
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const items = await AuditLog.find(where)
    .populate('actor', 'name email role employeeId')
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json(items);
});

module.exports = { list };
