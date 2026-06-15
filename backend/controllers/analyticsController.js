const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Submission = require('../models/Submission');
const DependencyTask = require('../models/DependencyTask');
const Assignment = require('../models/Assignment');
const Department = require('../models/Department');
const Designation = require('../models/Designation');
const { startOfDay, addDays, parseDay, formatYMD } = require('../utils/dateHelpers');
// Phase 4: every analytics query AND-s in this filter so soft-deleted
// and test-marked submissions never reach a leaderboard / KPI / trend.
const { liveSubmissionFilter, readReqFlags } = require('../utils/submissionFilter');

/**
 * analyticsController
 *
 * PENDENCY INTELLIGENCE.  Unlike the legacy completion-focused dashboard,
 * this analyses *pending work* only - and ONLY work the employee has
 * explicitly submitted and marked Pending.  It never counts unsubmitted /
 * unopened / future assignments, and always excludes "Work Not Available".
 *
 * It reads the SAME submission data the scoring pipeline uses but does not
 * write anything, so marks / salary / attendance are untouched.
 */

/** Resolve [from, to) from query: range=<days>|month|custom (+ from/to). */
const resolveRange = (q = {}) => {
  const todayPlus1 = addDays(startOfDay(new Date()), 1); // exclusive upper bound
  const range = q.range || (q.from && q.to ? 'custom' : '7');
  if (range === 'custom' && q.from && q.to) {
    return { from: parseDay(q.from), to: addDays(parseDay(q.to), 1), label: 'custom' };
  }
  if (range === 'month') {
    const now = new Date();
    return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: todayPlus1, label: 'month' };
  }
  // Any numeric range = that many days back (7 / 30 / 90 / 365 ...).
  const days = Number(range) > 0 ? Number(range) : 7;
  return { from: addDays(todayPlus1, -days), to: todayPlus1, label: `${days}d` };
};

/**
 * Count the explicitly-submitted scorable units of one submission.
 * Returns { done, pending, pendingAges:[days] }.  Excludes
 * work_not_available, pending_submit, and any row without a real status.
 */
const countUnits = (s, asOf) => {
  let done = 0, ongoing = 0, pending = 0;
  const pendingAges = [];
  const ageOf = (origin) => Math.max(0, Math.round((startOfDay(asOf) - startOfDay(origin || s.date)) / 86400000));

  if (s.templateType === 'excel') {
    for (const r of s.excelResponses || []) {
      if (r.rowStatus === 'done') done += 1;
      else if (r.rowStatus === 'pending') { pending += 1; pendingAges.push(ageOf(s.date)); }
    }
  } else if (s.templateType === 'sheet') {
    for (const sc of (s.sheet && s.sheet.scores) || []) {
      if (sc.rowStatus === 'done') done += 1;
      else if (sc.rowStatus === 'pending') { pending += 1; pendingAges.push(ageOf(s.date)); }
    }
  } else {
    // Task templates: ongoing is tracked as its own bucket but, for
    // completion-rate math, is rolled into `done` (counts as work
    // performed).  Pendency still only counts true 'pending' rows.
    for (const t of s.tasks || []) {
      if (t.status === 'done')         done += 1;
      else if (t.status === 'ongoing') ongoing += 1;
      else if (t.status === 'pending') { pending += 1; pendingAges.push(ageOf(t.pendingSince)); }
    }
  }
  return { done: done + ongoing, doneCount: done, ongoing, pending, pendingAges };
};

const rate = (pending, done) => {
  const denom = pending + done;
  return denom > 0 ? Math.round((pending / denom) * 1000) / 10 : 0; // 1dp %
};

/**
 * GET /api/dashboard/hr/pendency
 * Query: range, from, to, department, designation, employee
 */
const pendency = asyncHandler(async (req, res) => {
  const { from, to } = resolveRange(req.query);
  const asOf = new Date();

  // ---- Employee scope (respect group filters) ----
  // HR users are also workflow participants — Super Admin can assign work
  // to them and their submissions must flow through every analytics view
  // exactly like an employee's.  Super Admin is excluded.
  const empWhere = { role: { $in: ['employee', 'hr'] }, status: 'active' };
  // Role-aware scoping:
  //   - HR / Super Admin: may filter by ?department=...
  //   - HOD: hard-clamped to their own department, query param IGNORED
  //          (so a HOD modifying the URL cannot peek across departments).
  const isHRorSA = req.user.role === 'hr' || req.user.role === 'super_admin';
  if (!isHRorSA && req.user.isHOD && req.user.hodDepartment) {
    empWhere.department = req.user.hodDepartment;
  } else if (req.query.department) {
    empWhere.department = req.query.department;
  }
  if (req.query.designation) empWhere.designation = req.query.designation;
  if (req.query.employee) empWhere._id = req.query.employee;

  const employees = await User.find(empWhere)
    .populate('department', 'name')
    .populate('designation', 'title')
    .lean();
  const empMap = new Map(employees.map((e) => [String(e._id), e]));
  const empIds = employees.map((e) => e._id);

  // ---- Submitted submissions in range, scoped to those employees ----
  // Optional template-type + recurrence filters (still pendency-only).
  const subWhere = {
    submitted: true,
    employee: { $in: empIds },
    date: { $gte: from, $lt: to },
    ...liveSubmissionFilter(readReqFlags(req)),
  };
  if (['task', 'excel', 'sheet'].includes(req.query.templateType)) subWhere.templateType = req.query.templateType;
  if (['daily', 'weekly', 'monthly', 'one-time'].includes(req.query.recurrence)) subWhere.frequency = req.query.recurrence;
  const subs = await Submission.find(subWhere)
    .select('employee date frequency templateType tasks excelResponses sheet.scores').lean();

  // ---- Per-employee + per-day + per-frequency rollups ----
  const perEmp = new Map();   // empId -> { done, pending, ages:[] }
  const perDay = new Map();   // 'YYYY-MM-DD' -> pending
  const perFreq = { daily: 0, weekly: 0, monthly: 0, 'one-time': 0 };
  const aging = { '0-2d': 0, '3-7d': 0, '8-14d': 0, '15d+': 0 };
  let totalPending = 0, totalDone = 0;

  for (const s of subs) {
    const { done, pending, pendingAges } = countUnits(s, asOf);
    totalPending += pending; totalDone += done;

    const k = String(s.employee);
    if (!perEmp.has(k)) perEmp.set(k, { done: 0, pending: 0, ages: [] });
    const pe = perEmp.get(k);
    pe.done += done; pe.pending += pending; pe.ages.push(...pendingAges);

    if (pending) {
      const dk = formatYMD(s.date);
      perDay.set(dk, (perDay.get(dk) || 0) + pending);
      const fr = ['daily', 'weekly', 'monthly', 'one-time'].includes(s.frequency) ? s.frequency : 'daily';
      perFreq[fr] += pending;
      for (const a of pendingAges) {
        if (a <= 2) aging['0-2d'] += 1;
        else if (a <= 7) aging['3-7d'] += 1;
        else if (a <= 14) aging['8-14d'] += 1;
        else aging['15d+'] += 1;
      }
    }
  }

  // ---- Department + designation rollups ----
  const deptRoll = new Map();   // name -> { pending, done }
  const desigRoll = new Map();
  const employeeRows = [];
  for (const [k, v] of perEmp.entries()) {
    const e = empMap.get(k);
    if (!e) continue;
    const dn = e.department?.name || 'Unassigned';
    const dg = e.designation?.title || 'Unassigned';
    if (!deptRoll.has(dn)) deptRoll.set(dn, { pending: 0, done: 0 });
    if (!desigRoll.has(dg)) desigRoll.set(dg, { pending: 0, done: 0 });
    deptRoll.get(dn).pending += v.pending; deptRoll.get(dn).done += v.done;
    desigRoll.get(dg).pending += v.pending; desigRoll.get(dg).done += v.done;
    employeeRows.push({
      _id: String(e._id),
      employeeId: e.employeeId,
      name: e.name,
      department: dn,
      designation: dg,
      pending: v.pending,
      done: v.done,
      pendencyRate: rate(v.pending, v.done),
      oldestPendingDays: v.ages.length ? Math.max(...v.ages) : 0,
    });
  }

  const byDepartment = [...deptRoll.entries()]
    .map(([name, v]) => ({ name, pending: v.pending, done: v.done, pendencyRate: rate(v.pending, v.done) }))
    .sort((a, b) => b.pending - a.pending);
  const byDesignation = [...desigRoll.entries()]
    .map(([title, v]) => ({ title, pending: v.pending, done: v.done, pendencyRate: rate(v.pending, v.done) }))
    .sort((a, b) => b.pending - a.pending);

  const topUnresolvedEmployees = [...employeeRows]
    .sort((a, b) => b.pending - a.pending || b.oldestPendingDays - a.oldestPendingDays)
    .slice(0, 10);

  const mostDelayedEmployee = [...employeeRows]
    .filter((e) => e.pending > 0)
    .sort((a, b) => b.oldestPendingDays - a.oldestPendingDays || b.pending - a.pending)[0] || null;

  // Pendency trend: fill every day in range so the chart has no gaps.
  const trend = [];
  for (let d = startOfDay(from); d < startOfDay(to); d = addDays(d, 1)) {
    const dk = formatYMD(d);
    trend.push({ date: dk, pending: perDay.get(dk) || 0 });
  }

  // ---- Dependency analytics ----
  // Phase 23.4: also populate assignedBy so the "Dependent Work" drill-
  // down can show Shared By → Assigned To per row without a second hop.
  const depAll = await DependencyTask.find({})
    .populate('assignedTo', 'name employeeId')
    .populate('assignedBy', 'name employeeId')
    .lean();
  const depInRange = depAll.filter((d) => new Date(d.createdAt) >= from && new Date(d.createdAt) < to);

  const openDeps = depAll.filter((d) => d.currentStatus !== 'resolved');
  const resolvedDeps = depAll.filter((d) => d.currentStatus === 'resolved');

  // Most blocked employees: who currently owns the most OPEN dependency work.
  const blockedMap = new Map();
  for (const d of openDeps) {
    const name = d.assignedTo?.name || d.assignedToName || 'Unknown';
    blockedMap.set(name, (blockedMap.get(name) || 0) + 1);
  }
  const mostBlockedEmployees = [...blockedMap.entries()]
    .map(([name, count]) => ({ name, openCount: count }))
    .sort((a, b) => b.openCount - a.openCount)
    .slice(0, 10);

  // Departments creating most blockers (department of the assigner).
  const blockerDeptMap = new Map();
  for (const d of depAll) {
    const name = d.departmentName || 'Unassigned';
    blockerDeptMap.set(name, (blockerDeptMap.get(name) || 0) + 1);
  }
  const departmentsCreatingMostBlockers = [...blockerDeptMap.entries()]
    .map(([name, count]) => ({ name, blockers: count }))
    .sort((a, b) => b.blockers - a.blockers);

  // Longest dependency chain (most hops sharing a chainId).
  const chainLen = new Map();
  for (const d of depAll) {
    if (!d.chainId) continue;
    chainLen.set(d.chainId, (chainLen.get(d.chainId) || 0) + 1);
  }
  let longestChain = { chainId: null, length: 0 };
  for (const [chainId, length] of chainLen.entries()) {
    if (length > longestChain.length) longestChain = { chainId, length };
  }

  // Avg resolution time (hours) over resolved dependency tasks.
  let avgResolutionHours = 0;
  if (resolvedDeps.length) {
    const totalMs = resolvedDeps.reduce((sum, d) => {
      const start = new Date(d.waitingSince || d.createdAt);
      const end = new Date(d.resolvedAt || d.updatedAt);
      return sum + Math.max(0, end - start);
    }, 0);
    avgResolutionHours = Math.round((totalMs / resolvedDeps.length / 3600000) * 10) / 10;
  }

  const collaborativeCompletionPct = depAll.length
    ? Math.round((resolvedDeps.length / depAll.length) * 1000) / 10
    : 0;

  res.json({
    range: { from: formatYMD(from), to: formatYMD(addDays(to, -1)) },
    cards: {
      avgPendencyRate: rate(totalPending, totalDone),
      totalPendingTasks: totalPending,
      totalCompletedTasks: totalDone,
      mostPendingDepartment: byDepartment[0]?.name || null,
      mostDelayedEmployee: mostDelayedEmployee
        ? { name: mostDelayedEmployee.name, days: mostDelayedEmployee.oldestPendingDays }
        : null,
      dependencyBlockedTasks: openDeps.length,
      resolvedVsUnresolved: { resolved: resolvedDeps.length, unresolved: openDeps.length },
      collaborativePendingWork: depInRange.length,
    },
    charts: {
      pendencyTrend: trend,
      byDepartment,
      byDesignation,
      topUnresolvedEmployees,
      dependencyBottleneck: mostBlockedEmployees,
      weeklyVsMonthly: [
        { frequency: 'daily', pending: perFreq.daily },
        { frequency: 'weekly', pending: perFreq.weekly },
        { frequency: 'monthly', pending: perFreq.monthly },
        { frequency: 'one-time', pending: perFreq['one-time'] },
      ],
      aging: Object.entries(aging).map(([bucket, count]) => ({ bucket, count })),
    },
    dependency: {
      mostBlockedEmployees,
      departmentsCreatingMostBlockers,
      longestChain,
      avgResolutionHours,
      collaborativeCompletionPct,
      totalDependencies: depAll.length,
      openDependencies: openDeps.length,
      resolvedDependencies: resolvedDeps.length,
      // Phase 23.4: "Dependent Work" replaces the "Longest Chain" card.
      // Surface totals for total transferred, total resolved and the
      // org-wide resolution percentage, plus a per-record list so the
      // detail drill-down can render Task / Shared By / Assigned To /
      // Transfer Date / Resolved Date / Status without another fetch.
      dependentWork: {
        totalTransferred: depAll.length,
        totalResolved: resolvedDeps.length,
        resolutionPct: depAll.length
          ? Math.round((resolvedDeps.length / depAll.length) * 1000) / 10
          : 0,
        records: depAll
          .slice()
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .map((d) => ({
            _id: d._id,
            taskName: d.originalTaskName || '',
            sharedBy: d.assignedBy?.name || d.assignedByName || '',
            sharedById: d.assignedBy?.employeeId || '',
            assignedTo: d.assignedTo?.name || d.assignedToName || '',
            assignedToId: d.assignedTo?.employeeId || '',
            transferDate: d.createdAt,
            resolvedDate: d.resolvedAt || null,
            status: d.currentStatus,
            remark: d.remark || '',
            templateTitle: d.templateTitle || '',
            departmentName: d.departmentName || '',
          })),
      },
    },
    employeeRows: employeeRows.sort((a, b) => b.pending - a.pending),
  });
});

/* ====================================================================
 * COMPLETION REVIEW
 *
 * Performance based on reviewer-awarded marks.  Each submission's
 * finalized earned/total points already aggregate work marks (task /
 * excel / sheet / cell scoring) + discipline + innovation from the HR/HOD
 * review, so this reuses them directly - no new scoring math, and the
 * pendency engine above is untouched.
 * ==================================================================== */
const completion = asyncHandler(async (req, res) => {
  const { from, to } = resolveRange(req.query);

  // HR users are also workflow participants — Super Admin can assign work
  // to them and their submissions must flow through every analytics view
  // exactly like an employee's.  Super Admin is excluded.
  const empWhere = { role: { $in: ['employee', 'hr'] }, status: 'active' };
  // Role-aware scoping (mirrors pendency above).
  const isHRorSA_c = req.user.role === 'hr' || req.user.role === 'super_admin';
  if (!isHRorSA_c && req.user.isHOD && req.user.hodDepartment) {
    empWhere.department = req.user.hodDepartment;
  } else if (req.query.department) {
    empWhere.department = req.query.department;
  }
  if (req.query.designation) empWhere.designation = req.query.designation;
  if (req.query.employee) empWhere._id = req.query.employee;
  const employees = await User.find(empWhere)
    .populate('department', 'name').populate('designation', 'title').lean();
  const empMap = new Map(employees.map((e) => [String(e._id), e]));
  const empIds = employees.map((e) => e._id);

  const subWhere = {
    submitted: true, employee: { $in: empIds }, date: { $gte: from, $lt: to },
    // Phase 15: completion analytics counts reviewed submissions only.
    ...liveSubmissionFilter({ ...readReqFlags(req), onlyReviewed: true }),
  };
  if (['task', 'excel', 'sheet'].includes(req.query.templateType)) subWhere.templateType = req.query.templateType;
  if (['daily', 'weekly', 'monthly', 'one-time'].includes(req.query.recurrence)) subWhere.frequency = req.query.recurrence;
  if (req.query.reviewer) subWhere.reviewedBy = req.query.reviewer;
  const subs = await Submission.find(subWhere)
    .select('employee date submittedAt frequency templateType earnedPoints totalPoints workEarnedPoints workTotalPoints reviewStatus reviewedBy')
    .lean();

  // Phase 6: discipline + innovation marks live exclusively on
  // DailyReview.  Pull every (employee, date) in scope so we can fold
  // them into the per-employee + per-day completion totals below.
  // Only reviewed days count toward the marks; pending ones contribute
  // nothing (matches the per-sub reviewStatus gate).
  const DailyReview = require('../models/DailyReview');
  const dailyReviews = await DailyReview.find({
    employee: { $in: empIds },
    date: { $gte: from, $lt: to },
    reviewStatus: 'reviewed',
  }).select('employee date disciplineMarks maxDisciplineMarks ideaMarks maxIdeaMarks').lean();
  // Indexed by "empId|YMD" for O(1) lookup as we walk submissions.
  const drByKey = new Map();
  for (const r of dailyReviews) {
    drByKey.set(`${String(r.employee)}|${formatYMD(r.date)}`, r);
  }
  // Each (employee, date) bucket contributes its disc/idea ONCE,
  // regardless of how many submissions exist for that day.  Track
  // which buckets we've already counted as we walk submissions.
  const countedDR = new Set();

  const perEmp = new Map(); // empId -> { earned, total, subs, pctList, onTime, late, reviewed, disc, discMax }
  const perDay = new Map();
  const perFreq = { daily: { e: 0, t: 0 }, weekly: { e: 0, t: 0 }, monthly: { e: 0, t: 0 }, 'one-time': { e: 0, t: 0 } };
  const dist = { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
  const reviewerAgg = new Map(); // reviewerId -> { e, t, count }
  let totalEarned = 0, totalTotal = 0, reviewedCount = 0, onTimeTotal = 0, lateTotal = 0, discSum = 0, discMaxSum = 0;

  const dayMs = 86400000;
  for (const s of subs) {
    // Work-only marks (per-sub).  Discipline + idea are added below
    // via the DailyReview join, ONCE per (employee, date) bucket.
    const e = s.earnedPoints || 0;
    const t = s.totalPoints || 0;
    totalEarned += e; totalTotal += t;
    const pctOne = t > 0 ? (e / t) * 100 : 0;

    const k = String(s.employee);
    if (!perEmp.has(k)) perEmp.set(k, { earned: 0, total: 0, subs: 0, pctList: [], onTime: 0, late: 0, reviewed: 0, disc: 0, discMax: 0 });
    const pe = perEmp.get(k);
    pe.earned += e; pe.total += t; pe.subs += 1; pe.pctList.push(pctOne);

    if (s.reviewStatus === 'reviewed') {
      reviewedCount += 1; pe.reviewed += 1;
      if (s.reviewedBy) {
        const rk = String(s.reviewedBy);
        if (!reviewerAgg.has(rk)) reviewerAgg.set(rk, { e: 0, t: 0, count: 0 });
        const ra = reviewerAgg.get(rk); ra.e += e; ra.t += t; ra.count += 1;
      }
    }

    // Fold DailyReview disc + idea into the per-employee totals
    // exactly once per (employee, date) bucket -- the first time we
    // see a submission for that day in the walk.  Avoids double-
    // counting when an employee has N submissions on the same day.
    const drKey = `${k}|${formatYMD(s.date)}`;
    const dr = drByKey.get(drKey);
    if (dr && !countedDR.has(drKey)) {
      countedDR.add(drKey);
      const drDisc    = Number(dr.disciplineMarks)    || 0;
      const drMaxDisc = Number(dr.maxDisciplineMarks) || 0;
      const drIdea    = Number(dr.ideaMarks)          || 0;
      const drMaxIdea = Number(dr.maxIdeaMarks)       || 0;
      const dayBonus  = drDisc + drIdea;
      const dayBonusMax = drMaxDisc + drMaxIdea;
      pe.earned += dayBonus;        pe.total += dayBonusMax;
      totalEarned += dayBonus;      totalTotal += dayBonusMax;
      pe.disc += drDisc;            pe.discMax += drMaxDisc;
      discSum += drDisc;            discMaxSum += drMaxDisc;
    }

    // On-time = submitted on/before the assigned day (not a late backlog clear).
    if (s.submittedAt) {
      const onTime = startOfDay(s.submittedAt) <= startOfDay(s.date);
      if (onTime) { onTimeTotal += 1; pe.onTime += 1; } else { lateTotal += 1; pe.late += 1; }
    }

    const dk = formatYMD(s.date);
    if (!perDay.has(dk)) perDay.set(dk, { e: 0, t: 0 });
    const pd = perDay.get(dk); pd.e += e; pd.t += t;

    const fr = ['daily', 'weekly', 'monthly', 'one-time'].includes(s.frequency) ? s.frequency : 'daily';
    perFreq[fr].e += e; perFreq[fr].t += t;

    if (pctOne <= 20) dist['0-20'] += 1; else if (pctOne <= 40) dist['21-40'] += 1;
    else if (pctOne <= 60) dist['41-60'] += 1; else if (pctOne <= 80) dist['61-80'] += 1; else dist['81-100'] += 1;
  }

  // perDay trend gets the same per-bucket daily bonus, ONCE per date.
  // (perDay above only summed work points; here we add the day's
  // DailyReview marks summed across every employee that had a
  // reviewed day on that date.)
  for (const r of dailyReviews) {
    const dk = formatYMD(r.date);
    if (!perDay.has(dk)) perDay.set(dk, { e: 0, t: 0 });
    const pd = perDay.get(dk);
    pd.e += (Number(r.disciplineMarks) || 0) + (Number(r.ideaMarks) || 0);
    pd.t += (Number(r.maxDisciplineMarks) || 0) + (Number(r.maxIdeaMarks) || 0);
  }

  const round1 = (n) => Math.round(n * 10) / 10;
  const stddev = (arr) => {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  };

  // Employee rows
  const employeeRows = [];
  const deptRoll = new Map(); const desigRoll = new Map();
  for (const [k, v] of perEmp.entries()) {
    const emp = empMap.get(k); if (!emp) continue;
    const score = v.total > 0 ? round1((v.earned / v.total) * 100) : 0;
    const consistency = round1(100 - Math.min(100, stddev(v.pctList))); // higher = steadier
    const onTimeRate = (v.onTime + v.late) > 0 ? round1((v.onTime / (v.onTime + v.late)) * 100) : 0;
    const dn = emp.department?.name || 'Unassigned';
    const dg = emp.designation?.title || 'Unassigned';
    if (!deptRoll.has(dn)) deptRoll.set(dn, { e: 0, t: 0 });
    if (!desigRoll.has(dg)) desigRoll.set(dg, { e: 0, t: 0 });
    deptRoll.get(dn).e += v.earned; deptRoll.get(dn).t += v.total;
    desigRoll.get(dg).e += v.earned; desigRoll.get(dg).t += v.total;
    employeeRows.push({
      employeeId: emp.employeeId, name: emp.name, department: dn, designation: dg,
      score, submissions: v.subs, consistency, onTimeRate,
      disciplinePct: v.discMax > 0 ? round1((v.disc / v.discMax) * 100) : 0,
    });
  }
  employeeRows.sort((a, b) => b.score - a.score);

  const byDepartment = [...deptRoll.entries()].map(([name, v]) => ({ name, score: v.t > 0 ? round1((v.e / v.t) * 100) : 0 })).sort((a, b) => b.score - a.score);
  const byDesignation = [...desigRoll.entries()].map(([title, v]) => ({ title, score: v.t > 0 ? round1((v.e / v.t) * 100) : 0 })).sort((a, b) => b.score - a.score);

  // Trend
  const trend = [];
  for (let d = startOfDay(from); d < startOfDay(to); d = addDays(d, 1)) {
    const dk = formatYMD(d); const pd = perDay.get(dk);
    trend.push({ date: dk, score: pd && pd.t > 0 ? round1((pd.e / pd.t) * 100) : 0 });
  }

  // Reviewer distribution (names)
  const reviewerIds = [...reviewerAgg.keys()];
  const reviewers = reviewerIds.length ? await User.find({ _id: { $in: reviewerIds } }).select('name').lean() : [];
  const reviewerName = new Map(reviewers.map((r) => [String(r._id), r.name]));
  const reviewerScores = [...reviewerAgg.entries()].map(([id, v]) => ({ name: reviewerName.get(id) || 'Unknown', avgScore: v.t > 0 ? round1((v.e / v.t) * 100) : 0, reviews: v.count })).sort((a, b) => b.reviews - a.reviews);

  // Dependency resolution performance + collaboration
  const depAll = await DependencyTask.find({}).populate('assignedTo', 'name').lean();
  const resolved = depAll.filter((d) => d.currentStatus === 'resolved' && d.resolvedAt);
  const resolverAgg = new Map(); // name -> { hoursSum, count }
  for (const d of resolved) {
    const name = d.assignedTo?.name || d.assignedToName || 'Unknown';
    const hrs = (new Date(d.resolvedAt) - new Date(d.waitingSince || d.createdAt)) / 36e5;
    if (!resolverAgg.has(name)) resolverAgg.set(name, { hoursSum: 0, count: 0 });
    const r = resolverAgg.get(name); r.hoursSum += hrs; r.count += 1;
  }
  const resolverPerf = [...resolverAgg.entries()].map(([name, v]) => ({ name, avgHours: round1(v.hoursSum / v.count), resolved: v.count })).sort((a, b) => a.avgHours - b.avgHours);
  const collabAgg = new Map();
  for (const d of depAll) {
    const giver = d.assignedByName || 'Unknown'; const taker = d.assignedToName || 'Unknown';
    collabAgg.set(giver, (collabAgg.get(giver) || 0) + 1);
    collabAgg.set(taker, (collabAgg.get(taker) || 0) + 1);
  }
  const collaboration = [...collabAgg.entries()].map(([name, count]) => ({ name, interactions: count })).sort((a, b) => b.interactions - a.interactions).slice(0, 10);

  const mostConsistent = [...employeeRows].filter((e) => e.submissions >= 2).sort((a, b) => b.consistency - a.consistency)[0] || employeeRows[0] || null;
  const mostCollaborative = collaboration[0] || null;
  const fastestResolver = resolverPerf[0] || null;

  res.json({
    range: { from: formatYMD(from), to: formatYMD(addDays(to, -1)) },
    cards: {
      avgCompletionScore: totalTotal > 0 ? round1((totalEarned / totalTotal) * 100) : 0,
      avgQualityRating: totalTotal > 0 ? round1((totalEarned / totalTotal) * 100) : 0,
      mostConsistentEmployee: mostConsistent ? { name: mostConsistent.name, consistency: mostConsistent.consistency } : null,
      highestScoringDepartment: byDepartment[0] || null,
      fastestResolver: fastestResolver ? { name: fastestResolver.name, avgHours: fastestResolver.avgHours } : null,
      mostCollaborativeEmployee: mostCollaborative ? { name: mostCollaborative.name, interactions: mostCollaborative.interactions } : null,
      onTimeSubmissionRate: (onTimeTotal + lateTotal) > 0 ? round1((onTimeTotal / (onTimeTotal + lateTotal)) * 100) : 0,
      avgReviewMarks: reviewedCount > 0 ? round1(totalEarned / Math.max(1, reviewedCount)) : 0,
      avgDisciplineScore: discMaxSum > 0 ? round1((discSum / discMaxSum) * 100) : 0,
      reviewApprovalRate: subs.length > 0 ? round1((reviewedCount / subs.length) * 100) : 0,
    },
    charts: {
      completionTrend: trend,
      marksDistribution: Object.entries(dist).map(([bucket, count]) => ({ bucket, count })),
      byDepartment,
      byDesignation,
      topPerformers: employeeRows.slice(0, 10),
      lowestPerformers: [...employeeRows].reverse().slice(0, 10),
      onTimeVsLate: [{ name: 'On-time', value: onTimeTotal }, { name: 'Late', value: lateTotal }],
      weeklyVsMonthly: ['daily', 'weekly', 'monthly', 'one-time'].map((f) => ({ frequency: f, score: perFreq[f].t > 0 ? round1((perFreq[f].e / perFreq[f].t) * 100) : 0 })),
      reviewerScores,
      resolverPerformance: resolverPerf.slice(0, 10),
      collaboration,
      qualityVsSpeed: employeeRows.map((e) => ({ name: e.name, quality: e.score, speed: e.onTimeRate })),
    },
    employeeRows,
  });
});

/* ====================================================================
 * ASSIGNMENT ANALYTICS
 *
 * Read-only aggregations for the unified Work Assignment Management page:
 * template usage, pendency, completion, recurrence mix, department /
 * employee load, dependency-heavy templates, overdue assignments.
 * ==================================================================== */
const assignmentAnalytics = asyncHandler(async (_req, res) => {
  const todayPlus1 = addDays(startOfDay(new Date()), 1);
  const from30 = addDays(todayPlus1, -30);
  const sevenDaysAgo = addDays(startOfDay(new Date()), -7);

  const [assignments, subs, depAll, depts, designations, employees] = await Promise.all([
    Assignment.find({}).populate('template', 'title templateType').lean(),
    Submission.find({ submitted: true, date: { $gte: from30, $lt: todayPlus1 }, ...liveSubmissionFilter({}) })
      .select('template templateType tasks excelResponses sheet.scores assignment').lean(),
    DependencyTask.find({}).select('template templateTitle').lean(),
    Department.find({}).lean(),
    Designation.find({}).lean(),
    User.find({ role: { $in: ['employee', 'hr'] }, status: 'active' }).select('name department designation').lean(),
  ]);

  const deptMap = new Map(depts.map((d) => [String(d._id), d.name]));
  const desigMap = new Map(designations.map((d) => [String(d._id), { title: d.title, department: d.department ? String(d.department) : null }]));
  const empMap = new Map(employees.map((e) => [String(e._id), e]));

  // ---- Template usage ----
  const tplUsage = new Map();
  const tplOf = (a) => a.template && (tplUsage.get(String(a.template._id)) ||
    (tplUsage.set(String(a.template._id), { _id: a.template._id, title: a.template.title, type: a.template.templateType || 'task', assignments: 0, active: 0 }), tplUsage.get(String(a.template._id))));
  for (const a of assignments) {
    const m = tplOf(a); if (!m) continue;
    m.assignments += 1; if (a.active) m.active += 1;
  }

  // ---- Submission rollup per template ----
  const subStats = new Map(); // tplId -> { pending, done, count }
  for (const s of subs) {
    const k = String(s.template);
    if (!subStats.has(k)) subStats.set(k, { pending: 0, done: 0, count: 0 });
    const m = subStats.get(k); m.count += 1;
    if (s.templateType === 'task') {
      // Ongoing rolls into the `done` (work-performed) bucket for the
      // template-usage rollup -- it never inflates pendency.
      for (const t of s.tasks || []) {
        if (t.status === 'pending') m.pending += 1;
        else if (t.status === 'done' || t.status === 'ongoing') m.done += 1;
      }
    } else if (s.templateType === 'excel') {
      for (const r of s.excelResponses || []) { if (r.rowStatus === 'pending') m.pending += 1; else if (r.rowStatus === 'done') m.done += 1; }
    } else if (s.templateType === 'sheet') {
      for (const sc of (s.sheet && s.sheet.scores) || []) { if (sc.rowStatus === 'pending') m.pending += 1; else if (sc.rowStatus === 'done') m.done += 1; }
    }
  }

  const enriched = [...tplUsage.values()].map((t) => {
    const u = subStats.get(String(t._id)) || { pending: 0, done: 0, count: 0 };
    const denom = u.pending + u.done;
    return { ...t, pending: u.pending, done: u.done, submissions: u.count,
      pendencyRate: denom > 0 ? Math.round((u.pending / denom) * 1000) / 10 : 0,
      completionRate: denom > 0 ? Math.round((u.done / denom) * 1000) / 10 : 0 };
  });

  const mostUsedTemplates = [...enriched].sort((a, b) => b.assignments - a.assignments).slice(0, 10);
  const highestPendency = [...enriched].filter((t) => t.pending + t.done > 0).sort((a, b) => b.pendencyRate - a.pendencyRate).slice(0, 10);
  const highestCompletion = [...enriched].filter((t) => t.pending + t.done > 0).sort((a, b) => b.completionRate - a.completionRate).slice(0, 10);

  // ---- Department load (active assignments by department resolved from target) ----
  const deptLoad = new Map();
  for (const a of assignments) {
    if (!a.active) continue;
    let name = null;
    if (a.targetType === 'department') name = deptMap.get(String(a.targetRef)) || 'Unknown';
    else if (a.targetType === 'designation') {
      const dg = desigMap.get(String(a.targetRef));
      name = dg?.department ? deptMap.get(dg.department) : 'Standalone';
    } else if (a.targetType === 'employee') {
      const u = empMap.get(String(a.targetRef));
      name = u?.department ? deptMap.get(String(u.department)) : 'Unassigned';
    }
    name = name || 'Unassigned';
    deptLoad.set(name, (deptLoad.get(name) || 0) + 1);
  }
  const departmentLoad = [...deptLoad.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  // ---- Employee load (applicable assignment count per employee) ----
  const empLoadList = [];
  for (const e of employees) {
    const count = assignments.filter((a) => a.active && (
      (a.targetType === 'employee' && String(a.targetRef) === String(e._id))
      || (a.targetType === 'department' && e.department && String(a.targetRef) === String(e.department))
      || (a.targetType === 'designation' && e.designation && String(a.targetRef) === String(e.designation))
    )).length;
    if (count) empLoadList.push({ name: e.name, assignments: count });
  }
  empLoadList.sort((a, b) => b.assignments - a.assignments);
  const employeeLoad = empLoadList.slice(0, 10);

  // ---- Recurrence distribution ----
  const recur = { daily: 0, weekly: 0, monthly: 0, 'one-time': 0 };
  for (const a of assignments) {
    if (!a.active) continue;
    const f = ['daily', 'weekly', 'monthly', 'one-time'].includes(a.frequency) ? a.frequency : 'daily';
    recur[f] += 1;
  }
  const recurrenceDistribution = Object.entries(recur).map(([frequency, count]) => ({ frequency, count }));

  // ---- Dependency-heavy templates ----
  const depByTitle = new Map();
  for (const d of depAll) {
    const t = d.templateTitle || 'Unknown';
    depByTitle.set(t, (depByTitle.get(t) || 0) + 1);
  }
  const dependencyHeavyTemplates = [...depByTitle.entries()].map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count).slice(0, 10);

  // ---- Overdue assignments (any pending task older than 7 days) ----
  const overdueAgg = await Submission.aggregate([
    { $match: liveSubmissionFilter({}) }, // exclude soft-deleted / test submissions
    { $unwind: '$tasks' },
    { $match: { 'tasks.status': 'pending', 'tasks.pendingSince': { $lte: sevenDaysAgo } } },
    { $group: { _id: '$assignment' } },
  ]);

  res.json({
    cards: {
      totalAssignments: assignments.length,
      activeAssignments: assignments.filter((a) => a.active).length,
      totalTemplates: tplUsage.size,
      overdueAssignmentCount: overdueAgg.length,
    },
    charts: {
      mostUsedTemplates,
      highestPendency,
      highestCompletion,
      departmentLoad,
      employeeLoad,
      recurrenceDistribution,
      dependencyHeavyTemplates,
    },
  });
});

/* ====================================================================== */
/*  CALLING ANALYTICS                                                     */
/*                                                                        */
/*  Aggregates every submitted Custom Assignment with kind='calling'      */
/*  in a [from, to) window, scoped by role:                               */
/*    - HR / Super Admin: all departments (HR can filter by department)   */
/*    - HOD: their team only (Super Admin override gives full view)       */
/*    - employee (via /api/analytics/calling/mine): self only             */
/*                                                                        */
/*  Output is exactly what the Calling Analytics tab needs:               */
/*    - kpis: { totalAssignedCalls, totalCallsCompleted, ... 8 metrics }  */
/*    - leaderboards: top callers by 6 metrics, bottom by 3               */
/*    - trend: per-day totals for sparkline / table rendering             */
/*    - employees: per-employee rollup with all metrics                   */
/* ====================================================================== */

/** Sum a key across submission.customResponses (defaulting to 0). */
const sumCustom = (subs, key) => {
  let s = 0;
  for (const sub of subs) {
    const r = (sub.customResponses || []).find((x) => x.key === key);
    s += Number(r?.value) || 0;
  }
  return s;
};
const safeRate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

const callingAnalytics = asyncHandler(async (req, res) => {
  const { from, to } = resolveRange(req.query);

  // ---- Role-scoped employee filter ----
  const empWhere = { status: 'active' };
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (req.user.role === 'super_admin') {
    // full org
  } else if (req.user.role === 'hr') {
    // full org (HR may filter via query)
  } else if (isHOD) {
    empWhere.department = req.user.hodDepartment;
  } else {
    res.status(403);
    throw new Error('Calling analytics is restricted to HR / Super Admin / HOD.');
  }
  // Only HR / Super Admin may override the department via query.  A HOD
  // hitting ?department=other_dept is IGNORED -- their clamp stands.
  if ((req.user.role === 'hr' || req.user.role === 'super_admin') && req.query.department) {
    empWhere.department = req.query.department;
  }
  if (req.query.designation) empWhere.designation = req.query.designation;
  if (req.query.employee) empWhere._id = req.query.employee;
  const employees = await User.find(empWhere)
    .populate('department', 'name')
    .populate('designation', 'title')
    .lean();
  const empMap = new Map(employees.map((e) => [String(e._id), e]));
  const empIds = employees.map((e) => e._id);

  // ---- Pull every submitted calling submission in range ----
  const subs = await Submission.find({
    submitted: true,
    employee: { $in: empIds },
    templateType: 'custom',
    customKind: 'calling',
    date: { $gte: from, $lt: to },
    // Phase 15: calling analytics counts reviewed submissions only.
    ...liveSubmissionFilter({ ...readReqFlags(req), onlyReviewed: true }),
  }).select('employee date customResponses').lean();

  // ---- Headline KPIs (org-wide for the filtered scope) ----
  const totalAssignedCalls    = sumCustom(subs, 'assignedCalls');
  const totalCallsCompleted   = sumCustom(subs, 'totalCallsCompleted');
  const totalDialedCalls      = sumCustom(subs, 'dialedCalls');
  const totalAttendedCalls    = sumCustom(subs, 'attendedCalls');
  const totalUnattendedCalls  = sumCustom(subs, 'unattendedCalls');
  const totalConversions      = sumCustom(subs, 'totalConversions');
  const oldConversions        = sumCustom(subs, 'oldCustomerConversions');
  const newConversions        = sumCustom(subs, 'newCustomerConversions');
  const totalPendingCalls     = sumCustom(subs, 'totalPending');

  // Active-employee count for "per employee" averages -- only count
  // employees who actually submitted at least one calling report in the
  // range (matches the existing perEmp map keys).
  const activeEmpCount = new Set(subs.map((s) => String(s.employee))).size;
  const averageDialedPerEmployee = activeEmpCount > 0 ? Math.round((totalDialedCalls / activeEmpCount) * 10) / 10 : 0;

  const kpis = {
    totalAssignedCalls,
    totalCallsCompleted,
    totalDialedCalls,
    averageDialedPerEmployee,
    totalAttendedCalls,
    totalUnattendedCalls,
    totalConversions,
    oldConversions,
    newConversions,
    totalPendingCalls,
    // Connection Rate now uses Dialed Calls (= actual call attempts)
    // instead of Total Calls Completed (= unique-farmer reach).
    connectionRate:    safeRate(totalAttendedCalls, totalDialedCalls),
    conversionRate:    safeRate(totalConversions,   totalAttendedCalls),
    pendingRate:       safeRate(totalPendingCalls,  totalAssignedCalls),
    callCompletionRate: safeRate(totalCallsCompleted, totalAssignedCalls),
  };

  // ---- Per-employee rollup ----
  const perEmp = new Map();
  for (const sub of subs) {
    const k = String(sub.employee);
    if (!perEmp.has(k)) perEmp.set(k, {
      assignedCalls: 0, totalCallsCompleted: 0, dialedCalls: 0, attendedCalls: 0,
      unattendedCalls: 0, totalConversions: 0,
      oldConversions: 0, newConversions: 0, totalPending: 0,
      submissions: 0,
    });
    const m = perEmp.get(k);
    const r = (key) => Number((sub.customResponses || []).find((x) => x.key === key)?.value) || 0;
    m.assignedCalls       += r('assignedCalls');
    m.totalCallsCompleted += r('totalCallsCompleted');
    m.dialedCalls         += r('dialedCalls');
    m.attendedCalls       += r('attendedCalls');
    m.unattendedCalls     += r('unattendedCalls');
    m.totalConversions    += r('totalConversions');
    m.oldConversions      += r('oldCustomerConversions');
    m.newConversions      += r('newCustomerConversions');
    m.totalPending        += r('totalPending');
    m.submissions         += 1;
  }
  const employeeRows = [];
  for (const [k, m] of perEmp.entries()) {
    const e = empMap.get(k);
    if (!e) continue;
    employeeRows.push({
      _id: k,
      name: e.name,
      employeeId: e.employeeId,
      department: e.department?.name || 'Unassigned',
      designation: e.designation?.title || 'Unassigned',
      ...m,
      // Connection Rate now off Dialed Calls (per spec change).
      connectionRate:    safeRate(m.attendedCalls,    m.dialedCalls),
      conversionRate:    safeRate(m.totalConversions, m.attendedCalls),
      pendingRate:       safeRate(m.totalPending,     m.assignedCalls),
      callCompletionRate: safeRate(m.totalCallsCompleted, m.assignedCalls),
    });
  }

  // ---- Leaderboards (top N, descending unless noted) ----
  const sortDesc = (arr, key) => [...arr].sort((a, b) => (b[key] || 0) - (a[key] || 0));
  const sortAsc  = (arr, key) => [...arr].sort((a, b) => (a[key] || 0) - (b[key] || 0));
  const top = (arr, key, n = 5, dir = 'desc') => (dir === 'asc' ? sortAsc(arr, key) : sortDesc(arr, key)).slice(0, n);
  const leaderboards = {
    topCallsCompleted:    top(employeeRows, 'totalCallsCompleted'),
    topDialedCalls:       top(employeeRows, 'dialedCalls'),
    topConversionRate:    top(employeeRows.filter((r) => r.attendedCalls >= 1), 'conversionRate'),
    topNewCustomers:      top(employeeRows, 'newConversions'),
    topTotalConversions:  top(employeeRows, 'totalConversions'),
    lowestPending:        top(employeeRows.filter((r) => r.assignedCalls >= 1), 'totalPending', 5, 'asc'),
    // Best Connection Rate now requires dialedCalls>=1 so an
    // employee with no dial attempts can't appear with a 0/0 = 0 row.
    bestConnectionRate:   top(employeeRows.filter((r) => r.dialedCalls >= 1), 'connectionRate'),
    bottomHighestPending: top(employeeRows.filter((r) => r.assignedCalls >= 1), 'totalPending'),
    bottomLowestConversion: top(employeeRows.filter((r) => r.attendedCalls >= 1), 'conversionRate', 5, 'asc'),
    bottomLowestCompletion: top(employeeRows.filter((r) => r.assignedCalls >= 1), 'callCompletionRate', 5, 'asc'),
  };

  // ---- Per-day trend (org-wide totals for the filter) ----
  const perDay = new Map();
  for (const sub of subs) {
    const dk = formatYMD(sub.date);
    if (!perDay.has(dk)) perDay.set(dk, { date: dk, assigned: 0, completed: 0, dialed: 0, attended: 0, conversions: 0, pending: 0 });
    const m = perDay.get(dk);
    const r = (key) => Number((sub.customResponses || []).find((x) => x.key === key)?.value) || 0;
    m.assigned    += r('assignedCalls');
    m.completed   += r('totalCallsCompleted');
    m.dialed      += r('dialedCalls');
    m.attended    += r('attendedCalls');
    m.conversions += r('totalConversions');
    m.pending     += r('totalPending');
  }
  const trend = [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  /* =================================================================
   * PRODUCT & FARMER METRICS (additive -- existing calling KPIs above
   * are unchanged).  Pulls every submitted custom submission in range
   * whose productSales[] or farmerRecords[] is non-empty.  Templates
   * opt in via customSections, so the same aggregation works for
   * future Dealer Visit / Site Visit / Collection reports.
   * ================================================================= */
  const pfSubs = await Submission.find({
    submitted: true,
    employee: { $in: empIds },
    templateType: 'custom',
    date: { $gte: from, $lt: to },
    $or: [
      { 'productSales.0': { $exists: true } },
      { 'farmerRecords.0': { $exists: true } },
    ],
    // Phase 15: Product & Farmer + Dealer analytics count reviewed only.
    ...liveSubmissionFilter({ ...readReqFlags(req), onlyReviewed: true }),
  }).select('employee date productSales farmerRecords').lean();

  // Dealer Master snapshot for the "active dealers" KPI.  Independent of
  // pfSubs so an empty range still reports the catalogue size.
  const Dealer = require('../models/Dealer');
  const allDealers = await Dealer.find({ active: true }).select('_id name place').lean();
  const totalActiveDealers = allDealers.length;

  // Defensive log so deploys can verify data flow at a glance.
  const pfProductRows = pfSubs.reduce((s, sub) => s + ((sub.productSales || []).length), 0);
  const pfFarmerRows  = pfSubs.reduce((s, sub) => s + ((sub.farmerRecords || []).length), 0);
  console.log(`[analytics] product submissions found: ${pfSubs.length} (${pfProductRows} product rows, ${pfFarmerRows} farmer rows) [range ${from.toISOString().slice(0,10)} → ${to.toISOString().slice(0,10)}, ${empIds.length} employees scoped]`);

  let totalProductsSold     = 0;   // count of product-sale rows
  let totalQuantitySold     = 0;   // sum of quantityValue
  let totalSalesValue       = 0;
  let totalNbvValue         = 0;
  let totalFarmersAdded     = 0;

  const productAgg = new Map();    // productName -> { rows, qty, sales, nbv }
  const employeePFAgg = new Map(); // empId -> { sales, nbv, qty, products, farmers }
  // Dealer aggregation (Phase 2.6).  Keyed by dealerId so renames /
  // deactivations don't fragment the bucket.  Values use snapshot labels
  // for display.
  const dealerAgg = new Map();     // dealerId -> { name, place, farmers, products, sales, nbv, qty }
  const dealerDay = new Map();     // 'dealerId|date' -> { date, sales, nbv, farmers }

  for (const sub of pfSubs) {
    const empKey = String(sub.employee);
    if (!employeePFAgg.has(empKey)) employeePFAgg.set(empKey, { sales: 0, nbv: 0, qty: 0, products: 0, farmers: 0 });
    const peStats = employeePFAgg.get(empKey);

    for (const row of (sub.productSales || [])) {
      const sv = Number(row.salesValue) || 0;
      const nv = Number(row.nbvValue)   || 0;
      const qv = Number(row.quantityValue) || 0;
      totalProductsSold += 1;
      totalQuantitySold += qv;
      totalSalesValue   += sv;
      totalNbvValue     += nv;
      peStats.sales    += sv;
      peStats.nbv      += nv;
      peStats.qty      += qv;
      peStats.products += 1;
      const pname = row.productName || '—';
      if (!productAgg.has(pname)) productAgg.set(pname, { name: pname, rows: 0, qty: 0, sales: 0, nbv: 0 });
      const pa = productAgg.get(pname);
      pa.rows  += 1;
      pa.qty   += qv;
      pa.sales += sv;
      pa.nbv   += nv;
    }
    const farmerCount = (sub.farmerRecords || []).length;
    totalFarmersAdded += farmerCount;
    peStats.farmers   += farmerCount;

    // Dealer aggregation -- only rows that reference Dealer Master.
    // Free-text dealerLocation rows are intentionally NOT counted here;
    // they're legacy data and don't carry a stable bucket key.
    const dk = formatYMD(sub.date);
    for (const f of (sub.farmerRecords || [])) {
      if (!f.dealerId) continue;
      const key = String(f.dealerId);
      if (!dealerAgg.has(key)) dealerAgg.set(key, {
        _id: key,
        // Phase 3: surface all three labels.  Legacy `name` mirrors
        // firmName so older frontends keep rendering something useful.
        firmName:   f.dealerFirmSnapshot   || f.dealerNameSnapshot || '',
        place:      f.dealerPlaceSnapshot  || '',
        dealerName: f.dealerPersonSnapshot || '',
        name:       f.dealerFirmSnapshot   || f.dealerNameSnapshot || '',
        farmers: 0, products: 0, sales: 0, nbv: 0, qty: 0,
      });
      const da = dealerAgg.get(key);
      da.farmers += 1;
      // Sum every product attached to this farmer + match against
      // productSales rows on the same submission to fold in sales / NBV
      // when the product+quantity tuple is present on both sides.
      for (const fp of (f.products || [])) {
        da.products += 1;
        da.qty      += Number(fp.quantity) || 0;
        // Best-effort sales/NBV credit: find a productSales row on the
        // same submission with the same product to inherit pricing.
        const sale = (sub.productSales || []).find((ps) =>
          String(ps.productId) === String(fp.productId) && Number(ps.quantityValue || ps.quantity) === Number(fp.quantity));
        if (sale) {
          da.sales += Number(sale.salesValue) || 0;
          da.nbv   += Number(sale.nbvValue)   || 0;
        }
      }
      // Daily trend.
      const dayKey = `${key}|${dk}`;
      if (!dealerDay.has(dayKey)) dealerDay.set(dayKey, { dealerId: key, date: dk, sales: 0, nbv: 0, farmers: 0 });
      const dd = dealerDay.get(dayKey);
      dd.farmers += 1;
      // Same best-effort sales attribution per product.
      for (const fp of (f.products || [])) {
        const sale = (sub.productSales || []).find((ps) =>
          String(ps.productId) === String(fp.productId) && Number(ps.quantityValue || ps.quantity) === Number(fp.quantity));
        if (sale) {
          dd.sales += Number(sale.salesValue) || 0;
          dd.nbv   += Number(sale.nbvValue)   || 0;
        }
      }
    }
  }

  // Round once at the end so display doesn't drift on long sums.
  const round2 = (n) => Math.round(n * 100) / 100;
  totalSalesValue = round2(totalSalesValue);
  totalNbvValue   = round2(totalNbvValue);
  totalQuantitySold = round2(totalQuantitySold);

  const productKpis = {
    totalProductsSold,
    totalQuantitySold,
    totalSalesValue,
    totalNbvValue,
  };
  const farmerKpis = {
    totalFarmersAdded,
  };

  // Per-product leaderboard (top by sales value).
  const productsTable = [...productAgg.values()]
    .map((p) => ({ ...p, sales: round2(p.sales), nbv: round2(p.nbv), qty: round2(p.qty) }))
    .sort((a, b) => b.sales - a.sales);
  const topSellingProducts    = productsTable.slice(0, 5);
  const topRevenueProducts    = [...productsTable].sort((a, b) => b.sales - a.sales).slice(0, 5);
  const topNbvProducts        = [...productsTable].sort((a, b) => b.nbv - a.nbv).slice(0, 5);

  // Per-employee Product & Farmer rollup -- joined with the employee map.
  const employeePF = [];
  for (const [k, m] of employeePFAgg.entries()) {
    const e = empMap.get(k);
    if (!e) continue;
    employeePF.push({
      _id: k,
      name: e.name,
      employeeId: e.employeeId,
      department: e.department?.name || 'Unassigned',
      salesValue:    round2(m.sales),
      nbvValue:      round2(m.nbv),
      quantitySold:  round2(m.qty),
      productsSold:  m.products,
      farmersAdded:  m.farmers,
    });
  }
  const topBy = (key) => [...employeePF].sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, 5);
  const productEmployeeLeaderboards = {
    topSales:    topBy('salesValue'),
    topNbv:      topBy('nbvValue'),
    topQuantity: topBy('quantitySold'),
    topProducts: topBy('productsSold'),
    topFarmers:  topBy('farmersAdded'),
  };

  // ---- Dealer Analytics rollup (Phase 2.6) ----
  const dealersTouched = dealerAgg.size;
  const dealersWithSales = [...dealerAgg.values()].filter((d) => d.sales > 0).length;
  const totalDealerSales = [...dealerAgg.values()].reduce((s, d) => s + d.sales, 0);
  const avgSalesPerDealer = dealersTouched > 0 ? round2(totalDealerSales / dealersTouched) : 0;

  const dealersTable = [...dealerAgg.values()].map((d) => ({
    ...d,
    sales: round2(d.sales),
    nbv:   round2(d.nbv),
    qty:   round2(d.qty),
  })).sort((a, b) => b.sales - a.sales);

  const dealerKpis = {
    totalActiveDealers,
    dealersCovered:     dealersTouched,
    dealersWithSales,
    avgSalesPerDealer,
  };
  const topByKey = (arr, key) => [...arr].sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, 5);
  const dealerLeaderboards = {
    topSales:    topByKey(dealersTable, 'sales'),
    topQuantity: topByKey(dealersTable, 'qty'),
    topNbv:      topByKey(dealersTable, 'nbv'),
    topFarmers:  topByKey(dealersTable, 'farmers'),
  };
  // Daily trend: aggregate per date across all dealers so the chart on
  // the page is a single line / bar (dealer-specific trend lives in the
  // per-dealer drill-down).
  const dealerTrendByDate = new Map();
  for (const d of dealerDay.values()) {
    if (!dealerTrendByDate.has(d.date)) dealerTrendByDate.set(d.date, { date: d.date, sales: 0, nbv: 0, farmers: 0 });
    const t = dealerTrendByDate.get(d.date);
    t.sales   += d.sales;
    t.nbv     += d.nbv;
    t.farmers += d.farmers;
  }
  const dealerTrend = [...dealerTrendByDate.values()]
    .map((r) => ({ ...r, sales: round2(r.sales), nbv: round2(r.nbv) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Combined calling + product metrics (per organisation total).
  const combinedMetrics = {
    revenuePerCall:        safeRate(totalSalesValue,    totalCallsCompleted) / 10, // un-x10 the safeRate's %
    nbvPerCall:            safeRate(totalNbvValue,      totalCallsCompleted) / 10,
    revenuePerConversion:  safeRate(totalSalesValue,    totalConversions)    / 10,
    nbvPerConversion:      safeRate(totalNbvValue,      totalConversions)    / 10,
    farmersPerEmployee:    employees.length > 0 ? round2(totalFarmersAdded   / employees.length) : 0,
    revenuePerEmployee:    employees.length > 0 ? round2(totalSalesValue     / employees.length) : 0,
    nbvPerEmployee:        employees.length > 0 ? round2(totalNbvValue       / employees.length) : 0,
  };

  res.json({
    range: { from, to },
    kpis,
    leaderboards,
    employees: employeeRows.sort((a, b) => (b.totalCallsCompleted || 0) - (a.totalCallsCompleted || 0)),
    trend,
    // ---- Product & Farmer extension ----
    productKpis,
    farmerKpis,
    productsTable,
    topSellingProducts,
    topRevenueProducts,
    topNbvProducts,
    productEmployeeLeaderboards,
    combinedMetrics,
    employeesPF: employeePF.sort((a, b) => (b.salesValue || 0) - (a.salesValue || 0)),
    // ---- Dealer Analytics (Phase 2.6) ----
    dealerKpis,
    dealerLeaderboards,
    dealersTable,
    dealerTrend,
  });
});

/**
 * GET /api/analytics/calling/mine
 * Employee self-view of their calling performance over the same range.
 * Returns the same shape minus org-wide leaderboards.
 */
const myCallingAnalytics = asyncHandler(async (req, res) => {
  const { from, to } = resolveRange(req.query);
  const subs = await Submission.find({
    submitted: true,
    employee: req.user._id,
    templateType: 'custom',
    customKind: 'calling',
    date: { $gte: from, $lt: to },
    // Phase 15: employee's own analytics view also reviewed-only.
    ...liveSubmissionFilter({ onlyReviewed: true }),
  }).select('date customResponses').lean();

  const totalAssignedCalls    = sumCustom(subs, 'assignedCalls');
  const totalCallsCompleted   = sumCustom(subs, 'totalCallsCompleted');
  const totalAttendedCalls    = sumCustom(subs, 'attendedCalls');
  const totalConversions      = sumCustom(subs, 'totalConversions');
  const totalPendingCalls     = sumCustom(subs, 'totalPending');

  const perDay = new Map();
  for (const sub of subs) {
    const dk = formatYMD(sub.date);
    if (!perDay.has(dk)) perDay.set(dk, { date: dk, assigned: 0, completed: 0, attended: 0, conversions: 0, pending: 0 });
    const m = perDay.get(dk);
    const r = (key) => Number((sub.customResponses || []).find((x) => x.key === key)?.value) || 0;
    m.assigned    += r('assignedCalls');
    m.completed   += r('totalCallsCompleted');
    m.attended    += r('attendedCalls');
    m.conversions += r('totalConversions');
    m.pending     += r('totalPending');
  }
  res.json({
    range: { from, to },
    kpis: {
      totalAssignedCalls, totalCallsCompleted, totalAttendedCalls,
      totalConversions, totalPendingCalls,
      connectionRate:    safeRate(totalAttendedCalls, totalCallsCompleted),
      conversionRate:    safeRate(totalConversions,   totalAttendedCalls),
      pendingRate:       safeRate(totalPendingCalls,  totalAssignedCalls),
      callCompletionRate: safeRate(totalCallsCompleted, totalAssignedCalls),
    },
    trend: [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  });
});

module.exports = { pendency, completion, assignmentAnalytics, callingAnalytics, myCallingAnalytics };
