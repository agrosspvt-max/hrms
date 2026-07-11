const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * User model - represents both HR/Admin and Employee users.
 *
 * Leave balances are denormalised here for fast reads on the employee
 * dashboard.  The HR can re-configure them at any time.
 */
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    employeeId: { type: String, required: true, unique: true, index: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: { type: String, trim: true },
    password: { type: String, required: true, minlength: 6, select: false },

    role: {
      type: String,
      enum: ['super_admin', 'hr', 'employee'],
      default: 'employee',
      index: true,
    },

    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    designation: { type: mongoose.Schema.Types.ObjectId, ref: 'Designation' },

    // ---- HOD (Head of Department) ----
    // A HOD is fundamentally an EMPLOYEE account (role stays 'employee')
    // with extra department-level supervisory permissions granted by HR.
    // HOD is never above HR; HR remains the final authority.
    isHOD: { type: Boolean, default: false, index: true },
    // The department this user heads (only meaningful when isHOD).
    hodDepartment: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    // Fine-grained powers HR enables for this HOD.
    hodPermissions: {
      canReview: { type: Boolean, default: false },   // can open & review dept submissions
      canRemark: { type: Boolean, default: false },   // can add remarks
      canMarks: { type: Boolean, default: false },    // can give marks (recommendation)
      canRecommend: { type: Boolean, default: false },// can recommend approval to HR
      // Phase 59 -- when true, the HOD can edit Custom Assignment
      // submission values (Number Completed/OutOf, Status, Dropdown
      // choice) for employees IN THEIR OWN DEPARTMENT.  The edit
      // endpoint re-clamps the department server-side; false leaves
      // the HOD in read/review mode.  HR + Super Admin bypass.
      canEditSubmissions: { type: Boolean, default: false },
    },

    // Per-employee review routing.  'direct_hr' = current behaviour
    // (submissions go straight to HR).  'hod_first' = department HOD
    // reviews first, then HR finalises.
    reviewFlow: {
      type: String,
      enum: ['direct_hr', 'hod_first'],
      default: 'direct_hr',
      index: true,
    },

    /* ====================================================================
     * Phase 43 — Feature Permissions
     *
     * Per-employee feature access map.  Lets HR / Super Admin grant
     * specific modules + sub-permissions to individual employees
     * without promoting them to HR / Super Admin.  The map is a free-
     * form Mixed payload so new modules can be added without schema
     * migrations.  Shape:
     *
     *   featurePermissions: {
     *     <moduleKey>: {
     *       enabled: Boolean,             // module visible / accessible
     *       level: 'view'|'edit'|'full',  // access level (when needed)
     *       sub: { ... }                  // sub-permission map (e.g.
     *                                     // { dealers: { view, create,
     *                                     //   edit, delete }, ... })
     *       allowedTemplateIds: [String]  // template-analytics scope
     *     }
     *   }
     *
     * Semantics:
     *   - HR / Super Admin bypass all featurePermissions checks
     *     (existing behaviour preserved).
     *   - HOD-only modules continue to gate on isHOD; featurePermissions
     *     can layer additional employee-level grants on top, but never
     *     downgrade an existing role.
     *   - Employees with no featurePermissions set keep their default
     *     employee surface unchanged.
     * ================================================================== */
    featurePermissions: { type: mongoose.Schema.Types.Mixed, default: {} },
    featurePermissionsUpdatedAt: { type: Date },
    featurePermissionsUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // monthlySalary is the IN-HAND (net) amount the employee actually
    // takes home each month.  All daily-rate / salary-slip math is
    // derived from this value (perDay = monthlySalary / workingDays).
    monthlySalary: { type: Number, default: 0, min: 0 },

    // Salary structure used to build enterprise payslips.  Legacy fields
    // (ctc / grossSalary / pf) are retained for backward compatibility;
    // the new component + statutory fields drive the upgraded payroll.
    salaryStructure: {
      // ---- Legacy (kept so old data + old code keep working) ----
      ctc: { type: Number, default: 0 },          // == annualCTC
      grossSalary: { type: Number, default: 0 },  // == monthlyGross
      pf: { type: Number, default: 0 },           // legacy fixed PF amount

      // ---- Headline figures ----
      annualCTC: { type: Number, default: 0 },
      monthlyGross: { type: Number, default: 0 },

      // ---- Earning components (monthly, full) ----
      basicSalary: { type: Number, default: 0 },
      hra: { type: Number, default: 0 },
      conveyance: { type: Number, default: 0 },
      medicalAllowance: { type: Number, default: 0 },
      specialAllowance: { type: Number, default: 0 },
      otherAllowance: { type: Number, default: 0 },
      bonus: { type: Number, default: 0 }, // fixed monthly bonus (part of gross)

      // ---- Provident Fund (EPF) ----
      // Employee PF deducts from BASIC only.  Employer PF is a separate CTC
      // component and never reduces the employee's net.
      pfEnabled: { type: Boolean, default: false },
      pfPercentage: { type: Number, default: 12 },          // employee % of basic
      pfAmount: { type: Number, default: 0 },               // explicit override (optional)
      employerPfPercentage: { type: Number, default: 13 },  // employer % of basic (incl. EPS/admin)

      // ---- Employee State Insurance (% of GROSS) ----
      esicEnabled: { type: Boolean, default: false },
      esicPercentage: { type: Number, default: 0.75 },        // employee % of gross
      esicAmount: { type: Number, default: 0 },
      employerEsicPercentage: { type: Number, default: 3.25 }, // employer % of gross

      // ---- Professional Tax (fixed) ----
      ptEnabled: { type: Boolean, default: false },
      ptAmount: { type: Number, default: 200 },

      // ---- TDS / Income Tax ----
      tdsEnabled: { type: Boolean, default: false },
      tdsType: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
      tdsValue: { type: Number, default: 0 },  // % when percentage, amount when fixed
      tdsAmount: { type: Number, default: 0 },

      // ---- Cached config-time totals (informational; payslip recomputes) ----
      totalDeductions: { type: Number, default: 0 },
      netSalary: { type: Number, default: 0 },
    },

    // Payout details shown on the payslip (optional).
    bankName: { type: String, default: '', trim: true },
    bankAccount: { type: String, default: '', trim: true },
    uanNumber: { type: String, default: '', trim: true },  // UAN / PF number
    panNumber: { type: String, default: '', trim: true },

    // Date of birth - optional; powers automatic birthday events without
    // requiring HR to maintain them manually.
    dateOfBirth: { type: Date },

    joiningDate: { type: Date, default: Date.now },

    // Set on every successful login.  Powers the "Last login" column in
    // the Super Admin → Manage Access table.
    lastLoginAt: { type: Date },
    // Who created this account (Super Admin who added it).  Filled by the
    // create endpoint; legacy seed users have this null.
    createdByUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },

    // Leave configuration
    leaveBalance: {
      yearlyAllowance: { type: Number, default: 12 }, // total annual paid leaves
      monthlyAllowance: { type: Number, default: 2 }, // optional monthly cap
      used: { type: Number, default: 0 },             // used in current period
      resetDate: { type: Date, default: () => new Date(new Date().getFullYear(), 0, 1) },
    },

    // Configurable weekly offs - array of weekday numbers (0=Sun .. 6=Sat)
    weeklyOff: { type: [Number], default: [0] },

    /* ====================================================================
     * Phase 29 — Attendance mode (per-employee)
     *
     * Decouples attendance from work submissions for employees whose role
     * doesn't carry daily templates (HR, Accounts, Admin, Directors, etc.).
     *
     *   submission_based   (default) — current behaviour: a submitted work
     *                        record on a working day flips attendance to
     *                        Present; no submission = Absent.
     *   attendance_review  — employee files a lightweight Attendance
     *                        Confirmation each working day; HR / Super
     *                        Admin reviews it (Approve Present / Mark
     *                        Absent / Mark Half Day / Mark Leave) and the
     *                        outcome becomes the finalised attendance for
     *                        that day.
     *   auto_attendance    — every working day automatically counts as
     *                        Present.  Reserved for senior leadership.
     *
     * Leaves, holidays and weekly offs are honoured by every mode the
     * same way they were before this field existed.
     * ================================================================== */
    attendanceMode: {
      type: String,
      enum: ['submission_based', 'attendance_review', 'auto_attendance'],
      default: 'submission_based',
      index: true,
    },
    attendanceModeUpdatedAt: { type: Date },
    attendanceModeUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // ---- Role / job context (employee management dashboard) ----
    jobDescription: { type: String, default: '' },
    scopeOfWork: { type: String, default: '' },
    responsibilities: { type: String, default: '' },
    reportingManager: { type: String, default: '' },
    kpiNotes: { type: String, default: '' },

    // Salary increment history (informational; salaryStructure stays the
    // source of truth for payslips).
    salaryIncrements: {
      type: [
        new mongoose.Schema(
          {
            date: { type: Date, default: Date.now },
            previousGross: { type: Number, default: 0 },
            newGross: { type: Number, default: 0 },
            note: { type: String, default: '' },
            by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          },
          { _id: true }
        ),
      ],
      default: [],
    },
    lastIncrementDate: { type: Date },

    // Per-user favorite contacts (user-specific — one person's favorites
    // never affect another's).  Just an array of Contact ids; the directory
    // resolves them on demand.
    favoriteContacts: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }],
      default: [],
    },
  },
  { timestamps: true }
);

// Hash password on save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare a plain-text password against the stored hash
userSchema.methods.matchPassword = async function (entered) {
  return bcrypt.compare(entered, this.password);
};

// Convenience: remaining leaves
userSchema.virtual('leavesRemaining').get(function () {
  const allowance = this.leaveBalance?.yearlyAllowance || 0;
  const used = this.leaveBalance?.used || 0;
  return Math.max(allowance - used, 0);
});

userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('User', userSchema);
