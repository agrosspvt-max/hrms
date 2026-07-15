/**
 * dailySelfReviewController.js
 *
 * Phase 69 -- Daily Self Review analytics.
 *
 * ALL analytics are computed from the existing DailyReflection
 * collection (single source of truth per (employee, date)) joined
 * with User + Department for filtering.  No new collection, no
 * duplicate data; every metric is derived from the same rows that
 * power the daily-review UI.
 *
 * The module never touches Performance / Salary / Compliance /
 * Submission logic -- it purely reads.
 */
const asyncHandler   = require('express-async-handler');
const mongoose       = require('mongoose');
const DailyReflection = require('../models/DailyReflection');
const User            = require('../models/User');
const Submission      = require('../models/Submission');
const Attendance      = require('../models/Attendance');
const { startOfDay }  = require('../utils/dateHelpers');

/* ------------------------------------------------------------------ */
/* Filter resolution                                                    */
/* ------------------------------------------------------------------ */
/**
 * Parse the shared query filter block used by every endpoint in this
 * controller so from/to/department/employee/scope stay consistent
 * across overview / charts / libraries / export.  Returns the Mongo
 * `match` clause for DailyReflection lookups and the (possibly HOD-
 * scoped) employee id set the caller should reuse for User joins.
 */
const _resolveScope = async (req) => {
  const q = req.query || {};
  const now = new Date();
  const days = Number(q.range) || 30;
  let from, to;
  if (q.from && q.to) {
    from = startOfDay(new Date(q.from));
    to   = startOfDay(new Date(q.to));
  } else {
    to   = startOfDay(now);
    from = startOfDay(new Date(now.getTime() - (days - 1) * 86400000));
  }
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    const err = new Error('Invalid date range.');
    err._http = 400; throw err;
  }

  // Role scoping.  HR / Super Admin see the org; HOD sees their dept.
  const empWhere = { status: 'active' };
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin') {
    if (isHOD) empWhere.department = req.user.hodDepartment;
    else {
      const err = new Error('Forbidden');
      err._http = 403; throw err;
    }
  }
  if (q.department && mongoose.Types.ObjectId.isValid(q.department)) {
    empWhere.department = q.department;
  }
  if (q.designation && mongoose.Types.ObjectId.isValid(q.designation)) {
    empWhere.designation = q.designation;
  }
  if (q.employee && mongoose.Types.ObjectId.isValid(q.employee)) {
    empWhere._id = q.employee;
  }

  const employees = await User.find(empWhere)
    .select('_id name employeeId department designation')
    .populate('department', 'name')
    .lean();
  const empIds = employees.map((e) => e._id);
  const empMap = new Map(employees.map((e) => [String(e._id), e]));

  return { from, to, employees, empIds, empMap };
};

/* ------------------------------------------------------------------ */
/* Shared aggregation helpers                                           */
/* ------------------------------------------------------------------ */
const _stats = (arr) => {
  if (!arr.length) return { avg: 0, high: 0, low: 0, median: 0, count: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const avg = arr.reduce((s, n) => s + n, 0) / arr.length;
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    count: arr.length,
    avg:  Math.round(avg * 100) / 100,
    high: sorted[sorted.length - 1],
    low:  sorted[0],
    median: Math.round(median * 100) / 100,
  };
};

const _isoDay  = (d) => new Date(d).toISOString().slice(0, 10);
const _isoWeek = (d) => {
  const dt = new Date(d);
  // ISO week key -- year + week number, so week averages don't collide
  // across years.
  const day = dt.getUTCDay() || 7;
  dt.setUTCHours(0, 0, 0, 0);
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};
const _isoMonth = (d) => {
  const dt = new Date(d);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * Fetch DailyReflection rows for the resolved scope in one call.
 * Every downstream metric slices this array so the DB is hit once
 * per request.
 */
const _fetchReflections = async ({ from, to, empIds }) => {
  if (empIds.length === 0) return [];
  const rows = await DailyReflection.find({
    employee: { $in: empIds },
    date:     { $gte: from, $lte: to },
    selfRating: { $type: 'number' },
  }).select('employee date selfRating selfNote idea').lean();
  return rows;
};

/* ------------------------------------------------------------------ */
/* GET /api/self-review/overview                                        */
/* ------------------------------------------------------------------ */
/**
 * Returns the full analytics payload the Daily Self Review tab renders:
 * overview cards + every chart series + the department / period rollups.
 * Bundled into ONE endpoint so the frontend fires one request per view.
 */
const overview = asyncHandler(async (req, res) => {
  let scope;
  try { scope = await _resolveScope(req); }
  catch (e) { res.status(e._http || 500); throw e; }
  const { from, to, employees, empIds, empMap } = scope;

  const reflections = await _fetchReflections({ from, to, empIds });
  const ratings = reflections.map((r) => r.selfRating);
  const stats = _stats(ratings);

  // Employees who submitted at least one reflection in range, and the
  // rest (missing).
  const reflectedEmpIds = new Set(reflections.map((r) => String(r.employee)));
  const employeesSubmitted = reflectedEmpIds.size;
  const employeesMissing   = employees.length - employeesSubmitted;

  // Per-employee stats -- consistency = count / total-days in range.
  const totalDays = Math.max(1, Math.floor((to - from) / 86400000) + 1);
  const byEmp = new Map();
  for (const r of reflections) {
    const k = String(r.employee);
    if (!byEmp.has(k)) byEmp.set(k, { ratings: [], dates: [], notes: 0, ideas: 0 });
    const b = byEmp.get(k);
    b.ratings.push(r.selfRating);
    b.dates.push(new Date(r.date).getTime());
    if (r.selfNote) b.notes += 1;
    if (r.idea)     b.ideas += 1;
  }
  const perEmployee = [];
  for (const [empId, b] of byEmp.entries()) {
    const e = empMap.get(empId);
    if (!e) continue;
    const s = _stats(b.ratings);
    perEmployee.push({
      employee: {
        _id: e._id, name: e.name, employeeId: e.employeeId,
        department: e.department?.name || '',
      },
      count: s.count,
      avg: s.avg, high: s.high, low: s.low, median: s.median,
      consistency: Math.round((s.count / totalDays) * 100),
      notes: b.notes, ideas: b.ideas,
    });
  }

  // Most Improved: compare first-third avg vs last-third avg per employee.
  const mostImproved = perEmployee
    .filter((p) => p.count >= 4)
    .map((p) => {
      const emp = byEmp.get(String(p.employee._id));
      const pairs = emp.ratings.map((r, i) => ({ r, t: emp.dates[i] }))
        .sort((a, b) => a.t - b.t);
      const third = Math.max(1, Math.floor(pairs.length / 3));
      const firstAvg = pairs.slice(0, third).reduce((s, x) => s + x.r, 0) / third;
      const lastAvg  = pairs.slice(-third).reduce((s, x) => s + x.r, 0) / third;
      return { ...p, improvement: Math.round((lastAvg - firstAvg) * 100) / 100 };
    })
    .sort((a, b) => b.improvement - a.improvement)[0] || null;

  const mostConsistent = [...perEmployee].sort((a, b) => b.consistency - a.consistency)[0] || null;
  const mostPositive   = [...perEmployee].filter((p) => p.count >= 3).sort((a, b) => b.avg - a.avg)[0] || null;
  const mostCritical   = [...perEmployee].filter((p) => p.count >= 3).sort((a, b) => a.avg - b.avg)[0] || null;

  // Department averages.
  const byDept = new Map();
  for (const p of perEmployee) {
    const d = p.employee.department || 'Unassigned';
    if (!byDept.has(d)) byDept.set(d, []);
    byDept.get(d).push(p.avg);
  }
  const deptAvg = [...byDept.entries()]
    .map(([name, arr]) => ({ name, avg: Math.round((arr.reduce((s, n) => s + n, 0) / arr.length) * 100) / 100, employees: arr.length }))
    .sort((a, b) => b.avg - a.avg);

  // Daily / Weekly / Monthly average buckets.
  const bucket = (keyFn) => {
    const m = new Map();
    for (const r of reflections) {
      const k = keyFn(r.date);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r.selfRating);
    }
    return [...m.entries()]
      .map(([k, arr]) => ({ label: k, avg: Math.round((arr.reduce((s, n) => s + n, 0) / arr.length) * 100) / 100, count: arr.length }))
      .sort((a, b) => a.label.localeCompare(b.label));
  };
  const daily   = bucket(_isoDay);
  const weekly  = bucket(_isoWeek);
  const monthly = bucket(_isoMonth);

  // Distribution histogram (integer buckets 0..10).  Half-integer
  // ratings round to the nearest bucket.
  const dist = Array.from({ length: 11 }, (_, i) => ({ rating: i, count: 0 }));
  for (const r of ratings) dist[Math.round(r)].count += 1;

  // Heatmap by weekday (0 = Sun..6 = Sat).
  const heatByWeekday = Array.from({ length: 7 }, () => ({ ratings: [] }));
  for (const r of reflections) heatByWeekday[new Date(r.date).getUTCDay()].ratings.push(r.selfRating);
  const heatmap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, i) => {
    const arr = heatByWeekday[i].ratings;
    return {
      weekday: label,
      count: arr.length,
      avg: arr.length ? Math.round((arr.reduce((s, n) => s + n, 0) / arr.length) * 100) / 100 : 0,
    };
  });

  // Ranking: top / bottom 10 by avg (min 3 reflections).
  const ranking = perEmployee.filter((p) => p.count >= 3).sort((a, b) => b.avg - a.avg);
  const topRanking = ranking.slice(0, 10);
  const bottomRanking = ranking.slice(-10).reverse();

  // Trend vs previous equal-length period.
  const prevTo   = new Date(from.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (to - from));
  const prevRows = await _fetchReflections({ from: prevFrom, to: prevTo, empIds });
  const prev = _stats(prevRows.map((r) => r.selfRating));
  const trend = {
    currentAvg: stats.avg,
    previousAvg: prev.avg,
    delta: Math.round((stats.avg - prev.avg) * 100) / 100,
    deltaPct: prev.avg ? Math.round(((stats.avg - prev.avg) / prev.avg) * 10000) / 100 : 0,
  };

  res.json({
    range: {
      from: from.toISOString().slice(0, 10),
      to:   to.toISOString().slice(0, 10),
      days: totalDays,
    },
    cards: {
      avgRating: stats.avg,
      highestRating: stats.high,
      lowestRating: stats.low,
      medianRating: stats.median,
      totalReflections: stats.count,
      employeesSubmitted,
      employeesMissing,
      mostConsistent,
      mostPositive,
      mostCritical,
      mostImproved,
    },
    trend,
    charts: {
      daily, weekly, monthly,
      deptAvg,
      distribution: dist,
      heatmap,
      topRanking, bottomRanking,
    },
    perEmployee,
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/self-review/employee/:id                                    */
/* ------------------------------------------------------------------ */
/**
 * Employee drill-down: full stats + rating history + daily timeline
 * enriched with submission link + attendance status for the day.
 */
const employeeDetail = asyncHandler(async (req, res) => {
  let scope;
  try { scope = await _resolveScope({ ...req, query: { ...req.query, employee: req.params.id } }); }
  catch (e) { res.status(e._http || 500); throw e; }
  const { from, to, empMap } = scope;
  const emp = empMap.get(String(req.params.id));
  if (!emp) { res.status(404); throw new Error('Employee not found in scope.'); }

  const reflections = await DailyReflection.find({
    employee: emp._id,
    date: { $gte: from, $lte: to },
    selfRating: { $type: 'number' },
  }).select('date selfRating selfNote idea').lean();

  // Pull that employee's submissions + attendance rows for the range
  // so the timeline can link back to the day's submission + show the
  // attendance status alongside.
  const [subs, attRows] = await Promise.all([
    Submission.find({ employee: emp._id, date: { $gte: from, $lte: to } })
      .select('_id date submitted reviewStatus').lean(),
    Attendance.find({ employee: emp._id, date: { $gte: from, $lte: to } })
      .select('date status').lean(),
  ]);
  const subByDay = new Map();
  for (const s of subs) {
    const k = _isoDay(s.date);
    // Prefer the SUBMITTED row (there can be a placeholder + a submitted
    // row for the same day if the day was reopened).
    if (!subByDay.has(k) || (!subByDay.get(k).submitted && s.submitted)) subByDay.set(k, s);
  }
  const attByDay = new Map(attRows.map((a) => [_isoDay(a.date), a.status]));

  const stats = _stats(reflections.map((r) => r.selfRating));
  const timeline = reflections
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map((r) => {
      const k = _isoDay(r.date);
      const s = subByDay.get(k);
      return {
        date: r.date,
        selfRating: r.selfRating,
        selfNote: r.selfNote || '',
        idea: r.idea || '',
        submissionId: s?._id || null,
        submissionStatus: s ? (s.submitted ? (s.reviewStatus || 'pending') : 'draft') : 'none',
        attendance: attByDay.get(k) || null,
      };
    });

  res.json({
    employee: {
      _id: emp._id, name: emp.name, employeeId: emp.employeeId,
      department: emp.department?.name || '',
    },
    range: {
      from: from.toISOString().slice(0, 10),
      to:   to.toISOString().slice(0, 10),
    },
    stats,
    timeline,
  });
});

/* ------------------------------------------------------------------ */
/* Libraries -- Ideas + Notes                                           */
/* ------------------------------------------------------------------ */
const _libraryLookup = async (req, { field, requireNonEmpty }) => {
  const scope = await _resolveScope(req);
  const { from, to, empIds, empMap } = scope;
  const q = req.query || {};
  const match = {
    employee: { $in: empIds },
    date: { $gte: from, $lte: to },
  };
  if (requireNonEmpty) match[field] = { $exists: true, $ne: '', $ne: null };
  if (q.rating) {
    const n = Number(q.rating);
    if (Number.isFinite(n)) match.selfRating = n;
  }
  const rows = await DailyReflection.find(match)
    .select(`employee date selfRating ${field}`)
    .sort({ date: -1 })
    .limit(1000)
    .lean();
  const keyword = String(q.keyword || '').trim().toLowerCase();

  // Phase 70 -- attendance + submission status filters + click-through
  // to the original submission.  Batched joins so a 1000-row library
  // costs two queries, not N.
  const [subs, attRows] = rows.length ? await Promise.all([
    Submission.find({
      employee: { $in: empIds },
      date: { $gte: from, $lte: to },
    }).select('_id employee date submitted reviewStatus').lean(),
    Attendance.find({
      employee: { $in: empIds },
      date: { $gte: from, $lte: to },
    }).select('employee date status').lean(),
  ]) : [[], []];
  const subKey = (e, d) => `${String(e)}|${_isoDay(d)}`;
  const subMap = new Map();
  for (const s of subs) {
    const k = subKey(s.employee, s.date);
    if (!subMap.has(k) || (!subMap.get(k).submitted && s.submitted)) subMap.set(k, s);
  }
  const attMap = new Map(attRows.map((a) => [subKey(a.employee, a.date), a.status]));

  const attFilter = (q.attendance || '').trim();
  const subFilter = (q.submissionStatus || '').trim();

  const out = rows
    .filter((r) => r[field] && String(r[field]).trim())
    .filter((r) => !keyword || String(r[field]).toLowerCase().includes(keyword))
    .map((r) => {
      const e = empMap.get(String(r.employee)) || {};
      const k = subKey(r.employee, r.date);
      const s = subMap.get(k);
      const attStatus = attMap.get(k) || '';
      const subStatus = s ? (s.submitted ? (s.reviewStatus || 'pending') : 'draft') : 'none';
      return {
        _id: r._id,
        date: r.date,
        selfRating: r.selfRating,
        [field]: r[field],
        attendance: attStatus,
        submissionId: s?._id || null,
        submissionStatus: subStatus,
        employee: e ? {
          _id: e._id, name: e.name, employeeId: e.employeeId,
          department: e.department?.name || '',
        } : null,
      };
    })
    .filter((r) => !attFilter || r.attendance === attFilter)
    .filter((r) => !subFilter || r.submissionStatus === subFilter);
  return out;
};

/**
 * GET /api/self-review/ideas
 * Filters: from, to, department, employee, keyword, rating
 */
const ideasLibrary = asyncHandler(async (req, res) => {
  try {
    const rows = await _libraryLookup(req, { field: 'idea', requireNonEmpty: true });
    res.json(rows);
  } catch (e) { res.status(e._http || 500); throw e; }
});

/**
 * GET /api/self-review/notes
 * Filters: from, to, department, employee, keyword
 */
const notesLibrary = asyncHandler(async (req, res) => {
  try {
    const rows = await _libraryLookup(req, { field: 'selfNote', requireNonEmpty: true });
    res.json(rows);
  } catch (e) { res.status(e._http || 500); throw e; }
});

/* ------------------------------------------------------------------ */
/* GET /api/self-review/export.csv                                       */
/* ------------------------------------------------------------------ */
/**
 * Streams a CSV with every reflection in the current scope + its
 * attendance status + submission status.  Excel opens this natively.
 */
const exportCsv = asyncHandler(async (req, res) => {
  let scope;
  try { scope = await _resolveScope(req); }
  catch (e) { res.status(e._http || 500); throw e; }
  const { from, to, empIds, empMap } = scope;
  const reflections = await DailyReflection.find({
    employee: { $in: empIds },
    date: { $gte: from, $lte: to },
    selfRating: { $type: 'number' },
  }).select('employee date selfRating selfNote idea').sort({ date: 1 }).lean();

  const [subs, attRows] = await Promise.all([
    Submission.find({ employee: { $in: empIds }, date: { $gte: from, $lte: to } })
      .select('employee date submitted reviewStatus').lean(),
    Attendance.find({ employee: { $in: empIds }, date: { $gte: from, $lte: to } })
      .select('employee date status').lean(),
  ]);
  const subKey = (e, d) => `${String(e)}|${_isoDay(d)}`;
  const subMap = new Map();
  for (const s of subs) {
    const k = subKey(s.employee, s.date);
    if (!subMap.has(k) || (!subMap.get(k).submitted && s.submitted)) subMap.set(k, s);
  }
  const attMap = new Map(attRows.map((a) => [subKey(a.employee, a.date), a.status]));

  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = ['Date,Employee,Employee ID,Department,Rating,Note,Business Idea,Attendance,Submission Status'];
  for (const r of reflections) {
    const e = empMap.get(String(r.employee));
    if (!e) continue;
    const k = subKey(r.employee, r.date);
    const s = subMap.get(k);
    const att = attMap.get(k) || '';
    const subStatus = s ? (s.submitted ? (s.reviewStatus || 'pending') : 'draft') : 'none';
    lines.push([
      _isoDay(r.date),
      e.name || '',
      e.employeeId || '',
      e.department?.name || '',
      r.selfRating,
      (r.selfNote || '').replace(/\r?\n/g, ' '),
      (r.idea     || '').replace(/\r?\n/g, ' '),
      att,
      subStatus,
    ].map(esc).join(','));
  }
  const filename = `daily-self-review_${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
});

/* ------------------------------------------------------------------ */
/* GET /api/self-review/breakdown                                       */
/* ------------------------------------------------------------------ */
/**
 * Row-level drill-down for every clickable card / chart in the tab.
 * Query:
 *   metricId (required) -- see METRIC_INFO on the frontend
 *   from / to / department / designation / employee -- same scope shape
 *   Sub-filters (metric-specific):
 *     rating   -- narrow to reflections with exact selfRating
 *     day      -- narrow to one day (YYYY-MM-DD)
 *     week     -- ISO week key (YYYY-Www)
 *     month    -- YYYY-MM
 *     weekday  -- 0..6 (Sun..Sat)
 *     deptName -- narrow to one department name (works when the caller
 *                 already scoped by department via the id, or wants to
 *                 slice by department from a dept-chart click)
 *
 * Returns a homogeneous `rows` array plus `columns` metadata so a
 * generic sortable / paginated / CSV-exportable table can render it
 * on the client without a bespoke component per metric.
 */
const breakdown = asyncHandler(async (req, res) => {
  let scope;
  try { scope = await _resolveScope(req); }
  catch (e) { res.status(e._http || 500); throw e; }
  const { from, to, empIds, empMap } = scope;

  const q = req.query || {};
  const metricId = String(q.metricId || '');
  const totalDays = Math.max(1, Math.floor((to - from) / 86400000) + 1);

  // Base fetch, sub-filtered per metric.  Every metric ends up with a
  // uniform row shape { date, employeeId, employeeName, department,
  // rating, note, idea, submissionId, submissionStatus, attendance }.
  const enrichRows = async (rows) => {
    if (rows.length === 0) return [];
    const empIdsUsed = [...new Set(rows.map((r) => String(r.employee)))];
    const [subs, attRows] = await Promise.all([
      Submission.find({
        employee: { $in: empIdsUsed },
        date: { $gte: from, $lte: to },
      }).select('_id employee date submitted reviewStatus').lean(),
      Attendance.find({
        employee: { $in: empIdsUsed },
        date: { $gte: from, $lte: to },
      }).select('employee date status').lean(),
    ]);
    const subKey = (e, d) => `${String(e)}|${_isoDay(d)}`;
    const subMap = new Map();
    for (const s of subs) {
      const k = subKey(s.employee, s.date);
      if (!subMap.has(k) || (!subMap.get(k).submitted && s.submitted)) subMap.set(k, s);
    }
    const attMap = new Map(attRows.map((a) => [subKey(a.employee, a.date), a.status]));

    return rows.map((r) => {
      const e = empMap.get(String(r.employee)) || {};
      const k = subKey(r.employee, r.date);
      const s = subMap.get(k);
      return {
        _id: r._id,
        date: r.date,
        rating: r.selfRating,
        note: r.selfNote || '',
        idea: r.idea || '',
        employeeId: e._id || null,
        employeeName: e.name || '',
        employeeCode: e.employeeId || '',
        department: e.department?.name || '',
        submissionId: s?._id || null,
        submissionStatus: s ? (s.submitted ? (s.reviewStatus || 'pending') : 'draft') : 'none',
        attendance: attMap.get(k) || '',
      };
    });
  };

  // Universal date bucket for day/week/month sub-filtering.
  const dayFilter = q.day ? String(q.day) : '';
  const weekFilter = q.week ? String(q.week) : '';
  const monthFilter = q.month ? String(q.month) : '';
  const weekdayFilter = q.weekday !== undefined && q.weekday !== '' ? Number(q.weekday) : null;
  const ratingFilter = q.rating !== undefined && q.rating !== '' ? Number(q.rating) : null;
  const deptNameFilter = q.deptName ? String(q.deptName) : '';
  const filterCommon = (rows) => rows.filter((r) => {
    if (dayFilter && _isoDay(r.date) !== dayFilter) return false;
    if (weekFilter && _isoWeek(r.date) !== weekFilter) return false;
    if (monthFilter && _isoMonth(r.date) !== monthFilter) return false;
    if (weekdayFilter !== null && new Date(r.date).getUTCDay() !== weekdayFilter) return false;
    if (ratingFilter !== null && Math.round(r.selfRating) !== ratingFilter) return false;
    if (deptNameFilter) {
      const e = empMap.get(String(r.employee));
      if ((e?.department?.name || 'Unassigned') !== deptNameFilter) return false;
    }
    return true;
  });

  const cols = [
    { key: 'date',             label: 'Date',       type: 'date' },
    { key: 'employeeName',     label: 'Employee' },
    { key: 'employeeCode',     label: 'Emp ID' },
    { key: 'department',       label: 'Department' },
    { key: 'rating',           label: 'Rating',     type: 'number' },
    { key: 'attendance',       label: 'Attendance' },
    { key: 'submissionStatus', label: 'Submission' },
    { key: 'note',             label: 'Note' },
    { key: 'idea',             label: 'Idea' },
  ];

  // ---- Metric-specific row sets ----
  const reflectionRows = await _fetchReflections({ from, to, empIds });

  // Employees list metrics -- render an employee-centric table instead
  // of a per-reflection row list.
  const employeeSummary = (rows) => {
    const map = new Map();
    for (const r of rows) {
      const k = String(r.employee);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r.selfRating);
    }
    return [...map.entries()].map(([k, arr]) => {
      const e = empMap.get(k) || {};
      const s = _stats(arr);
      return {
        employeeId: e._id || null,
        employeeName: e.name || '',
        employeeCode: e.employeeId || '',
        department: e.department?.name || '',
        count: s.count,
        avg: s.avg, high: s.high, low: s.low, median: s.median,
        consistency: Math.round((s.count / totalDays) * 100),
      };
    });
  };
  const employeeCols = [
    { key: 'employeeName', label: 'Employee' },
    { key: 'employeeCode', label: 'Emp ID' },
    { key: 'department',   label: 'Department' },
    { key: 'count',        label: 'Reflections',  type: 'number' },
    { key: 'avg',          label: 'Avg Rating',   type: 'number' },
    { key: 'high',         label: 'High',         type: 'number' },
    { key: 'low',          label: 'Low',          type: 'number' },
    { key: 'median',       label: 'Median',       type: 'number' },
    { key: 'consistency',  label: 'Consistency %', type: 'number' },
  ];

  let rows;
  let columns = cols;
  let title = '';

  const filtered = filterCommon(reflectionRows);

  switch (metricId) {
    case 'srAvgRating':
    case 'srDaily':
    case 'srWeekly':
    case 'srMonthly':
    case 'srHeatmap':
    case 'srDistribution':
    case 'srTrendCurrent':
    case 'srTrendPrevious':
    case 'srTrendDelta':
      rows = await enrichRows(filtered);
      title = 'Reflections in scope';
      break;
    case 'srHighestRating': {
      // Every 10/10 (or the maximum found if none) reflection.
      const max = Math.max(...reflectionRows.map((r) => r.selfRating), 0);
      const target = ratingFilter !== null ? ratingFilter : max;
      rows = await enrichRows(filterCommon(reflectionRows.filter((r) => Math.round(r.selfRating) === Math.round(target))));
      title = `Reflections rated ${target}`;
      columns = cols;
      break;
    }
    case 'srLowestRating': {
      const min = Math.min(...reflectionRows.map((r) => r.selfRating), 10);
      const target = ratingFilter !== null ? ratingFilter : min;
      rows = await enrichRows(filterCommon(reflectionRows.filter((r) => Math.round(r.selfRating) === Math.round(target))));
      title = `Reflections rated ${target}`;
      columns = cols;
      break;
    }
    case 'srMedianRating': {
      const sorted = [...reflectionRows].sort((a, b) => a.selfRating - b.selfRating);
      const medianVal = sorted.length ? sorted[Math.floor(sorted.length / 2)].selfRating : 0;
      const window = 0.5;
      rows = await enrichRows(filtered.filter((r) => Math.abs(r.selfRating - medianVal) <= window));
      title = `Reflections around median (${medianVal})`;
      columns = cols;
      break;
    }
    case 'srEmployeesSubmitted': {
      rows = employeeSummary(reflectionRows);
      columns = employeeCols;
      title = 'Employees with at least one reflection';
      break;
    }
    case 'srEmployeesMissing': {
      const reflectedIds = new Set(reflectionRows.map((r) => String(r.employee)));
      rows = [...empMap.values()]
        .filter((e) => !reflectedIds.has(String(e._id)))
        .map((e) => ({
          employeeId: e._id, employeeName: e.name, employeeCode: e.employeeId,
          department: e.department?.name || '',
          count: 0, avg: 0, high: 0, low: 0, median: 0, consistency: 0,
        }));
      columns = employeeCols;
      title = 'Employees missing reflections in this range';
      break;
    }
    case 'srDeptCompare': {
      // Department roll-up.
      const byDept = new Map();
      for (const r of reflectionRows) {
        const e = empMap.get(String(r.employee));
        const d = e?.department?.name || 'Unassigned';
        if (!byDept.has(d)) byDept.set(d, { ratings: [], employees: new Set() });
        byDept.get(d).ratings.push(r.selfRating);
        byDept.get(d).employees.add(String(r.employee));
      }
      rows = [...byDept.entries()].map(([name, v]) => ({
        department: name,
        avg: Math.round((v.ratings.reduce((s, n) => s + n, 0) / v.ratings.length) * 100) / 100,
        reflections: v.ratings.length,
        employees: v.employees.size,
      })).sort((a, b) => b.avg - a.avg);
      columns = [
        { key: 'department',  label: 'Department' },
        { key: 'avg',         label: 'Avg Rating',   type: 'number' },
        { key: 'reflections', label: 'Reflections',  type: 'number' },
        { key: 'employees',   label: 'Employees',    type: 'number' },
      ];
      title = 'Department comparison';
      break;
    }
    case 'srRanking': {
      rows = employeeSummary(reflectionRows).filter((e) => e.count >= 3).sort((a, b) => b.avg - a.avg);
      columns = employeeCols;
      title = 'Employee ranking (3+ reflections)';
      break;
    }
    default: {
      rows = await enrichRows(filtered);
      title = 'Reflections in scope';
    }
  }

  res.json({
    metricId, title,
    range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    columns,
    rows,
    totalRows: rows.length,
  });
});

module.exports = { overview, employeeDetail, ideasLibrary, notesLibrary, exportCsv, breakdown };
