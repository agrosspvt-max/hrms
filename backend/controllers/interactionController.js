/**
 * interactionController.js
 *
 * Employee Interactions -- unified HR case-management module.  Every
 * write goes through logAudit so the module doubles as an append-only
 * audit trail.  Reads are server-paginated + text-indexed for scale.
 *
 * Endpoints (mounted at /api/interactions):
 *   GET    /                    list + filter (paginated)
 *   POST   /                    create interaction
 *   GET    /:id                 fetch one with participants + notes
 *   PUT    /:id                 update (title / body / meeting / tags / visibility)
 *   DELETE /:id                 delete (HR / SA)
 *   POST   /:id/notes           append a note
 *   PUT    /:id/notes/:noteId   edit a note
 *   DELETE /:id/notes/:noteId   remove a note
 *   PUT    /:id/participants    replace/update participants (bulk)
 *   POST   /:id/respond         employee accept/decline/maybe
 *   PUT    /:id/attendance      HR sets final attendance for one participant
 *   POST   /:id/follow-up/resolve
 *   GET    /analytics           dashboard cards + chart series
 *   GET    /timeline/:employee  chronological history for one employee
 *   GET    /mine                interactions the current employee is invited to
 *   GET    /mentions            autocomplete for ! employee mentions
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Interaction     = require('../models/Interaction');
const InteractionNote = require('../models/InteractionNote');
const InteractionTag  = require('../models/InteractionTag');
const User = require('../models/User');
const { logAudit } = require('../utils/audit');
// Phase-2 event bus: publishing interaction.created fans the notification
// out to every participant via the existing notificationProjector
// subscriber -- one row per participant, deduped by
// (recipient, `meeting.created:<id>`, variant) at the DB layer.
const events = require('../services/events');

/* ------------------------------------------------------------------ */
/* Permission helpers                                                   */
/* ------------------------------------------------------------------ */
const _isReviewer = (req) => {
  const role = req.user?.role;
  if (role === 'hr' || role === 'super_admin') return true;
  // HOD access is scoped to their own department (enforced downstream).
  if (req.user?.isHOD && req.user?.hodDepartment) return true;
  const perms = req.user?.featurePermissions || {};
  return !!(perms.employeeInteractions?.enabled);
};

const _assertReviewer = (req, res) => {
  if (!_isReviewer(req)) { res.status(403); throw new Error('Forbidden: Employee Interactions access required.'); }
};

/* ------------------------------------------------------------------ */
/* Search-text builder                                                  */
/* ------------------------------------------------------------------ */
const _buildSearchText = async (doc, participantNames = []) => {
  const parts = [doc.title || '', doc.description || '', ...participantNames];
  if (doc.tags?.length) {
    const tags = await InteractionTag.find({ _id: { $in: doc.tags } }).select('name').lean();
    parts.push(...tags.map((t) => `@${t.name}`));
  }
  return parts.filter(Boolean).join(' ').slice(0, 4000).toLowerCase();
};

const _buildNoteSearchText = async (body, tagIds = []) => {
  const parts = [body || ''];
  if (tagIds?.length) {
    const tags = await InteractionTag.find({ _id: { $in: tagIds } }).select('name').lean();
    parts.push(...tags.map((t) => `@${t.name}`));
  }
  return parts.filter(Boolean).join(' ').slice(0, 4000).toLowerCase();
};

/* ------------------------------------------------------------------ */
/* LIST + FILTER                                                        */
/* ------------------------------------------------------------------ */
const list = asyncHandler(async (req, res) => {
  _assertReviewer(req, res);
  const q = req.query || {};
  const page = Math.max(1, Number(q.page) || 1);
  const perPage = Math.min(200, Math.max(1, Number(q.perPage) || 25));

  const where = {};
  if (q.type)         where.type       = q.type;
  if (q.visibility)   where.visibility = q.visibility;
  if (q.status)       where.status     = q.status;
  if (q.createdBy && mongoose.Types.ObjectId.isValid(q.createdBy)) where.createdBy = q.createdBy;
  if (q.tag && mongoose.Types.ObjectId.isValid(q.tag)) where.tags = q.tag;
  if (q.department && mongoose.Types.ObjectId.isValid(q.department)) where.department = q.department;
  if (q.designation && mongoose.Types.ObjectId.isValid(q.designation)) where.designation = q.designation;
  if (q.employee && mongoose.Types.ObjectId.isValid(q.employee)) where['participants.employee'] = q.employee;

  if (q.from || q.to) {
    where.createdAt = {};
    if (q.from) where.createdAt.$gte = new Date(q.from);
    if (q.to)   where.createdAt.$lte = new Date(new Date(q.to).getTime() + 86400000 - 1);
  }
  if (q.followUp === 'open')     where['followUp.required'] = true, where['followUp.resolvedAt'] = { $exists: false };
  if (q.followUp === 'resolved') where['followUp.resolvedAt'] = { $exists: true };

  // HOD scoping: clamp to their department if they're neither HR nor SA.
  if (req.user.role !== 'hr' && req.user.role !== 'super_admin' && req.user.isHOD && req.user.hodDepartment) {
    where.department = req.user.hodDepartment;
  }

  // Global search: case-insensitive partial match against BOTH the
  // parent Interaction.searchText and any child InteractionNote row.
  // Previous behaviour only searched the parent, so a note containing
  // "needs a raise" would never surface for the query "raise".  We
  // now widen the query to pull interactions whose notes match.
  if (q.search) {
    const raw = String(q.search).trim();
    if (raw) {
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(escaped, 'i');   // case-insensitive
      // Find every InteractionNote whose searchText matches so we can
      // include the parent interactions in the result.
      const matchingNoteIds = await InteractionNote.find({ searchText: rx })
        .select('interaction').lean();
      const parentIdsFromNotes = matchingNoteIds.map((n) => n.interaction);
      where.$or = [
        { searchText: rx },
        ...(parentIdsFromNotes.length ? [{ _id: { $in: parentIdsFromNotes } }] : []),
      ];
    }
  }

  const [rows, total, noteCounts] = await Promise.all([
    Interaction.find(where)
      .populate('createdBy', 'name employeeId')
      .populate('tags', 'name color category countsAsWarning')
      .populate('participants.employee', 'name employeeId department')
      .populate('department', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
    Interaction.countDocuments(where),
    // Grouped note counts for the visible page only.
    (async () => new Map())(),
  ]);
  const noteAgg = await InteractionNote.aggregate([
    { $match: { interaction: { $in: rows.map((r) => r._id) } } },
    { $group: { _id: '$interaction', n: { $sum: 1 } } },
  ]);
  const noteMap = new Map(noteAgg.map((r) => [String(r._id), r.n]));

  res.json({
    rows: rows.map((r) => ({ ...r, notesCount: noteMap.get(String(r._id)) || 0 })),
    page, perPage, total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  });
});

/* ------------------------------------------------------------------ */
/* CREATE                                                               */
/* ------------------------------------------------------------------ */
const _normaliseParticipants = (raw = []) => (raw || [])
  .filter((p) => p && mongoose.Types.ObjectId.isValid(p.employee || p))
  .map((p) => ({
    employee: p.employee || p,
    invitationStatus: p.invitationStatus || 'invited',
    attendanceStatus: p.attendanceStatus || null,
    note: p.note || '',
  }));

const create = asyncHandler(async (req, res) => {
  _assertReviewer(req, res);
  const body = req.body || {};
  if (!body.type || !body.title) { res.status(400); throw new Error('type and title are required.'); }

  const participants = _normaliseParticipants(body.participants);
  const tagIds = Array.isArray(body.tags) ? body.tags.filter((t) => mongoose.Types.ObjectId.isValid(t)) : [];
  const mentions = Array.isArray(body.mentions) ? body.mentions.filter((m) => mongoose.Types.ObjectId.isValid(m)) : [];

  const empDocs = participants.length
    ? await User.find({ _id: { $in: participants.map((p) => p.employee) } }).select('name employeeId department designation').lean()
    : [];
  const participantNames = empDocs.map((e) => `${e.name || ''} ${e.employeeId || ''}`.trim());

  const doc = new Interaction({
    type: body.type,
    title: body.title,
    description: body.description || '',
    meeting: body.meeting || {},
    participants,
    tags: tagIds,
    mentions,
    visibility: body.visibility || 'hr_only',
    linkedRefs: Array.isArray(body.linkedRefs) ? body.linkedRefs : [],
    followUp: {
      required: !!body.followUp?.required,
      dueDate:  body.followUp?.dueDate || null,
      note:     body.followUp?.note || '',
    },
    status: body.status || 'scheduled',
    department:  body.department  || (empDocs[0]?.department || null),
    designation: body.designation || (empDocs[0]?.designation || null),
    createdBy: req.user._id,
  });
  doc.searchText = await _buildSearchText(doc, participantNames);
  await doc.save();

  logAudit(req, {
    action: 'interaction.create',
    targetType: 'Interaction',
    targetId: doc._id,
    targetLabel: `${doc.type} · ${doc.title}`,
    meta: { participants: participants.length, tags: tagIds.length },
  });

  // Publish the domain event AFTER save + audit.  The subscriber in
  // services/subscribers/notificationProjector.js turns this into one
  // Notification per participant (upsert-by-eventKey, so a caller
  // retry / cron restart cannot duplicate).  Doc is passed as a plain
  // object with populated participant + createdBy so the subscriber
  // doesn't have to re-query.
  try {
    const populated = doc.toObject ? doc.toObject() : doc;
    // Attach a shallow createdBy identity for the message signature.
    populated.createdByName = req.user?.name;
    events.publish('interaction.created', {
      interaction: populated,
      createdBy: req.user?._id,
    });
  } catch (err) {
    // Publishing must never fail the create -- the audit + row already
    // landed; realtime / notifications can retry via a manual refresh.
    console.error('[interaction.create] events.publish failed:', err.message);
  }

  res.status(201).json(doc);
});

/* ------------------------------------------------------------------ */
/* READ ONE                                                             */
/* ------------------------------------------------------------------ */
const getOne = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) { res.status(400); throw new Error('Invalid id.'); }
  const doc = await Interaction.findById(id)
    .populate('createdBy', 'name employeeId role')
    .populate('tags', 'name color category severity countsAsWarning visibleToEmployee')
    .populate('participants.employee', 'name employeeId department designation')
    .populate('participants.attendanceSetBy', 'name')
    .populate('mentions', 'name employeeId')
    .populate('department', 'name')
    .populate('designation', 'title')
    .lean();
  if (!doc) { res.status(404); throw new Error('Interaction not found.'); }

  // Visibility gate for employees: only see when invited AND (visibility != hr_only) OR they're the author.
  const isReviewer = _isReviewer(req);
  const uid = String(req.user._id);
  if (!isReviewer) {
    const isParticipant = (doc.participants || []).some((p) => String(p.employee?._id || p.employee) === uid);
    const isAuthor = String(doc.createdBy?._id || doc.createdBy) === uid;
    const visible = doc.visibility === 'employee_visible';
    if (!isAuthor && !(isParticipant && visible)) {
      res.status(403); throw new Error('You do not have access to this interaction.');
    }
  }

  const noteWhere = { interaction: id };
  if (!isReviewer) noteWhere.visibility = 'employee_visible';
  const notes = await InteractionNote.find(noteWhere)
    .populate('author', 'name role')
    .populate('tags', 'name color category countsAsWarning')
    .populate('mentions', 'name employeeId')
    .sort({ createdAt: 1 })
    .lean();
  res.json({ interaction: doc, notes });
});

/* ------------------------------------------------------------------ */
/* UPDATE                                                               */
/* ------------------------------------------------------------------ */
const update = asyncHandler(async (req, res) => {
  _assertReviewer(req, res);
  const { id } = req.params;
  const doc = await Interaction.findById(id);
  if (!doc) { res.status(404); throw new Error('Interaction not found.'); }
  const body = req.body || {};
  const editable = ['title', 'description', 'visibility', 'status', 'department', 'designation'];
  for (const k of editable) if (k in body) doc[k] = body[k];
  if (body.meeting) doc.meeting = { ...(doc.meeting?.toObject?.() || doc.meeting || {}), ...body.meeting };
  if (Array.isArray(body.tags))     doc.tags = body.tags.filter((t) => mongoose.Types.ObjectId.isValid(t));
  if (Array.isArray(body.mentions)) doc.mentions = body.mentions.filter((m) => mongoose.Types.ObjectId.isValid(m));
  if (body.followUp) doc.followUp = { ...(doc.followUp?.toObject?.() || doc.followUp || {}), ...body.followUp };

  const empDocs = doc.participants.length
    ? await User.find({ _id: { $in: doc.participants.map((p) => p.employee) } }).select('name employeeId').lean()
    : [];
  const participantNames = empDocs.map((e) => `${e.name || ''} ${e.employeeId || ''}`.trim());
  doc.searchText = await _buildSearchText(doc, participantNames);
  await doc.save();

  logAudit(req, {
    action: 'interaction.update',
    targetType: 'Interaction', targetId: doc._id, targetLabel: `${doc.type} · ${doc.title}`,
  });
  res.json(doc);
});

/* ------------------------------------------------------------------ */
/* DELETE                                                               */
/* ------------------------------------------------------------------ */
const remove = asyncHandler(async (req, res) => {
  _assertReviewer(req, res);
  const { id } = req.params;
  const doc = await Interaction.findByIdAndDelete(id);
  if (!doc) { res.status(404); throw new Error('Interaction not found.'); }
  await InteractionNote.deleteMany({ interaction: id });
  logAudit(req, {
    action: 'interaction.delete',
    targetType: 'Interaction', targetId: id, targetLabel: `${doc.type} · ${doc.title}`,
  });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* NOTES                                                                */
/* ------------------------------------------------------------------ */
const addNote = asyncHandler(async (req, res) => {
  _assertReviewer(req, res);
  const { id } = req.params;
  const parent = await Interaction.findById(id).select('_id');
  if (!parent) { res.status(404); throw new Error('Interaction not found.'); }
  const body = req.body || {};
  const tagIds  = Array.isArray(body.tags)     ? body.tags.filter((t) => mongoose.Types.ObjectId.isValid(t))     : [];
  const mentIds = Array.isArray(body.mentions) ? body.mentions.filter((m) => mongoose.Types.ObjectId.isValid(m)) : [];
  const note = await InteractionNote.create({
    interaction: id,
    author: req.user._id,
    body: String(body.body || '').trim(),
    tags: tagIds,
    mentions: mentIds,
    visibility: body.visibility || 'hr_only',
    searchText: await _buildNoteSearchText(body.body, tagIds),
  });
  logAudit(req, {
    action: 'interaction.note.create',
    targetType: 'InteractionNote', targetId: note._id, targetLabel: `note on ${id}`,
  });
  res.status(201).json(note);
});

const updateNote = asyncHandler(async (req, res) => {
  _assertReviewer(req, res);
  const { id, noteId } = req.params;
  const n = await InteractionNote.findOne({ _id: noteId, interaction: id });
  if (!n) { res.status(404); throw new Error('Note not found.'); }
  const body = req.body || {};
  if ('body' in body)       n.body       = String(body.body || '').trim();
  if ('visibility' in body) n.visibility = body.visibility;
  if (Array.isArray(body.tags))     n.tags     = body.tags.filter((t) => mongoose.Types.ObjectId.isValid(t));
  if (Array.isArray(body.mentions)) n.mentions = body.mentions.filter((m) => mongoose.Types.ObjectId.isValid(m));
  n.searchText   = await _buildNoteSearchText(n.body, n.tags);
  n.lastEditedBy = req.user._id;
  n.lastEditedAt = new Date();
  await n.save();
  logAudit(req, { action: 'interaction.note.update', targetType: 'InteractionNote', targetId: n._id });
  res.json(n);
});

const removeNote = asyncHandler(async (req, res) => {
  _assertReviewer(req, res);
  const { id, noteId } = req.params;
  const n = await InteractionNote.findOneAndDelete({ _id: noteId, interaction: id });
  if (!n) { res.status(404); throw new Error('Note not found.'); }
  logAudit(req, { action: 'interaction.note.delete', targetType: 'InteractionNote', targetId: noteId });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* PARTICIPANTS + ATTENDANCE                                            */
/* ------------------------------------------------------------------ */
const setParticipants = asyncHandler(async (req, res) => {
  _assertReviewer(req, res);
  const { id } = req.params;
  const doc = await Interaction.findById(id);
  if (!doc) { res.status(404); throw new Error('Interaction not found.'); }
  const parts = _normaliseParticipants(req.body?.participants);
  // Preserve existing invitation / attendance state where possible.
  const existing = new Map((doc.participants || []).map((p) => [String(p.employee), p]));
  doc.participants = parts.map((p) => {
    const prev = existing.get(String(p.employee));
    if (!prev) return p;
    return {
      ...prev.toObject?.() || prev,
      note: p.note || prev.note || '',
    };
  });
  await doc.save();
  logAudit(req, { action: 'interaction.participants.update', targetType: 'Interaction', targetId: id });
  res.json(doc);
});

const respond = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const status = req.body?.status;
  if (!['accepted', 'declined', 'maybe'].includes(status)) {
    res.status(400); throw new Error("status must be accepted, declined, or maybe.");
  }
  const doc = await Interaction.findById(id);
  if (!doc) { res.status(404); throw new Error('Interaction not found.'); }
  const uid = String(req.user._id);
  const p = doc.participants.find((x) => String(x.employee) === uid);
  if (!p) { res.status(403); throw new Error('You are not a participant of this interaction.'); }
  p.invitationStatus = status;
  p.invitationRespondedAt = new Date();
  await doc.save();
  logAudit(req, { action: 'interaction.respond', targetType: 'Interaction', targetId: id, meta: { status } });
  res.json({ ok: true, invitationStatus: status });
});

const setAttendance = asyncHandler(async (req, res) => {
  _assertReviewer(req, res);
  const { id } = req.params;
  const { employeeId, attendanceStatus, note } = req.body || {};
  const valid = ['present', 'absent', 'late', 'left_early', 'excused', null];
  if (!valid.includes(attendanceStatus)) { res.status(400); throw new Error('Invalid attendanceStatus.'); }
  const doc = await Interaction.findById(id);
  if (!doc) { res.status(404); throw new Error('Interaction not found.'); }
  const p = doc.participants.find((x) => String(x.employee) === String(employeeId));
  if (!p) { res.status(404); throw new Error('Participant not found.'); }
  p.attendanceStatus = attendanceStatus;
  p.attendanceSetBy  = req.user._id;
  p.attendanceSetAt  = new Date();
  if (note !== undefined) p.note = String(note || '');
  await doc.save();
  logAudit(req, {
    action: 'interaction.attendance.update',
    targetType: 'Interaction', targetId: id,
    meta: { employeeId: String(employeeId), attendanceStatus },
  });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* FOLLOW-UP RESOLVE                                                    */
/* ------------------------------------------------------------------ */
const resolveFollowUp = asyncHandler(async (req, res) => {
  _assertReviewer(req, res);
  const { id } = req.params;
  const doc = await Interaction.findById(id);
  if (!doc) { res.status(404); throw new Error('Interaction not found.'); }
  doc.followUp = doc.followUp || {};
  doc.followUp.resolvedAt = new Date();
  doc.followUp.resolvedBy = req.user._id;
  await doc.save();
  logAudit(req, { action: 'interaction.followup.resolve', targetType: 'Interaction', targetId: id });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* ANALYTICS                                                            */
/* ------------------------------------------------------------------ */
const analytics = asyncHandler(async (req, res) => {
  _assertReviewer(req, res);
  const q = req.query || {};
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 90 * 86400000);
  const to   = q.to   ? new Date(q.to)   : new Date();
  const scope = {};
  if (req.user.role !== 'hr' && req.user.role !== 'super_admin' && req.user.isHOD && req.user.hodDepartment) {
    scope.department = req.user.hodDepartment;
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86400000);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

  const [
    totalInteractions, meetings, warnings, appreciations, openFollowUps,
    todayMeetings, thisMonth, topAuthorAgg,
    byType, byMonth, byDept, topTags,
  ] = await Promise.all([
    Interaction.countDocuments(scope),
    Interaction.countDocuments({ ...scope, type: 'meeting' }),
    Interaction.countDocuments({ ...scope, type: 'warning' }),
    Interaction.countDocuments({ ...scope, type: 'appreciation' }),
    Interaction.countDocuments({ ...scope, 'followUp.required': true, 'followUp.resolvedAt': { $exists: false } }),
    Interaction.countDocuments({ ...scope, type: 'meeting', 'meeting.date': { $gte: today, $lt: tomorrow } }),
    Interaction.countDocuments({ ...scope, createdAt: { $gte: monthStart } }),
    Interaction.aggregate([
      { $match: scope },
      { $group: { _id: '$createdBy', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 1 },
    ]),
    Interaction.aggregate([
      { $match: { ...scope, createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$type', n: { $sum: 1 } } },
    ]),
    Interaction.aggregate([
      { $match: { ...scope, createdAt: { $gte: from, $lte: to } } },
      { $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          total: { $sum: 1 },
          warnings: { $sum: { $cond: [{ $eq: ['$type', 'warning'] }, 1, 0] } },
          recognitions: { $sum: { $cond: [{ $eq: ['$type', 'appreciation'] }, 1, 0] } },
        } },
      { $sort: { _id: 1 } },
    ]),
    Interaction.aggregate([
      { $match: { ...scope, createdAt: { $gte: from, $lte: to }, department: { $ne: null } } },
      { $group: { _id: '$department', n: { $sum: 1 } } },
      { $lookup: { from: 'departments', localField: '_id', foreignField: '_id', as: 'dept' } },
      { $project: { name: { $ifNull: [{ $arrayElemAt: ['$dept.name', 0] }, 'Unassigned'] }, n: 1 } },
      { $sort: { n: -1 } },
    ]),
    Interaction.aggregate([
      { $match: { ...scope, createdAt: { $gte: from, $lte: to } } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'interactiontags', localField: '_id', foreignField: '_id', as: 'tag' } },
      { $project: {
          _id: 1, n: 1,
          name:  { $arrayElemAt: ['$tag.name', 0] },
          color: { $arrayElemAt: ['$tag.color', 0] },
          category: { $arrayElemAt: ['$tag.category', 0] },
        } },
    ]),
  ]);

  const topAuthor = topAuthorAgg?.[0]?._id
    ? await User.findById(topAuthorAgg[0]._id).select('name employeeId').lean()
    : null;

  res.json({
    cards: {
      totalInteractions, meetings, warnings, appreciations,
      openFollowUps, todayMeetings, thisMonth,
      mostActiveHr: topAuthor ? { ...topAuthor, count: topAuthorAgg[0].n } : null,
    },
    charts: {
      byType, byMonth, byDept, topTags,
    },
    range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
  });
});

/* ------------------------------------------------------------------ */
/* EMPLOYEE TIMELINE                                                    */
/* ------------------------------------------------------------------ */
const timeline = asyncHandler(async (req, res) => {
  const { employee } = req.params;
  if (!mongoose.Types.ObjectId.isValid(employee)) { res.status(400); throw new Error('Invalid employee id.'); }
  const isSelf = String(req.user._id) === String(employee);
  if (!isSelf && !_isReviewer(req)) { res.status(403); throw new Error('Forbidden.'); }
  const where = { 'participants.employee': employee };
  if (isSelf && !_isReviewer(req)) where.visibility = 'employee_visible';
  const rows = await Interaction.find(where)
    .populate('createdBy', 'name role')
    .populate('tags', 'name color category countsAsWarning')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  res.json(rows);
});

/* ------------------------------------------------------------------ */
/* EMPLOYEE MY INTERACTIONS                                             */
/* ------------------------------------------------------------------ */
const mine = asyncHandler(async (req, res) => {
  const rows = await Interaction.find({ 'participants.employee': req.user._id })
    .populate('createdBy', 'name role')
    .populate('tags', 'name color category')
    .sort({ 'meeting.date': -1, createdAt: -1 })
    .limit(200)
    .lean();
  // Employees only see notes with employee_visible visibility -- so
  // clip HR-only interactions unless they're a meeting they've been
  // invited to (invited-to meetings always visible to keep the flow).
  const visible = rows.filter((r) => r.type === 'meeting' || r.visibility === 'employee_visible');
  res.json(visible);
});

/* ------------------------------------------------------------------ */
/* AUTOCOMPLETE for ! mentions                                          */
/* ------------------------------------------------------------------ */
const mentions = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const users = await User.find({
    status: 'active',
    $or: [
      { name: { $regex: q, $options: 'i' } },
      { employeeId: { $regex: q, $options: 'i' } },
    ],
  }).select('name employeeId department')
    .populate('department', 'name')
    .limit(10).lean();
  res.json(users.map((u) => ({
    _id: u._id, name: u.name, employeeId: u.employeeId,
    department: u.department?.name || '',
  })));
});

module.exports = {
  list, create, getOne, update, remove,
  addNote, updateNote, removeNote,
  setParticipants, respond, setAttendance,
  resolveFollowUp, analytics, timeline, mine, mentions,
};
