const mongoose = require('mongoose');

/**
 * Template supports THREE modes:
 *
 *   templateType = 'task'  (default, original system)
 *     Reusable checklist of `tasks: [{ title, points }]`.  Employees
 *     mark each task done/pending/not-available.
 *
 *   templateType = 'excel'  (legacy column-wise reporting)
 *     Spreadsheet-style report defined by `excelColumns`.  Each column
 *     can be flagged mark-eligible with its own max marks.  Employees
 *     fill a dynamic form; HR awards marks per field on review.
 *     Kept intact for backward compatibility.
 *
 *   templateType = 'sheet'  (advanced spreadsheet reporting)
 *     Preserves the ORIGINAL workbook layout as a 2-D grid of cells.
 *     HR can mark scoring anywhere - by whole column, whole row, or an
 *     individual cell - and hide helper rows/columns from employees.
 *     Employees fill editable cells directly in a spreadsheet UI; HR
 *     awards row/column/cell marks on review.  See `sheetSchema` below.
 *
 * All types live in the same collection so assignments, dashboards,
 * attendance and salary all keep working uniformly.
 */
const taskItemSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    points: { type: Number, default: 1, min: 0 },
  },
  { _id: true }
);

const excelColumnSchema = new mongoose.Schema(
  {
    fieldName: { type: String, required: true, trim: true },
    fieldType: {
      type: String,
      enum: ['text', 'number', 'textarea', 'dropdown', 'date'],
      default: 'text',
    },
    markEligible: { type: Boolean, default: false },
    maxMarks: { type: Number, default: 0, min: 0 },
    options: { type: [String], default: [] }, // used when fieldType === 'dropdown'
    hint: { type: String, default: '' },
  },
  { _id: true }
);

/* ------------------------------------------------------------------ */
/* Advanced spreadsheet ('sheet') schemas                             */
/* ------------------------------------------------------------------ */

/**
 * One cell of the preserved grid.  `role` drives behaviour:
 *   - label   : HR-authored static text (column header, row label, etc.)
 *               read-only for everyone.
 *   - static  : a preset value HR wants shown but not edited.
 *   - input   : an editable cell the employee fills in.
 *
 * Merged regions keep their metadata: the top-left "master" cell carries
 * `merge: { rowspan, colspan }`; every covered cell carries
 * `mergedInto: { r, c }` pointing back at the master.
 */
const sheetCellSchema = new mongoose.Schema(
  {
    r: { type: Number, required: true }, // 0-based row index
    c: { type: Number, required: true }, // 0-based column index
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
    merge: {
      rowspan: { type: Number },
      colspan: { type: Number },
    },
    mergedInto: {
      r: { type: Number },
      c: { type: Number },
    },
  },
  { _id: false }
);

const sheetColumnSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true },
    label: { type: String, default: '' },
    width: { type: Number, default: 140 },
    hidden: { type: Boolean, default: false },
  },
  { _id: false }
);

const sheetRowSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true },
    label: { type: String, default: '' },
    hidden: { type: Boolean, default: false },
  },
  { _id: false }
);

/**
 * A scoring target.  `key` is a stable identifier:
 *   cell   -> "cell:<r>:<c>"
 *   row    -> "row:<r>"
 *   column -> "col:<c>"
 */
const sheetScoreSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    type: { type: String, enum: ['cell', 'row', 'column'], required: true },
    rowIndex: { type: Number }, // row + cell
    colIndex: { type: Number }, // column + cell
    label: { type: String, default: '' },
    maxMarks: { type: Number, default: 0, min: 0 },
    // ROW-WISE status tracking: when true, this scored row behaves like a
    // task at submission time (Done / Pending / Work Not Available dropdown
    // + dependency hand-off).  Configured per-row, independent of marks.
    statusTracking: { type: Boolean, default: false },
  },
  { _id: false }
);

const sheetSchema = new mongoose.Schema(
  {
    sheetName: { type: String, default: 'Sheet1' },
    rowCount: { type: Number, default: 0 },
    colCount: { type: Number, default: 0 },
    columns: { type: [sheetColumnSchema], default: [] },
    rows: { type: [sheetRowSchema], default: [] },
    cells: { type: [sheetCellSchema], default: [] },
    scoring: { type: [sheetScoreSchema], default: [] },
    // When true, employees may append extra rows while filling.
    allowEmployeeAddRows: { type: Boolean, default: false },
  },
  { _id: false }
);

/* ------------------------------------------------------------------ */
/* Custom Assignment ('custom') schemas                               */
/*                                                                    */
/* Generic per-field builder so HR can spin up structured reports     */
/* (Daily Calling Report, Site Visit, Dispatch, etc.) without code    */
/* changes.  Each field has a stable `key` (used by formulas + the    */
/* analytics layer), a type, role-based visibility, and -- for type   */
/* 'auto' -- a formula string evaluated server-side at submit time.   */
/*                                                                    */
/* `kind` lets analytics pre-built dashboards (e.g. Calling) discover */
/* their templates without hardcoding template IDs.  e.g. `kind:      */
/* 'calling'` is the well-known kind the Calling Analytics tab reads. */
/* ------------------------------------------------------------------ */
const customFieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },   // stable id (e.g. 'attendedCalls')
    label: { type: String, required: true, trim: true }, // HR-facing display name
    fieldType: {
      type: String,
      // Phase 12: 'currency' / 'percentage' / 'yes_no' / 'time' are
      // first-class display variants.  Numeric math treats currency +
      // percentage exactly like 'number'; yes_no is a 2-option
      // dropdown; time accepts HH:MM strings.
      enum: ['number', 'text', 'textarea', 'dropdown', 'auto', 'readonly', 'date', 'currency', 'percentage', 'yes_no', 'time'],
      default: 'number',
    },
    required: { type: Boolean, default: false },
    options: { type: [String], default: [] }, // dropdown options
    group: { type: String, default: '' },     // visually groups fields in the form
    description: { type: String, default: '' },
    formula: { type: String, default: '' },
    systemGenerated: { type: Boolean, default: false },
    visibleTo: {
      type: [String],
      enum: ['employee', 'hod', 'hr', 'super_admin'],
      default: ['employee', 'hod', 'hr', 'super_admin'],
    },
    order: { type: Number, default: 0 },

    /* ---- Phase 12: builder UI flags + sub-template membership ----
       All optional and default to behaviour the existing flow already
       provides, so legacy templates render unchanged.

         subTemplateId       Which sub-template this field belongs to.
                             Empty / null = template root (the legacy
                             flat structure).
         supportsStatus      Render a Done / Pending / Work N/A picker
                             alongside this field on the employee form.
         supportsRemark      Show a remark text field alongside.
         dependencyType      'independent' (default) or 'dependent'.
                             Drives dependency hand-off semantics like
                             task templates.
         isAnalyticsEligible Surface this field on the Dynamic Analytics
                             page.  Defaults to true for numeric types.
    */
    subTemplateId:       { type: String, default: '' },
    supportsStatus:      { type: Boolean, default: false },
    supportsRemark:      { type: Boolean, default: false },
    /* Phase 52 -- when supportsRemark is true, HR can additionally
       require the employee to write a non-empty remark before the
       submission for THIS field is accepted.  Ignored (and coerced to
       false in the create/update controllers) when supportsRemark is
       false so the two flags stay logically consistent. */
    remarkRequired:      { type: Boolean, default: false },
    dependencyType:      { type: String, enum: ['independent', 'dependent'], default: 'independent' },
    isAnalyticsEligible: { type: Boolean, default: true },
  },
  { _id: false }
);

/* ------------------------------------------------------------------ */
/* Phase 12: sub-templates                                            */
/* A template may contain zero or more sub-templates.  Each holds its */
/* own set of customFields (selected via customField.subTemplateId).  */
/* Assignment.subTemplateId optionally scopes the daily submission to */
/* a single sub-template; no scoping = entire template.                */
/* ------------------------------------------------------------------ */
const subTemplateSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    isActive:    { type: Boolean, default: true },
    order:       { type: Number, default: 0 },
  },
  { _id: true },
);

const templateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, index: true },
    description: { type: String, trim: true },

    templateType: {
      type: String,
      enum: ['task', 'excel', 'sheet', 'custom'],
      default: 'task',
      index: true,
    },

    // Used when templateType === 'task'
    tasks: { type: [taskItemSchema], default: [] },

    // Used when templateType === 'excel'
    excelColumns: { type: [excelColumnSchema], default: [] },

    // Used when templateType === 'sheet'
    sheet: { type: sheetSchema, default: undefined },

    // Used when templateType === 'custom'
    customFields: { type: [customFieldSchema], default: [] },
    // Well-known kind that targeted analytics surfaces (e.g. Calling
    // Analytics) use to discover their templates.  Free-form for HR-
    // authored custom templates; the seeded Daily Calling Report uses
    // `kind: 'calling'`.
    customKind: { type: String, default: '', index: true },
    // Opt-in sub-tables a custom template wants on its submission.
    // Currently supported:
    //   'productSales'   -> repeating Product Sales rows (Product +
    //                       Quantity dropdowns, auto Sales Value + NBV).
    //   'farmerRecords'  -> repeating Farmer detail rows.
    // Future templates (Dealer Visit, Site Visit, Collection Report)
    // can re-use the same sections without code changes.
    customSections: { type: [String], default: [] },

    /* ---- Phase 11: Dynamic Analytics + workflow scaffolding ----
       All optional + backward-compatible.

         department       Owning department (used to scope which HOD can
                          see this template's analytics).  Null => global.
         analyticsName    Display label for the auto-generated analytics
                          page.  Derived from `title` if blank (e.g.
                          "Accounts Template" -> "Accounts Analytics").
         reviewFlow       'direct_hr' (default) or 'hod_first'.  Mirrors
                          the per-employee reviewFlow already on User --
                          when a template carries hod_first, every
                          submission routes through the HOD first
                          regardless of the employee's personal setting.
                          Currently advisory; the existing submission
                          pipeline still defers to the employee's
                          reviewFlow.  Stored so the builder UI + future
                          enforcement have a single source of truth.
    */
    department:    { type: mongoose.Schema.Types.ObjectId, ref: 'Department', index: true },
    analyticsName: { type: String, default: '', trim: true },
    reviewFlow:    { type: String, enum: ['direct_hr', 'hod_first'], default: 'direct_hr' },

    // Phase 12: sub-templates the builder UI manages.  Fields are
    // grouped under each sub-template via customField.subTemplateId.
    subTemplates:  { type: [subTemplateSchema], default: [] },

    // Lifecycle toggle so HR can deactivate templates without deleting.
    isActive: { type: Boolean, default: true },

    /* Phase 41 -- Template Analytics surface visibility toggle.
     *
     * When `true`, the template still exists + still accepts new
     * submissions (assignments / reviews / attendance / submissions all
     * keep working), but it is hidden from the Template Analytics
     * picker.  HR uses this from the Template Analytics page's
     * "Delete Analytics" action: the underlying template + every
     * historical record is preserved; only the analytics-surface entry
     * disappears.
     */
    analyticsHidden: { type: Boolean, default: false, index: true },

    // When enabled (excel / sheet templates), each scored row gets a
    // Done / Pending / Work Not Available status dropdown + optional
    // dependency hand-off, just like task templates.  Off by default so
    // existing templates behave exactly as before.
    statusTracking: { type: Boolean, default: false },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Template', templateSchema);
