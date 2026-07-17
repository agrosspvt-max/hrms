const asyncHandler = require('express-async-handler');
const Template = require('../models/Template');
const { parseBuffer } = require('../utils/excelParser');
const { parseWorkbookToSheet } = require('../utils/sheetParser');

const FIELD_TYPES = ['text', 'number', 'textarea', 'dropdown', 'date'];
const CELL_ROLES = ['label', 'static', 'input'];

/**
 * Sanitise an incoming `sheet` payload so we never persist a malformed
 * grid.  Coerces numbers, clamps enums, rebuilds scoring keys.
 */
const normaliseSheet = (sheet) => {
  const s = sheet && typeof sheet === 'object' ? sheet : {};
  const rowCount = Math.max(0, Number(s.rowCount) || 0);
  const colCount = Math.max(0, Number(s.colCount) || 0);

  const columns = (Array.isArray(s.columns) ? s.columns : []).map((col, i) => ({
    index: Number.isFinite(Number(col.index)) ? Number(col.index) : i,
    label: String(col.label ?? '').trim(),
    width: Math.max(40, Number(col.width) || 140),
    hidden: !!col.hidden,
  })).sort((a, b) => a.index - b.index);

  const rows = (Array.isArray(s.rows) ? s.rows : []).map((row, i) => ({
    index: Number.isFinite(Number(row.index)) ? Number(row.index) : i,
    label: String(row.label ?? '').trim(),
    hidden: !!row.hidden,
  })).sort((a, b) => a.index - b.index);

  const cells = (Array.isArray(s.cells) ? s.cells : []).map((cell) => {
    const out = {
      r: Number(cell.r) || 0,
      c: Number(cell.c) || 0,
      value: cell.value === undefined ? '' : cell.value,
      role: CELL_ROLES.includes(cell.role) ? cell.role : 'input',
      fieldType: FIELD_TYPES.includes(cell.fieldType) ? cell.fieldType : 'text',
      editable: cell.editable !== undefined ? !!cell.editable : cell.role === 'input',
      hidden: !!cell.hidden,
      options: Array.isArray(cell.options)
        ? cell.options.map((o) => String(o).trim()).filter(Boolean)
        : [],
    };
    if (cell.merge && (cell.merge.rowspan || cell.merge.colspan)) {
      out.merge = {
        rowspan: Math.max(1, Number(cell.merge.rowspan) || 1),
        colspan: Math.max(1, Number(cell.merge.colspan) || 1),
      };
    }
    if (cell.mergedInto && cell.mergedInto.r !== undefined) {
      out.mergedInto = { r: Number(cell.mergedInto.r), c: Number(cell.mergedInto.c) };
    }
    return out;
  }).sort((a, b) => (a.r - b.r) || (a.c - b.c));

  const scoring = (Array.isArray(s.scoring) ? s.scoring : [])
    .map((sc) => {
      const type = ['cell', 'row', 'column'].includes(sc.type) ? sc.type : null;
      if (!type) return null;
      const rowIndex = sc.rowIndex !== undefined && sc.rowIndex !== null ? Number(sc.rowIndex) : undefined;
      const colIndex = sc.colIndex !== undefined && sc.colIndex !== null ? Number(sc.colIndex) : undefined;
      let key;
      if (type === 'cell') key = `cell:${rowIndex}:${colIndex}`;
      else if (type === 'row') key = `row:${rowIndex}`;
      else key = `col:${colIndex}`;
      return {
        key,
        type,
        rowIndex,
        colIndex,
        label: String(sc.label ?? '').trim(),
        maxMarks: Math.max(0, Number(sc.maxMarks) || 0),
        // Row-level status tracking (only meaningful for row scores, but
        // preserved generically so the flag round-trips).
        statusTracking: !!sc.statusTracking,
      };
    })
    .filter(Boolean)
    // de-dupe by key (last one wins)
    .reduce((acc, item) => {
      acc.set(item.key, item);
      return acc;
    }, new Map());

  return {
    sheetName: String(s.sheetName || 'Sheet1'),
    rowCount,
    colCount,
    columns,
    rows,
    cells,
    scoring: [...scoring.values()],
    allowEmployeeAddRows: !!s.allowEmployeeAddRows,
  };
};

const list = asyncHandler(async (_req, res) => {
  res.json(await Template.find({}).sort({ createdAt: -1 }));
});

const get = asyncHandler(async (req, res) => {
  const t = await Template.findById(req.params.id);
  if (!t) { res.status(404); throw new Error('Template not found'); }
  res.json(t);
});

/**
 * Normalise the incoming body so we never persist a mismatched shape -
 * task templates shouldn't carry excel columns, and vice-versa.
 */
// Phase 12: extended fieldType set + new builder UI flags.
// Phase 53.1 / bugfix: 'none' (status-only field) was added to the
// Template.customFieldSchema enum + the frontend Value Type dropdown
// but never added to this controller-side whitelist.  Because the
// write path coerces any unknown value to 'number', picking "None"
// (or any future new type) in the builder silently reverted to
// "Number" on Save.  Keep this list in sync with the model enum in
// backend/models/Template.js.
const CUSTOM_FIELD_TYPES = ['number', 'text', 'textarea', 'dropdown', 'auto', 'readonly', 'date', 'currency', 'percentage', 'yes_no', 'time', 'none'];
const CUSTOM_VISIBLE_ROLES = ['employee', 'hod', 'hr', 'super_admin'];
const DEP_TYPES = ['independent', 'dependent'];
const REVIEW_FLOWS = ['direct_hr', 'hod_first'];

// Auto-derive analyticsName when blank: "Calling Report" -> "Calling Analytics".
const _deriveAnalyticsName = (title) => {
  const t = String(title || '').trim();
  if (!t) return '';
  const stripped = t.replace(/\s*(Template|Report|Form)s?\s*$/i, '');
  return `${stripped} Analytics`;
};

const normalisePayload = (body) => {
  const type = ['excel', 'sheet', 'custom'].includes(body.templateType) ? body.templateType : 'task';
  const out = {
    title: body.title,
    description: body.description || '',
    templateType: type,
    tasks: [],
    excelColumns: [],
    sheet: undefined,
    customFields: [],
    customKind: '',
    isActive: body.isActive !== false,
    // Status tracking (Done / Pending / Work Not Available + dependency
    // hand-off) only applies to excel + sheet templates.
    statusTracking: type !== 'task' && type !== 'custom' ? !!body.statusTracking : false,
  };
  if (type === 'task') {
    out.tasks = Array.isArray(body.tasks) ? body.tasks : [];
  } else if (type === 'excel') {
    out.excelColumns = (Array.isArray(body.excelColumns) ? body.excelColumns : []).map((c) => ({
      fieldName: String(c.fieldName || '').trim(),
      fieldType: FIELD_TYPES.includes(c.fieldType) ? c.fieldType : 'text',
      markEligible: !!c.markEligible,
      maxMarks: Math.max(0, Number(c.maxMarks) || 0),
      options: Array.isArray(c.options) ? c.options.map((o) => String(o).trim()).filter(Boolean) : [],
      hint: c.hint || '',
    })).filter((c) => c.fieldName);
  } else if (type === 'sheet') {
    out.sheet = normaliseSheet(body.sheet);
  } else if (type === 'custom') {
    out.customKind = String(body.customKind || '').trim().toLowerCase();
    out.customFields = (Array.isArray(body.customFields) ? body.customFields : []).map((f) => ({
      key:    String(f.key || '').trim(),
      label:  String(f.label || '').trim(),
      fieldType: CUSTOM_FIELD_TYPES.includes(f.fieldType) ? f.fieldType : 'number',
      required: !!f.required,
      options:  Array.isArray(f.options) ? f.options.map((o) => String(o).trim()).filter(Boolean) : [],
      group:    String(f.group || '').trim(),
      description: String(f.description || '').trim(),
      formula:  String(f.formula || '').trim(),
      systemGenerated: !!f.systemGenerated,
      visibleTo: Array.isArray(f.visibleTo)
        ? f.visibleTo.filter((r) => CUSTOM_VISIBLE_ROLES.includes(r))
        : CUSTOM_VISIBLE_ROLES.slice(),
      order: Number(f.order) || 0,
      // Phase 12 builder fields (all optional / default-safe).
      subTemplateId:       String(f.subTemplateId || '').trim(),
      supportsStatus:      !!f.supportsStatus,
      supportsRemark:      !!f.supportsRemark,
      // Phase 52 -- Remark Required is meaningful only when Remark
      // Enabled is on.  Coerced to false here so the two flags stay
      // consistent in the DB regardless of what the client posts.
      remarkRequired:      !!f.supportsRemark && !!f.remarkRequired,
      dependencyType:      DEP_TYPES.includes(f.dependencyType) ? f.dependencyType : 'independent',
      isAnalyticsEligible: f.isAnalyticsEligible !== false,
      // Phase 58 — Custom-template Marks system.  All optional; when
      // enableMarks is off, the numeric knobs are coerced to 0 so the
      // DB never carries phantom marks that could sneak into
      // analytics.  Same story for isCritical + penalty.
      enableMarks:   !!f.enableMarks,
      maxMarks:      Math.max(0, Number(f.maxMarks) || 0),
      enableOutOf:   !!f.enableOutOf,
      outOfLabel:    String(f.outOfLabel || '').trim() || 'Out Of',
      // Coerce per-option marks to a clean [{ option, percent, penalty }]
      // array.  Percents clamped to 0-100; penalties clamped to >= 0.
      optionMarks: Array.isArray(f.optionMarks)
        ? f.optionMarks
            .filter((o) => o && typeof o.option === 'string')
            .map((o) => ({
              option:  String(o.option).trim(),
              percent: Math.max(0, Math.min(100, Number(o.percent) || 0)),
              penalty: Math.max(0, Number(o.penalty) || 0),
            }))
            .filter((o) => o.option)
        : [],
      isCritical:    !!f.isCritical,
      penaltyMarks:  Math.max(0, Number(f.penaltyMarks) || 0),
      threshold:     Math.max(0, Number(f.threshold) || 0),
    })).filter((f) => f.key && f.label);
    out.customSections = Array.isArray(body.customSections)
      ? body.customSections.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
      : [];
    // Phase 12 sub-templates.  Each entry: { _id?, name, description, isActive, order }.
    out.subTemplates = Array.isArray(body.subTemplates)
      ? body.subTemplates.map((s) => ({
          _id:  s._id || undefined,
          name: String(s.name || '').trim(),
          description: String(s.description || '').trim(),
          isActive: s.isActive !== false,
          order: Number(s.order) || 0,
        })).filter((s) => s.name)
      : [];
    out.analyticsName = String(body.analyticsName || '').trim() || _deriveAnalyticsName(body.title);
    out.reviewFlow    = REVIEW_FLOWS.includes(body.reviewFlow) ? body.reviewFlow : 'direct_hr';
    if (body.department && /^[a-f0-9]{24}$/i.test(String(body.department))) {
      out.department = body.department;
    } else {
      out.department = null;
    }
  }
  // Phase 60 — Employee Private Remark configuration.  Available on
  // both Task and Custom templates.  Label defaults to "Remark" so
  // toggling on gives HR a working default without extra typing.
  // Required is coerced to false when the remark is disabled so the
  // two flags stay consistent regardless of what the client sent.
  out.privateRemarkEnabled  = !!body.privateRemarkEnabled;
  out.privateRemarkLabel    = String(body.privateRemarkLabel || '').trim() || 'Remark';
  out.privateRemarkRequired = !!out.privateRemarkEnabled && !!body.privateRemarkRequired;
  return out;
};

const create = asyncHandler(async (req, res) => {
  const payload = normalisePayload(req.body);
  if (!payload.title) { res.status(400); throw new Error('title is required'); }
  const t = await Template.create({ ...payload, createdBy: req.user._id });
  res.status(201).json(t);
});

const update = asyncHandler(async (req, res) => {
  const payload = normalisePayload(req.body);
  const t = await Template.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!t) { res.status(404); throw new Error('Template not found'); }
  res.json(t);
});

const remove = asyncHandler(async (req, res) => {
  const t = await Template.findByIdAndDelete(req.params.id);
  if (!t) { res.status(404); throw new Error('Template not found'); }
  res.json({ message: 'Template deleted' });
});

/**
 * POST /api/templates/excel/parse  (multipart/form-data, field "file")
 *
 * Parses the uploaded workbook in-memory and returns its column
 * structure + a small preview.  Nothing is persisted - HR reviews and
 * tweaks the columns, then POSTs to /api/templates with templateType=excel.
 */
const excelParse = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    res.status(400);
    throw new Error('Upload an .xlsx / .xls / .csv file in the "file" form field.');
  }
  try {
    const result = parseBuffer(req.file.buffer);
    res.json(result);
  } catch (err) {
    res.status(400);
    throw new Error(`Failed to parse workbook: ${err.message}`);
  }
});

/**
 * POST /api/templates/sheet/parse  (multipart/form-data, field "file")
 *
 * Parses the uploaded workbook into a structure-preserving 2-D grid
 * (rows, columns, cells, merged-cell metadata).  Nothing is persisted -
 * HR refines roles / scoring / hidden flags in the builder, then POSTs
 * to /api/templates with templateType=sheet.
 */
const sheetParse = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    res.status(400);
    throw new Error('Upload an .xlsx / .xls / .csv file in the "file" form field.');
  }
  try {
    const result = parseWorkbookToSheet(req.file.buffer);
    res.json(result);
  } catch (err) {
    res.status(400);
    throw new Error(`Failed to parse workbook: ${err.message}`);
  }
});

/**
 * POST /api/templates/:id/clone
 *
 * Phase 12: duplicate everything that defines a template -- title +
 * customFields + subTemplates + customSections + customKind +
 * reviewFlow + analyticsName + department + tasks / excelColumns /
 * sheet -- so HR can fork a working template and tweak the copy.
 * Returns the new doc; the UI opens it for editing.
 */
const clone = asyncHandler(async (req, res) => {
  const src = await Template.findById(req.params.id).lean();
  if (!src) { res.status(404); throw new Error('Template not found'); }
  // Strip Mongo internals.
  delete src._id; delete src.createdAt; delete src.updatedAt; delete src.__v;
  // Re-stamp ownership + uniqueify the visible title.
  src.title         = `${src.title} (Copy)`;
  src.analyticsName = src.analyticsName ? `${src.analyticsName} (Copy)` : '';
  src.createdBy     = req.user._id;
  // For sub-templates we drop the _id so Mongoose mints a fresh one --
  // otherwise the new template would carry the original sub-template
  // ids, which would break cross-reference if HR later edits the original.
  if (Array.isArray(src.subTemplates)) {
    // Map old subTemplateId -> new id so customFields stay attached.
    const idMap = new Map();
    src.subTemplates = src.subTemplates.map((s) => {
      const newId = new (require('mongoose').Types.ObjectId)();
      idMap.set(String(s._id), String(newId));
      return { ...s, _id: newId };
    });
    if (Array.isArray(src.customFields)) {
      src.customFields = src.customFields.map((f) => (
        f.subTemplateId && idMap.has(String(f.subTemplateId))
          ? { ...f, subTemplateId: idMap.get(String(f.subTemplateId)) }
          : f
      ));
    }
  }
  const created = await Template.create(src);
  res.status(201).json(created);
});

module.exports = { list, get, create, update, remove, excelParse, sheetParse, clone };
