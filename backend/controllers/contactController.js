const asyncHandler = require('express-async-handler');
const Contact = require('../models/Contact');
const User = require('../models/User');
const { sendCSV } = require('../utils/csvExporter');

/**
 * Hydrate an internal contact with live user data (name / phone / email /
 * department name / designation title).  External contacts are returned
 * as-is.  Falls back to the snapshot fields if the linked user is gone.
 */
const hydrate = (c) => {
  const o = c.toObject ? c.toObject() : c;
  if (o.kind === 'employee' && o.linkedEmployee) {
    const u = o.linkedEmployee;
    o.name = u.name || o.name;
    o.phone = u.phone || '';
    o.email = u.email || '';
    o.roleTitle = u.designation?.title || '';
    o.departmentText = u.department?.name || '';
    o.employeeId = u.employeeId || '';
    o.reportingManager = u.reportingManager || '';
    o.isHOD = !!u.isHOD;
    // Keep the ref as id only for the client.
    o.linkedEmployee = u._id;
  }
  return o;
};

// Populate config reused everywhere.
const POP = { path: 'linkedEmployee', select: 'name employeeId phone email department designation reportingManager isHOD status',
  populate: [{ path: 'department', select: 'name' }, { path: 'designation', select: 'title' }] };

// GET /api/contacts (everyone authenticated)
const list = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.kind && ['employee', 'external'].includes(req.query.kind)) where.kind = req.query.kind;
  if (req.query.status && ['active', 'inactive'].includes(req.query.status)) where.status = req.query.status;
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).trim(), 'i');
    where.$or = [{ name: rx }, { phone: rx }, { email: rx }, { organization: rx }, { scopeOfWork: rx }, { roleTitle: rx }, { departmentText: rx }];
  }
  // Default to active for non-HR viewers; HR may filter explicitly.
  if (!req.query.status && req.user.role === 'employee') where.status = 'active';

  const items = await Contact.find(where)
    .populate({ path: 'linkedEmployee', select: 'name employeeId phone email department designation reportingManager isHOD status',
      populate: [{ path: 'department', select: 'name' }, { path: 'designation', select: 'title' }] })
    .sort({ name: 1 })
    .lean({ getters: true });
  res.json(items.map(hydrate));
});

// GET /api/contacts/:id
const get = asyncHandler(async (req, res) => {
  const c = await Contact.findById(req.params.id)
    .populate({ path: 'linkedEmployee', select: 'name employeeId phone email department designation reportingManager isHOD',
      populate: [{ path: 'department', select: 'name' }, { path: 'designation', select: 'title' }] });
  if (!c) { res.status(404); throw new Error('Contact not found'); }
  res.json(hydrate(c));
});

/** Build the persisted Contact doc from incoming body, kind-aware. */
const buildPayload = async (body) => {
  const kind = body.kind === 'external' ? 'external' : 'employee';
  const category = ['emergency', 'critical_support', 'management', 'general'].includes(body.category) ? body.category : 'general';
  const out = { kind, category, scopeOfWork: (body.scopeOfWork || '').trim(), status: body.status === 'inactive' ? 'inactive' : 'active' };

  if (kind === 'employee') {
    if (!body.linkedEmployee) throw new Error('Select an employee for an internal contact');
    const u = await User.findById(body.linkedEmployee).select('name');
    if (!u) throw new Error('Selected employee not found');
    out.linkedEmployee = u._id;
    out.name = u.name || 'Employee';
    // Clear external-only fields.
    out.organization = ''; out.contactType = 'Internal Employee';
    out.phone = ''; out.altPhone = ''; out.email = ''; out.roleTitle = '';
    out.departmentText = ''; out.address = ''; out.notes = '';
  } else {
    if (!body.name || !body.name.trim()) throw new Error('Contact name is required');
    out.name = body.name.trim();
    out.organization = (body.organization || '').trim();
    out.contactType = (body.contactType || '').trim();
    out.phone = (body.phone || '').trim();
    out.altPhone = (body.altPhone || '').trim();
    out.email = (body.email || '').trim().toLowerCase();
    out.roleTitle = (body.roleTitle || '').trim();
    out.departmentText = (body.departmentText || '').trim();
    out.address = (body.address || '').trim();
    out.notes = (body.notes || '').trim();
    out.linkedEmployee = undefined;
  }
  return out;
};

// POST /api/contacts (HR / Super Admin)
const create = asyncHandler(async (req, res) => {
  let payload;
  try { payload = await buildPayload(req.body); } catch (e) { res.status(400); throw e; }
  payload.createdBy = req.user._id;
  const c = await Contact.create(payload);
  res.status(201).json(hydrate(await c.populate({ path: 'linkedEmployee', select: 'name employeeId phone email department designation reportingManager isHOD', populate: [{ path: 'department', select: 'name' }, { path: 'designation', select: 'title' }] })));
});

// PUT /api/contacts/:id (HR / Super Admin)
const update = asyncHandler(async (req, res) => {
  const c = await Contact.findById(req.params.id);
  if (!c) { res.status(404); throw new Error('Contact not found'); }
  let payload;
  try { payload = await buildPayload({ ...c.toObject(), ...req.body }); } catch (e) { res.status(400); throw e; }
  Object.assign(c, payload);
  await c.save();
  res.json(hydrate(await c.populate({ path: 'linkedEmployee', select: 'name employeeId phone email department designation reportingManager isHOD', populate: [{ path: 'department', select: 'name' }, { path: 'designation', select: 'title' }] })));
});

// PATCH /api/contacts/:id/status (HR / Super Admin)
const toggleStatus = asyncHandler(async (req, res) => {
  const c = await Contact.findById(req.params.id);
  if (!c) { res.status(404); throw new Error('Contact not found'); }
  c.status = c.status === 'active' ? 'inactive' : 'active';
  await c.save();
  res.json({ status: c.status });
});

// DELETE /api/contacts/:id (HR / Super Admin)
const remove = asyncHandler(async (req, res) => {
  const c = await Contact.findByIdAndDelete(req.params.id);
  if (!c) { res.status(404); throw new Error('Contact not found'); }
  res.json({ message: 'Contact deleted' });
});

// GET /api/contacts/export.csv (HR / Super Admin)
const exportCsv = asyncHandler(async (_req, res) => {
  const items = await Contact.find({})
    .populate({ path: 'linkedEmployee', select: 'name employeeId phone email department designation reportingManager isHOD',
      populate: [{ path: 'department', select: 'name' }, { path: 'designation', select: 'title' }] });
  const rows = items.map((c) => {
    const o = hydrate(c);
    return {
      kind: o.kind,
      name: o.name,
      organization: o.organization || (o.kind === 'employee' ? 'Agromaxx Industry' : ''),
      contactType: o.contactType,
      roleTitle: o.roleTitle,
      department: o.departmentText,
      phone: o.phone,
      altPhone: o.altPhone,
      email: o.email,
      scopeOfWork: o.scopeOfWork,
      status: o.status,
    };
  });
  sendCSV(res, 'contacts.csv', rows);
});

/* ---------------- Per-user favorites + view tracking ---------------- */

// GET /api/contacts/favorites  (any authenticated user)
const myFavorites = asyncHandler(async (req, res) => {
  const ids = (req.user.favoriteContacts || []).map(String);
  if (!ids.length) return res.json([]);
  const items = await Contact.find({ _id: { $in: ids }, status: 'active' })
    .populate(POP).lean({ getters: true });
  res.json(items.map(hydrate));
});

// POST /api/contacts/:id/favorite  (any authenticated user)
const favorite = asyncHandler(async (req, res) => {
  const exists = await Contact.findById(req.params.id).select('_id');
  if (!exists) { res.status(404); throw new Error('Contact not found'); }
  await User.updateOne({ _id: req.user._id }, { $addToSet: { favoriteContacts: exists._id } });
  res.json({ favored: true });
});

// DELETE /api/contacts/:id/favorite  (any authenticated user)
const unfavorite = asyncHandler(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $pull: { favoriteContacts: req.params.id } });
  res.json({ favored: false });
});

// POST /api/contacts/:id/view  (any authenticated user)
// Increments the contact's view counter; powers the HR "Most Viewed" card.
const view = asyncHandler(async (req, res) => {
  await Contact.updateOne({ _id: req.params.id }, { $inc: { viewCount: 1 } });
  res.json({ ok: true });
});

// GET /api/contacts/analytics  (HR / Super Admin)
const analytics = asyncHandler(async (_req, res) => {
  const all = await Contact.find({}).select('kind status category viewCount name').lean();
  const stats = { total: all.length, internal: 0, external: 0, active: 0, inactive: 0,
    byCategory: { emergency: 0, critical_support: 0, management: 0, general: 0 } };
  for (const c of all) {
    if (c.kind === 'employee') stats.internal += 1; else stats.external += 1;
    if (c.status === 'active') stats.active += 1; else stats.inactive += 1;
    stats.byCategory[c.category || 'general'] = (stats.byCategory[c.category || 'general'] || 0) + 1;
  }
  const mostViewed = [...all].sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0))
    .slice(0, 5).map((c) => ({ _id: c._id, name: c.name, views: c.viewCount || 0, kind: c.kind }));
  res.json({ ...stats, mostViewed });
});

module.exports = { list, get, create, update, toggleStatus, remove, exportCsv,
  myFavorites, favorite, unfavorite, view, analytics };
