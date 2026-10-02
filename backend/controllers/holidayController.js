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
  // Issue #2 (Part 8): a newly-declared holiday inside an approved
  // leave's range must shrink that leave's day count + refund balance.
  try {
    await require('../services/leaveHolidaySync').recalcApprovedLeavesForDates({
      dates: [day], actor: req.user._id, reason: `holiday created ${day.toISOString().slice(0, 10)}`, source: 'holiday',
    });
  } catch (e) { console.error('[holiday.create leaveSync]', e.message); }
  res.status(201).json(h);
});

const update = asyncHandler(async (req, res) => {
  // Capture the pre-image date so a moved holiday re-syncs BOTH the
  // day it left and the day it moved to.
  const before = await Holiday.findById(req.params.id).select('date').lean();
  const patch = {};
  if (req.body.name !== undefined) patch.name = req.body.name.trim();
  if (req.body.description !== undefined) patch.description = req.body.description;
  if (req.body.type !== undefined) patch.type = req.body.type;
  if (req.body.date !== undefined) patch.date = startOfDay(new Date(req.body.date));
  const h = await Holiday.findByIdAndUpdate(req.params.id, patch, { new: true });
  if (!h) { res.status(404); throw new Error('Holiday not found'); }
  // Issue #2: recompute approved leaves over the old + new holiday date.
  try {
    const dates = [];
    if (before?.date) dates.push(before.date);
    if (h?.date) dates.push(h.date);
    await require('../services/leaveHolidaySync').recalcApprovedLeavesForDates({
      dates, actor: req.user._id, reason: `holiday updated ${req.params.id}`, source: 'holiday',
    });
  } catch (e) { console.error('[holiday.update leaveSync]', e.message); }
  res.json(h);
});

const remove = asyncHandler(async (req, res) => {
  const h = await Holiday.findByIdAndDelete(req.params.id);
  if (!h) { res.status(404); throw new Error('Holiday not found'); }
  // Issue #2 (Part 9): removing a holiday inside an approved leave's
  // range restores that leave's day count + deducts the balance.
  try {
    await require('../services/leaveHolidaySync').recalcApprovedLeavesForDates({
      dates: [h.date], actor: req.user._id, reason: `holiday deleted ${String(h.date).slice(0, 10)}`, source: 'holiday',
    });
  } catch (e) { console.error('[holiday.remove leaveSync]', e.message); }
  res.json({ message: 'Holiday deleted' });
});

module.exports = { list, create, update, remove };
