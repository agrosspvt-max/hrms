/**
 * templateAnalyticsController.js
 *
 * Dynamic Analytics Engine -- Phase 11.
 *
 * For ANY custom template HR has defined, this controller produces a
 * uniformly-shaped analytics payload that the frontend renders without
 * any template-specific code:
 *
 *   - Overview: submitted vs total assigned, Done/Pending/Work N/A rates,
 *     completion percentage, on-time vs late.
 *   - Field analytics: for every Number / Currency / Percentage
 *     `customField` (or `auto` formula), Total / Avg / Min / Max +
 *     per-employee leaderboard + daily trend.
 *   - Task analytics: for every employee-facing task row across all
 *     submissions, Done% / Pending% / Work N/A% per task title.
 *   - Employee performance leaderboards: top, bottom, most consistent,
 *     most pending, most active.
 *   - Extra Work analytics: aggregates Submission.tasks[].addedByEmployee
 *     rows (the existing "ad-hoc work" surface).
 *
 * Filters honoured on every request:
 *   range / from / to / department / designation / employee / status
 *   / includeTest / includeDeleted
 *
 * Scoping:
 *   - HR / Super Admin: full org (or filter by ?department).
 *   - HOD: hard-clamped to their own department, query ignored.
 *
 * Backward compatibility:
 *   - Built ON TOP of the existing Submission + Template collections.
 *     No schema migration required.  Reads only.
 *   - The hand-coded Calling Analytics + Product & Farmer Analytics
 *     endpoints continue to exist and are unaffected; this engine is
 *     additive.
 */

const asyncHandler = require('express-async-handler');
const mongoose     = require('mongoose');
const Template     = require('../models/Template');
const Submission   = require('../models/Submission');
const User         = require('../models/User');
const Assignment   = require('../models/Assignment');
const { startOfDay, addDays, parseDay, formatYMD } = require('../utils/dateHelpers');
const { liveSubmissionFilter, readReqFlags } = require('../utils/submissionFilter');

const resolveRange = (q = {}) => {
  const todayPlus1 = addDays(startOfDay(new Date()), 1);
  if (q.range === 'custom' && q.from && q.to) {
    return { from: parseDay(q.from), to: addDays(parseDay(q.to), 1) };
  }
  if (q.range === 'month') {
    const now = new Date();
    return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: todayPlus1 };
  }
  const days = Number(q.range) > 0 ? Number(q.range) : 30;
  return { from: addDays(todayPlus1, -days), to: todayPlus1 };
};

// Numeric fieldTypes (the ones field analytics targets).  All other
// types render as KPI summaries only (counts, last value).
const NUMERIC_TYPES = new Set(['number', 'currency', 'percentage', 'auto', 'readonly']);

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const safePct = (num, den) => (den > 0 ? round1((num / den) * 100) : 0);

/* ------------------------------------------------------------------ */
/* GET /api/template-analytics                                          */
/* Lightweight list of every analytics-eligible template + a HOD scope */
/* clamp so the sidebar / picker only shows what the caller can see.   */
/* ------------------------------------------------------------------ */
// Phase 44.2 — pull the templateAnalytics feature config off the caller
// so list / generate can apply per-employee `allowedTemplateIds`
// filtering.  Returns { hasFeature, allowedTemplateIds | null } where
// `null` means "no scope -- all templates allowed".
const _templateAnalyticsScope = (req) => {
  const u = req.user || {};
  if (u.role === 'hr' || u.role === 'super_admin' || u.isHOD === true) {
    return { hasFeature: true, allowedTemplateIds: null };
  }
  const perms = (u.featurePermissions && (u.featurePermissions.toObject
    ? u.featurePermissions.toObject() : u.featurePermissions)) || {};
  const cfg = perms.templateAnalytics;
  if (!cfg?.enabled) return { hasFeature: false, allowedTemplateIds: [] };
  const ids = Array.isArray(cfg.allowedTemplateIds) ? cfg.allowedTemplateIds.map(String) : [];
  return { hasFeature: true, allowedTemplateIds: ids.length > 0 ? ids : null };
};

const list = asyncHandler(async (req, res) => {
  // Phase 41.1 -- backfill legacy templates.  Older Template documents
  // that pre-date the `isActive` field carry it as `undefined`, which
  // failed the strict `isActive: true` filter and made them invisible
  // in the Template Analytics picker.  `$ne: false` matches `true`,
  // `undefined`, and any document where the field is missing -- the
  // exact set the user wants surfaced.  Templates HR explicitly
  // deactivated (`isActive: false`) still stay hidden.
  //
  // Phase 41.2 -- hide analytics-surface entries HR has "deleted" via
  // the Template Analytics page.  The underlying template document is
  // preserved (so submissions / assignments / history keep working),
  // only the analytics picker entry is hidden.
  const where = {
    isActive: { $ne: false },
    analyticsHidden: { $ne: true },
  };
  // HOD scope: only templates without a department (global) OR templates
  // tied to the HOD's department.  HR/SA see everything.
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin' && isHOD) {
    where.$or = [{ department: null }, { department: req.user.hodDepartment }];
  }
  // Phase 44.2 / 44.3 -- per-employee Template Analytics scope.
  //   HR / SA / HOD          : full picker (HOD-scope already applied
  //                             via where.$or above).
  //   Employee + feature on  : full picker OR narrowed picker if
  //                             allowedTemplateIds was configured.
  //   Anyone else            : 403.
  const scope = _templateAnalyticsScope(req);
  if (!scope.hasFeature) {
    res.status(403);
    throw new Error('Template analytics requires HR, Super Admin, HOD, or the Template Analytics feature permission.');
  }
  if (scope.allowedTemplateIds && scope.allowedTemplateIds.length > 0) {
    where._id = { $in: scope.allowedTemplateIds };
  }
  const items = await Template.find(where)
    .select('title analyticsName templateType customKind department reviewFlow')
    .populate('department', 'name')
    .sort({ title: 1 })
    .lean();
  // Slim down for the sidebar.
  res.json(items.map((t) => ({
    _id: t._id,
    title: t.title,
    analyticsName: t.analyticsName || `${t.title} Analytics`,
    templateType: t.templateType,
    customKind: t.customKind || '',
    department: t.department && { _id: t.department._id, name: t.department.name },
    reviewFlow: t.reviewFlow,
  })));
});

/* ------------------------------------------------------------------ */
/* GET /api/template-analytics/:templateId                              */
/* The dynamic engine.  Pulls every submitted, live submission for     */
/* this template in range, then derives the full KPI payload.          */
/* ------------------------------------------------------------------ */
const generate = asyncHandler(async (req, res) => {
  const { templateId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(templateId)) {
    res.status(400); throw new Error('Valid templateId is required.');
  }
  const tpl = await Template.findById(templateId).lean();
  // Phase 42 -- mirror the picker filter (`isActive: { $ne: false }`).
  // Legacy Template documents that pre-date the `isActive` field carry
  // it as `undefined` on disk, which the previous `!tpl.isActive`
  // check treated as "inactive" -> 404 -> frontend stuck on Loader.
  // We only refuse the request when HR explicitly deactivated the
  // template (`isActive === false`).
  if (!tpl || tpl.isActive === false) {
    res.status(404); throw new Error('Template not found or inactive.');
  }
  // Phase 44.2 -- enforce per-employee templateAnalytics scope.  If
  // HR has narrowed an employee's `allowedTemplateIds`, the API
  // refuses to serve any template not in that list even if someone
  // tries to type the URL directly.  HR / SA / HOD bypass.
  const scope = _templateAnalyticsScope(req);
  if (!scope.hasFeature) { res.status(403); throw new Error('Forbidden: Template Analytics access not granted.'); }
  if (scope.allowedTemplateIds && !scope.allowedTemplateIds.includes(String(tpl._id))) {
    res.status(403); throw new Error('Forbidden: this template is not in your Template Analytics scope.');
  }

  const { from, to } = resolveRange(req.query);
  const flags = readReqFlags(req);

  // ----- Employee scope (role-aware) -----
  // Phase 44.3 -- employees granted the templateAnalytics feature
  // permission get HR-equivalent visibility into this endpoint.  HOD
  // still gets the department clamp; HR / SA see the org by default
  // and may filter by ?department.
  const empWhere = { status: 'active' };
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin') {
    if (isHOD) {
      empWhere.department = req.user.hodDepartment;
    } else if (scope.hasFeature) {
      // Feature-granted employee: respect optional ?department filter
      // exactly like HR (no automatic clamp).
      if (req.query.department && mongoose.Types.ObjectId.isValid(req.query.department)) {
        empWhere.department = req.query.department;
      }
    } else {
      res.status(403);
      throw new Error('Template analytics requires HR, Super Admin, HOD, or the Template Analytics feature permission.');
    }
  } else {
    if (req.query.department && mongoose.Types.ObjectId.isValid(req.query.department)) {
      empWhere.department = req.query.department;
    }
  }
  if (req.query.designation && mongoose.Types.ObjectId.isValid(req.query.designation)) {
    empWhere.designation = req.query.designation;
  }
  if (req.query.employee && mongoose.Types.ObjectId.isValid(req.query.employee)) {
    empWhere._id = req.query.employee;
  }
  const employees = await User.find(empWhere)
    .populate('department', 'name')
    .populate('designation', 'title')
    .lean();
  const empMap = new Map(employees.map((e) => [String(e._id), e]));
  const empIds = employees.map((e) => e._id);

  // ----- Generated submission counter (denominator for "submission rate") -----
  const generatedCount = await Submission.countDocuments({
    employee: { $in: empIds },
    template: tpl._id,
    date: { $gte: from, $lt: to },
    ...liveSubmissionFilter(flags),
  });

  // ----- Pull every submitted live submission in range -----
  // Phase 15: Dynamic Analytics Engine includes REVIEWED submissions
  // only.  Pending / rejected work can't move a KPI, leaderboard, or
  // trend until HR/HOD approves it.  Submission counts on the Overview
  // block already report this gate via submittedCount (= reviewed
  // count under the new filter).
  const subs = await Submission.find({
    employee: { $in: empIds },
    template: tpl._id,
    date: { $gte: from, $lt: to },
    submitted: true,
    ...liveSubmissionFilter({ ...flags, onlyReviewed: true }),
  })
    .select('employee date submittedAt templateType customResponses tasks productSales farmerRecords earnedPoints totalPoints workEarnedPoints workTotalPoints reviewStatus')
    .lean();

  /* =================================================================
   * OVERVIEW
   * ================================================================= */
  const submittedCount = subs.length;
  const submissionRate = safePct(submittedCount, generatedCount);

  // Aggregate task-status counts across every submission's tasks[].
  let totalTasksDone = 0, totalTasksPending = 0, totalTasksWNA = 0, totalTasksOngoing = 0;
  let extraTasksDone = 0, extraTasksPending = 0, extraTasksWNA = 0;
  const taskAgg = new Map();      // taskTitle -> { done, pending, wna }
  const extraByTitle = new Map(); // extra-work title -> { done, pending, wna, count }
  // Phase 14: custom-template fields with supportsStatus carry status
  // on customResponses[].status, not on tasks[].  Aggregate them into
  // the same taskAgg map so Done/Pending/Work N/A counts work
  // uniformly for both shapes.
  const statusFieldByKey = new Map(
    (tpl.customFields || [])
      .filter((f) => f.supportsStatus)
      .map((f) => [f.key, f]),
  );

  for (const s of subs) {
    for (const t of (s.tasks || [])) {
      const key = (t.title || '').trim() || '(untitled)';
      if (t.addedByEmployee) {
        // Extra work bucket -- tracked separately.
        if (!extraByTitle.has(key)) extraByTitle.set(key, { title: key, done: 0, pending: 0, wna: 0, count: 0 });
        const b = extraByTitle.get(key);
        b.count += 1;
        if (t.status === 'done' || t.status === 'ongoing') { b.done += 1; extraTasksDone += 1; }
        else if (t.status === 'pending') { b.pending += 1; extraTasksPending += 1; }
        else if (t.status === 'work_not_available') { b.wna += 1; extraTasksWNA += 1; }
      } else {
        if (!taskAgg.has(key)) taskAgg.set(key, { title: key, done: 0, pending: 0, wna: 0, ongoing: 0 });
        const b = taskAgg.get(key);
        if (t.status === 'done') { b.done += 1; totalTasksDone += 1; }
        else if (t.status === 'ongoing') { b.ongoing += 1; totalTasksOngoing += 1; }
        else if (t.status === 'pending') { b.pending += 1; totalTasksPending += 1; }
        else if (t.status === 'work_not_available') { b.wna += 1; totalTasksWNA += 1; }
      }
    }
    // Phase 14: per-customField status aggregation.  Each
    // status-supporting field contributes one row per submission to the
    // task agg keyed by its label (or key).
    for (const r of (s.customResponses || [])) {
      const def = statusFieldByKey.get(r.key);
      if (!def) continue;
      const key = (def.label || def.key || '').trim() || '(untitled)';
      if (!taskAgg.has(key)) taskAgg.set(key, { title: key, done: 0, pending: 0, wna: 0, ongoing: 0 });
      const b = taskAgg.get(key);
      if (r.status === 'done')                    { b.done += 1; totalTasksDone += 1; }
      else if (r.status === 'ongoing')            { b.ongoing += 1; totalTasksOngoing += 1; }
      else if (r.status === 'pending')            { b.pending += 1; totalTasksPending += 1; }
      else if (r.status === 'work_not_available') { b.wna += 1; totalTasksWNA += 1; }
    }
  }
  const totalTaskRows = totalTasksDone + totalTasksOngoing + totalTasksPending + totalTasksWNA;
  const overview = {
    totalSubmissions: submittedCount,
    generatedSubmissions: generatedCount,
    submissionRate,
    totalTasksDone, totalTasksOngoing, totalTasksPending, totalTasksWNA,
    doneRate:    safePct(totalTasksDone + totalTasksOngoing, totalTaskRows),
    pendingRate: safePct(totalTasksPending, totalTaskRows),
    wnaRate:     safePct(totalTasksWNA, totalTaskRows),
    // Work-only completion (matches Phase 6 reading of earned/total).
    completionRate: (() => {
      let e = 0, t = 0;
      for (const s of subs) { e += Number(s.earnedPoints) || 0; t += Number(s.totalPoints) || 0; }
      return safePct(e, t);
    })(),
  };

  /* =================================================================
   * FIELD ANALYTICS (every numeric custom field gets a KPI block)
   * ================================================================= */
  const fields = [];
  const numericFields = (tpl.customFields || []).filter((f) => NUMERIC_TYPES.has(f.fieldType));
  for (const f of numericFields) {
    const values = [];                   // { empId, date, value }
    const perEmp = new Map();            // empId -> { sum, count, min, max }
    const perDay = new Map();            // YMD -> sum
    for (const s of subs) {
      const row = (s.customResponses || []).find((r) => r.key === f.key);
      if (!row) continue;
      const v = Number(row.value);
      if (!Number.isFinite(v)) continue;
      const k = String(s.employee);
      if (!perEmp.has(k)) perEmp.set(k, { sum: 0, count: 0, min: v, max: v });
      const pe = perEmp.get(k);
      pe.sum += v; pe.count += 1; pe.min = Math.min(pe.min, v); pe.max = Math.max(pe.max, v);
      values.push({ empId: k, date: s.date, value: v });
      const dk = formatYMD(s.date);
      perDay.set(dk, (perDay.get(dk) || 0) + v);
    }

    let total = 0, count = 0, min = Infinity, max = -Infinity;
    for (const v of values) { total += v.value; count += 1; if (v.value < min) min = v.value; if (v.value > max) max = v.value; }
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 0;
    const avg = count > 0 ? round2(total / count) : 0;

    // Per-employee leaderboard: by sum of the field across the range.
    const topEmployees = [...perEmp.entries()].map(([eid, m]) => {
      const e = empMap.get(eid);
      return e ? {
        _id: eid, name: e.name, employeeId: e.employeeId,
        department: e.department?.name || 'Unassigned',
        total: round2(m.sum), avg: m.count > 0 ? round2(m.sum / m.count) : 0,
        min: round2(m.min), max: round2(m.max), submissions: m.count,
      } : null;
    }).filter(Boolean).sort((a, b) => b.total - a.total).slice(0, 10);

    // Per-department roll-up.
    const byDeptMap = new Map();
    for (const e of topEmployees) {
      const d = e.department || 'Unassigned';
      if (!byDeptMap.has(d)) byDeptMap.set(d, { name: d, total: 0, employees: 0 });
      const b = byDeptMap.get(d); b.total += e.total; b.employees += 1;
    }
    const byDepartment = [...byDeptMap.values()]
      .map((d) => ({ ...d, total: round2(d.total), avg: d.employees > 0 ? round2(d.total / d.employees) : 0 }))
      .sort((a, b) => b.total - a.total);

    const trend = [];
    for (let d = startOfDay(from); d < startOfDay(to); d = addDays(d, 1)) {
      const dk = formatYMD(d);
      trend.push({ date: dk, value: round2(perDay.get(dk) || 0) });
    }

    fields.push({
      key: f.key, label: f.label || f.key, fieldType: f.fieldType,
      total: round2(total), avg, min: round2(min), max: round2(max), count,
      topEmployees, byDepartment, trend,
    });
  }

  /* =================================================================
   * DROPDOWN ANALYTICS (Phase 15)
   *
   * For every customField with fieldType === 'dropdown', compute:
   *   - per-option frequency + percentage of all submissions
   *   - per-option top employees (who picked that option most)
   *   - per-day trend (option counts over the range)
   *
   * Output shape mirrors `fields[]` so the frontend can render a
   * uniform card per dropdown field.
   * ================================================================= */
  const dropdowns = [];
  const dropdownFields = (tpl.customFields || []).filter((f) => f.fieldType === 'dropdown');
  for (const f of dropdownFields) {
    const optionCounts = new Map();      // option -> count
    const perEmpPerOption = new Map();   // empId -> { option -> count }
    const perDayPerOption = new Map();   // YMD -> { option -> count }
    let totalAnswered = 0;
    for (const s of subs) {
      const row = (s.customResponses || []).find((r) => r.key === f.key);
      const opt = String(row?.value ?? '').trim();
      if (!opt) continue;
      totalAnswered += 1;
      optionCounts.set(opt, (optionCounts.get(opt) || 0) + 1);
      const eid = String(s.employee);
      if (!perEmpPerOption.has(eid)) perEmpPerOption.set(eid, new Map());
      const emap = perEmpPerOption.get(eid);
      emap.set(opt, (emap.get(opt) || 0) + 1);
      const dk = formatYMD(s.date);
      if (!perDayPerOption.has(dk)) perDayPerOption.set(dk, new Map());
      const dmap = perDayPerOption.get(dk);
      dmap.set(opt, (dmap.get(opt) || 0) + 1);
    }
    // Build options array sorted by frequency desc.  Templates only
    // surface configured options; ad-hoc values employees somehow
    // typed get included too so HR can spot data-entry mismatches.
    const allOptions = Array.from(new Set([
      ...(Array.isArray(f.options) ? f.options : []),
      ...optionCounts.keys(),
    ]));
    const options = allOptions.map((opt) => {
      const count = optionCounts.get(opt) || 0;
      // Top employees picking this option (across all submissions in range).
      const empBoard = [...perEmpPerOption.entries()]
        .map(([eid, emap]) => {
          const cnt = emap.get(opt) || 0;
          if (cnt <= 0) return null;
          const e = empMap.get(eid);
          return e ? {
            _id: eid, name: e.name, employeeId: e.employeeId,
            department: e.department?.name || 'Unassigned',
            count: cnt,
          } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      return {
        option: opt,
        count,
        pct: safePct(count, totalAnswered),
        topEmployees: empBoard,
      };
    }).sort((a, b) => b.count - a.count);

    // Daily trend: one series per option.  Empty days yield 0 for each
    // option so chart bars line up across the range.
    const trend = [];
    for (let d = startOfDay(from); d < startOfDay(to); d = addDays(d, 1)) {
      const dk = formatYMD(d);
      const dmap = perDayPerOption.get(dk) || new Map();
      const day = { date: dk };
      for (const opt of allOptions) day[opt] = dmap.get(opt) || 0;
      trend.push(day);
    }

    dropdowns.push({
      key: f.key,
      label: f.label || f.key,
      options,
      totalAnswered,
      trend,
      // Mirror the options list keys so the frontend chart knows which
      // series to plot without re-deriving them from `trend[0]`.
      seriesKeys: allOptions,
    });
  }

  /* =================================================================
   * TASK STATUS ANALYTICS (per task title)
   * ================================================================= */
  const tasks = [...taskAgg.values()].map((t) => {
    const total = t.done + t.ongoing + t.pending + t.wna;
    return {
      title: t.title,
      counts: t,
      donePct:    safePct(t.done + t.ongoing, total),
      pendingPct: safePct(t.pending, total),
      wnaPct:     safePct(t.wna, total),
    };
  }).sort((a, b) => (b.counts.done + b.counts.pending + b.counts.wna) - (a.counts.done + a.counts.pending + a.counts.wna));

  /* =================================================================
   * EMPLOYEE PERFORMANCE
   *
   * Built from work-only earnedPoints / totalPoints (Phase 6).  Daily
   * discipline + idea aren't folded in here because the dynamic page
   * focuses on the template's own data; the existing Completion
   * Review page already does the cross-template view.
   * ================================================================= */
  const perEmpPerf = new Map();
  for (const s of subs) {
    const k = String(s.employee);
    if (!perEmpPerf.has(k)) perEmpPerf.set(k, {
      _id: k, earned: 0, total: 0, subs: 0, pending: 0, done: 0, wna: 0,
      pctList: [],
    });
    const pe = perEmpPerf.get(k);
    pe.earned += Number(s.earnedPoints) || 0;
    pe.total  += Number(s.totalPoints)  || 0;
    pe.subs   += 1;
    for (const t of (s.tasks || [])) {
      if (t.addedByEmployee) continue;
      if (t.status === 'done' || t.status === 'ongoing') pe.done += 1;
      else if (t.status === 'pending') pe.pending += 1;
      else if (t.status === 'work_not_available') pe.wna += 1;
    }
    if (Number(s.totalPoints) > 0) {
      pe.pctList.push((Number(s.earnedPoints) || 0) / Number(s.totalPoints) * 100);
    }
  }
  const employeeRows = [];
  for (const [k, v] of perEmpPerf.entries()) {
    const e = empMap.get(k); if (!e) continue;
    const score = v.total > 0 ? round1((v.earned / v.total) * 100) : 0;
    // Consistency = 100 - stddev(pctList), clamped.
    const consistency = (() => {
      const arr = v.pctList;
      if (arr.length < 2) return arr.length === 1 ? 100 : 0;
      const m = arr.reduce((a, b) => a + b, 0) / arr.length;
      const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
      return round1(Math.max(0, 100 - Math.min(100, sd)));
    })();
    employeeRows.push({
      _id: k, name: e.name, employeeId: e.employeeId,
      department: e.department?.name || 'Unassigned',
      designation: e.designation?.title || 'Unassigned',
      score, submissions: v.subs, pendingCount: v.pending, doneCount: v.done, wnaCount: v.wna,
      consistency,
    });
  }
  const top5     = (arr, key, dir = 'desc') => [...arr].sort((a, b) => (dir === 'desc' ? (b[key] - a[key]) : (a[key] - b[key]))).slice(0, 5);
  const employeePerformance = {
    topPerformers:    top5(employeeRows.filter((e) => e.submissions >= 1), 'score'),
    lowestPerformers: top5(employeeRows.filter((e) => e.submissions >= 1), 'score', 'asc'),
    mostConsistent:   top5(employeeRows.filter((e) => e.submissions >= 2), 'consistency'),
    mostPending:      top5(employeeRows, 'pendingCount'),
    mostActive:       top5(employeeRows, 'submissions'),
  };

  /* =================================================================
   * EXTRA WORK ANALYTICS
   *
   * Aggregates Submission.tasks[].addedByEmployee=true rows across all
   * submissions in scope.  Surfaces total, top employees, by department,
   * by extra-work title, and a daily trend.
   * ================================================================= */
  let extraTotal = 0;
  const extraByEmp = new Map();   // empId -> { count, done, pending }
  const extraByDept = new Map();  // dept -> count
  const extraTrend = new Map();   // YMD -> count
  for (const s of subs) {
    const dk = formatYMD(s.date);
    const extras = (s.tasks || []).filter((t) => t.addedByEmployee);
    if (extras.length === 0) continue;
    extraTotal += extras.length;
    const eid = String(s.employee);
    if (!extraByEmp.has(eid)) extraByEmp.set(eid, { count: 0, done: 0, pending: 0 });
    const eb = extraByEmp.get(eid);
    eb.count += extras.length;
    for (const x of extras) {
      if (x.status === 'done' || x.status === 'ongoing') eb.done += 1;
      else if (x.status === 'pending') eb.pending += 1;
    }
    const e = empMap.get(eid);
    const d = e?.department?.name || 'Unassigned';
    extraByDept.set(d, (extraByDept.get(d) || 0) + extras.length);
    extraTrend.set(dk, (extraTrend.get(dk) || 0) + extras.length);
  }
  const extraEmployees = [...extraByEmp.entries()].map(([eid, m]) => {
    const e = empMap.get(eid);
    return e ? {
      _id: eid, name: e.name, employeeId: e.employeeId,
      department: e.department?.name || 'Unassigned',
      extra: m.count, done: m.done, pending: m.pending,
    } : null;
  }).filter(Boolean).sort((a, b) => b.extra - a.extra).slice(0, 10);
  const extraDept = [...extraByDept.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const extraTrendArr = [];
  for (let d = startOfDay(from); d < startOfDay(to); d = addDays(d, 1)) {
    const dk = formatYMD(d);
    extraTrendArr.push({ date: dk, count: extraTrend.get(dk) || 0 });
  }
  const extraTypes = [...extraByTitle.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  const extraWork = {
    total: extraTotal,
    done: extraTasksDone, pending: extraTasksPending, wna: extraTasksWNA,
    topEmployees: extraEmployees,
    byDepartment: extraDept,
    trend: extraTrendArr,
    byTitle: extraTypes,
  };

  /* =================================================================
   * SUB-TEMPLATE BREAKDOWN (Phase 12 / 13)
   *
   * For every sub-template defined on the parent template, emit a
   * mini-block of overview KPIs + per-field totals so the analytics
   * UI can compare sub-templates side by side.  Heavy-lifting reuses
   * the same per-field math; we just bucket by subTemplateId.
   *
   * Phase 13 additions: per-sub-template assignedCount (how many
   * employees have this sub-template scoped in any live assignment)
   * + submittedCount + completionRate + pendingRate + a daily trend
   * series so HR can compare Billing vs Collections head-on.
   * ================================================================= */
  const subTemplates = [];
  const subTemplateDefs = Array.isArray(tpl.subTemplates) ? tpl.subTemplates : [];

  // Pre-fetch every live assignment for this template so the per-sub
  // assignedCount is one query, not N.  Active + not revoked only.
  let subAssignmentRows = [];
  if (subTemplateDefs.length > 0) {
    subAssignmentRows = await Assignment.find({
      template: tpl._id,
      active: true,
      revokedAt: null,
    }).select('targetType targetRef subTemplateIds subTemplateId').lean();
  }

  // Helper: expand a single assignment's target to the set of
  // currently-active employee ids it covers (intersected with empIds
  // so HOD scope + filters apply correctly).
  const _empIdsFor = (a) => {
    if (a.targetType === 'employee') {
      const id = String(a.targetRef);
      return empIds.filter((x) => String(x) === id);
    }
    return employees
      .filter((e) => {
        if (a.targetType === 'department')  return String(e.department?._id || e.department) === String(a.targetRef);
        if (a.targetType === 'designation') return String(e.designation?._id || e.designation) === String(a.targetRef);
        return false;
      })
      .map((e) => e._id);
  };

  for (const sub of subTemplateDefs) {
    const subFieldDefs = (tpl.customFields || []).filter((f) => String(f.subTemplateId || '') === String(sub._id));
    const subNumeric = subFieldDefs.filter((f) => NUMERIC_TYPES.has(f.fieldType));
    const subFields = [];
    for (const f of subNumeric) {
      let total = 0, count = 0, min = Infinity, max = -Infinity;
      for (const s of subs) {
        const row = (s.customResponses || []).find((r) => r.key === f.key);
        if (!row) continue;
        const v = Number(row.value);
        if (!Number.isFinite(v)) continue;
        total += v; count += 1;
        if (v < min) min = v; if (v > max) max = v;
      }
      if (!Number.isFinite(min)) min = 0;
      if (!Number.isFinite(max)) max = 0;
      subFields.push({
        key: f.key, label: f.label || f.key, fieldType: f.fieldType,
        total: round2(total), avg: count > 0 ? round2(total / count) : 0,
        min: round2(min), max: round2(max), count,
      });
    }
    // Sub-template task aggregation (only count fields with status enabled
    // OR any tasks whose title looks like one of the sub-template's fields).
    let subDone = 0, subPending = 0, subWNA = 0;
    for (const s of subs) {
      for (const t of (s.tasks || [])) {
        if (t.addedByEmployee) continue;
        // Cross-reference: when a customField with supportsStatus exists
        // in this sub-template AND a task.title matches its label,
        // attribute that task to the sub-template.
        const match = subFieldDefs.find((f) => (f.label || '') === (t.title || ''));
        if (!match) continue;
        if (t.status === 'done' || t.status === 'ongoing') subDone += 1;
        else if (t.status === 'pending') subPending += 1;
        else if (t.status === 'work_not_available') subWNA += 1;
      }
    }
    const subTaskTotal = subDone + subPending + subWNA;

    /* ---- Phase 13: assigned + submitted + per-employee + trend ---- */
    // assignedCount = distinct employees whose assignment covers this
    // sub-template (including assignments with empty subTemplateIds =
    // "all sub-templates").
    const assignedSet = new Set();
    for (const a of subAssignmentRows) {
      const scope = Array.isArray(a.subTemplateIds) && a.subTemplateIds.length > 0
        ? a.subTemplateIds.map(String)
        : (a.subTemplateId ? [String(a.subTemplateId)] : []);
      const matches = scope.length === 0 || scope.includes(String(sub._id));
      if (!matches) continue;
      for (const eid of _empIdsFor(a)) assignedSet.add(String(eid));
    }

    // submittedCount + per-employee ranking + daily trend.  A submission
    // counts toward this sub-template when ANY of its customResponses
    // matches a field belonging to this sub-template (non-null/non-zero).
    const subFieldKeys = new Set(subFieldDefs.map((f) => f.key));
    const subEmpAgg = new Map();    // empId -> { submissions, donePct numerator/denominator }
    const subDailyAgg = new Map();  // YMD -> { subs, done, pending }
    let subSubmitted = 0;
    for (const s of subs) {
      const responses = s.customResponses || [];
      const touched = responses.some((r) => subFieldKeys.has(r.key));
      if (!touched) continue;
      subSubmitted += 1;
      const eid = String(s.employee);
      if (!subEmpAgg.has(eid)) subEmpAgg.set(eid, { submissions: 0, earned: 0, total: 0 });
      const pe = subEmpAgg.get(eid);
      pe.submissions += 1;
      pe.earned += Number(s.earnedPoints) || 0;
      pe.total  += Number(s.totalPoints)  || 0;
      const dk = formatYMD(s.date);
      if (!subDailyAgg.has(dk)) subDailyAgg.set(dk, { date: dk, submissions: 0 });
      subDailyAgg.get(dk).submissions += 1;
    }
    const submittedExpected = assignedSet.size > 0
      ? assignedSet.size * Math.max(1, Math.ceil((to - from) / 86400000))
      : 0;
    const employeeRanking = [...subEmpAgg.entries()].map(([eid, m]) => {
      const e = empMap.get(eid);
      return e ? {
        _id: eid, name: e.name, employeeId: e.employeeId,
        department: e.department?.name || 'Unassigned',
        submissions: m.submissions,
        completionPct: m.total > 0 ? round1((m.earned / m.total) * 100) : 0,
      } : null;
    }).filter(Boolean).sort((a, b) => (b.completionPct - a.completionPct) || (b.submissions - a.submissions)).slice(0, 10);

    const subTrend = [];
    for (let d = startOfDay(from); d < startOfDay(to); d = addDays(d, 1)) {
      const dk = formatYMD(d);
      subTrend.push({ date: dk, submissions: (subDailyAgg.get(dk)?.submissions || 0) });
    }

    subTemplates.push({
      _id: sub._id, name: sub.name, description: sub.description,
      fieldCount: subFieldDefs.length,
      overview: {
        donePct:    safePct(subDone, subTaskTotal),
        pendingPct: safePct(subPending, subTaskTotal),
        wnaPct:     safePct(subWNA, subTaskTotal),
        taskRows: subTaskTotal,
        assignedCount:  assignedSet.size,
        submittedCount: subSubmitted,
        completionRate: subSubmitted > 0
          ? round1((subEmpAgg.size > 0
              ? [...subEmpAgg.values()].reduce((s, v) => s + (v.total > 0 ? (v.earned / v.total) * 100 : 0), 0) / subEmpAgg.size
              : 0))
          : 0,
        submissionRate: submittedExpected > 0 ? safePct(subSubmitted, submittedExpected) : 0,
      },
      fields: subFields,
      employeeRanking,
      trend: subTrend,
    });
  }

  /* ====================================================================
   * Phase 30 — Drill-down detail rows
   *
   * Flat, read-only projections of the SAME `subs` cursor already walked
   * above so every card / table cell on Template Analytics can open a
   * drill-down modal showing the records behind the number.  No new
   * query, no new aggregation, no change to any KPI / leaderboard /
   * rate / formula -- the existing payload is left exactly as it was;
   * we just append three flat arrays below.
   *
   *   submissionRows[]  — one row per submission in scope
   *   taskRows[]        — one row per task across every submission
   *                       (system + employee-added), keyed by task title
   *                       and statusFieldKey so the Task Status table
   *                       cells can filter by title + status
   *   fieldRows[]       — one row per (submission, numeric field) so
   *                       every auto-generated Field Analytics KPI card
   *                       has a per-record drill behind it
   *
   * Auto-coverage for future templates: the projections are derived
   * purely from `tpl.customFields` and `Submission.tasks[]` /
   * `Submission.customResponses[]`.  Any new custom template inherits
   * the drill-down behaviour without per-template code, satisfying the
   * spec's "Auto-Generated Future Templates" requirement.
   * ================================================================== */
  const submissionRows = [];
  const taskRows = [];
  const fieldRows = [];
  for (const s of subs) {
    const e = empMap.get(String(s.employee));
    if (!e) continue;
    const empSnap = {
      employeeId: String(e._id),
      employeeName: e.name,
      employeeCode: e.employeeId,
      department: e.department?.name || 'Unassigned',
      designation: e.designation?.title || 'Unassigned',
    };
    const dateKey = formatYMD(s.date);
    const submissionRow = {
      _id: String(s._id),
      ...empSnap,
      date: dateKey,
      submittedAt: s.submittedAt,
      reviewStatus: s.reviewStatus,
      earnedPoints: Number(s.earnedPoints) || 0,
      totalPoints:  Number(s.totalPoints)  || 0,
      workEarnedPoints: Number(s.workEarnedPoints) || 0,
      workTotalPoints:  Number(s.workTotalPoints)  || 0,
      // Per-submission rollups so Overview drill-downs can sort by
      // contribution.  Mirrors the same status math the aggregate uses
      // (Done/Ongoing → done, Pending → pending, Work N/A → wna).
      taskDone: 0, taskPending: 0, taskWNA: 0, taskOngoing: 0,
      extraDone: 0, extraPending: 0, extraWNA: 0, extraCount: 0,
    };
    submissionRows.push(submissionRow);

    // Walk system + employee-added tasks.
    for (const t of (s.tasks || [])) {
      const title = (t.title || '').trim() || '(untitled)';
      const row = {
        submissionId: String(s._id),
        taskId: String(t._id || ''),
        ...empSnap,
        date: dateKey,
        title,
        status: t.status,
        points: Number(t.points) || 0,
        awardedMarks: Number(t.awardedMarks) || 0,
        addedByEmployee: !!t.addedByEmployee,
        pendingReason: t.pendingReason || '',
      };
      taskRows.push(row);
      if (t.addedByEmployee) {
        submissionRow.extraCount += 1;
        if (t.status === 'done' || t.status === 'ongoing') submissionRow.extraDone += 1;
        else if (t.status === 'pending') submissionRow.extraPending += 1;
        else if (t.status === 'work_not_available') submissionRow.extraWNA += 1;
      } else {
        if (t.status === 'done')                    submissionRow.taskDone += 1;
        else if (t.status === 'ongoing')            submissionRow.taskOngoing += 1;
        else if (t.status === 'pending')            submissionRow.taskPending += 1;
        else if (t.status === 'work_not_available') submissionRow.taskWNA += 1;
      }
    }

    // Status-supporting customField responses (Phase 14) — same task
    // semantics, just stored on customResponses[] instead of tasks[].
    for (const r of (s.customResponses || [])) {
      const def = statusFieldByKey.get(r.key);
      if (def) {
        const title = (def.label || def.key || '').trim() || '(untitled)';
        taskRows.push({
          submissionId: String(s._id),
          taskId: '',
          fieldKey: def.key,
          ...empSnap,
          date: dateKey,
          title,
          status: r.status || '',
          remark: r.remark || '',
          addedByEmployee: false,
        });
        if (r.status === 'done')                    submissionRow.taskDone += 1;
        else if (r.status === 'ongoing')            submissionRow.taskOngoing += 1;
        else if (r.status === 'pending')            submissionRow.taskPending += 1;
        else if (r.status === 'work_not_available') submissionRow.taskWNA += 1;
      }
      // Numeric field projection — per-(submission, field) row.
      // numericFields is already filtered above.
      const numericDef = numericFields.find((f) => f.key === r.key);
      if (numericDef) {
        const v = Number(r.value);
        if (Number.isFinite(v)) {
          fieldRows.push({
            submissionId: String(s._id),
            ...empSnap,
            date: dateKey,
            fieldKey: numericDef.key,
            fieldLabel: numericDef.label || numericDef.key,
            fieldType: numericDef.fieldType,
            value: v,
          });
        }
      }
    }
  }

  res.json({
    template: {
      _id: tpl._id, title: tpl.title,
      analyticsName: tpl.analyticsName || `${tpl.title} Analytics`,
      templateType: tpl.templateType, customKind: tpl.customKind || '',
      fields: numericFields.map((f) => ({ key: f.key, label: f.label, fieldType: f.fieldType })),
      subTemplates: subTemplateDefs.map((s) => ({ _id: s._id, name: s.name, description: s.description })),
    },
    range: { from: formatYMD(from), to: formatYMD(addDays(to, -1)) },
    overview,
    fields,
    dropdowns,
    tasks,
    employeePerformance,
    extraWork,
    subTemplates,
    // Phase 30: drill-down detail rows.
    detail: { submissionRows, taskRows, fieldRows },
  });
});

/* ====================================================================
 * Phase 41.2 — Delete Template Analytics entry (analytics only)
 *
 * Sets `template.analyticsHidden = true` so the template disappears
 * from the Template Analytics picker.  Everything else about the
 * template is preserved verbatim:
 *   - the Template document stays in the collection,
 *   - active assignments keep targeting it,
 *   - submissions keep flowing in,
 *   - attendance / performance / review-history / dashboards keep
 *     reading from the same Submission rows,
 *   - the original work-template can still be re-surfaced later by
 *     flipping the flag back to `false`.
 *
 * HR / Super Admin only.  HODs cannot delete analytics entries.
 *
 *   DELETE /api/template-analytics/:templateId
 *     hide a single template
 *
 *   POST   /api/template-analytics/hide-bulk
 *     Body: { templateIds: [String] }
 *     hide many templates in one call
 *
 * To re-enable an analytics entry, HR can flip the flag back via the
 * Templates admin page (or this endpoint with action='restore').
 * ================================================================== */
const remove = asyncHandler(async (req, res) => {
  const role = req.user.role;
  if (role !== 'hr' && role !== 'super_admin') {
    res.status(403); throw new Error('Only HR / Super Admin can manage analytics entries.');
  }
  const { templateId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(templateId)) {
    res.status(400); throw new Error('Valid templateId is required.');
  }
  const tpl = await Template.findByIdAndUpdate(
    templateId,
    { $set: { analyticsHidden: true } },
    { new: true },
  ).select('_id title analyticsHidden');
  if (!tpl) { res.status(404); throw new Error('Template not found.'); }
  res.json({ ok: true, template: { _id: tpl._id, title: tpl.title, analyticsHidden: tpl.analyticsHidden } });
});

const removeBulk = asyncHandler(async (req, res) => {
  const role = req.user.role;
  if (role !== 'hr' && role !== 'super_admin') {
    res.status(403); throw new Error('Only HR / Super Admin can manage analytics entries.');
  }
  const { templateIds } = req.body || {};
  if (!Array.isArray(templateIds) || templateIds.length === 0) {
    res.status(400); throw new Error('templateIds[] is required.');
  }
  const validIds = templateIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  const result = await Template.updateMany(
    { _id: { $in: validIds } },
    { $set: { analyticsHidden: true } },
  );
  res.json({
    ok: true,
    requested: templateIds.length,
    matched: result.matchedCount || result.n || 0,
    modified: result.modifiedCount || result.nModified || 0,
  });
});

module.exports = { list, generate, remove, removeBulk };
