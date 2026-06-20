const PDFDocument = require('pdfkit');

/**
 * Streams a professional, enterprise-style salary slip PDF to the response.
 *
 * Layout mirrors a corporate Indian payslip (Zoho / Razorpay style):
 *   - dark-blue header band + company identity
 *   - employee details grid
 *   - attendance table
 *   - split earnings / deductions tables
 *   - highlighted net-salary box
 *   - footer notes
 *
 * Works for BOTH new slips (with `slip.payroll`) and legacy slips: when
 * the payroll breakdown is missing it is reconstructed from the flat
 * fields so old slips still render in the new design.
 */

// Theme
const NAVY = '#1a365d';
const NAVY2 = '#2a4365';
const BLUE = '#3182ce';
const HEAD_BG = '#f7fafc';
const BORDER = '#e2e8f0';
const CELL_BORDER = '#edf2f7';
const MUTED = '#64748b';
const TEXT = '#1f2937';

const PAGE = { left: 50, right: 545, width: 495 };

/** Build a normalised view-model from a slip (new or legacy). */
const toViewModel = (slip) => {
  if (slip.payroll && slip.payroll.earnings) {
    return {
      earnings: slip.payroll.earnings,
      deductions: slip.payroll.deductions,
      employer: slip.payroll.employer || { pf: 0, esic: 0, total: 0 },
      ctc: slip.payroll.ctc || { monthly: slip.payroll.earnings.grossEarnings || 0, annual: 0 },
      netPayable: slip.payroll.netPayable,
      attendance: slip.payroll.attendanceSummary || {},
    };
  }
  // Legacy fallback: treat earned gross as a single Basic component.
  const gross = slip.grossSalary || 0;
  const bonuses = slip.bonuses || 0;
  const ded = slip.deductions || 0;
  return {
    earnings: {
      basic: gross, hra: 0, conveyance: 0, medical: 0, special: 0, other: 0, bonus: 0,
      incentives: bonuses, bonuses, grossEarnings: gross + bonuses,
    },
    deductions: {
      pf: 0, esic: 0, pt: 0, tds: 0, halfDay: 0, unpaidLeave: 0,
      attendance: 0, penalties: ded, totalDeductions: ded,
    },
    employer: { pf: 0, esic: 0, total: 0 },
    ctc: { monthly: gross + bonuses, annual: (gross + bonuses) * 12 },
    netPayable: slip.netSalary != null ? slip.netSalary : (gross + bonuses - ded),
    attendance: {
      totalDays: (slip.workingDays || 0) + (slip.weeklyOffDays || 0) + (slip.holidayDays || 0),
      presentDays: slip.presentDays || 0,
      paidLeaves: slip.paidLeaves || 0,
      unpaidLeaves: slip.unpaidLeaves || 0,
      halfDayCount: (slip.halfPaidDays || 0) + (slip.halfUnpaidDays || 0),
      weeklyOffDays: slip.weeklyOffDays || 0,
      lopDays: slip.unpaidLeaves || 0,
      attendancePercentage: slip.workingDays
        ? Math.round(((slip.payableDays || 0) / slip.workingDays) * 100) : 0,
    },
  };
};

const streamSalarySlipPdf = (res, { slip, employee, company }) => {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const filename = `salary-slip-${employee.employeeId}-${slip.periodKey || slip.month}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const cur = company.currencySymbol || 'Rs.';
  const money = (n) => `${cur} ${Number(n || 0).toLocaleString('en-IN')}`;
  const vm = toViewModel(slip);

  const monthLabel = (() => {
    try {
      const [y, m] = slip.month.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    } catch { return slip.month; }
  })();

  // The payroll cycle is still date-range based internally; the visible
  // payslip shows only the simplified Month + Year (e.g. "May 2026").

  // ---- Top accent band ----
  doc.rect(0, 0, doc.page.width, 8).fill(NAVY);

  // ---- Header ----
  let y = 40;
  doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text(company.name || 'Company', PAGE.left, y);
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text(company.address || '', PAGE.left, doc.y + 2, { width: 300 });

  doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text('PAYSLIP', PAGE.left, y, { align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(TEXT)
    .text(monthLabel, PAGE.left, y + 28, { align: 'right' });
  if (slip.payslipNumber) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text(`Payslip No: ${slip.payslipNumber}`, PAGE.left, y + 44, { align: 'right' });
  }

  y = Math.max(doc.y, y + 60) + 6;
  doc.moveTo(PAGE.left, y).lineTo(PAGE.right, y).lineWidth(1.5).strokeColor(BORDER).stroke();
  y += 16;

  // ---- Section title helper ----
  const sectionTitle = (label, atY, x = PAGE.left, w = PAGE.width) => {
    doc.rect(x, atY, 4, 14).fill(BLUE);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
      .text(label.toUpperCase(), x + 10, atY + 1, { width: w - 10 });
    return atY + 22;
  };

  // ---- Employee details grid (2 pairs per row) ----
  y = sectionTitle('Employee Details', y);
  const details = [
    ['Employee Name', employee.name],
    ['Employee ID', employee.employeeId],
    ['Department', employee.department?.name || slip.departmentName || '-'],
    ['Designation', employee.designation?.title || slip.designationTitle || '-'],
    ['Joining Date', employee.joiningDate ? new Date(employee.joiningDate).toLocaleDateString('en-GB') : '-'],
    ['Bank Name', employee.bankName || slip.bankName || '-'],
    ['Account Number', employee.bankAccount || slip.bankAccount || '-'],
    ['UAN / PF Number', employee.uanNumber || slip.uanNumber || '-'],
  ];
  const colW = PAGE.width / 2;
  const rowH = 22;
  for (let i = 0; i < details.length; i += 2) {
    const rowY = y + (i / 2) * rowH;
    [details[i], details[i + 1]].forEach((pair, idx) => {
      if (!pair) return;
      const cx = PAGE.left + idx * colW;
      doc.rect(cx, rowY, colW, rowH).lineWidth(0.5).strokeColor(CELL_BORDER).stroke();
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(pair[0], cx + 8, rowY + 6, { width: colW * 0.42 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TEXT)
        .text(String(pair[1] || '-'), cx + colW * 0.42, rowY + 6, { width: colW * 0.56 - 8 });
    });
  }
  y += Math.ceil(details.length / 2) * rowH + 16;

  // ---- Attendance table ----
  y = sectionTitle('Attendance', y);
  const att = vm.attendance;
  // Phase 31.3: include Month Days / Absent / Payable Days / Holiday
  // Worked / Per Day Salary in the slip's Attendance table so the
  // standardised breakdown is visible directly on the PDF.
  const attCols = [
    ['Month Days',   slip.monthDays ?? att.monthDays ?? att.totalDays ?? '-'],
    ['Present',      att.presentDays ?? slip.presentDays ?? 0],
    ['Absent',       slip.absentDays ?? 0],
    ['Approved Lv',  (slip.paidLeaves ?? 0) + (slip.unpaidLeaves ?? 0)],
    ['Holiday Wk.',  slip.holidayWorkedDays ?? att.holidayWorkedDays ?? 0],
    ['Payable Days', slip.payableDays ?? 0],
    ['Per Day ₹',    Math.round(slip.perDaySalary || 0)],
    ['Attendance %', `${att.attendancePercentage ?? 0}%`],
  ];
  const aCellW = PAGE.width / attCols.length;
  // header row
  doc.rect(PAGE.left, y, PAGE.width, 20).fill(HEAD_BG);
  attCols.forEach((c, i) => {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY)
      .text(c[0], PAGE.left + i * aCellW, y + 6, { width: aCellW, align: 'center' });
  });
  // value row
  const avY = y + 20;
  doc.rect(PAGE.left, avY, PAGE.width, 22).lineWidth(0.5).strokeColor(CELL_BORDER).stroke();
  attCols.forEach((c, i) => {
    const cx = PAGE.left + i * aCellW;
    if (i > 0) doc.moveTo(cx, avY).lineTo(cx, avY + 22).lineWidth(0.5).strokeColor(CELL_BORDER).stroke();
    doc.font('Helvetica-Bold').fontSize(11).fillColor(TEXT)
      .text(String(c[1]), cx, avY + 6, { width: aCellW, align: 'center' });
  });
  y = avY + 22 + 18;

  // ---- Split earnings / deductions ----
  const gap = 20;
  const blockW = (PAGE.width - gap) / 2;
  const leftX = PAGE.left;
  const rightX = PAGE.left + blockW + gap;

  const finTable = (x, atY, title, rows, totalLabel, totalVal, totalColor) => {
    let ty = sectionTitle(title, atY, x, blockW);
    // header
    doc.rect(x, ty, blockW, 18).fill(HEAD_BG);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text('Component', x + 8, ty + 5);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text('Amount', x, ty + 5, { width: blockW - 8, align: 'right' });
    ty += 18;
    rows.forEach((r) => {
      doc.rect(x, ty, blockW, 18).lineWidth(0.5).strokeColor(CELL_BORDER).stroke();
      doc.font('Helvetica').fontSize(9).fillColor(TEXT).text(r[0], x + 8, ty + 5, { width: blockW * 0.6 });
      doc.font('Helvetica').fontSize(9).fillColor(TEXT).text(money(r[1]), x, ty + 5, { width: blockW - 8, align: 'right' });
      ty += 18;
    });
    // total
    doc.rect(x, ty, blockW, 20).fill('#eef2f7');
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(totalColor || NAVY).text(totalLabel, x + 8, ty + 6, { width: blockW * 0.6 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(totalColor || NAVY).text(money(totalVal), x, ty + 6, { width: blockW - 8, align: 'right' });
    return ty + 20;
  };

  const e = vm.earnings;
  // Label swap (UI-only):
  //   "Bonus"                  <- e.special      (DB: salaryStructure.specialAllowance)
  //   "Special Allowance"      <- e.bonus        (DB: salaryStructure.bonus)
  //   "Additional Compensation" <- e.incentives   (DB: salarySlip.bonuses / bonusItems)
  // Values, math, and the gross total are unchanged.
  const earningRows = [
    ['Basic Salary', e.basic],
    ['HRA', e.hra],
    ['Conveyance', e.conveyance],
    ['Medical Allowance', e.medical],
    ['Bonus', e.special],
    ['Other Allowances', e.other],
    ['Special Allowance', e.bonus],
    ['Additional Compensation', e.incentives ?? e.bonuses],
  ].filter((r) => r[1]); // hide zero rows for a clean look
  if (earningRows.length === 0) earningRows.push(['Basic Salary', e.basic]);

  const d = vm.deductions;
  const deductionRows = [
    ['PF (EPF)', d.pf],
    ['ESIC', d.esic],
    ['Professional Tax', d.pt],
    ['Income Tax (TDS)', d.tds],
    ['Half-Day Deduction', d.halfDay],
    ['Unpaid Leave Deduction', d.unpaidLeave],
    ['Absent Deduction', d.attendance],
    ['Penalties / Other', d.penalties],
  ].filter((r) => r[1]);
  if (deductionRows.length === 0) deductionRows.push(['Total Deductions', 0]);

  const yL = finTable(leftX, y, 'Earnings', earningRows, 'Gross Total', e.grossEarnings, '#15803d');
  const yR = finTable(rightX, y, 'Deductions', deductionRows, 'Total Deductions', d.totalDeductions, '#b91c1c');
  y = Math.max(yL, yR) + 18;

  // ---- Employer contributions + CTC (CTC items - do not reduce net) ----
  const emp = vm.employer || { pf: 0, esic: 0, total: 0 };
  const ctc = vm.ctc || { monthly: 0, annual: 0 };
  if (emp.total || ctc.monthly) {
    y = sectionTitle('Employer Contributions & CTC', y);
    const empCols = [
      ['Employer PF', money(emp.pf)],
      ['Employer ESIC', money(emp.esic)],
      ['Employer Total', money(emp.total)],
      ['Monthly CTC', money(ctc.monthly)],
      ['Annual CTC', money(ctc.annual)],
    ];
    const ecW = PAGE.width / empCols.length;
    doc.rect(PAGE.left, y, PAGE.width, 18).fill(HEAD_BG);
    empCols.forEach((c, i) => doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY)
      .text(c[0], PAGE.left + i * ecW, y + 5, { width: ecW, align: 'center' }));
    const evY = y + 18;
    doc.rect(PAGE.left, evY, PAGE.width, 20).lineWidth(0.5).strokeColor(CELL_BORDER).stroke();
    empCols.forEach((c, i) => {
      const cx = PAGE.left + i * ecW;
      if (i > 0) doc.moveTo(cx, evY).lineTo(cx, evY + 20).lineWidth(0.5).strokeColor(CELL_BORDER).stroke();
      doc.font('Helvetica-Bold').fontSize(9).fillColor(TEXT).text(c[1], cx, evY + 6, { width: ecW, align: 'center' });
    });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text('Employer contributions are part of CTC and do not reduce net pay.', PAGE.left, evY + 24, { width: PAGE.width });
    y = evY + 20 + 18;
  }

  // ---- Net salary box ----
  const boxH = 56;
  doc.rect(PAGE.left, y, PAGE.width, boxH).fill(NAVY);
  doc.rect(PAGE.left, y, 6, boxH).fill(NAVY2);
  doc.font('Helvetica').fontSize(11).fillColor('#cbd5e1').text('NET SALARY PAYABLE', PAGE.left + 20, y + 14);
  doc.font('Helvetica').fontSize(8).fillColor('#94a3b8').text('Total CTC minus Total Employee Deductions', PAGE.left + 20, y + 32);
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff')
    .text(money(vm.netPayable), PAGE.left, y + 16, { width: PAGE.width - 20, align: 'right' });
  y += boxH + 20;

  // ---- Footer note ----
  // Sits BELOW the blue net-salary box (uses the tracked `y`, not the text
  // cursor, so it can never overlap the box).  Black, left-aligned.
  doc.font('Helvetica').fontSize(8.5).fillColor('#000000')
    .text('This is a computer-generated payslip and does not require a signature.',
      PAGE.left, y, { width: PAGE.width, align: 'left' });

  doc.end();
};

module.exports = { streamSalarySlipPdf };
