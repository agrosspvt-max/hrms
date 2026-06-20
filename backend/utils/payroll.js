/**
 * payroll
 *
 * Realistic Indian CTC payroll engine.  Turns an employee's salary
 * structure + a month's attendance into a full payslip breakdown that
 * follows standard offer-letter accounting:
 *
 *   GROSS SALARY      = Basic + HRA + Conveyance + Medical + Special
 *                       + Other + Bonus            (employee earnings)
 *   EMPLOYER CONTRIB. = Employer PF (% of Basic) + Employer ESIC (% of Gross)
 *   TOTAL CTC         = Gross + Employer Contributions
 *   EMPLOYEE DEDUCTNS = PF / ESIC / TDS (% of TOTAL CTC, monthly)
 *                       + PT (fixed)
 *                       + attendance LOP (unpaid / half-day / absent)
 *                       + penalties
 *   NET IN-HAND       = Total CTC (+ ad-hoc incentives) - Employee Deductions
 *
 * KEY RULES
 *   - All percentage-based employee deductions (PF / ESIC / TDS) are
 *     calculated on TOTAL CTC (monthly) = Gross + Employer contributions.
 *   - PT is a fixed amount.  Explicit *Amount overrides still win.
 *   - Employer PF (% of Basic) / Employer ESIC (% of Gross) are separate
 *     CTC items and DO NOT reduce net pay.
 *
 * BACKWARD COMPATIBILITY
 *   When no earning components are configured, the employee's legacy
 *   in-hand `monthlySalary` (or monthlyGross) is treated as Basic with no
 *   statutory deductions, so regenerating old slips reproduces the prior
 *   net exactly.
 */

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rupee = (n) => Math.round(Number(n) || 0); // payslip money is whole rupees
const sumItems = (arr) => (arr || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
const pct = (base, percent) => round((Number(base) || 0) * (Number(percent) || 0) / 100);

/**
 * Resolve monthly earning components, with a legacy fallback so earnings
 * are never empty.
 */
const resolveComponents = (structure = {}, inHand = 0) => {
  const c = {
    basic: Number(structure.basicSalary) || 0,
    hra: Number(structure.hra) || 0,
    conveyance: Number(structure.conveyance) || 0,
    medical: Number(structure.medicalAllowance) || 0,
    special: Number(structure.specialAllowance) || 0,
    other: Number(structure.otherAllowance) || 0,
    bonus: Number(structure.bonus) || 0,
  };
  const total = c.basic + c.hra + c.conveyance + c.medical + c.special + c.other + c.bonus;
  if (total <= 0) {
    // Legacy: treat the in-hand / gross figure as Basic.
    c.basic = Number(structure.monthlyGross) || Number(structure.grossSalary) || Number(inHand) || 0;
  }
  return c;
};

/**
 * Compute the full CTC payroll breakdown for one month.
 *
 * @param {object} opts
 * @param {object} opts.structure      user.salaryStructure
 * @param {number} opts.monthlySalary  legacy in-hand fallback
 * @param {object} opts.attendance     deriveAttendance() result
 * @param {Array}  opts.bonusItems     ad-hoc incentives [{amount,note}]
 * @param {Array}  opts.deductionItems penalties / custom [{amount,note}]
 */
const computePayroll = ({ structure = {}, monthlySalary = 0, attendance = {}, bonusItems = [], deductionItems = [] }) => {
  const workingDays = attendance.workingDays || 1;
  // Phase 31.2 -- standardised payroll rule. `monthDays` (calendar days
  // in the salary month, Sundays + holidays included) replaces
  // `workingDays` as the divisor when present on the attendance bundle.
  const monthDays = attendance.monthDays || workingDays;
  const presentDays = attendance.presentDays || 0;
  const paidLeaves = attendance.paidLeaves || 0;
  const unpaidLeaves = attendance.unpaidLeaves || 0;
  const halfPaidDays = attendance.halfPaidDays || 0;
  const halfUnpaidDays = attendance.halfUnpaidDays || 0;
  const absentDays = attendance.absentDays || 0;
  const holidayWorkedDays = attendance.holidayWorkedDays || 0;

  // Every payslip line is rounded to whole rupees AS IT IS COMPUTED, and
  // all totals are summed from those rounded lines.  This guarantees the
  // slip reconciles exactly (Gross - Total Deductions === Net), with no
  // off-by-one rounding drift between the lines and the totals.

  // ---- STEP 1: Earnings / Gross ----
  const comp = resolveComponents(structure, monthlySalary);
  const basic = rupee(comp.basic);
  const monthlyGross = rupee(comp.basic + comp.hra + comp.conveyance + comp.medical + comp.special + comp.other + comp.bonus);
  const incentives = rupee(sumItems(bonusItems));           // ad-hoc, on top of structure
  const grossEarnings = monthlyGross + incentives;

  // ---- STEP 2: Employer contributions (CTC only - never reduce net) ----
  const employerPf = structure.pfEnabled ? rupee(pct(basic, structure.employerPfPercentage ?? 13)) : 0;
  // Phase 33 -- ESIC is considered "configured" when ANY of the
  // following holds.  A bare default percentage (3.25) is NOT enough --
  // every employee carries that default, so it would auto-enable
  // everyone.  We only trust signals HR actually set on the profile:
  //   - the explicit toggle (`esicEnabled === true`), OR
  //   - an override amount (`esicAmount > 0`)
  // When neither is present, ESIC stays at 0 (matches the user's spec
  // "If ESIC is not enabled/configured: ESIC should remain 0.")
  // PF logic is unchanged.
  const esicConfigured = !!structure.esicEnabled || Number(structure.esicAmount) > 0;
  // Phase 35 -- treat a missing OR a zero `employerEsicPercentage` as
  // "use the schema default" (3.25%).  Legacy User documents that were
  // saved before the field existed, or HR profiles where only
  // `esicAmount` was filled, persist this as 0; the previous `??`
  // operator only caught null / undefined, so a stored 0 silently
  // zeroed Employer ESIC even when employee ESIC was computed.
  const employerEsicRate = Number(structure.employerEsicPercentage) > 0
    ? Number(structure.employerEsicPercentage)
    : 3.25;
  const employerEsic = esicConfigured ? rupee(pct(monthlyGross, employerEsicRate)) : 0;
  const employerTotal = employerPf + employerEsic;
  const ctcMonthly = monthlyGross + employerTotal;

  // ---- STEP 3: Employee statutory deductions ----
  // Per configuration, all percentage-based employee deductions (PF / ESIC
  // / TDS) are calculated on TOTAL CTC (monthly).  PT remains a fixed
  // amount.  Explicit *Amount overrides still win.  (Employer
  // contributions above are NOT derived from CTC, so there is no circular
  // dependency.)
  const deductionBase = ctcMonthly;

  let employeePf = 0;
  if (structure.pfEnabled) {
    employeePf = rupee(Number(structure.pfAmount) > 0
      ? Number(structure.pfAmount)
      : pct(deductionBase, structure.pfPercentage ?? 12));
  } else if (Number(structure.pf) > 0 && monthlyGross === basic) {
    employeePf = rupee(structure.pf); // honour legacy flat PF only when no modern structure
  }

  let esic = 0;
  // Phase 33 -- mirror the employer-side `esicConfigured` check so the
  // employee ESIC deduction is read from the same signal.  Otherwise
  // we'd compute the employer side (CTC line) but skip the employee
  // side (net deduction), which would inflate net pay incorrectly.
  if (esicConfigured) {
    esic = rupee(Number(structure.esicAmount) > 0
      ? Number(structure.esicAmount)
      : pct(deductionBase, structure.esicPercentage ?? 0.75));
  }
  const pt = structure.ptEnabled ? rupee(structure.ptAmount) : 0;
  let tds = 0;
  if (structure.tdsEnabled) {
    tds = rupee(structure.tdsType === 'fixed'
      ? (Number(structure.tdsValue) || 0)
      : pct(deductionBase, structure.tdsValue));
  }

  // ---- Attendance / LOP deductions (prorated on gross) ----
  // Phase 31.2: per-day rate divides by monthDays (Sundays + holidays
  // included), so each absent day deducts exactly perDayGross — matching
  // the documented rule monthlyGross ÷ daysInMonth.
  const perDayGross = monthlyGross / Math.max(1, monthDays);
  const unpaidLeaveDeduction = rupee(perDayGross * unpaidLeaves);
  const halfDayDeduction = rupee(perDayGross * 0.5 * halfUnpaidDays);
  const absentDeduction = rupee(perDayGross * absentDays);
  // Phase 31.2: holiday / Sunday worked credit -- one extra payable day
  // per day the employee filed work on a weekly-off / holiday day.
  // Stored as a positive adjustment so the slip can render it as
  // "Adjustment: +₹X" alongside the deductions line.
  const holidayWorkedCredit = rupee(perDayGross * holidayWorkedDays);

  // ---- Penalties / custom deductions ----
  const penalties = rupee(sumItems(deductionItems));

  // Sum of the already-rounded lines -> the displayed total matches exactly.
  const totalDeductions =
    employeePf + esic + pt + tds +
    unpaidLeaveDeduction + halfDayDeduction + absentDeduction +
    penalties;

  // ---- STEP 4: Net in-hand (reconciles to the rupee) ----
  // Company rule: deductions reduce TOTAL CTC (monthly), not just gross.
  //   Net = Total CTC + ad-hoc incentives + Holiday Worked Credit
  //         - Total Employee Deductions
  // (For legacy employees employerTotal is 0, so CTC === gross and the
  //  net is identical to the previous behaviour aside from the new
  //  Holiday Worked credit which defaults to 0.)
  const netPayable = Math.max(0, ctcMonthly + incentives + holidayWorkedCredit - totalDeductions);

  // ---- Attendance summary ----
  const totalDays = (attendance.perDay && attendance.perDay.length) ||
    (workingDays + (attendance.weeklyOffDays || 0) + (attendance.holidayDays || 0));
  const lopDays = round(unpaidLeaves + 0.5 * halfUnpaidDays + absentDays);
  const halfDayCount = halfPaidDays + halfUnpaidDays;
  const attendancePercentage = workingDays > 0
    ? round(((attendance.payableDays != null ? attendance.payableDays : presentDays + paidLeaves) / workingDays) * 100)
    : 0;

  return {
    earnings: {
      basic: rupee(comp.basic),
      hra: rupee(comp.hra),
      conveyance: rupee(comp.conveyance),
      medical: rupee(comp.medical),
      special: rupee(comp.special),
      other: rupee(comp.other),
      bonus: rupee(comp.bonus),         // fixed structure bonus
      incentives: rupee(incentives),    // ad-hoc bonus items
      bonuses: rupee(incentives),       // legacy alias
      monthlyGross: rupee(monthlyGross),
      grossEarnings: rupee(grossEarnings),
    },
    employer: {
      pf: rupee(employerPf),
      esic: rupee(employerEsic),
      total: rupee(employerTotal),
    },
    ctc: {
      monthly: rupee(ctcMonthly),
      annual: rupee(ctcMonthly * 12),
    },
    deductions: {
      pf: rupee(employeePf),
      esic: rupee(esic),
      pt: rupee(pt),
      tds: rupee(tds),
      halfDay: rupee(halfDayDeduction),
      unpaidLeave: rupee(unpaidLeaveDeduction),
      attendance: rupee(absentDeduction),
      penalties: rupee(penalties),
      totalDeductions: rupee(totalDeductions),
    },
    netPayable: rupee(netPayable),
    perDayGross: round(perDayGross),
    // Phase 31.2 -- positive holiday/Sunday-worked adjustment surfaced
    // for the new salary slip breakdown (Adjustment line).
    holidayWorkedCredit: rupee(holidayWorkedCredit),
    attendanceSummary: {
      totalDays,
      monthDays,
      presentDays,
      paidLeaves,
      unpaidLeaves,
      halfPaidDays,
      halfUnpaidDays,
      halfDayCount,
      weeklyOffDays: attendance.weeklyOffDays || 0,
      holidayWorkedDays,
      lopDays,
      attendancePercentage,
    },
  };
};

module.exports = { computePayroll, resolveComponents, round, rupee, sumItems, pct };
