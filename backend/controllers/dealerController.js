const asyncHandler = require('express-async-handler');
const Dealer = require('../models/Dealer');
const { logAudit } = require('../utils/audit');

/**
 * Dealer controller -- mirrors the Product controller's CRUD shape so
 * HR-side admin UIs follow the same code patterns.
 *
 * Reads are open to any authenticated user (employee needs the dropdown
 * when filing a Farmer Record).  Writes are HR / Super Admin only.
 */

// GET /api/dealers?activeOnly=true&search=raj
const listDealers = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.activeOnly === 'true') where.active = true;
  if (req.query.search) {
    const re = new RegExp(String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    where.$or = [{ name: re }, { place: re }];
  }
  res.json(await Dealer.find(where).sort({ active: -1, name: 1 }));
});

// POST /api/dealers  (HR/SA)
const createDealer = asyncHandler(async (req, res) => {
  const { name, place, active } = req.body;
  if (!name || !String(name).trim()) {
    res.status(400);
    throw new Error('Dealer name is required');
  }
  const exists = await Dealer.findOne({ name: { $regex: new RegExp(`^${String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } });
  if (exists) {
    res.status(400);
    throw new Error('A dealer with that name already exists');
  }
  const d = await Dealer.create({
    name: String(name).trim(),
    place: String(place || '').trim(),
    active: active !== false,
  });
  logAudit(req, { action: 'dealer.create', targetType: 'Dealer', targetId: d._id, targetLabel: d.name, meta: { place: d.place } });
  res.status(201).json(d);
});

// PUT /api/dealers/:id  (HR/SA)
const updateDealer = asyncHandler(async (req, res) => {
  const d = await Dealer.findById(req.params.id);
  if (!d) { res.status(404); throw new Error('Dealer not found'); }
  const { name, place, active } = req.body;
  if (name !== undefined) d.name = String(name).trim();
  if (place !== undefined) d.place = String(place).trim();
  if (active !== undefined) d.active = !!active;
  await d.save();
  logAudit(req, { action: 'dealer.update', targetType: 'Dealer', targetId: d._id, targetLabel: d.name });
  res.json(d);
});

// DELETE /api/dealers/:id  (HR/SA) -- soft-deactivate to preserve history.
const deactivateDealer = asyncHandler(async (req, res) => {
  const d = await Dealer.findById(req.params.id);
  if (!d) { res.status(404); throw new Error('Dealer not found'); }
  d.active = false;
  await d.save();
  logAudit(req, { action: 'dealer.deactivate', targetType: 'Dealer', targetId: d._id, targetLabel: d.name });
  res.json(d);
});

module.exports = { listDealers, createDealer, updateDealer, deactivateDealer };
