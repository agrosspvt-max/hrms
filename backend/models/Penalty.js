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

    /* -------- Employee-facing -------- */
    /** True after the employee's dashboard warning was opened. */
    acknowledgedAt: { type: Date, default: null },
    /** Message text stored so we can display exactly the same
     *  wording later (audit + history). */
    employeeMessage: { type: String, default: '', trim: true },
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
