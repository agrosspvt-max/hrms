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
const { logAudit } = require('../utils/audit');
// Phase 45 -- salary slip generated -> employee notification.
const notify = require('../services/notifyEvents');

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

  // Phase 33 -- Sunday / Holiday worked credit.
  //
  // A day earns the credit when BOTH hold:
  //   (a) the day is calendar-wise a weekly off (per employee.weeklyOff[])
  //       OR a holiday (per the Holiday collection), AND
  //   (b) the employee was effectively present -- either by filing a
  //       submission, by an Attendance record with status 'present' /
  //       half_paid / half_unpaid, or by auto_attendance mode.
  //
  // We can't use deriveAttendance's `status` field alone because a
  // manual Attendance override that flips a Sunday to 'present' rewrites
  // the day's status (manual wins), so `status === 'weekly_off'` was
  // failing for exactly the case the user reported.  We instead detect
  // weekly-off / holiday from the calendar independently, then check
  // for any signal that the employee actually worked that day.
  const Holiday = require('../models/Holiday');
  const Attendance = require('../models/Attendance');
  const holidayMap = new Map(
    (await Holiday.find({ date: { $gte: from, $lt: to } }).select('date').lean())
      .map((h) => [startOfDay(h.date).toISOString(), true]),
  );
  const attRecords = await Attendance.find({
    employee: employee._id,
    date: { $gte: from, $lt: to },
  }).select('date status').lean();
  const attByIso = new Map(attRecords.map((a) => [startOfDay(a.date).toISOString(), a.status]));
  const employeeWeeklyOff = new Set(employee.weeklyOff || [0]);
  const submittedDayIso = new Set(submissions.map((s) => startOfDay(s.date).toISOString()));
  // Presence signal used by the credit check.  ONLY these signals
  // qualify as "the employee actually worked that day":
  //   - a submission was filed on this day, OR
  //   - an Attendance record says present / half_paid / half_unpaid.
  //
  // Phase 35 fix: auto_attendance mode (Mode 3) is intentionally NOT a
  // signal here.  Mode 3 only marks WORKING days as Present; weekly
  // offs and holidays remain weekly_off / holiday for that employee,
  // and there's no reason to assume they worked every Sunday in the
  // month just because their mode is "auto".  Including it caused
  // 4 Sundays in a 30-day month to all count as holiday-worked,
  // bumping payable days from 30 to 34 when only 1 should have been
  // credited (the spec's required Case B → answer = 1).
  const PRESENT_STATUSES = new Set(['present', 'half_paid', 'half_unpaid']);
  const wasPresentOn = (dayDate) => {
    const iso = startOfDay(dayDate).toISOString();
    if (submittedDayIso.has(iso)) return true;
    if (PRESENT_STATUSES.has(attByIso.get(iso))) return true;
    return false;
  };

  let holidayWorkedDays = 0;
  for (const d of (att.perDay || [])) {
    const dayDate = new Date(d.date);
    const iso = startOfDay(dayDate).toISOString();
    const isWeeklyOff = employeeWeeklyOff.has(dayDate.getUTCDay());
    const isHoliday   = holidayMap.has(iso);
    if (!isWeeklyOff && !isHoliday) continue;
    if (wasPresentOn(dayDate)) holidayWorkedDays += 1;
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

  // Phase 32 + Phase 34 -- regeneration reuses the existing document.
  //
  // The (employee, periodKey) pair is a unique index on the collection,
  // so we cannot create a second slip for the same employee + period.
  // Instead, find ANY slip for that pair and update it in place:
  //   - active   → refresh in place (existing behaviour)
  //   - retracted → flip back to active, clear retraction fields,
  //                  reuse the same _id (audit log gets a
  //                  `salary.regenerated` entry from the caller)
  //   - no slip   → upsert creates a fresh active one
  //
  // The `_setRetractionCleared` block below explicitly clears the
  // retracted-only fields so a regenerated slip doesn't carry stale
  // reason / reviewer / timestamp data from its prior life.
  update.status = 'active';
  update.retractedAt = null;
  update.retractedBy = null;
  update.retractionReason = '';
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

  // Phase 32 — detect whether a retracted slip exists for the same
  // (employee, periodKey); if so, this counts as a regeneration for
  // audit-log purposes.  The compute path itself doesn't care: it
  // upserts onto status !== 'retracted', leaving the retracted row in
  // place.
  const periodKeyHint = `${formatYMD(startOfDay(startDate))}_${formatYMD(startOfDay(endDate))}`;
  const priorRetracted = await SalarySlip.findOne({
    employee: employeeId, periodKey: periodKeyHint, status: 'retracted',
  }).select('_id').lean();

  const { slip } = await computeSlip(employeeId, startDate, endDate, {
    bonuses, deductions, bonusNote, deductionNote, bonusItems, deductionItems,
    generatedBy: req.user._id,
  });

  logAudit(req, {
    action: priorRetracted ? 'salary.regenerated' : 'salary.generated',
    targetType: 'SalarySlip',
    targetId: slip._id,
    targetLabel: `${slip.employeeName || employeeId} · ${slip.periodKey}`,
    meta: {
      employeeId: String(employeeId),
      periodKey: slip.periodKey,
      month: slip.month,
      via: 'individual',
    },
  });

  // Phase 45 -- meaningful event: notify the employee their slip is ready.
  notify.notifySalarySlipGenerated({ employeeId, slip, generatedBy: req.user });

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
      // Phase 45 -- one notification per generated slip.  Fire-and-forget;
      // notifyEvents swallows its own errors so a notification failure
      // never breaks the payroll batch.
      notify.notifySalarySlipGenerated({ employeeId: emp._id, slip, generatedBy: req.user });
    } catch (err) {
      console.error('[salary] failed for', emp.employeeId, err.message);
    }
  }
  // Phase 32: one audit entry per bulk run (per-row entries would flood
  // the log).  Detail rows live inside `meta.slipIds[]`.
  logAudit(req, {
    action: 'salary.generated',
    targetType: 'SalarySlip',
    targetLabel: `Bulk · ${formatYMD(startDate)} → ${formatYMD(endDate)} · ${slips.length} slip(s)`,
    meta: {
      via: 'bulk',
      periodStart: formatYMD(startDate),
      periodEnd: formatYMD(endDate),
      count: slips.length,
      slipIds: slips.map((s) => String(s._id)),
    },
  });
  res.json({ count: slips.length, slips });
});

/**
 * GET /api/salary/mine
 */
const mySlips = asyncHandler(async (req, res) => {
  // Phase 40.2 -- retracted slips must be completely invisible to the
  // employee.  HR / Super Admin retain access via /api/salary with
  // ?includeRetracted=true for audit; the employee's own list now
  // behaves exactly as if the slip was never generated.
  const items = await SalarySlip.find({
    employee: req.user._id,
    status: { $ne: 'retracted' },
  }).sort({ month: -1 });
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
  // Phase 32: by default hide retracted slips so active payroll views
  // never include them.  HR can pass ?includeRetracted=true to audit
  // historical retractions from the Salary module.
  if (req.query.includeRetracted !== 'true') {
    where.status = { $ne: 'retracted' };
  }
  const items = await SalarySlip.find(where)
    .populate('employee', 'name employeeId email')
    .populate('retractedBy', 'name email')
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
  // Phase 40.2 -- retracted slips must be unreachable from the
  // employee side, including the PDF endpoint.  HR / Super Admin keep
  // PDF access for audit (e.g. proving what was retracted and when).
  if (slip.status === 'retracted' && !isAdmin) {
    res.status(404); throw new Error('Slip not found');
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
  // Phase 32: retracted slips are excluded from payroll exports + totals.
  where.status = { $ne: 'retracted' };
  // Phase 34: Export Selected -- narrow to a comma-separated list of
  // slip ids when provided so HR can hand-pick rows for export.
  if (req.query.slipIds) {
    const ids = String(req.query.slipIds).split(',').map((x) => x.trim()).filter(Boolean);
    if (ids.length > 0) {
      where._id = { $in: ids };
      label = `${label}-selected-${ids.length}`;
    }
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

/* ====================================================================
 * Phase 32 — Soft-delete retraction
 *
 * Marks a generated salary slip as `retracted` so it disappears from
 * active payroll surfaces (list / CSV / totals / mySlips) but stays in
 * the database + audit trail.  The retracted slip's PDF endpoint still
 * works for historical audit; no calculation logic is altered.
 *
 * After a slip is retracted, a fresh `active` slip can be generated for
 * the same (employee, periodKey) because computeSlip's upsert scopes
 * to `status !== 'retracted'`.
 *
 * Body: { reason? }
 * ================================================================== */
const retract = asyncHandler(async (req, res) => {
  const role = req.user.role;
  if (role !== 'hr' && role !== 'super_admin') {
    res.status(403); throw new Error('Only HR / Super Admin can retract salary slips.');
  }
  const slip = await SalarySlip.findById(req.params.id);
  if (!slip) { res.status(404); throw new Error('Slip not found.'); }
  if (slip.status === 'retracted') {
    return res.json({ ok: true, slip, message: 'Slip is already retracted.' });
  }
  const reason = String(req.body?.reason || '').trim();

  slip.status = 'retracted';
  slip.retractedAt = new Date();
  slip.retractedBy = req.user._id;
  slip.retractionReason = reason;
  await slip.save();

  logAudit(req, {
    action: 'salary.retracted',
    targetType: 'SalarySlip',
    targetId: slip._id,
    targetLabel: `${slip.employeeName || slip.employee} · ${slip.periodKey || slip.month}`,
    meta: {
      employeeId: String(slip.employee),
      periodKey: slip.periodKey,
      month: slip.month,
      previousStatus: 'active',
      newStatus: 'retracted',
      reason,
    },
  });

  res.json({ ok: true, slip });
});

/* ====================================================================
 * Phase 34 — Bulk retraction
 *
 * Accepts an array of slip ids and retracts each one, mirroring the
 * single-slip `retract` handler's audit + permission semantics.
 * Already-retracted slips are silently skipped so the call is
 * idempotent for HR running it twice.
 *
 * Body: { slipIds: [String], reason? }
 * Returns: { requested, succeeded[], skipped[], failed[] }
 * ================================================================== */
const bulkRetract = asyncHandler(async (req, res) => {
  const role = req.user.role;
  if (role !== 'hr' && role !== 'super_admin') {
    res.status(403); throw new Error('Only HR / Super Admin can retract salary slips.');
  }
  const { slipIds } = req.body || {};
  if (!Array.isArray(slipIds) || slipIds.length === 0) {
    res.status(400); throw new Error('slipIds[] is required.');
  }
  const reason = String(req.body?.reason || '').trim();
  const succeeded = [];
  const skipped = [];
  const failed = [];
  for (const id of slipIds) {
    try {
      const slip = await SalarySlip.findById(id);
      if (!slip) { failed.push({ id, error: 'Slip not found' }); continue; }
      if (slip.status === 'retracted') {
        skipped.push({ id, reason: 'already retracted' });
        continue;
      }
      slip.status = 'retracted';
      slip.retractedAt = new Date();
      slip.retractedBy = req.user._id;
      slip.retractionReason = reason;
      await slip.save();
      logAudit(req, {
        action: 'salary.retracted',
        targetType: 'SalarySlip',
        targetId: slip._id,
        targetLabel: `${slip.employeeName || slip.employee} · ${slip.periodKey || slip.month}`,
        meta: {
          employeeId: String(slip.employee),
          periodKey: slip.periodKey, month: slip.month,
          previousStatus: 'active', newStatus: 'retracted',
          reason, via: 'bulk',
        },
      });
      succeeded.push({ id: String(slip._id) });
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }
  res.json({
    requested: slipIds.length,
    succeededCount: succeeded.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    succeeded, skipped, failed,
  });
});

/* ====================================================================
 * Phase 34 — Bulk regenerate for a list of employees
 *
 * Lets HR run the per-employee generate path for a specific subset of
 * employees in one call -- e.g. "regenerate just the 5 employees I
 * selected, for the same period the rest of the page is showing."
 *
 * Body: { employeeIds: [String], startDate, endDate }   (legacy { year, month } still accepted)
 * Returns: { count, slips, regeneratedCount, failed[] }
 * ================================================================== */
const bulkGenerateForEmployees = asyncHandler(async (req, res) => {
  const role = req.user.role;
  if (role !== 'hr' && role !== 'super_admin') {
    res.status(403); throw new Error('Only HR / Super Admin can generate salary slips.');
  }
  const { employeeIds } = req.body || {};
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
    res.status(400); throw new Error('employeeIds[] is required.');
  }
  const { startDate, endDate } = resolveRange(req.body);
  if (startDate > endDate) { res.status(400); throw new Error('Start date must be on or before end date'); }
  const periodKeyHint = `${formatYMD(startOfDay(startDate))}_${formatYMD(startOfDay(endDate))}`;

  const succeeded = [];
  const failed = [];
  let regeneratedCount = 0;
  for (const empId of employeeIds) {
    try {
      const priorRetracted = await SalarySlip.findOne({
        employee: empId, periodKey: periodKeyHint, status: 'retracted',
      }).select('_id').lean();
      const { slip } = await computeSlip(empId, startDate, endDate, { generatedBy: req.user._id });
      if (priorRetracted) regeneratedCount += 1;
      succeeded.push(slip);
      // Phase 45 -- notify each employee whose slip was generated.
      notify.notifySalarySlipGenerated({ employeeId: empId, slip, generatedBy: req.user });
    } catch (err) {
      failed.push({ employeeId: empId, error: err.message });
    }
  }
  logAudit(req, {
    action: regeneratedCount > 0 ? 'salary.regenerated' : 'salary.generated',
    targetType: 'SalarySlip',
    targetLabel: `Bulk-selected · ${formatYMD(startDate)} → ${formatYMD(endDate)} · ${succeeded.length} slip(s)`,
    meta: {
      via: 'bulk-selected',
      periodStart: formatYMD(startDate),
      periodEnd: formatYMD(endDate),
      employeeIds, regeneratedCount,
      slipIds: succeeded.map((s) => String(s._id)),
    },
  });
  res.json({ count: succeeded.length, slips: succeeded, regeneratedCount, failed });
});

module.exports = {
  generate, generateAll, mySlips, listSlips, downloadPdf, updateSlip, exportCsv,
  retract, bulkRetract, bulkGenerateForEmployees,
};
