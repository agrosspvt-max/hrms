/**
 * noteController.js -- HR knowledge-base entries.
 *
 * Endpoints (mounted at /api/notes):
 *   GET    /types                    list Note Types
 *   POST   /types                    create Note Type
 *   PATCH  /types/:id                update / archive
 *   DELETE /types/:id                delete (empty types only)
 *
 *   GET    /                         list notes (filters: type / mine / mention / search)
 *   POST   /                         create note
 *   GET    /:id                      fetch one
 *   PATCH  /:id                      update
 *   DELETE /:id                      delete
 *
 * Reuse: mentions autocomplete, tag catalogue, search text pattern are
 * all shared with the existing Interaction module; no duplication.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Note = require('../models/Note');
const NoteType = require('../models/NoteType');
const InteractionTag = require('../models/InteractionTag');
const { logAudit } = require('../utils/audit');

const _slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const _isAdmin = (u) => u && (u.role === 'hr' || u.role === 'super_admin');
const _isReviewer = (req) => {
  if (_isAdmin(req.user)) return true;
  if (req.user?.isHOD && req.user?.hodDepartment) return true;
  const perms = req.user?.featurePermissions || {};
  return !!perms.employeeInteractions?.enabled;
};
const _assert = (req, res) => {
  if (!_isReviewer(req)) { res.status(403); throw new Error('Forbidden: Employee Interactions access required.'); }
};

const _buildSearchText = async (doc) => {
  const parts = [doc.title || '', doc.body || ''];
  if (doc.tags?.length) {
    const tags = await InteractionTag.find({ _id: { $in: doc.tags } }).select('name').lean();
    parts.push(...tags.map((t) => `@${t.name}`));
  }
  return parts.filter(Boolean).join(' ').slice(0, 4000).toLowerCase();
};

/* ------------------------------------------------------------------ */
/* Note Types                                                          */
/* ------------------------------------------------------------------ */
const listTypes = asyncHandler(async (req, res) => {
  _assert(req, res);
  const where = {};
  if (req.query.archived === 'true') where.archived = true;
  else if (req.query.archived !== 'all') where.archived = false;
  const rows = await NoteType.find(where).sort({ archived: 1, name: 1 }).lean();
  // Attach entry count per type for the notebook grid.
  const counts = await Note.aggregate([
    { $match: { noteType: { $ne: null } } },
    { $group: { _id: '$noteType', n: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json(rows.map((r) => ({ ...r, entryCount: countMap.get(String(r._id)) || 0 })));
});

const createType = asyncHandler(async (req, res) => {
  _assert(req, res);
  const b = req.body || {};
  if (!b.name) { res.status(400); throw new Error('Name is required.'); }
  const slug = _slug(b.name);
  if (!slug) { res.status(400); throw new Error('Name must contain letters or numbers.'); }
  const doc = await NoteType.create({
    name: String(b.name).trim(),
    slug,
    description: b.description || '',
    icon:  b.icon  || '',
    color: b.color || '#64748b',
    visibility: ['hr_only', 'managers_hr'].includes(b.visibility) ? b.visibility : 'hr_only',
    archived: false,
    createdBy: req.user._id,
  });
  logAudit(req, { action: 'note_type.create', targetType: 'NoteType', targetId: doc._id, targetLabel: doc.name });
  res.status(201).json(doc);
});

const updateType = asyncHandler(async (req, res) => {
  _assert(req, res);
  const { id } = req.params;
  const b = req.body || {};
  const patch = {};
  for (const k of ['description', 'icon', 'color', 'visibility']) if (k in b) patch[k] = b[k];
  if ('name' in b) { patch.name = String(b.name).trim(); patch.slug = _slug(b.name); }
  if ('archived' in b) patch.archived = !!b.archived;
  const doc = await NoteType.findByIdAndUpdate(id, patch, { new: true });
  if (!doc) { res.status(404); throw new Error('Note Type not found.'); }
  logAudit(req, { action: 'note_type.update', targetType: 'NoteType', targetId: doc._id, targetLabel: doc.name });
  res.json(doc);
});

const deleteType = asyncHandler(async (req, res) => {
  _assert(req, res);
  const { id } = req.params;
  const count = await Note.countDocuments({ noteType: id });
  if (count > 0) { res.status(400); throw new Error(`Cannot delete: ${count} note(s) still use this type. Archive instead.`); }
  const doc = await NoteType.findByIdAndDelete(id);
  if (!doc) { res.status(404); throw new Error('Note Type not found.'); }
  logAudit(req, { action: 'note_type.delete', targetType: 'NoteType', targetId: id, targetLabel: doc.name });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Notes                                                                */
/* ------------------------------------------------------------------ */
const list = asyncHandler(async (req, res) => {
  _assert(req, res);
  const q = req.query || {};
  const page = Math.max(1, Number(q.page) || 1);
  const perPage = Math.min(200, Math.max(1, Number(q.perPage) || 25));

  const where = {};
  if (q.noteType && mongoose.Types.ObjectId.isValid(q.noteType)) where.noteType = q.noteType;
  else if (q.scope === 'personal') { where.personal = true; where.createdBy = req.user._id; }
  else if (q.scope === 'typed')    { where.personal = false; where.noteType = { $ne: null }; }
  if (q.mention && mongoose.Types.ObjectId.isValid(q.mention)) where.mentions = q.mention;
  if (q.tag && mongoose.Types.ObjectId.isValid(q.tag)) where.tags = q.tag;
  if (q.createdBy && mongoose.Types.ObjectId.isValid(q.createdBy)) where.createdBy = q.createdBy;
  if (q.from || q.to) {
    where.createdAt = {};
    if (q.from) where.createdAt.$gte = new Date(q.from);
    if (q.to)   where.createdAt.$lte = new Date(new Date(q.to).getTime() + 86400000 - 1);
  }
  if (q.search) {
    const rx = new RegExp(String(q.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    where.searchText = rx;
  }

  // Personal notes are strictly private -- HR / SA / HOD only ever see their OWN.
  where.$or = [
    { personal: true, createdBy: req.user._id },
    { personal: false },
  ];

  const [rows, total] = await Promise.all([
    Note.find(where)
      .populate('createdBy', 'name employeeId')
      .populate('lastEditedBy', 'name')
      .populate('tags', 'name color category')
      .populate('mentions', 'name employeeId')
      .populate('noteType', 'name color icon')
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
    Note.countDocuments(where),
  ]);
  res.json({ rows, page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) });
});

const create = asyncHandler(async (req, res) => {
  _assert(req, res);
  const b = req.body || {};
  if (!b.title) { res.status(400); throw new Error('Title is required.'); }
  const personal = !!b.personal;
  const noteType = !personal && b.noteType && mongoose.Types.ObjectId.isValid(b.noteType) ? b.noteType : null;
  if (!personal && !noteType) { res.status(400); throw new Error('noteType or personal:true is required.'); }
  const tags = Array.isArray(b.tags) ? b.tags.filter((t) => mongoose.Types.ObjectId.isValid(t)) : [];
  const mentions = Array.isArray(b.mentions) ? b.mentions.filter((m) => mongoose.Types.ObjectId.isValid(m)) : [];
  const doc = new Note({
    noteType, personal,
    title: String(b.title).trim(),
    body:  String(b.body || ''),
    tags, mentions,
    visibility: ['hr_only', 'managers_hr', 'employee_visible'].includes(b.visibility) ? b.visibility : 'hr_only',
    createdBy: req.user._id,
  });
  doc.searchText = await _buildSearchText(doc);
  await doc.save();
  logAudit(req, { action: 'note.create', targetType: 'Note', targetId: doc._id, targetLabel: doc.title });
  res.status(201).json(doc);
});

const getOne = asyncHandler(async (req, res) => {
  _assert(req, res);
  const { id } = req.params;
  const doc = await Note.findById(id)
    .populate('createdBy', 'name employeeId')
    .populate('lastEditedBy', 'name')
    .populate('tags', 'name color category')
    .populate('mentions', 'name employeeId department')
    .populate('noteType', 'name color icon')
    .lean();
  if (!doc) { res.status(404); throw new Error('Note not found.'); }
  if (doc.personal && String(doc.createdBy._id || doc.createdBy) !== String(req.user._id)) {
    res.status(403); throw new Error('Personal notes are private to their author.');
  }
  res.json(doc);
});

const update = asyncHandler(async (req, res) => {
  _assert(req, res);
  const { id } = req.params;
  const doc = await Note.findById(id);
  if (!doc) { res.status(404); throw new Error('Note not found.'); }
  if (doc.personal && String(doc.createdBy) !== String(req.user._id)) {
    res.status(403); throw new Error('Personal notes are private to their author.');
  }
  const b = req.body || {};
  if ('title' in b) doc.title = String(b.title || '').trim();
  if ('body'  in b) doc.body  = String(b.body  || '');
  if ('visibility' in b) doc.visibility = b.visibility;
  if (Array.isArray(b.tags))     doc.tags     = b.tags.filter((t) => mongoose.Types.ObjectId.isValid(t));
  if (Array.isArray(b.mentions)) doc.mentions = b.mentions.filter((m) => mongoose.Types.ObjectId.isValid(m));
  doc.lastEditedBy = req.user._id;
  doc.searchText = await _buildSearchText(doc);
  await doc.save();
  logAudit(req, { action: 'note.update', targetType: 'Note', targetId: doc._id, targetLabel: doc.title });
  res.json(doc);
});

const remove = asyncHandler(async (req, res) => {
  _assert(req, res);
  const { id } = req.params;
  const doc = await Note.findById(id);
  if (!doc) { res.status(404); throw new Error('Note not found.'); }
  if (doc.personal && String(doc.createdBy) !== String(req.user._id)) {
    res.status(403); throw new Error('Personal notes are private to their author.');
  }
  await Note.deleteOne({ _id: id });
  logAudit(req, { action: 'note.delete', targetType: 'Note', targetId: id, targetLabel: doc.title });
  res.json({ ok: true });
});

module.exports = {
  listTypes, createType, updateType, deleteType,
  list, create, getOne, update, remove,
};
