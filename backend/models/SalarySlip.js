const mongoose = require('mongoose');

/**
 * A single bonus or deduction line item.  Salary slips can carry as many
 * of these as HR needs, each with its own note - e.g. "Diwali bonus",
 * "Late attendance fine", "Equipment recovery".
 */
const adjustmentItemSchema = new mongoose.Schema(
  {
    amount: { type: Number, default: 0, min: 0 },
    note: { type: String, default: '', trim: true },
  },
  { _id: true }
);

const salarySlipSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Denormalised employee identity at slip-generation time, so a slip
    // always renders correctly even if the user is later deleted or
    // renamed.  Populated automatically by computeSlip().
    employeeName: { type: String, default: '' },
    employeeEmpId: { type: String, default: '' },
    employeeEmail: { type: String, default: '' },

    // Month is stored as a YYYY-MM string (derived from the period start)
    // for easy sorting & legacy display.  No longer the uniqueness key.
    month: { type: String, required: true, index: true }, // '2026-05'
    year: { type: Number, required: true, index: true },
    monthNumber: { type: Number, required: true, min: 1, max: 12 },

    // ---- Payroll period (custom date-range cycle) ----
    // periodStart / periodEnd are inclusive UTC-midnight dates.  periodKey
    // ('YYYY-MM-DD_YYYY-MM-DD') is the uniqueness key per employee, so HR
    // can run any custom cycle (e.g. 15 May -> 14 Jun) and re-running the
    // same range updates the slip in place.
    periodStart: { type: Date, index: true },
    periodEnd: { type: Date },
    periodKey: { type: String, index: true }, // '2026-05-01_2026-05-31'

    workingDays: { type: Number, default: 0 },
    presentDays: { type: Number, default: 0 },
    paidLeaves: { type: Number, default: 0 },
    unpaidLeaves: { type: Number, default: 0 },
    absentDays: { type: Number, default: 0 },
    weeklyOffDays: { type: Number, default: 0 },
    holidayDays: { type: Number, default: 0 },
    // Half-day accounting (decimals supported elsewhere; counts are day units)
    halfPaidDays: { type: Number, default: 0 },
    halfUnpaidDays: { type: Number, default: 0 },
    // Total paid day-units used for gross pay (present + paid leaves +
    // half_paid + 0.5*half_unpaid).
    payableDays: { type: Number, default: 0 },
    // Phase 31.2 -- standardized payroll rule.
    //   monthDays         = total calendar days in the payroll period
    //                        (perDay rate divisor; Sundays + holidays
    //                        ARE included so each calendar day is
    //                        equally weighted).
    //   holidayWorkedDays = days where the employee submitted work on a
    //                        weekly-off or holiday day; each such day
    //                        adds one extra payable-day credit.
    monthDays: { type: Number, default: 0 },
    holidayWorkedDays: { type: Number, default: 0 },

    completionPercentage: { type: Number, default: 0 },
    backlogCount: { type: Number, default: 0 },

    monthlySalary: { type: Number, default: 0 }, // in-hand (basis for daily rate)
    perDaySalary: { type: Number, default: 0 },
    grossSalary: { type: Number, default: 0 },   // earned for the month (per-day * paid days)

    // Snapshot of the employee's salary structure at the time this slip
    // was generated.  Used for display only.  Mixed-type so it can hold
    // both the legacy {ctc,grossSalary,pf} and the full enterprise
    // structure without a rigid sub-schema.
    salaryStructure: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ ctc: 0, grossSalary: 0, pf: 0 }),
    },

    // Denormalised payout details for the payslip.
    bankName: { type: String, default: '' },
    bankAccount: { type: String, default: '' },
    uanNumber: { type: String, default: '' },
    designationTitle: { type: String, default: '' },
    departmentName: { type: String, default: '' },
    joiningDate: { type: Date },

    // Full enterprise payroll breakdown computed by utils/payroll.js.
    // Optional: legacy slips generated before this upgrade won't have it,
    // and the PDF / UI fall back to the flat fields when it's absent.
    payroll: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    payslipNumber: { type: String, default: '' },

    // Itemised adjustments (source of truth from now on)
    bonusItems: { type: [adjustmentItemSchema], default: [] },
    deductionItems: { type: [adjustmentItemSchema], default: [] },

    // Cached numeric totals (auto-derived from the arrays above)
    bonuses: { type: Number, default: 0 },
    deductions: { type: Number, default: 0 },
    netSalary: { type: Number, default: 0 },

    // Legacy single-note fields, kept for backward compatibility but no
    // longer written by the UI.  New code uses bonusItems/deductionItems.
    bonusNote: { type: String, default: '' },
    deductionNote: { type: String, default: '' },

    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    /* Phase 32 -- soft-delete retraction.
     *
     *   active     - the live slip used by active payroll, exports,
     *                totals and reports.  Default for every newly
     *                generated slip (preserves backward compatibility
     *                with every existing record).
     *   retracted  - HR / Super Admin pulled the slip back.  Stays in
     *                the database + audit logs but is excluded from
     *                every active-payroll surface.  A fresh slip can
     *                be generated for the same (employee, periodKey)
     *                because the active scope check ignores retracted
     *                rows.
     *   paid      - reserved for future "marked as paid" workflow;
     *                schema accepts it now so the UI can render the
     *                blue badge without a follow-up migration.
     */
    status: {
      type: String,
      enum: ['active', 'retracted', 'paid'],
      default: 'active',
      index: true,
    },
    retractedAt:  { type: Date },
    retractedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    retractionReason: { type: String, default: '' },
  },
  { timestamps: true }
);

// Uniqueness is now per (employee, payroll period) instead of per month, so
// multiple custom cycles can coexist.  The month index stays (non-unique)
// for sorting / legacy filters.  Indexes are built explicitly on startup
// (after backfilling periodKey on legacy slips) - see server.js - so we
// disable autoIndex here to avoid a unique-index build racing the backfill.
salarySlipSchema.set('autoIndex', false);
salarySlipSchema.index({ employee: 1, periodKey: 1 }, { unique: true });
salarySlipSchema.index({ employee: 1, month: 1 });

module.exports = mongoose.model('SalarySlip', salarySlipSchema);
