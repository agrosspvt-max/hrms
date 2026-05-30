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

const templateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, index: true },
    description: { type: String, trim: true },

    templateType: {
      type: String,
      enum: ['task', 'excel', 'sheet'],
      default: 'task',
      index: true,
    },

    // Used when templateType === 'task'
    tasks: { type: [taskItemSchema], default: [] },

    // Used when templateType === 'excel'
    excelColumns: { type: [excelColumnSchema], default: [] },

    // Used when templateType === 'sheet'
    sheet: { type: sheetSchema, default: undefined },

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
