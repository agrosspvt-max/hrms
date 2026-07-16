/**
 * interactionTagController.js -- CRUD for the global tag catalogue
 * used by the Employee Interactions module.  HR + Super Admin manage
 * tags; every read is available to any authenticated user so the
 * autocomplete works everywhere the tag picker appears.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const InteractionTag = require('../models/InteractionTag');
const { logAudit } = require('../utils/audit');

const _slugify = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const list = asyncHandler(async (req, res) => {
  const q = req.query || {};
  const where = {};
  if (q.category) where.category = q.category;
  if (q.archived !== undefined) where.archived = q.archived === 'true';
  if (q.search) {
    const term = String(q.search).trim();
    if (term) where.$or = [
      { name: { $regex: term, $options: 'i' } },
      { description: { $regex: term, $options: 'i' } },
    ];
  }
  const rows = await InteractionTag.find(where).sort({ archived: 1, category: 1, name: 1 }).lean();
  res.json(rows);
});

const create = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name) { res.status(400); throw new Error('Name is required.'); }
  const slug = _slugify(b.name);
  if (!slug) { res.status(400); throw new Error('Name must contain letters or numbers.'); }
  const doc = await InteractionTag.create({
    name: String(b.name).trim(),
    slug,
    category:          b.category || 'custom',
    color:             b.color    || '#64748b',
    icon:              b.icon     || '',
    description:       b.description || '',
    severity:          b.severity || 'info',
    countsAsWarning:   !!b.countsAsWarning,
    countsInAnalytics: b.countsInAnalytics !== false,
    visibleToEmployee: !!b.visibleToEmployee,
    archived:          false,
    createdBy: req.user._id,
  });
  logAudit(req, { action: 'interaction.tag.create', targetType: 'InteractionTag', targetId: doc._id, targetLabel: doc.name });
  res.status(201).json(doc);
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) { res.status(400); throw new Error('Invalid id.'); }
  const b = req.body || {};
  const patch = {};
  for (const k of ['color', 'icon', 'description', 'severity', 'category']) if (k in b) patch[k] = b[k];
  if ('name' in b) { patch.name = String(b.name).trim(); patch.slug = _slugify(b.name); }
  if ('countsAsWarning'   in b) patch.countsAsWarning   = !!b.countsAsWarning;
  if ('countsInAnalytics' in b) patch.countsInAnalytics = !!b.countsInAnalytics;
  if ('visibleToEmployee' in b) patch.visibleToEmployee = !!b.visibleToEmployee;
  if ('archived'          in b) patch.archived          = !!b.archived;
  const doc = await InteractionTag.findByIdAndUpdate(id, patch, { new: true });
  if (!doc) { res.status(404); throw new Error('Tag not found.'); }
  logAudit(req, { action: 'interaction.tag.update', targetType: 'InteractionTag', targetId: doc._id, targetLabel: doc.name });
  res.json(doc);
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await InteractionTag.findByIdAndDelete(id);
  if (!doc) { res.status(404); throw new Error('Tag not found.'); }
  logAudit(req, { action: 'interaction.tag.delete', targetType: 'InteractionTag', targetId: id, targetLabel: doc.name });
  res.json({ ok: true });
});

module.exports = { list, create, update, remove };
