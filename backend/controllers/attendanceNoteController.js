/**
 * attendanceNoteController — Phase 50.
 *
 * Notes are personal reminders on the Attendance calendar.  They are
 * intentionally decoupled from the rest of the app so they never
 * affect submissions, reviews, analytics, payroll, or leave.
 *
 * Endpoints:
 *   GET    /api/attendance-notes
 *          List for the current user's scope with filters.
 *          Query params:
 *            employee  — target employee (HR/SA only; employees are
 *                        clamped to themselves).
 *            from,to   — inclusive UTC-day range.
 *            date      — single day (mutually exclusive with from/to).
 *            priority  — 'normal' | 'important'
 *            completed — 'true' | 'false'
 *            archived  — 'true' | 'false' (default false)
 *            department— HR/SA only.  Employee filter is applied via
 *                        User.find({ department }) first.
 *            q         — case-insensitive title/description search.
 *
 *   POST   /api/attendance-notes
 *          Body: { employee?, date, title, description?, priority?,
 *                  reminderTime? }.  Employees may only create for
 *                  themselves.  createdBy / createdByRole are derived
 *                  from req.user.
 *
 *   PATCH  /api/attendance-notes/:id
 *          Body: any editable subset.  Content edits are gated on
 *          canManage(); status transitions (complete / archive) are
 *          allowed to the note's employee even when they didn't
 *          author the note (mirroring the spec).
 *
 *   DELETE /api/attendance-notes/:id
 *          Gated on canManage() -- employees may only delete their
 *          own unlocked notes; HR/SA may delete anything.
 */
const asyncHandler = require('express-async-handler');
const mongoose     = require('mongoose');
const AttendanceNote = require('../models/AttendanceNote');
const User = require('../models/User');
const { startOfDay } = require('../utils/dateHelpers');

/** Is this request-user an HR or Super Admin? */
const _isAdmin = (u) => u?.role === 'hr' || u?.role === 'super_admin';

/**
 * canManage — decides whether the request user may edit CONTENT
 * (title / description / priority / reminderTime / date) or delete
 * the note.  HR/SA always pass; employees pass only when they authored
 * the note AND the note isn't locked.
 */
const canManage = (note, user) => {
  if (!user) return false;
  if (_isAdmin(user)) return true;
  if (String(note.employee) !== String(user._id)) return false;
  if (String(note.createdBy) !== String(user._id)) return false;
  if (note.locked) return false;
  return true;
};

/**
 * canSetStatus — separate check for complete / uncomplete / archive.
 * Per spec, employees may mark HR-assigned notes complete / archived
 * on their own calendar even though they can't edit content.
 */
const canSetStatus = (note, user) => {
  if (!user) return false;
  if (_isAdmin(user)) return true;
  return String(note.employee) === String(user._id);
};

/* -------------------------------------------------------------------- */
/* LIST                                                                 */
/* -------------------------------------------------------------------- */
const list = asyncHandler(async (req, res) => {
  const where = {};

  // Scope by target employee.
  const rawEmp = (req.query.employee || '').toString().trim();
  if (_isAdmin(req.user)) {
    if (rawEmp && mongoose.Types.ObjectId.isValid(rawEmp)) where.employee = rawEmp;
  } else {
    // Employees can only ever see their own notes.
    where.employee = req.user._id;
  }

  // Department scope (HR/SA only).  Resolve to employee ids first so
  // the note query stays index-covered.
  if (_isAdmin(req.user) && req.query.department && mongoose.Types.ObjectId.isValid(req.query.department)) {
    const empIds = await User.find({ department: req.query.department }).select('_id').lean();
    where.employee = where.employee
      ? { $in: empIds.map((e) => e._id).filter((id) => String(id) === String(where.employee)) }
      : { $in: empIds.map((e) => e._id) };
  }

  // Date filter — single day OR range OR neither.
  if (req.query.date) {
    where.date = startOfDay(new Date(req.query.date));
  } else if (req.query.from && req.query.to) {
    const from = startOfDay(new Date(req.query.from));
    const to   = startOfDay(new Date(req.query.to));
    if (to < from) { res.status(400); throw new Error('"to" must be on or after "from".'); }
    where.date = { $gte: from, $lte: to };
  }

  if (req.query.priority === 'normal' || req.query.priority === 'important') {
    where.priority = req.query.priority;
  }
  if (req.query.completed === 'true')  where.completed = true;
  if (req.query.completed === 'false') where.completed = false;
  // Default: hide archived unless the caller explicitly asks.
  if (req.query.archived === 'true')       where.archived = true;
  else if (req.query.archived === 'false') where.archived = false;
  else                                     where.archived = { $ne: true };

  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    where.$or = [{ title: rx }, { description: rx }];
  }

  const items = await AttendanceNote.find(where)
    .populate('createdBy', 'name role employeeId')
    .populate('employee',  'name employeeId')
    .populate('completedBy', 'name role')
    .populate('lockedBy',    'name role')
    .sort({ date: 1, priority: -1, createdAt: 1 })
    .lean();
  res.json(items);
});

/* -------------------------------------------------------------------- */
/* CREATE                                                               */
/* -------------------------------------------------------------------- */
const create = asyncHandler(async (req, res) => {
  const {
    employee: employeeId,
    date, title, description = '', priority, reminderTime = '',
  } = req.body || {};
  if (!date)   { res.status(400); throw new Error('date is required'); }
  if (!title || !String(title).trim()) { res.status(400); throw new Error('title is required'); }

  let targetEmployee = req.user._id;
  if (_isAdmin(req.user) && employeeId) {
    if (!mongoose.Types.ObjectId.isValid(employeeId)) {
      res.status(400); throw new Error('Invalid employee id');
    }
    targetEmployee = employeeId;
  } else if (employeeId && String(employeeId) !== String(req.user._id)) {
    res.status(403);
    throw new Error('Employees may only create notes on their own calendar.');
  }

  const doc = await AttendanceNote.create({
    employee: targetEmployee,
    date: startOfDay(new Date(date)),
    title: String(title).trim(),
    description: String(description || '').trim(),
    priority: priority === 'important' ? 'important' : 'normal',
    reminderTime: String(reminderTime || '').trim(),
    createdBy: req.user._id,
    createdByName: req.user.name || '',
    createdByRole: req.user.role,
  });
  const populated = await AttendanceNote.findById(doc._id)
    .populate('createdBy', 'name role employeeId')
    .populate('employee', 'name employeeId')
    .lean();
  res.status(201).json(populated);
});

/* -------------------------------------------------------------------- */
/* PATCH                                                                */
/* -------------------------------------------------------------------- */
const patch = asyncHandler(async (req, res) => {
  const note = await AttendanceNote.findById(req.params.id);
  if (!note) { res.status(404); throw new Error('Note not found'); }

  const body = req.body || {};
  const editingContent = ['title', 'description', 'priority', 'reminderTime', 'date']
    .some((k) => Object.prototype.hasOwnProperty.call(body, k));
  const togglingStatus = ['completed', 'archived']
    .some((k) => Object.prototype.hasOwnProperty.call(body, k));
  const togglingLock = Object.prototype.hasOwnProperty.call(body, 'locked');

  if (editingContent && !canManage(note, req.user)) {
    res.status(403);
    throw new Error(note.locked
      ? 'This note has been locked by HR and cannot be edited.'
      : 'You may only edit your own notes.');
  }
  if (togglingStatus && !canSetStatus(note, req.user)) {
    res.status(403);
    throw new Error('You may not change this note.');
  }
  if (togglingLock && !_isAdmin(req.user)) {
    res.status(403);
    throw new Error('Only HR or Super Admin may lock a note.');
  }

  // ----- content edits -----
  if (typeof body.title === 'string' && body.title.trim())       note.title = body.title.trim();
  if (typeof body.description === 'string')                      note.description = body.description.trim();
  if (body.priority === 'normal' || body.priority === 'important') note.priority = body.priority;
  if (typeof body.reminderTime === 'string')                     note.reminderTime = body.reminderTime.trim();
  if (body.date)                                                  note.date = startOfDay(new Date(body.date));

  // ----- status transitions -----
  if (typeof body.completed === 'boolean') {
    note.completed = body.completed;
    if (body.completed) {
      note.completedAt = new Date();
      note.completedBy = req.user._id;
    } else {
      note.completedAt = undefined;
      note.completedBy = undefined;
    }
  }
  if (typeof body.archived === 'boolean') {
    note.archived = body.archived;
    if (body.archived) {
      note.archivedAt = new Date();
      note.archivedBy = req.user._id;
    } else {
      note.archivedAt = undefined;
      note.archivedBy = undefined;
    }
  }

  // ----- lock toggle (HR/SA only) -----
  if (typeof body.locked === 'boolean') {
    note.locked = body.locked;
    if (body.locked) {
      note.lockedAt = new Date();
      note.lockedBy = req.user._id;
    } else {
      note.lockedAt = undefined;
      note.lockedBy = undefined;
    }
  }

  await note.save();
  const populated = await AttendanceNote.findById(note._id)
    .populate('createdBy', 'name role employeeId')
    .populate('employee', 'name employeeId')
    .populate('completedBy', 'name role')
    .populate('lockedBy', 'name role')
    .lean();
  res.json(populated);
});

/* -------------------------------------------------------------------- */
/* DELETE                                                               */
/* -------------------------------------------------------------------- */
const remove = asyncHandler(async (req, res) => {
  const note = await AttendanceNote.findById(req.params.id);
  if (!note) { res.status(404); throw new Error('Note not found'); }
  if (!canManage(note, req.user)) {
    res.status(403);
    throw new Error(note.locked
      ? 'This note has been locked by HR and cannot be deleted.'
      : 'You may only delete notes you created.');
  }
  await note.deleteOne();
  res.json({ ok: true });
});

/* -------------------------------------------------------------------- */
/* SUMMARY — cheap per-day count for calendar indicators                */
/* -------------------------------------------------------------------- */
const daySummary = asyncHandler(async (req, res) => {
  // Same date-range logic as list(), returns [{ date: 'YYYY-MM-DD',
  // count, hasImportant, firstTitle }].  Used by the calendar to
  // render the pin indicator without pulling every note into the
  // browser.
  const targetEmp = _isAdmin(req.user) && req.query.employee && mongoose.Types.ObjectId.isValid(req.query.employee)
    ? req.query.employee
    : req.user._id;

  const from = req.query.from ? startOfDay(new Date(req.query.from)) : null;
  const to   = req.query.to   ? startOfDay(new Date(req.query.to))   : null;
  const where = { employee: targetEmp, archived: { $ne: true } };
  if (from && to) where.date = { $gte: from, $lte: to };

  const rows = await AttendanceNote.find(where)
    .select('date title priority completed')
    .sort({ date: 1, priority: -1, createdAt: 1 })
    .lean();
  const byDay = new Map();
  for (const n of rows) {
    const k = new Date(n.date).toISOString().slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, { date: k, count: 0, importantCount: 0, pendingCount: 0, firstTitle: n.title });
    const bucket = byDay.get(k);
    bucket.count += 1;
    if (n.priority === 'important') bucket.importantCount += 1;
    if (!n.completed)               bucket.pendingCount   += 1;
  }
  res.json([...byDay.values()]);
});

module.exports = { list, create, patch, remove, daySummary };
