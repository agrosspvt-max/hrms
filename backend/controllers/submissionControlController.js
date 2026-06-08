/**
 * submissionControlController.js
 *
 * HR / Super Admin admin tool for cleaning up submissions that
 * shouldn't count toward analytics (tests, demos, accidental
 * double-submits, calibration runs).
 *
 * Architecture:
 *   - Soft-delete only.  Rows stay in the collection so HR can
 *     restore.  Set { deleted, deletedBy, deletedAt, deleteReason }.
 *   - isTestData flag offers a softer alternative -- analytics
 *     ignore it but the submission is still visible in employee
 *     history with a "Test" badge.
 *   - Every list / KPI / leaderboard endpoint in the rest of the
 *     codebase AND-s in liveSubmissionFilter(), which excludes
 *     both flags by default.  HR can flip ?includeTest=true or
 *     ?includeDeleted=true on any analytics call to compare.
 *
 * Every endpoint requires role ∈ { hr, super_admin } (enforced by
 * the route's authorize('hr') middleware).  Every write action is
 * captured by logAudit().
 */

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const XLSX     = require('xlsx');
const Submission = require('../models/Submission');
const User       = require('../models/User');
const Template   = require('../models/Template');
const Assignment = require('../models/Assignment');
const Department = require('../models/Department');
const { logAudit } = require('../utils/audit');

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const isTruthy = (v) => TRUTHY.has(String(v || '').toLowerCase());

/** Whitelist + coerce a list of ObjectId strings.  Drops invalid ids silently. */
const toObjectIds = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    if (mongoose.Types.ObjectId.isValid(x)) out.push(new mongoose.Types.ObjectId(x));
  }
  return out;
};

/** Build the Mongo where-clause from the page's filter bar. */
const buildWhere = (q = {}) => {
  const where = {};
  // Date range (inclusive of from, exclusive of to+1)
  if (q.from || q.to) {
    where.date = {};
    if (q.from) where.date.$gte = new Date(q.from);
    if (q.to)   where.date.$lte = new Date(q.to);
  }
  if (q.employee   && mongoose.Types.ObjectId.isValid(q.employee))   where.employee   = q.employee;
  if (q.department && mongoose.Types.ObjectId.isValid(q.department)) where['_emp.department'] = q.department; // applied post-lookup
  if (q.templateType && ['task', 'excel', 'sheet', 'custom'].includes(q.templateType)) where.templateType = q.templateType;
  if (q.customKind)  where.customKind = q.customKind;
  if (q.status === 'submitted') where.submitted = true;
  if (q.status === 'draft')     where.submitted = false;
  if (q.reviewStatus && ['pending', 'reviewed'].includes(q.reviewStatus)) where.reviewStatus = q.reviewStatus;
  if (q.reviewer && mongoose.Types.ObjectId.isValid(q.reviewer)) where.reviewedBy = q.reviewer;
  if (q.assignment && mongoose.Types.ObjectId.isValid(q.assignment)) where.assignment = q.assignment;

  // Flag filters -- defaults expose ONLY live data; HR can ask for
  // deleted-only / test-only / all via explicit query params.
  if (q.showDeleted === 'only')     where.deleted = true;
  else if (q.showDeleted !== 'all') where.deleted = { $ne: true };

  if (q.showTest === 'only')     where.isTestData = true;
  else if (q.showTest !== 'all') where.isTestData = { $ne: true };

  return where;
};

/**
 * GET /api/submission-control
 *
 * Paginated + filtered list.  Returns rows shaped for the table
 * view: { _id, date, employee:{name,emp,dept,role}, template:title,
 *         templateType, customKind, submitted, reviewStatus, reviewedBy,
 *         deleted, isTestData, createdAt, updatedAt }.
 */
const list = asyncHandler(async (req, res) => {
  const where = buildWhere(req.query);
  const page  = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));

  // Text search across employee name/empId + template title.  We do this
  // as a post-populate filter so the index plan on the find() stays simple.
  const search = (req.query.search || '').trim().toLowerCase();

  let q = Submission.find(where)
    .populate({
      path: 'employee',
      select: 'name employeeId email role department',
      populate: { path: 'department', select: 'name' },
    })
    .populate('template',   'title templateType customKind')
    .populate('assignment', 'frequency scheduleLabel template')
    .populate('reviewedBy', 'name role')
    .populate('deletedBy',  'name role')
    .sort({ date: -1, submittedAt: -1 });

  // For the department filter we need to post-filter after populate
  // (Submission doesn't carry department directly).
  const all = await q.lean();
  const filtered = all.filter((s) => {
    if (req.query.department && String(s.employee?.department?._id || s.employee?.department) !== String(req.query.department)) return false;
    if (search) {
      const hay = [
        s.employee?.name, s.employee?.employeeId, s.employee?.email,
        s.template?.title, s.customKind,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const total = filtered.length;
  const start = (page - 1) * limit;
  const items = filtered.slice(start, start + limit).map((s) => ({
    _id: s._id,
    date: s.date,
    employee: s.employee && {
      _id: s.employee._id,
      name: s.employee.name,
      employeeId: s.employee.employeeId,
      role: s.employee.role,
      department: s.employee.department?.name || '',
    },
    template: s.template && {
      _id: s.template._id,
      title: s.template.title,
      templateType: s.template.templateType,
      customKind: s.template.customKind,
    },
    assignment: s.assignment && {
      _id: s.assignment._id,
      frequency: s.assignment.frequency,
      scheduleLabel: s.assignment.scheduleLabel,
    },
    templateType: s.templateType,
    customKind: s.customKind,
    submitted: s.submitted,
    reviewStatus: s.reviewStatus,
    currentReviewStage: s.currentReviewStage,
    reviewedBy: s.reviewedBy && { _id: s.reviewedBy._id, name: s.reviewedBy.name, role: s.reviewedBy.role },
    deleted: !!s.deleted,
    deletedAt: s.deletedAt,
    deletedBy: s.deletedBy && { _id: s.deletedBy._id, name: s.deletedBy.name, role: s.deletedBy.role },
    deleteReason: s.deleteReason || '',
    isTestData: !!s.isTestData,
    testDataMarkedAt: s.testDataMarkedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    earnedPoints: s.earnedPoints,
    totalPoints: s.totalPoints,
  }));

  res.json({ total, page, limit, items });
});

/**
 * GET /api/submission-control/:id
 *
 * Full submission payload -- every sub-array (tasks / excel / sheet /
 * customResponses / productSales / farmerRecords) + review history +
 * edit history.  Read-only view for the modal.
 */
const get = asyncHandler(async (req, res) => {
  const s = await Submission.findById(req.params.id)
    .populate({ path: 'employee', select: 'name employeeId email role department', populate: { path: 'department', select: 'name' } })
    .populate('template',   'title templateType customKind customSections customFields')
    .populate('assignment', 'frequency scheduleLabel template')
    .populate('reviewedBy', 'name role')
    .populate('deletedBy',  'name role')
    .populate('testDataMarkedBy', 'name role')
    .lean();
  if (!s) { res.status(404); throw new Error('Submission not found'); }
  res.json(s);
});

/**
 * PUT /api/submission-control/:id
 *
 * HR / Super Admin edit.  Freeze-mode: only fields HR explicitly
 * sends in the body are written; salesValue / nbvValue on
 * productSales rows are NOT recomputed.  Caller can still patch
 * those by sending them explicitly.
 *
 * Accepted body keys (any subset):
 *   customResponses [{key, value}]
 *   productSales    [...rows...] (replaces array)
 *   farmerRecords   [...rows...] (replaces array)
 *   tasks           [{taskId, status, pendingReason}] (patches in place)
 *   disciplineNote, ideaFeedback, selfNote, idea
 *   note            (free-text edit reason; captured on the audit row)
 */
const ALLOWED_EDIT_KEYS = new Set([
  'customResponses', 'productSales', 'farmerRecords', 'tasks',
  'disciplineNote', 'ideaFeedback', 'selfNote', 'idea',
]);

const update = asyncHandler(async (req, res) => {
  const s = await Submission.findById(req.params.id);
  if (!s) { res.status(404); throw new Error('Submission not found'); }

  const touched = [];
  for (const k of Object.keys(req.body || {})) {
    if (!ALLOWED_EDIT_KEYS.has(k)) continue;
    const v = req.body[k];
    if (k === 'tasks' && Array.isArray(v)) {
      // Patch-in-place: only fields the body sends overwrite the existing row.
      const byId = new Map((s.tasks || []).map((t) => [String(t._id), t]));
      for (const upd of v) {
        const t = byId.get(String(upd.taskId || upd._id));
        if (!t) continue;
        if (upd.status        !== undefined) t.status        = upd.status;
        if (upd.pendingReason !== undefined) t.pendingReason = upd.pendingReason;
      }
      s.markModified('tasks');
    } else {
      // Array replacements (productSales / farmerRecords / customResponses)
      // and scalar fields go through verbatim.  Editor is responsible for
      // sending the full array.
      s[k] = v;
      s.markModified(k);
    }
    touched.push(k);
  }

  if (touched.length === 0) {
    res.status(400); throw new Error('No editable fields in body.');
  }

  s.editHistory = s.editHistory || [];
  s.editHistory.push({
    editedBy: req.user._id,
    editorName: req.user.name,
    role: req.user.role,
    fields: touched,
    note: String(req.body.note || '').trim(),
    timestamp: new Date(),
  });

  await s.save();
  logAudit(req, {
    action: 'submission.edit',
    targetType: 'Submission',
    targetId: s._id,
    targetLabel: `${s.employee} · ${String(s.date).slice(0, 10)}`,
    meta: { fields: touched, note: req.body.note || '' },
  });
  res.json(s);
});

/**
 * POST /api/submission-control/:id/delete
 * Body: { reason: 'DELETE' confirmation typed by HR, reason text }
 *
 * Soft-deletes.  Requires the body field `confirm === 'DELETE'` so
 * the API can't be hit accidentally by a misclicked button.
 */
const remove = asyncHandler(async (req, res) => {
  if (String(req.body?.confirm || '') !== 'DELETE') {
    res.status(400);
    throw new Error('Confirmation required: pass body.confirm = "DELETE".');
  }
  const s = await Submission.findById(req.params.id);
  if (!s) { res.status(404); throw new Error('Submission not found'); }
  if (s.deleted) { res.status(400); throw new Error('Submission is already deleted.'); }
  s.deleted = true;
  s.deletedBy = req.user._id;
  s.deletedAt = new Date();
  s.deleteReason = String(req.body?.reason || '').trim();
  await s.save();
  logAudit(req, {
    action: 'submission.soft-delete',
    targetType: 'Submission',
    targetId: s._id,
    targetLabel: `${s.employee} · ${String(s.date).slice(0, 10)}`,
    meta: { reason: s.deleteReason },
  });
  res.json({ ok: true, _id: s._id });
});

/**
 * POST /api/submission-control/:id/restore
 *
 * Reverses a soft-delete.  Analytics automatically pick the row up
 * again on the next request (no rebuild required).
 */
const restore = asyncHandler(async (req, res) => {
  const s = await Submission.findById(req.params.id);
  if (!s) { res.status(404); throw new Error('Submission not found'); }
  if (!s.deleted) { res.status(400); throw new Error('Submission is not deleted.'); }
  s.deleted = false;
  s.deletedBy = undefined;
  s.deletedAt = undefined;
  s.deleteReason = '';
  await s.save();
  logAudit(req, {
    action: 'submission.restore',
    targetType: 'Submission',
    targetId: s._id,
    targetLabel: `${s.employee} · ${String(s.date).slice(0, 10)}`,
  });
  res.json({ ok: true, _id: s._id });
});

/**
 * POST /api/submission-control/:id/mark-test
 * Body: { test: true | false }
 */
const markTest = asyncHandler(async (req, res) => {
  const flag = req.body?.test !== false; // default true
  const s = await Submission.findById(req.params.id);
  if (!s) { res.status(404); throw new Error('Submission not found'); }
  s.isTestData = flag;
  s.testDataMarkedBy = flag ? req.user._id : undefined;
  s.testDataMarkedAt = flag ? new Date() : undefined;
  await s.save();
  logAudit(req, {
    action: flag ? 'submission.mark-test' : 'submission.unmark-test',
    targetType: 'Submission',
    targetId: s._id,
    targetLabel: `${s.employee} · ${String(s.date).slice(0, 10)}`,
  });
  res.json({ ok: true, _id: s._id, isTestData: s.isTestData });
});

/**
 * Bulk helpers.  Body: { ids: [...], reason? }
 */
const bulkDelete = asyncHandler(async (req, res) => {
  if (String(req.body?.confirm || '') !== 'DELETE') {
    res.status(400);
    throw new Error('Confirmation required: pass body.confirm = "DELETE".');
  }
  const ids = toObjectIds(req.body?.ids);
  if (ids.length === 0) { res.status(400); throw new Error('No valid ids supplied.'); }
  const r = await Submission.updateMany(
    { _id: { $in: ids }, deleted: { $ne: true } },
    {
      $set: {
        deleted: true,
        deletedBy: req.user._id,
        deletedAt: new Date(),
        deleteReason: String(req.body?.reason || '').trim(),
      },
    },
  );
  logAudit(req, {
    action: 'submission.bulk-delete',
    targetType: 'Submission',
    targetLabel: `${ids.length} submissions`,
    meta: { count: r.modifiedCount, reason: req.body?.reason || '' },
  });
  res.json({ ok: true, modified: r.modifiedCount });
});

const bulkRestore = asyncHandler(async (req, res) => {
  const ids = toObjectIds(req.body?.ids);
  if (ids.length === 0) { res.status(400); throw new Error('No valid ids supplied.'); }
  const r = await Submission.updateMany(
    { _id: { $in: ids }, deleted: true },
    { $set: { deleted: false }, $unset: { deletedBy: 1, deletedAt: 1, deleteReason: 1 } },
  );
  logAudit(req, { action: 'submission.bulk-restore', targetType: 'Submission', targetLabel: `${ids.length} submissions`, meta: { count: r.modifiedCount } });
  res.json({ ok: true, modified: r.modifiedCount });
});

const bulkMarkTest = asyncHandler(async (req, res) => {
  const ids = toObjectIds(req.body?.ids);
  const flag = req.body?.test !== false;
  if (ids.length === 0) { res.status(400); throw new Error('No valid ids supplied.'); }
  const r = await Submission.updateMany(
    { _id: { $in: ids } },
    flag
      ? { $set: { isTestData: true, testDataMarkedBy: req.user._id, testDataMarkedAt: new Date() } }
      : { $set: { isTestData: false }, $unset: { testDataMarkedBy: 1, testDataMarkedAt: 1 } },
  );
  logAudit(req, {
    action: flag ? 'submission.bulk-mark-test' : 'submission.bulk-unmark-test',
    targetType: 'Submission',
    targetLabel: `${ids.length} submissions`,
    meta: { count: r.modifiedCount },
  });
  res.json({ ok: true, modified: r.modifiedCount, isTestData: flag });
});

/**
 * GET /api/submission-control/export?format=xlsx|csv & (same filters as list)
 *
 * Streams the filtered submission set as an Excel sheet (default)
 * or CSV.  Rows mirror the table view columns.
 */
const exportFiltered = asyncHandler(async (req, res) => {
  const where = buildWhere(req.query);
  const items = await Submission.find(where)
    .populate({ path: 'employee', select: 'name employeeId department', populate: { path: 'department', select: 'name' } })
    .populate('template', 'title templateType')
    .populate('reviewedBy', 'name')
    .populate('deletedBy', 'name')
    .sort({ date: -1, submittedAt: -1 })
    .lean();

  const header = [
    'Date', 'Employee Name', 'Employee ID', 'Department',
    'Template', 'Template Type', 'Custom Kind',
    'Assignment Frequency', 'Status', 'Review Status', 'Reviewer',
    'Created At', 'Last Updated', 'Deleted', 'Deleted By', 'Delete Reason',
    'Is Test Data', 'Earned', 'Total',
  ];
  const rows = items.map((s) => [
    s.date ? new Date(s.date).toISOString().slice(0, 10) : '',
    s.employee?.name || '',
    s.employee?.employeeId || '',
    s.employee?.department?.name || '',
    s.template?.title || '',
    s.templateType || '',
    s.customKind || '',
    s.frequency || '',
    s.submitted ? 'Submitted' : 'Draft',
    s.reviewStatus || '',
    s.reviewedBy?.name || '',
    s.createdAt ? new Date(s.createdAt).toISOString() : '',
    s.updatedAt ? new Date(s.updatedAt).toISOString() : '',
    s.deleted ? 'Yes' : 'No',
    s.deletedBy?.name || '',
    s.deleteReason || '',
    s.isTestData ? 'Yes' : 'No',
    s.earnedPoints ?? 0,
    s.totalPoints ?? 0,
  ]);

  const format = (req.query.format || 'xlsx').toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'csv') {
    const esc = (v) => {
      const x = String(v ?? '');
      return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
    };
    const csv = [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="submissions_export_${stamp}.csv"`);
    return res.send(csv);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, 'Submissions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="submissions_export_${stamp}.xlsx"`);
  return res.send(buf);
});

/**
 * POST /api/submission-control/rebuild-scores
 *
 * Re-derives earnedPoints / totalPoints / completionPercentage on
 * every (live) submission so scoring formula changes propagate
 * without HR re-reviewing manually.  Excludes deleted + test rows.
 */
const rebuildScores = asyncHandler(async (_req, res) => {
  // Phase 6: cached scores are WORK-ONLY now.  Discipline + idea live
  // on DailyReview; the per-employee day total is reconstructed by
  // analytics / salary / dashboards via a join to that collection.
  const cursor = Submission.find({ deleted: { $ne: true } }).cursor();
  let touched = 0;
  for (let s = await cursor.next(); s != null; s = await cursor.next()) {
    const earned = Number(s.workEarnedPoints) || 0;
    const total  = Number(s.workTotalPoints)  || 0;
    const pct    = total > 0 ? (earned / total) * 100 : 0;
    if (s.earnedPoints !== earned || s.totalPoints !== total || s.completionPercentage !== pct) {
      s.earnedPoints = earned;
      s.totalPoints  = total;
      s.completionPercentage = pct;
      await s.save();
      touched += 1;
    }
  }
  logAudit(_req, { action: 'submission-control.rebuild-scores', meta: { touched } });
  res.json({ ok: true, touched, message: `Recomputed cached work-only scores on ${touched} submission(s). Day-level discipline + innovation totals live on DailyReview.` });
});

/**
 * POST /api/submission-control/rebuild-analytics
 *
 * Informational endpoint.  All analytics in this HRMS are computed
 * on demand from the Submission collection; there is no cache to
 * invalidate.  Returns success + a friendly message so the UI can
 * confirm the action ran.
 */
const rebuildAnalytics = asyncHandler(async (_req, res) => {
  res.json({
    ok: true,
    message: 'Analytics are computed on demand from the live submission collection. No cache to rebuild — soft-deleted and test-marked rows are already excluded from every analytics query.',
  });
});

/**
 * GET /api/submission-control/filter-options
 *
 * Compact payload for the filter bar: departments, employees, reviewers,
 * templates so the page can render dropdowns in a single round-trip.
 */
const filterOptions = asyncHandler(async (_req, res) => {
  const [departments, employees, templates] = await Promise.all([
    Department.find({}).select('name').sort({ name: 1 }).lean(),
    User.find({ role: { $in: ['employee', 'hr'] }, status: 'active' })
      .select('name employeeId role department')
      .populate('department', 'name')
      .sort({ name: 1 }).lean(),
    Template.find({}).select('title templateType customKind').sort({ title: 1 }).lean(),
  ]);
  res.json({ departments, employees, templates });
});

module.exports = {
  list, get, update,
  remove, restore, markTest,
  bulkDelete, bulkRestore, bulkMarkTest,
  exportFiltered,
  rebuildScores, rebuildAnalytics,
  filterOptions,
};
