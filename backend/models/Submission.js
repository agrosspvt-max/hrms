const mongoose = require('mongoose');

/**
 * A Submission represents the per-day work record for one employee
 * for ONE assigned template.  Tasks are embedded so that we can keep
 * per-day status without ballooning the document count.
 *
 * Status semantics:
 *   - done                -> earned += pts, total += pts
 *   - pending             -> total += pts, becomes backlog
 *   - work_not_available  -> not counted at all
 *
 * Backlog tasks live on the original submission until completed.
 * The dashboard query gathers all submissions with at least one
 * pending task that is older than today.
 */
/**
 * Reusable dependent/independent workflow fields, embedded on every
 * scorable unit (task, excel row, sheet score) so an employee can hand
 * their completed-but-blocked work to someone else.  All optional &
 * additive - when dependencyType stays 'independent' nothing changes and
 * the existing scoring / review pipelines are untouched.
 */
const dependencyFields = {
  dependencyType: {
    type: String,
    enum: ['independent', 'dependent'],
    default: 'independent',
  },
  dependencyAssignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dependencyAssignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dependencyRemark: { type: String, default: '' },
  dependencyCreatedAt: { type: Date },
  // Lifecycle of the linked dependency (mirrors DependencyTask.currentStatus)
  dependencyStatus: {
    type: String,
    enum: ['', 'open', 'in_progress', 'resolved'],
    default: '',
  },
  // Back-references to the created DependencyTask + its chain.
  dependencyTaskId: { type: mongoose.Schema.Types.ObjectId, ref: 'DependencyTask' },
  chainId: { type: String, default: '' },
};

const submissionTaskSchema = new mongoose.Schema(
  {
    taskId: { type: mongoose.Schema.Types.ObjectId },
    title: { type: String, required: true },
    points: { type: Number, default: 0 },
    status: {
      type: String,
      // 'ongoing' = work has been started and is actively in progress.
      // Operationally identical to 'done' (earns points, reviewable,
      // dependency-able) but reported separately in analytics; never
      // contributes to pendency.  Existing 'pending' alone still drives
      // pendency / backlog metrics.
      enum: ['pending_submit', 'done', 'ongoing', 'pending', 'work_not_available'],
      default: 'pending_submit',
    },
    pendingReason: { type: String, default: '' },
    pendingSince: { type: Date }, // first date the task became pending
    completedAt: { type: Date },  // when a backlog item is finally completed
    // Employee-added rows: the employee can append extra tasks they did
    // beyond the HR-defined template.  HR awards `awardedMarks` for each
    // during review; HR-defined rows leave `awardedMarks` at 0 and use
    // `points` directly.
    addedByEmployee: { type: Boolean, default: false },
    awardedMarks: { type: Number, default: 0 },
    ...dependencyFields,
  },
  { _id: true }
);

/**
 * One filled-in row of an excel-reporting template.  Stored verbatim
 * on the submission so the report stands on its own even if the
 * source template changes later.
 */
const excelResponseSchema = new mongoose.Schema(
  {
    fieldName: { type: String, required: true },
    fieldType: { type: String, default: 'text' },
    value: { type: mongoose.Schema.Types.Mixed, default: '' },
    markEligible: { type: Boolean, default: false },
    maxMarks: { type: Number, default: 0 },
    marksAwarded: { type: Number, default: 0 },
    // Optional per-row status (only when the template enables status tracking)
    rowStatus: {
      type: String,
      enum: ['', 'done', 'pending', 'work_not_available'],
      default: '',
    },
    ...dependencyFields,
  },
  { _id: true }
);

/**
 * Snapshot of an advanced spreadsheet ('sheet') report on the submission.
 * The full grid structure is copied from the template at creation time so
 * the report stands on its own.  Employees fill the editable cell values;
 * HR awards per-target marks (`scores[].marksAwarded`) during review.
 */
const submissionSheetCellSchema = new mongoose.Schema(
  {
    r: { type: Number, required: true },
    c: { type: Number, required: true },
    value: { type: mongoose.Schema.Types.Mixed, default: '' },
    role: { type: String, enum: ['label', 'static', 'input'], default: 'input' },
    fieldType: {
      type: String,
      enum: ['text', 'number', 'textarea', 'dropdown', 'date'],
      default: 'text',
    },
    editable: { type: Boolean, default: false },
    hidden: { type: Boolean, default: false },
    options: { type: [String], default: [] },
    merge: { rowspan: { type: Number }, colspan: { type: Number } },
    mergedInto: { r: { type: Number }, c: { type: Number } },
    // True for rows the employee appended while filling.
    addedByEmployee: { type: Boolean, default: false },
  },
  { _id: false }
);

const submissionSheetScoreSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    type: { type: String, enum: ['cell', 'row', 'column'], required: true },
    rowIndex: { type: Number },
    colIndex: { type: Number },
    label: { type: String, default: '' },
    maxMarks: { type: Number, default: 0, min: 0 },
    marksAwarded: { type: Number, default: 0, min: 0 },
    remark: { type: String, default: '' },
    // Snapshot of the template's per-row status-tracking flag, so the
    // employee UI + submit handler know which scored rows are task rows.
    statusTracking: { type: Boolean, default: false },
    // Optional per-row status (only when statusTracking is enabled)
    rowStatus: {
      type: String,
      enum: ['', 'done', 'pending', 'work_not_available'],
      default: '',
    },
    pendingReason: { type: String, default: '' },
    ...dependencyFields,
  },
  { _id: false }
);

const submissionSheetSchema = new mongoose.Schema(
  {
    sheetName: { type: String, default: 'Sheet1' },
    rowCount: { type: Number, default: 0 },
    colCount: { type: Number, default: 0 },
    columns: { type: [mongoose.Schema.Types.Mixed], default: [] },
    rows: { type: [mongoose.Schema.Types.Mixed], default: [] },
    cells: { type: [submissionSheetCellSchema], default: [] },
    scores: { type: [submissionSheetScoreSchema], default: [] },
    allowEmployeeAddRows: { type: Boolean, default: false },
  },
  { _id: false }
);

const submissionSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', required: true },
    assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' },

    // Cached at creation time so submit / review handlers don't have
    // to repopulate the template just to branch on type.
    templateType: {
      type: String,
      enum: ['task', 'excel', 'sheet', 'custom'],
      default: 'task',
      index: true,
    },

    // Custom kind cached from the template (e.g. 'calling') so analytics
    // can scope by domain without re-populating the template document.
    customKind: { type: String, default: '', index: true },

    // Recurrence info cached from the assignment at creation time so every
    // surface that shows a submission (dashboard, reviews, backlog) can
    // render a schedule tag without re-querying the assignment.
    frequency: {
      type: String,
      enum: ['one-time', 'daily', 'weekly', 'monthly'],
      default: 'daily',
    },
    scheduleLabel: { type: String, default: '' },

    // Set by the daily engine when this submission was generated through a
    // holiday/weekend override on the source assignment.  Drives the
    // "Holiday Override" / "Weekend Assignment" badge on the employee's
    // submission card so they know why work appeared on a non-working day.
    holidayOverride: { type: Boolean, default: false },
    overrideReason: { type: String, default: '' },

    // The day this submission belongs to (date-only, 00:00 UTC of that local day)
    date: { type: Date, required: true, index: true },

    tasks: { type: [submissionTaskSchema], default: [] },
    excelResponses: { type: [excelResponseSchema], default: [] },
    sheet: { type: submissionSheetSchema, default: undefined },

    /* ---- Custom-template responses ----
       Flat { key, value } pairs.  Auto fields are evaluated server-side
       at submit and stored alongside employee-entered values so analytics
       can read everything from one shape.  System-generated fields (e.g.
       yesterdayPending) are populated by the daily engine. */
    /* Phase 14: per-field status + remark live alongside the value so
       analytics can compute Done/Pending/W-N-A rates without a join.
       Legacy submissions { key, value } resolve too -- status defaults
       to '' (treated as "no status"), remark defaults to ''.
       status enum mirrors the task statuses so analytics math stays
       uniform across template kinds. */
    customResponses: {
      type: [new mongoose.Schema(
        {
          key:    { type: String, required: true },
          value:  { type: mongoose.Schema.Types.Mixed, default: '' },
          status: {
            type: String,
            enum: ['', 'done', 'ongoing', 'pending', 'work_not_available'],
            default: '',
          },
          remark: { type: String, default: '' },
          // Phase 58 — Number-task second value.  Only meaningful when
          // the template's field carries `enableOutOf: true`.  Legacy
          // rows leave this at 0.  Always coerced to a non-negative
          // number by the submit handler.
          outOfValue: { type: Number, default: 0 },
          // Phase 58 — per-response marks snapshot.  Computed at submit
          // time from the CURRENT template's marks config so historical
          // scoring is preserved even if HR later edits the template.
          availableMarks: { type: Number, default: 0 },
          earnedMarks:    { type: Number, default: 0 },
          penaltyMarks:   { type: Number, default: 0 },
        },
        { _id: false },
      )],
      default: [],
    },

    /* ---- Phase 58 — Custom-template marks totals ----
       Roll-up of the per-response marks numbers above.  Computed at
       submit time; zeroed on legacy submissions so they simply don't
       contribute to Marks Analytics.  Historical values are NEVER
       recomputed after submission, so a template edit will not
       retroactively change scores. */
    customAvailableMarks: { type: Number, default: 0 },
    customEarnedMarks:    { type: Number, default: 0 },
    customPenaltyMarks:   { type: Number, default: 0 },
    customFinalMarks:     { type: Number, default: 0 },

    /* ---- Phase 53: Extra Tasks ----
       Per-submission ad-hoc tasks the employee added on top of the
       template's predefined `customFields`.  Each row snapshots
       label + description + responseType at submit time so historical
       submissions keep rendering correctly even if the template's
       extraTaskCatalog is later renamed or the employee-side wording
       is edited.  Analytics groups across submissions by `key`.

       Predefined tasks (customResponses) and extra tasks live in
       distinct arrays so the HR review UI, template analytics, and
       existing scoring / discipline / innovation flows never confuse
       one for the other. */
    extraTasks: {
      type: [new mongoose.Schema(
        {
          key:          { type: String, required: true, trim: true },
          label:        { type: String, required: true, trim: true },
          description:  { type: String, default: '', trim: true },
          responseType: {
            type: String,
            enum: ['none', 'number', 'status', 'number_status'],
            default: 'none',
          },
          value:  { type: mongoose.Schema.Types.Mixed, default: '' },
          status: {
            type: String,
            enum: ['', 'done', 'ongoing', 'pending', 'work_not_available'],
            default: '',
          },
          remark: { type: String, default: '' },
          /* ---- Phase 59 — Marks parity for Extra Tasks ----
             Snapshot fields captured at submit time so the row can be
             scored + re-edited independently of the catalog.  Same
             semantics as the customField marks block; historical rows
             leave these at 0. */
          outOfValue:     { type: Number, default: 0 },
          maxMarks:       { type: Number, default: 0 },
          isCritical:     { type: Boolean, default: false },
          penaltyMarksCfg:{ type: Number, default: 0 },
          threshold:      { type: Number, default: 0 },
          optionMarks: {
            type: [new mongoose.Schema(
              {
                option:  { type: String, required: true, trim: true },
                percent: { type: Number, default: 0, min: 0, max: 100 },
                penalty: { type: Number, default: 0, min: 0 },
              },
              { _id: false },
            )],
            default: [],
          },
          availableMarks: { type: Number, default: 0 },
          earnedMarks:    { type: Number, default: 0 },
          penaltyMarks:   { type: Number, default: 0 },
        },
        { _id: false },
      )],
      default: [],
    },

    /* ---- Product Sales sub-table ----
       Repeating rows for templates that declare customSections: ['productSales'].
       Each row snapshots the product + quantity master values at submit
       time so analytics + historical reports stay correct even when the
       master catalogue is later edited or deactivated.
       salesValue + nbvValue are RECOMPUTED server-side from the snapshot
       (never trusted from the client). */
    productSales: {
      type: [new mongoose.Schema(
        {
          productId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
          productName:         { type: String, default: '' },
          productUnit:         { type: String, enum: ['L', 'KG'], default: 'L' },
          productPrice:        { type: Number, default: 0 },
          productNbvPercentage:{ type: Number, default: 0 },
          // Legacy Quantity Master reference -- kept so historical
          // submissions keep resolving + HR can still wire the old
          // dropdown if they want a curated list.  New submissions
          // ignore these unless `quantity` (below) is missing.
          quantityId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Quantity' },
          quantityLabel:       { type: String, default: '' },
          quantityValue:       { type: Number, default: 0 },
          // New: raw canonical quantity entered by the employee.
          // 0.5 = 500 ml on an L-unit product, 25 = 25 kg on a KG-unit
          // product, etc.  When present, drives salesValue/nbvValue.
          quantity:            { type: Number, default: 0 },
          salesValue:          { type: Number, default: 0 },
          nbvValue:            { type: Number, default: 0 },
        },
        { _id: true },
      )],
      default: [],
    },

    /* ---- Farmer records sub-table ----
       Repeating farmer-detail rows for templates that declare
       customSections: ['farmerRecords'].

       Schema v2:
         - dealerId + dealerNameSnapshot + dealerPlaceSnapshot let
           Dealer Analytics aggregate across submissions even after the
           Dealer Master is renamed or deactivated.
         - products[] supports multiple products per farmer.  Legacy
           single product/quantity fields are kept (and back-filled by
           the submit handler) so historical reports still render
           without a migration script.
    */
    farmerRecords: {
      type: [new mongoose.Schema(
        {
          name:            { type: String, default: '' },
          mobile:          { type: String, default: '' },
          village:         { type: String, default: '' },

          // Legacy free-text dealer field (kept for historical
          // submissions; new flow uses dealerId).
          dealerLocation:  { type: String, default: '' },

          // New: Dealer Master reference + snapshot.  After Phase 3 the
          // canonical breakdown is firm + place + dealerName; the older
          // dealerNameSnapshot column is kept for back-compat and is
          // populated to firmName by the submit handler so any older
          // analytics path that reads it still resolves.
          dealerId:            { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
          dealerNameSnapshot:  { type: String, default: '' },   // legacy = firmName
          dealerPlaceSnapshot: { type: String, default: '' },
          dealerFirmSnapshot:  { type: String, default: '' },   // explicit firm
          dealerPersonSnapshot:{ type: String, default: '' },   // dealer person name

          // Legacy single product fields -- mirror the first products[] row.
          productId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
          productName:     { type: String, default: '' },
          quantityId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Quantity' },
          quantityLabel:   { type: String, default: '' },

          // New: repeating products this farmer purchased.
          products: {
            type: [new mongoose.Schema(
              {
                productId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
                productName:  { type: String, default: '' },
                productUnit:  { type: String, enum: ['L', 'KG'], default: 'L' },
                quantity:     { type: Number, default: 0 }, // canonical (L or KG)
              },
              { _id: false },
            )],
            default: [],
          },
        },
        { _id: true },
      )],
      default: [],
    },

    submitted: { type: Boolean, default: false },
    submittedAt: { type: Date },
    /* Phase 19: server-persisted draft auto-save.  The draft endpoint
       stamps `lastDraftSavedAt` every time it writes the unsubmitted
       submission.  Drives the frontend "Saved at HH:MM" pill and the
       per-card "you left work here" indicator.  Cleared on submit. */
    lastDraftSavedAt: { type: Date },

    // Self-observation (informational only)
    selfRating: { type: Number, min: 0, max: 10 },
    selfNote: { type: String, default: '' },

    // Employee-submitted business idea / innovation suggestion
    idea: { type: String, default: '' },

    // ----- Final cached scoring (work + review) -----
    earnedPoints: { type: Number, default: 0 },
    totalPoints: { type: Number, default: 0 },
    completionPercentage: { type: Number, default: 0 },

    // Immutable snapshot of pure work scoring at submit time.
    // earnedPoints / totalPoints get re-derived as
    //   workEarnedPoints + disciplineMarks + ideaMarks
    //   workTotalPoints + maxDisciplineMarks + maxIdeaMarks
    // after HR review, so we can always recompute.
    workEarnedPoints: { type: Number, default: 0 },
    workTotalPoints: { type: Number, default: 0 },

    // ----- Multi-stage review pipeline -----
    // currentReviewStage tracks where a submission is in the optional
    // HOD -> HR pipeline.  reviewStatus (below) is kept in lock-step for
    // backward compatibility: it only becomes 'reviewed' when HR finalises.
    //   submitted     -> just submitted (direct-HR flow waits here)
    //   under_hod     -> awaiting HOD review (hod_first flow)
    //   hod_reviewed  -> HOD reviewed, awaiting HR finalisation
    //   finalized     -> HR finalised
    currentReviewStage: {
      type: String,
      // 'under_super_admin' is reserved for submissions whose owner is an
      // HR user — those bypass the HR review queue entirely and are
      // reviewed by Super Admin only.
      enum: ['submitted', 'under_hod', 'hod_reviewed', 'under_hr', 'under_super_admin', 'finalized'],
      default: 'submitted',
      index: true,
    },

    // HOD's review (recommendation only - does NOT commit final scores).
    hodReview: {
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reviewedAt: { type: Date },
      remarks: { type: String, default: '' },
      marksGiven: { type: Boolean, default: false }, // did HOD enter marks?
      recommend: {
        type: String,
        enum: ['', 'approve', 'needs_changes'],
        default: '',
      },
    },

    // Immutable-ish audit trail of every review action across stages.
    reviewHistory: {
      type: [
        new mongoose.Schema(
          {
            reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            reviewerName: { type: String, default: '' },
            role: { type: String, default: '' },        // 'employee' | 'hod' | 'hr' | 'super_admin'
            stage: { type: String, default: '' },        // resulting stage
            action: { type: String, default: '' },       // 'submitted' | 'hod_review' | 'hr_finalize'
            marks: { type: Number },                      // total marks at this action (if any)
            remarks: { type: String, default: '' },
            timestamp: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // ----- HR review / marking -----
    reviewStatus: {
      type: String,
      enum: ['pending', 'reviewed'],
      default: 'pending',
      index: true,
    },
    disciplineMarks: { type: Number, default: 0, min: 0 },
    maxDisciplineMarks: { type: Number, default: 3, min: 0 },
    disciplineNote: { type: String, default: '' },

    ideaMarks: { type: Number, default: 0, min: 0 },
    maxIdeaMarks: { type: Number, default: 2, min: 0 },
    ideaFeedback: { type: String, default: '' },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },

    /* ---- Phase 4: Submission Control flags ----
       Both default to `false` so every existing submission in the
       database is treated as "live, real data" without a migration.
       Every analytics query AND-s in the `liveSubmissionFilter()`
       helper so analytics never accidentally include deleted /
       test-marked rows.

       Soft-delete: rows stay in the collection so HR can audit /
       restore.  Hard-delete is intentionally not supported. */
    deleted:        { type: Boolean, default: false, index: true },
    deletedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedAt:      { type: Date },
    deleteReason:   { type: String, default: '' },

    /* Test-data marker: HR flags an obvious test row (manual
       acceptance test, demo recording, training example) so it
       stops contributing to analytics without a delete trail.
       The `?includeTest=true` query param re-includes them when
       HR explicitly asks. */
    isTestData:          { type: Boolean, default: false, index: true },
    testDataMarkedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    testDataMarkedAt:    { type: Date },

    /* HR/SA inline edit audit -- captures who touched what + when.
       Replaces nothing existing; runs in parallel to reviewHistory. */
    editHistory: {
      type: [
        new mongoose.Schema(
          {
            editedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            editorName: { type: String, default: '' },
            role:       { type: String, default: '' },
            fields:     { type: [String], default: [] }, // top-level keys touched
            note:       { type: String, default: '' },
            timestamp:  { type: Date, default: Date.now },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

submissionSchema.index({ employee: 1, template: 1, date: 1 }, { unique: true });
submissionSchema.index({ employee: 1, date: 1 });
// Submission Control quick-filter: (deleted, isTestData) gives the
// analytics path a covered index when both flags are checked together,
// which is the default case on every analytics + leaderboard query.
submissionSchema.index({ deleted: 1, isTestData: 1 });

module.exports = mongoose.model('Submission', submissionSchema);
