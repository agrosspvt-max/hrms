const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Submission = require('../models/Submission');
const Department = require('../models/Department');
const Leave = require('../models/Leave');
const { startOfDay, addDays } = require('../utils/dateHelpers');
const { getBacklog } = require('../services/dailyEngine');

/**
 * GET /api/dashboard/hr/today
 *
 * Aggregates today's submissions grouped by employee.  HR sees
 * completion percentages, done/pending/work-not-available counts,
 * and the self-rating.
 */
const hrToday = asyncHandler(async (_req, res) => {
  const today = startOfDay(new Date());

  // Include HR users — they participate in the workflow when Super Admin
  // assigns templates to them.  Super Admin stays excluded.
  const employees = await User.find({ role: { $in: ['employee', 'hr'] }, status: 'active' })
    .populate('department', 'name')
    .populate('designation', 'title')
    .lean();

  const submissions = await Submission.find({ date: today })
    .populate('template', 'title')
    .lean();

  const byEmployee = {};
  for (const s of submissions) {
    const key = String(s.employee);
    if (!byEmployee[key]) byEmployee[key] = [];
    byEmployee[key].push(s);
  }

  const result = employees.map((emp) => {
    const subs = byEmployee[String(emp._id)] || [];
    let done = 0, pending = 0, wna = 0, earned = 0, total = 0;
    let submittedAll = subs.length > 0 && subs.every((s) => s.submitted);
    let selfRatings = [];
    for (const s of subs) {
      earned += s.earnedPoints || 0;
      total += s.totalPoints || 0;
      if (s.selfRating !== undefined && s.selfRating !== null) selfRatings.push(s.selfRating);
      for (const t of s.tasks) {
        if (t.status === 'done') done += 1;
        else if (t.status === 'pending') pending += 1;
        else if (t.status === 'work_not_available') wna += 1;
      }
    }
    return {
      employee: emp,
      hasSubmission: subs.length > 0,
      submitted: submittedAll,
      doneCount: done,
      pendingCount: pending,
      workNotAvailableCount: wna,
      earnedPoints: earned,
      totalPoints: total,
      completionPercentage: total > 0 ? (earned / total) * 100 : 0,
      selfRating: selfRatings.length ? selfRatings.reduce((a, b) => a + b, 0) / selfRatings.length : null,
      submissions: subs,
    };
  });

  res.json({ date: today, items: result });
});

/**
 * GET /api/dashboard/hr/backlog
 * Backlog across the entire company, grouped by employee.
 */
const hrBacklog = asyncHandler(async (_req, res) => {
  const employees = await User.find({ role: { $in: ['employee', 'hr'] } })
    .populate('department', 'name')
    .lean();
  const out = [];
  for (const emp of employees) {
    const list = await getBacklog(emp._id);
    if (list.length === 0) continue;
    out.push({ employee: emp, count: list.length, backlog: list });
  }
  out.sort((a, b) => b.count - a.count);
  res.json(out);
});

/**
 * GET /api/dashboard/hr/performance?days=7
 * Per-employee performance + ranking + dept aggregates.
 */
const hrPerformance = asyncHandler(async (req, res) => {
  const days = Number(req.query.days) || 7;
  const to = addDays(startOfDay(new Date()), 1);
  const from = addDays(to, -days);

  // Include HR users — they participate in the workflow when Super Admin
  // assigns templates to them.  Super Admin stays excluded.
  const employees = await User.find({ role: { $in: ['employee', 'hr'] }, status: 'active' })
    .populate('department', 'name')
    .lean();

  const subs = await Submission.find({
    submitted: true,
    date: { $gte: from, $lt: to },
  }).lean();

  const byEmp = {};
  for (const s of subs) {
    const k = String(s.employee);
    if (!byEmp[k]) byEmp[k] = { earned: 0, total: 0, submissions: 0 };
    byEmp[k].earned += s.earnedPoints || 0;
    byEmp[k].total += s.totalPoints || 0;
    byEmp[k].submissions += 1;
  }

  const ranking = employees
    .map((e) => {
      const agg = byEmp[String(e._id)] || { earned: 0, total: 0, submissions: 0 };
      return {
        employee: e,
        earnedPoints: agg.earned,
        totalPoints: agg.total,
        completionPercentage: agg.total ? (agg.earned / agg.total) * 100 : 0,
        submissions: agg.submissions,
      };
    })
    .sort((a, b) => b.completionPercentage - a.completionPercentage);

  // department aggregate
  const deptMap = {};
  for (const r of ranking) {
    const dname = r.employee.department?.name || 'Unassigned';
    if (!deptMap[dname]) deptMap[dname] = { earned: 0, total: 0, employees: 0 };
    deptMap[dname].earned += r.earnedPoints;
    deptMap[dname].total += r.totalPoints;
    deptMap[dname].employees += 1;
  }
  const departments = Object.entries(deptMap).map(([name, v]) => ({
    name,
    employees: v.employees,
    completionPercentage: v.total ? (v.earned / v.total) * 100 : 0,
  }));

  // overdue employees (have any backlog)
  let overdueCount = 0;
  for (const e of employees) {
    const bl = await getBacklog(e._id);
    if (bl.length > 0) overdueCount += 1;
  }

  // backlog growth - count of pending tasks created per day in range
  const pendingCounts = await Submission.aggregate([
    { $match: { date: { $gte: from, $lt: to } } },
    { $unwind: '$tasks' },
    { $match: { 'tasks.status': 'pending' } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  // ----- Recurrence-based productivity -----
  // Completion rate per frequency (daily / weekly / monthly / one-time)
  // from submitted submissions in range.
  const FREQS = ['daily', 'weekly', 'monthly', 'one-time'];
  const freqAgg = {};
  for (const fr of FREQS) freqAgg[fr] = { earned: 0, total: 0, submissions: 0, overdue: 0 };
  for (const s of subs) {
    const fr = FREQS.includes(s.frequency) ? s.frequency : 'daily';
    freqAgg[fr].earned += s.earnedPoints || 0;
    freqAgg[fr].total += s.totalPoints || 0;
    freqAgg[fr].submissions += 1;
  }

  // Overdue recurring tasks: still-pending tasks grouped by the submission's
  // recurrence type (regardless of date, mirroring backlog semantics).
  const overdueByFreq = await Submission.aggregate([
    { $unwind: '$tasks' },
    {
      $match: {
        'tasks.status': 'pending',
        $or: [{ 'tasks.completedAt': { $exists: false } }, { 'tasks.completedAt': null }],
      },
    },
    { $group: { _id: '$frequency', count: { $sum: 1 } } },
  ]);
  for (const o of overdueByFreq) {
    const fr = FREQS.includes(o._id) ? o._id : 'daily';
    freqAgg[fr].overdue += o.count;
  }

  const byFrequency = FREQS.map((fr) => ({
    frequency: fr,
    submissions: freqAgg[fr].submissions,
    earnedPoints: freqAgg[fr].earned,
    totalPoints: freqAgg[fr].total,
    completionPercentage: freqAgg[fr].total ? (freqAgg[fr].earned / freqAgg[fr].total) * 100 : 0,
    overdueTasks: freqAgg[fr].overdue,
  }));

  res.json({
    ranking,
    departments,
    overdueCount,
    backlogTrend: pendingCounts.map((p) => ({ date: p._id, count: p.count })),
    byFrequency,
  });
});

/**
 * GET /api/dashboard/hr/summary
 * Topline numbers for the HR landing cards.
 */
const hrSummary = asyncHandler(async (req, res) => {
  const today = startOfDay(new Date());
  const totalEmployees = await User.countDocuments({ role: 'employee', status: 'active' });
  const submittedToday = await Submission.distinct('employee', { date: today, submitted: true });

  // Pending leaves count is role-aware:
  //   - HR can only approve employee leaves -> count those only
  //   - Super Admin sees all pending leaves
  const pendingLeavesPipeline = [
    { $match: { status: 'pending' } },
    { $lookup: { from: 'users', localField: 'employee', foreignField: '_id', as: 'emp' } },
    { $unwind: '$emp' },
  ];
  if (req.user.role === 'hr') {
    pendingLeavesPipeline.push({ $match: { 'emp.role': 'employee' } });
  }
  pendingLeavesPipeline.push({ $count: 'count' });
  const pendingLeavesAgg = await Leave.aggregate(pendingLeavesPipeline);
  const pendingLeaves = pendingLeavesAgg[0]?.count || 0;

  const totalDepartments = await Department.countDocuments();

  // Match the same scoping used by the Global Backlog page:
  //   - only submissions belonging to a still-existing 'employee' role user
  //   - only tasks whose status is still 'pending' AND haven't been
  //     completed-late (completedAt unset)
  const backlogAgg = await Submission.aggregate([
    { $lookup: { from: 'users', localField: 'employee', foreignField: '_id', as: 'emp' } },
    { $unwind: '$emp' },
    { $match: { 'emp.role': { $in: ['employee', 'hr'] } } },
    { $unwind: '$tasks' },
    {
      $match: {
        'tasks.status': 'pending',
        $or: [
          { 'tasks.completedAt': { $exists: false } },
          { 'tasks.completedAt': null },
        ],
      },
    },
    { $count: 'count' },
  ]);

  res.json({
    totalEmployees,
    submittedToday: submittedToday.length,
    pendingLeaves,
    totalDepartments,
    backlogCount: backlogAgg[0]?.count || 0,
  });
});

/**
 * GET /api/dashboard/employee/summary
 * Quick numbers for the employee landing.
 */
const employeeSummary = asyncHandler(async (req, res) => {
  const today = startOfDay(new Date());
  const last30From = addDays(today, -29);
  const subs = await Submission.find({
    employee: req.user._id,
    date: { $gte: last30From, $lte: today },
    submitted: true,
  });
  const earned = subs.reduce((s, x) => s + x.earnedPoints, 0);
  const total = subs.reduce((s, x) => s + x.totalPoints, 0);
  const backlog = await getBacklog(req.user._id);
  const pendingLeaves = await Leave.countDocuments({ employee: req.user._id, status: 'pending' });

  res.json({
    last30Days: {
      submissions: subs.length,
      earnedPoints: earned,
      totalPoints: total,
      completionPercentage: total ? (earned / total) * 100 : 0,
    },
    backlogCount: backlog.length,
    pendingLeaves,
    leaveBalance: req.user.leaveBalance,
  });
});

module.exports = { hrToday, hrBacklog, hrPerformance, hrSummary, employeeSummary };
