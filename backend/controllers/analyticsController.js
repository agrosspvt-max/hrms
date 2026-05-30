const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Submission = require('../models/Submission');
const DependencyTask = require('../models/DependencyTask');
const Assignment = require('../models/Assignment');
const Department = require('../models/Department');
const Designation = require('../models/Designation');
const { startOfDay, addDays, parseDay, formatYMD } = require('../utils/dateHelpers');

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
  let done = 0, pending = 0;
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
    for (const t of s.tasks || []) {
      if (t.status === 'done') done += 1;
      else if (t.status === 'pending') { pending += 1; pendingAges.push(ageOf(t.pendingSince)); }
    }
  }
  return { done, pending, pendingAges };
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
  if (req.query.department) empWhere.department = req.query.department;
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
  const depAll = await DependencyTask.find({}).populate('assignedTo', 'name employeeId').lean();
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
  if (req.query.department) empWhere.department = req.query.department;
  if (req.query.designation) empWhere.designation = req.query.designation;
  if (req.query.employee) empWhere._id = req.query.employee;
  const employees = await User.find(empWhere)
    .populate('department', 'name').populate('designation', 'title').lean();
  const empMap = new Map(employees.map((e) => [String(e._id), e]));
  const empIds = employees.map((e) => e._id);

  const subWhere = { submitted: true, employee: { $in: empIds }, date: { $gte: from, $lt: to } };
  if (['task', 'excel', 'sheet'].includes(req.query.templateType)) subWhere.templateType = req.query.templateType;
  if (['daily', 'weekly', 'monthly', 'one-time'].includes(req.query.recurrence)) subWhere.frequency = req.query.recurrence;
  if (req.query.reviewer) subWhere.reviewedBy = req.query.reviewer;
  const subs = await Submission.find(subWhere)
    .select('employee date submittedAt frequency templateType earnedPoints totalPoints workEarnedPoints workTotalPoints disciplineMarks maxDisciplineMarks ideaMarks maxIdeaMarks reviewStatus reviewedBy')
    .lean();

  const perEmp = new Map(); // empId -> { earned, total, subs, pctList, onTime, late, reviewed, disc, discMax }
  const perDay = new Map();
  const perFreq = { daily: { e: 0, t: 0 }, weekly: { e: 0, t: 0 }, monthly: { e: 0, t: 0 }, 'one-time': { e: 0, t: 0 } };
  const dist = { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
  const reviewerAgg = new Map(); // reviewerId -> { e, t, count }
  let totalEarned = 0, totalTotal = 0, reviewedCount = 0, onTimeTotal = 0, lateTotal = 0, discSum = 0, discMaxSum = 0;

  const dayMs = 86400000;
  for (const s of subs) {
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
      pe.disc += s.disciplineMarks || 0; pe.discMax += s.maxDisciplineMarks || 0;
      discSum += s.disciplineMarks || 0; discMaxSum += s.maxDisciplineMarks || 0;
      if (s.reviewedBy) {
        const rk = String(s.reviewedBy);
        if (!reviewerAgg.has(rk)) reviewerAgg.set(rk, { e: 0, t: 0, count: 0 });
        const ra = reviewerAgg.get(rk); ra.e += e; ra.t += t; ra.count += 1;
      }
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
    Submission.find({ submitted: true, date: { $gte: from30, $lt: todayPlus1 } })
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
      for (const t of s.tasks || []) { if (t.status === 'pending') m.pending += 1; else if (t.status === 'done') m.done += 1; }
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

module.exports = { pendency, completion, assignmentAnalytics };
