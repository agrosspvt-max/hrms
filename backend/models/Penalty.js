const mongoose = require('mongoose');

/**
 * Penalty  --  Phase 61 Performance Penalty Engine.
 *
 * Penalties are STORED SEPARATELY from earned marks.  We never
 * overwrite a submission's `earnedPoints` or `workEarnedPoints`.
 * Instead, every enforcement rule creates its own Penalty document
 * that references (a) the employee, (b) an optional target date /
 * submission, and (c) the penalty marks it wants to subtract.
 *
 * Final Marks (per submission or per day) are derived on read as:
 *
 *   Final = max(0, Earned  −  Σ active penalties on that record)
 *
 * Because every penalty is a separate document, removing one
 * automatically restores the original earned score -- no historical
 * mutation ever happens.
 *
 * ---------------------------------------------------------------
 * Categories of penalty
 * ---------------------------------------------------------------
 *   absent_submission    - present + assigned template + no submit.
 *                          Created day-after by the daily engine.
 *   dependency_pending   - a dependency task has been Pending for 3+
 *                          consecutive days.  Renewed every day the
 *                          dependency is still open.
 *   attendance_manual    - HR flipped Absent -> Present on a day
 *                          with no submission and picked
 *                          'Performance Penalty' (Option A).
 *   critical_threshold   - a Critical task fell below its threshold.
 *   repeated_missing     - repeated missing-submission pattern.
 *   manual_marks         - HR-created ad-hoc marks penalty
 *                          (with optional grace period).
 *   manual_completion    - HR-created Completion % penalty
 *                          (with duration; auto-expires).
 *
 * ---------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------
 *   pending    -- created but effectiveDate is in the future
 *                 (e.g. grace-period manual penalty).  Does NOT
 *                 affect Final Marks yet.
 *   scheduled  -- alias of `pending` for manual penalties awaiting
 *                 grace-period expiry; kept so the UI can label
 *                 automatic vs. manual future-dated penalties.
 *   active     -- currently effective; subtracts from Final Marks.
 *   resolved   -- the underlying condition was fixed (e.g. the
 *                 employee completed the missing submission).  Does
 *                 NOT affect Final Marks anymore.
 *   cancelled  -- HR removed it before it took effect.
 *   expired    -- its effective window ended (used by
 *                 Completion Score penalties with a duration).
 *
 * ---------------------------------------------------------------
 * Field guide
 * ---------------------------------------------------------------
 *   penaltyMarks       -- Marks to subtract when applied to
 *                         `submission` on `targetDate`.  For
 *                         completion-% penalties this is the
 *                         percentage-point drop instead.
 *   completionPercent  -- Present only on manual_completion.
 *   probable           -- true when this is a WARNING record shown
 *                         in "Probable Penalties" but not yet
 *                         enforced.  Only automatic engines set
 *                         probable=true; manual penalties never do.
 *   acknowledgedAt     -- Employee saw the dashboard warning.
 *   ---
 * The (employee, category, targetDate, submission) tuple is
 * effectively the natural key for auto-generated records so the
 * daily job is idempotent.  We enforce that with a partial unique
 * index further down.
 */
const penaltySchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Category -- see comment above.  Extendable enum. */
    category: {
      type: String,
      enum: [
        'absent_submission',
        'dependency_pending',
        'attendance_manual',
        'critical_threshold',
        'repeated_missing',
        'manual_marks',
        'manual_completion',
        // Phase 64 -- new categories.
        'missed_submission',   // Part 2: day-after auto-detected miss.
        'performance_lock',    // Part 3: overdue pending task lock.
        'completion_adjustment', // Part 5: rename of manual_completion.
        'marks_adjustment',    // Part 4: HR-classified manual marks tweak.
        // Phase 65 -- HR-created ₹ fine.  Never affects marks or
        // completion %; may be optionally deducted from salary.
        'financial_penalty',
      ],
      required: true,
      index: true,
    },

    /** Automatic engines flip this so the UI can group cleanly. */
    source: { type: String, enum: ['automatic', 'manual'], default: 'automatic', index: true },

    /** Warning-only?  When true this record shows under
     *  "Probable Penalties" and does NOT deduct Final Marks. */
    probable: { type: Boolean, default: false, index: true },

    /**
     * Status lifecycle -- see comment above.
     */
    status: {
      type: String,
      enum: ['pending', 'scheduled', 'active', 'resolved', 'cancelled', 'expired'],
      default: 'active',
      index: true,
    },

    /* -------- Marks / effect payload -------- */
    /** Marks to subtract on the target submission. */
    penaltyMarks: { type: Number, default: 0, min: 0 },
    /** Percentage-point drop for manual_completion penalties. */
    completionPercent: { type: Number, default: 0, min: 0 },

    /* -------- Targeting -------- */
    /** UTC midnight of the day the penalty applies to. */
    targetDate: { type: Date, index: true },
    /** Optional back-link -- filled when the penalty is tied to
     *  a specific submission's earned/available marks. */
    submission: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', index: true, default: null },
    /** For dependency_pending: which DependencyTasks triggered it. */
    dependencyIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },

    /* -------- Timing -------- */
    /** When the penalty becomes active (== createdAt for most). */
    effectiveDate: { type: Date, default: Date.now, index: true },
    /** When the penalty ceases (Completion Score penalties + grace
     *  period penalties both set this). */
    expiryDate: { type: Date, default: null, index: true },
    /** When the underlying condition was cleared. */
    resolvedAt: { type: Date, default: null },

    /* -------- Provenance -------- */
    /** Human-readable rule label -- 'submission_missing_v1',
     *  'dependency_3day_v1', etc. -- so we can evolve rules while
     *  keeping older penalties tagged with the version that made them. */
    rule: { type: String, default: '', trim: true },
    /** Free-text reason for the audit + employee-facing message. */
    reason: { type: String, default: '', trim: true },
    /** Who created it (User for manual, null for automatic). */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** Who cancelled / removed it. */
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '', trim: true },
    // Phase 64.1 Item 3 -- who resolved / who restored the marks.
    // resolvedBy fires when a performance_lock auto-clears OR when
    // HR marks the underlying condition resolved.  restoredBy fires
    // when HR restores the day's marks via a 'restore' evaluationMode.
    resolvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    restoredBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    restorationReason: { type: String, default: '', trim: true },
    /**
     * Phase 64.2 Item 2 -- when HR runs a 'restore' evaluation mode,
     * `penaltyMarks` drops to 0 so it stops deducting; the ORIGINAL
     * amount is preserved here so the audit trail can always answer
     * "how much was restored?".  `restoredMarks` never mutates after
     * the first restoration.  For 'information' / 'neutral' modes
     * this stays 0 because those modes don't restore anything.
     */
    restoredMarks:            { type: Number, default: 0, min: 0 },
    /** The Final Marks value the submission had BEFORE the restore. */
    restoredFromFinalMarks:   { type: Number, default: 0 },
    /** The Final Marks value the submission has AFTER the restore. */
    restoredToFinalMarks:     { type: Number, default: 0 },

    /* -------- Employee-facing -------- */
    /** True after the employee's dashboard warning was opened. */
    acknowledgedAt: { type: Date, default: null },
    /** Phase 64 -- Employee can Dismiss the notification (hides it
     *  from the dashboard).  Does NOT restore marks or resolve the
     *  underlying penalty.  Separate from acknowledgedAt because
     *  Dismiss is a stronger UX action ("stop bothering me"). */
    dismissedByEmployeeAt: { type: Date, default: null },
    /** Message text stored so we can display exactly the same
     *  wording later (audit + history). */
    employeeMessage: { type: String, default: '', trim: true },

    /* -------- Phase 64 -- Missed-Submission / Performance-Lock recovery -------- */
    /**
     * When the employee raises a Request Reopening (Part 2), the
     * details live here.  HR then decides.  Approve => the day's
     * submission gets reopened AND HR picks one of the three
     * evaluation modes below.  Reject => request goes to
     * decision='rejected' and the penalty stays in place.
     */
    reopenRequest: {
      requested:     { type: Boolean, default: false },
      reason:        { type: String,  default: '', trim: true },
      requestedAt:   { type: Date,    default: null },
      // Phase 64.1 Item 7 -- full lifecycle:
      //   pending    -> employee submitted, HR hasn't decided.
      //   approved   -> HR approved but employee hasn't re-submitted.
      //   rejected   -> HR rejected.
      //   completed  -> employee re-submitted after approval.
      //   cancelled  -> employee (or HR on employee's behalf) cancelled
      //                 the request before HR decided.
      decision:      { type: String,  enum: ['pending', 'approved', 'rejected', 'completed', 'cancelled', ''], default: '' },
      decidedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      decidedAt:     { type: Date,    default: null },
      decisionNote:  { type: String,  default: '', trim: true },
      completedAt:   { type: Date,    default: null },
    },
    /**
     * HR chooses ONE of three evaluation modes after approving a
     * reopen request OR when restoring a Performance Lock period.
     * The rules per mode are documented in penaltyMath:
     *   restore     -- Marks restored (penalty resolved).
     *   information -- Analytics values in, marks stay 0.
     *   neutral     -- Day is ignored (Available=Earned=Final=0).
     */
    evaluationMode: {
      type: String,
      enum: ['', 'restore', 'information', 'neutral'],
      default: '',
    },

    /* -------- Phase 64 -- Performance Lock link -------- */
    /**
     * For category='performance_lock' rows, the specific overdue
     * pending task that triggered the lock.  Format:
     *   { submissionId, taskId }
     * Stored as an ObjectId + subId pair rather than a hard ref so a
     * submission delete doesn't cascade weirdly.
     */
    overdueRef: {
      submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', default: null },
      taskId:       { type: mongoose.Schema.Types.ObjectId, default: null },
      taskTitle:    { type: String, default: '' },
      pendingSince: { type: Date, default: null },
      resolveBy:    { type: Date, default: null },
    },

    /* -------- Phase 65 -- Financial Penalty -------- */
    /**
     * Amount in ₹.  Only meaningful when category === 'financial_penalty'.
     * Never contributes to Final Marks; may be optionally deducted
     * from a future salary slip (see salary integration).
     */
    amount:  { type: Number, default: 0, min: 0 },
    /** Optional due date shown to the employee.  Informational; the
     *  penalty stays 'active' until HR resolves / waives / deducts. */
    dueDate: { type: Date,   default: null },
    /** Financial-penalty lifecycle beyond the standard status field:
     *   pending      -- created, HR hasn't acted (status='active').
     *   deducted     -- HR included it in a salary slip (see below).
     *   waived       -- HR explicitly wrote it off (no salary impact).
     *   resolved     -- HR marked it resolved by other means.
     *   paid         -- reserved for future direct-pay workflow.
     * Stored as its own field so the standard Penalty `status` enum
     * stays clean; a `deducted` financial penalty is Penalty.status
     * === 'resolved' with financialStatus === 'deducted'.
     */
    financialStatus: {
      type: String,
      enum: ['pending', 'deducted', 'waived', 'resolved', 'paid', ''],
      default: '',
    },
    /** Set when the penalty was included in a generated salary slip.
     *  These fields make double-deduction impossible: the salary
     *  generator filters on `financialStatus: 'pending'` only. */
    deductedInSalaryMonth: { type: String, default: '' },      // 'YYYY-MM'
    deductedBy:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    deductedAt:            { type: Date, default: null },
    salarySlipId:          { type: mongoose.Schema.Types.ObjectId, ref: 'SalarySlip', default: null },

    /* -------- Phase 64 -- Completion Score Adjustment (Part 5) -------- */
    /**
     * For category='completion_adjustment' rows the adjustment
     * applies whenever a Performance Analytics query overlaps this
     * window.  Both dates must be in the past at creation time; the
     * controller enforces that.  No auto-expiry -- adjustment lives
     * forever unless HR cancels.  Multiple overlapping adjustments
     * stack additively (spec: -3% + -5% = -8%).
     */
    evaluationPeriod: {
      startDate: { type: Date, default: null },
      endDate:   { type: Date, default: null },
    },
  },
  { timestamps: true }
);

/* -----------------------------------------------------------------
 * Partial unique index so the automatic daily engines are
 * idempotent: re-running the same day never creates duplicate
 * absent_submission or dependency_pending penalties for the same
 * (employee, category, targetDate, submission) tuple.
 * ----------------------------------------------------------------- */
penaltySchema.index(
  { employee: 1, category: 1, targetDate: 1, submission: 1 },
  {
    unique: true,
    partialFilterExpression: {
      source: 'automatic',
      probable: false,
    },
    name: 'penalty_auto_dedupe',
  }
);

/**
 * Verification-audit fix -- probable (warning) records were not
 * covered by the dedupe index above (the partial filter required
 * probable === false).  Under load, two concurrent probable-sweep
 * calls could each observe "no existing warning" and insert twice.
 * A second partial-unique index covers the probable side using the
 * same natural key.
 */
penaltySchema.index(
  { employee: 1, category: 1, targetDate: 1, submission: 1 },
  {
    unique: true,
    partialFilterExpression: {
      source: 'automatic',
      probable: true,
    },
    name: 'penalty_probable_dedupe',
  }
);

/** Fast lookup of every penalty that hits a given submission. */
penaltySchema.index({ submission: 1, status: 1 });

/** Fast "what's active for this employee" query. */
penaltySchema.index({ employee: 1, status: 1, effectiveDate: -1 });

module.exports = mongoose.model('Penalty', penaltySchema);
