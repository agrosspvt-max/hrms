const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Submission = require('../models/Submission');
const SalarySlip = require('../models/SalarySlip');
const { liveSubmissionFilter } = require('../utils/submissionFilter');
const { deriveAttendance } = require('../services/dailyEngine');
const { monthRange, formatMonth, formatYMD, parseDay, startOfDay, addDays } = require('../utils/dateHelpers');
const { streamSalarySlipPdf } = require('../utils/pdfGenerator');
const { sendCSV } = require('../utils/csvExporter');
const { computePayroll } = require('../utils/payroll');

/**
 * Normalise an array of { amount, note } objects coming from the API
 * and return { items, total }.  Filters out zero/blank rows.
 */
const normaliseItems = (raw) => {
  if (!Array.isArray(raw)) return { items: [], total: 0 };
  const items = raw
    .map((x) => ({ amount: Number(x?.amount) || 0, note: String(x?.note || '').trim() }))
    .filter((x) => x.amount > 0 || x.note);
  const total = items.reduce((s, x) => s + x.amount, 0);
  return { items, total };
};

/**
 * Compute salary slip for one employee over an inclusive [startDate, endDate]
 * payroll period and persist it.  Idempotent: re-running for the same
 * (employee, period) updates the row.
 *
 * The whole payroll cycle - attendance, leaves, half-days, submissions,
 * bonuses/penalties - is calculated ONLY from the selected date range.
 */
const computeSlip = async (employeeId, startDate, endDate, opts = {}) => {
  const employee = await User.findById(employeeId)
    .populate('department', 'name')
    .populate('designation', 'title');
  if (!employee) throw new Error('Employee not found');

  // Inclusive period: [from, periodEnd]; `to` is the exclusive upper bound
  // (start of the day AFTER endDate) so the end date itself is counted.
  const from = startOfDay(startDate);
  const periodEnd = startOfDay(endDate);
  const to = addDays(periodEnd, 1);
  const att = await deriveAttendance(employee, from, to);

  // Performance metrics for the month -- excludes soft-deleted /
  // test-marked submissions so payroll never pays out on test data.
  const submissions = await Submission.find({
    employee: employee._id,
    date: { $gte: from, $lt: to },
    submitted: true,
    ...liveSubmissionFilter({}),
  });
  // Phase 6: work scoring sums from submissions; day-level discipline
  // + innovation come from DailyReview, ONCE per (employee, date).
  let earned = submissions.reduce((s, x) => s + (Number(x.earnedPoints) || 0), 0);
  let total  = submissions.reduce((s, x) => s + (Number(x.totalPoints)  || 0), 0);
  const DailyReview = require('../models/DailyReview');
  const dailyReviews = await DailyReview.find({
    employee: employee._id,
    date: { $gte: from, $lt: to },
    reviewStatus: 'reviewed',
  }).select('disciplineMarks maxDisciplineMarks ideaMarks maxIdeaMarks').lean();
  for (const r of dailyReviews) {
    earned += (Number(r.disciplineMarks)    || 0) + (Number(r.ideaMarks)    || 0);
    total  += (Number(r.maxDisciplineMarks) || 0) + (Number(r.maxIdeaMarks) || 0);
  }
  const completionPercentage = total > 0 ? (earned / total) * 100 : 0;

  const backlogTasks = await Submission.aggregate([
    { $match: { employee: employee._id, date: { $gte: from, $lt: to }, ...liveSubmissionFilter({}) } },
    { $unwind: '$tasks' },
    { $match: { 'tasks.status': 'pending' } },
    { $count: 'count' },
  ]);
  const backlogCount = backlogTasks[0]?.count || 0;

  // Phase 31.2 — Standardised payroll rule (audited):
  //
  //   Per Day Salary = Monthly Gross ÷ Calendar Days in the salary
  //                    month  (Sundays + holidays included).
  //   Payable Days   = monthDays
  //                   - absentDays
  //                   - unpaidLeaves
  //                   - 0.5 × halfUnpaidDays
  //                   + holidayWorkedDays         (Sunday/holiday
  //                                                 submissions earn +1)
  //   Final Salary   = perDaySalary × payableDays
  //
  // The legacy `workingDays` (calendar days minus weekly-off minus
  // holiday) is retained on the slip for backward-compat display, but
  // it no longer drives the perDay rate.
  const monthDays = (att.perDay && att.perDay.length)
    || Math.max(1, Math.round((to - from) / 86400000));

  // Sunday / Holiday worked credit -- one credit per day where the
  // employee filed any submission AND the day was classified as
  // weekly_off or holiday by deriveAttendance.  Computed from the same
  // `submissions` array already pulled above, so no extra query.
  const submittedDayIso = new Set(submissions.map((s) => startOfDay(s.date).toISOString()));
  let holidayWorkedDays = 0;
  for (const d of (att.perDay || [])) {
    const iso = startOfDay(d.date).toISOString();
    if ((d.status === 'weekly_off' || d.status === 'holiday') && submittedDayIso.has(iso)) {
      holidayWorkedDays += 1;
    }
  }

  const workingDays = att.workingDays || 1;
  const monthlySalary = employee.monthlySalary || 0;
  const perDaySalary = monthlySalary / Math.max(1, monthDays);

  // Standardised payable days under the new rule.  Half-paid days are
  // already fully paid (worked half + paid half) so they don't deduct;
  // half-unpaid forfeits the second half (0.5 day LOP).
  const standardPayableDays = Math.max(0,
    monthDays
    - (att.absentDays || 0)
    - (att.unpaidLeaves || 0)
    - 0.5 * (att.halfUnpaidDays || 0)
    + holidayWorkedDays
  );
  const grossSalary = Math.round(perDaySalary * standardPayableDays);

  // Re-publish the standardised value on att so computePayroll (below)
  // uses the same number for its breakdown without us having to thread
  // an extra parameter through every call site.
  att.monthDays = monthDays;
  att.holidayWorkedDays = holidayWorkedDays;
  att.standardPayableDays = standardPayableDays;

  // Accept either the new items arrays OR fall back to legacy single
  // numeric `bonuses` / `deductions` values for callers that don't yet
  // know about the multi-line format.
  const { items: bonusItems, total: bonusFromItems } = normaliseItems(opts.bonusItems);
  const { items: deductionItems, total: deductionFromItems } = normaliseItems(opts.deductionItems);
  const bonuses = bonusItems.length ? bonusFromItems : (Number(opts.bonuses) || 0);
  // Itemised custom deductions (penalties etc.) - the statutory + LOP cuts
  // are computed inside the payroll engine below.
  const customDeductions = deductionItems.length ? deductionFromItems : (Number(opts.deductions) || 0);

  // ---- Full enterprise payroll breakdown (PF/ESIC/PT/TDS + LOP) ----
  const structureSnapshot = employee.salaryStructure
    ? (employee.salaryStructure.toObject ? employee.salaryStructure.toObject() : { ...employee.salaryStructure })
    : {};
  const payroll = computePayroll({
    structure: structureSnapshot,
    monthlySalary,
    attendance: att,
    bonusItems: bonusItems.length ? bonusItems : (bonuses ? [{ amount: bonuses, note: opts.bonusNote || '' }] : []),
    deductionItems,
  });

  // netSalary + the table's "Deductions" total now come from the payroll
  // engine (statutory + attendance + penalties).  grossSalary continues to
  // hold the attendance-earned in-hand figure for backward compatibility.
  const netSalary = payroll.netPayable;
  const deductions = payroll.deductions.totalDeductions;

  // Period identifiers.  month / year / monthNumber are derived from the
  // period start for legacy display + sorting; periodKey is the uniqueness
  // key for this exact cycle.
  const year = from.getUTCFullYear();
  const monthNumber = from.getUTCMonth() + 1;
  const month = formatMonth(year, monthNumber);
  const periodKey = `${formatYMD(from)}_${formatYMD(periodEnd)}`;
  // Shortened payslip number: PS-<empId>-<MMM>-<YYYY> (derived from the
  // payroll period start).  Uniqueness / period scoping continues to live
  // on `periodKey` -- the payslip number is a human-friendly display.
  const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const mmm = MONTH_ABBR[monthNumber - 1] || '';
  const update = {
    employee: employee._id,
    employeeName: employee.name || '',
    employeeEmpId: employee.employeeId || '',
    employeeEmail: employee.email || '',
    departmentName: employee.department?.name || '',
    designationTitle: employee.designation?.title || '',
    joiningDate: employee.joiningDate,
    bankName: employee.bankName || '',
    bankAccount: employee.bankAccount || '',
    uanNumber: employee.uanNumber || '',
    payslipNumber: `PS-${employee.employeeId || String(employee._id).slice(-6)}-${mmm}-${year}`,
    month, year, monthNumber,
    periodStart: from, periodEnd, periodKey,
    workingDays: att.workingDays,
    presentDays: att.presentDays,
    paidLeaves: att.paidLeaves,
    unpaidLeaves: att.unpaidLeaves,
    absentDays: att.absentDays,
    weeklyOffDays: att.weeklyOffDays,
    holidayDays: att.holidayDays || 0,
    halfPaidDays: att.halfPaidDays || 0,
    halfUnpaidDays: att.halfUnpaidDays || 0,
    // Phase 31.2 -- persist the standardised payable days (matches the
    // new rule) on the canonical field.  workingDays + the legacy
    // `att.payableDays` (worked-half + paid leaves) are still in the
    // schema for compat but no longer drive the rate.
    payableDays: standardPayableDays,
    monthDays,
    holidayWorkedDays,
    completionPercentage,
    backlogCount,
    monthlySalary,
    perDaySalary: Math.round(perDaySalary * 100) / 100,
    grossSalary,
    salaryStructure: structureSnapshot,
    payroll,
    bonusItems,
    deductionItems,
    bonuses,
    deductions,
    netSalary,
    bonusNote: opts.bonusNote || '',
    deductionNote: opts.deductionNote || '',
    generatedBy: opts.generatedBy,
  };

  const slip = await SalarySlip.findOneAndUpdate(
    { employee: employee._id, periodKey },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { slip, employee };
};

/**
 * Resolve a payroll date range from a request body.  Accepts the new
 * { startDate, endDate } ('YYYY-MM-DD'), and still honours the legacy
 * { year, month } shape (treated as the full calendar month) so older
 * callers / integrations keep working.  Falls back to the current month.
 */
const resolveRange = (body = {}) => {
  if (body.startDate && body.endDate) {
    return { startDate: parseDay(body.startDate), endDate: parseDay(body.endDate) };
  }
  if (body.year && body.month) {
    const { from, to } = monthRange(Number(body.year), Number(body.month));
    return { startDate: from, endDate: addDays(to, -1) };
  }
  const now = new Date();
  const { from, to } = monthRange(now.getUTCFullYear(), now.getUTCMonth() + 1);
  return { startDate: from, endDate: addDays(to, -1) };
};

/**
 * POST /api/salary/generate
 * Body: { employeeId, startDate, endDate, bonuses?, deductions?, ... }
 *       (legacy { year, month } still accepted)
 */
const generate = asyncHandler(async (req, res) => {
  const {
    employeeId,
    bonuses, deductions, bonusNote, deductionNote,
    bonusItems, deductionItems,
  } = req.body;
  const { startDate, endDate } = resolveRange(req.body);
  if (startDate > endDate) { res.status(400); throw new Error('Start date must be on or before end date'); }
  const { slip } = await computeSlip(employeeId, startDate, endDate, {
    bonuses, deductions, bonusNote, deductionNote, bonusItems, deductionItems,
    generatedBy: req.user._id,
  });
  res.status(201).json(slip);
});

/**
 * POST /api/salary/generate-all
 * Generate slips for all active accounts (employee + HR + Super Admin)
 * for a payroll period.  All three roles are real people with a salary
 * structure on their User record, so they all need payslips.
 * Body: { startDate, endDate }  (legacy { year, month } still accepted)
 */
const generateAll = asyncHandler(async (req, res) => {
  const { startDate, endDate } = resolveRange(req.body);
  if (startDate > endDate) { res.status(400); throw new Error('Start date must be on or before end date'); }
  const employees = await User.find({
    role: { $in: ['employee', 'hr', 'super_admin'] },
    status: 'active',
  });
  const slips = [];
  for (const emp of employees) {
    try {
      const { slip } = await computeSlip(emp._id, startDate, endDate, { generatedBy: req.user._id });
      slips.push(slip);
    } catch (err) {
      console.error('[salary] failed for', emp.employeeId, err.message);
    }
  }
  res.json({ count: slips.length, slips });
});

/**
 * GET /api/salary/mine
 */
const mySlips = asyncHandler(async (req, res) => {
  const items = await SalarySlip.find({ employee: req.user._id }).sort({ month: -1 });
  res.json(items);
});

/**
 * GET /api/salary?employeeId=&periodStart=&periodEnd=  (or legacy &month=)
 * When periodStart + periodEnd are supplied, returns slips for that exact
 * payroll cycle; otherwise falls back to the legacy month filter.
 */
const listSlips = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.employeeId) where.employee = req.query.employeeId;
  if (req.query.periodStart && req.query.periodEnd) {
    where.periodKey = `${req.query.periodStart}_${req.query.periodEnd}`;
  } else if (req.query.month) {
    where.month = req.query.month;
  }
  const items = await SalarySlip.find(where)
    .populate('employee', 'name employeeId email')
    .sort({ periodStart: -1, month: -1 });
  res.json(items);
});

/**
 * GET /api/salary/:id/pdf
 */
const downloadPdf = asyncHandler(async (req, res) => {
  const slip = await SalarySlip.findById(req.params.id);
  if (!slip) { res.status(404); throw new Error('Slip not found'); }

  // Self-service: HR / Super Admin can fetch anyone's slip; an employee
  // may only fetch their own.  (Mirrors the "hr role implies super_admin"
  // hierarchy used by the `authorize` middleware elsewhere.)
  const isAdmin = req.user.role === 'hr' || req.user.role === 'super_admin';
  const isOwner = String(slip.employee) === String(req.user._id);
  if (!isAdmin && !isOwner) {
    res.status(403); throw new Error('Forbidden');
  }

  const employee = (await User.findById(slip.employee)
    .populate('department', 'name')
    .populate('designation', 'title')) || {
      // Fallback synthetic record if the user has been deleted, built
      // from the denormalised snapshot on the slip itself.
      _id: slip.employee,
      name: slip.employeeName || 'Deleted Employee',
      employeeId: slip.employeeEmpId || '-',
      email: slip.employeeEmail || '',
      joiningDate: slip.createdAt,
    };

  streamSalarySlipPdf(res, {
    slip,
    employee,
    company: {
      name: process.env.COMPANY_NAME || 'Agromaxx Industry',
      address: process.env.COMPANY_ADDRESS || 'A11, Alkapuri, Saket Nagar, Bhopal 462024',
      currency: process.env.COMPANY_CURRENCY || 'INR',
      currencySymbol: process.env.COMPANY_CURRENCY_SYMBOL || 'Rs.',
    },
  });
});

/**
 * PATCH /api/salary/:id
 * HR updates bonuses/deductions; recomputes netSalary.
 */
const updateSlip = asyncHandler(async (req, res) => {
  const slip = await SalarySlip.findById(req.params.id);
  if (!slip) { res.status(404); throw new Error('Slip not found'); }
  const { bonuses, deductions, bonusNote, deductionNote, bonusItems, deductionItems } = req.body;

  if (bonusItems !== undefined) {
    const { items, total } = normaliseItems(bonusItems);
    slip.bonusItems = items;
    slip.bonuses = total;
  } else if (bonuses !== undefined) {
    slip.bonuses = Number(bonuses);
  }

  if (deductionItems !== undefined) {
    const { items, total } = normaliseItems(deductionItems);
    slip.deductionItems = items;
    slip.deductions = total;
  } else if (deductions !== undefined) {
    slip.deductions = Number(deductions);
  }

  if (bonusNote !== undefined) slip.bonusNote = bonusNote;
  if (deductionNote !== undefined) slip.deductionNote = deductionNote;

  // Recompute the full payroll breakdown from the slip's stored attendance
  // + structure snapshot so statutory/LOP deductions stay correct after an
  // HR bonus / penalty adjustment.
  const attendance = {
    workingDays: slip.workingDays,
    presentDays: slip.presentDays,
    paidLeaves: slip.paidLeaves,
    unpaidLeaves: slip.unpaidLeaves,
    halfPaidDays: slip.halfPaidDays,
    halfUnpaidDays: slip.halfUnpaidDays,
    absentDays: slip.absentDays,
    weeklyOffDays: slip.weeklyOffDays,
    holidayDays: slip.holidayDays,
    payableDays: slip.payableDays,
  };
  const structure = slip.salaryStructure
    ? (slip.salaryStructure.toObject ? slip.salaryStructure.toObject() : slip.salaryStructure)
    : {};
  const payroll = computePayroll({
    structure,
    monthlySalary: slip.monthlySalary,
    attendance,
    bonusItems: slip.bonusItems,
    deductionItems: slip.deductionItems,
  });
  slip.payroll = payroll;
  slip.markModified('payroll');
  slip.deductions = payroll.deductions.totalDeductions;
  slip.netSalary = payroll.netPayable;

  await slip.save();
  res.json(slip);
});

/**
 * GET /api/salary/export.csv?periodStart=&periodEnd=  (or legacy ?month=)
 */
const exportCsv = asyncHandler(async (req, res) => {
  const where = {};
  let label = 'all';
  if (req.query.periodStart && req.query.periodEnd) {
    where.periodKey = `${req.query.periodStart}_${req.query.periodEnd}`;
    label = `${req.query.periodStart}_${req.query.periodEnd}`;
  } else if (req.query.month) {
    where.month = req.query.month;
    label = req.query.month;
  }
  const items = await SalarySlip.find(where).populate('employee', 'name employeeId');
  const rows = items.map((s) => ({
    employeeId: s.employee?.employeeId || s.employeeEmpId || '',
    name: s.employee?.name || s.employeeName || '',
    periodStart: s.periodStart ? formatYMD(s.periodStart) : '',
    periodEnd: s.periodEnd ? formatYMD(s.periodEnd) : '',
    month: s.month,
    workingDays: s.workingDays,
    presentDays: s.presentDays,
    paidLeaves: s.paidLeaves,
    unpaidLeaves: s.unpaidLeaves,
    absentDays: s.absentDays,
    grossSalary: s.grossSalary,
    bonuses: s.bonuses,
    deductions: s.deductions,
    netSalary: s.netSalary,
  }));
  sendCSV(res, `salary-${label}.csv`, rows);
});

module.exports = {
  generate, generateAll, mySlips, listSlips, downloadPdf, updateSlip, exportCsv,
};
