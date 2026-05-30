const asyncHandler = require('express-async-handler');
const Holiday = require('../models/Holiday');
const { startOfDay } = require('../utils/dateHelpers');

/**
 * GET /api/holidays?year=&month=
 * If year (and optional month) given, filter to that range.
 */
const list = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.year) {
    const y = Number(req.query.year);
    if (req.query.month) {
      const m = Number(req.query.month);
      where.date = {
        $gte: new Date(Date.UTC(y, m - 1, 1)),
        $lt: new Date(Date.UTC(y, m, 1)),
      };
    } else {
      where.date = {
        $gte: new Date(Date.UTC(y, 0, 1)),
        $lt: new Date(Date.UTC(y + 1, 0, 1)),
      };
    }
  }
  const items = await Holiday.find(where).sort({ date: 1 });
  res.json(items);
});

const create = asyncHandler(async (req, res) => {
  const { date, name, description, type } = req.body;
  if (!date || !name) {
    res.status(400);
    throw new Error('date and name are required');
  }
  const day = startOfDay(new Date(date));
  // Upsert by date so adding twice doesn't blow up; HR can just edit instead
  const h = await Holiday.findOneAndUpdate(
    { date: day },
    {
      $set: { name: name.trim(), description: description || '', type: type || 'company' },
      $setOnInsert: { createdBy: req.user._id, date: day },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.status(201).json(h);
});

const update = asyncHandler(async (req, res) => {
  const patch = {};
  if (req.body.name !== undefined) patch.name = req.body.name.trim();
  if (req.body.description !== undefined) patch.description = req.body.description;
  if (req.body.type !== undefined) patch.type = req.body.type;
  if (req.body.date !== undefined) patch.date = startOfDay(new Date(req.body.date));
  const h = await Holiday.findByIdAndUpdate(req.params.id, patch, { new: true });
  if (!h) { res.status(404); throw new Error('Holiday not found'); }
  res.json(h);
});

const remove = asyncHandler(async (req, res) => {
  const h = await Holiday.findByIdAndDelete(req.params.id);
  if (!h) { res.status(404); throw new Error('Holiday not found'); }
  res.json({ message: 'Holiday deleted' });
});

module.exports = { list, create, update, remove };
