import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import Collapsible from '../../components/Collapsible.jsx';
import SheetGrid from '../../components/SheetGrid.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';
import { EmptyState } from '../../components/Loader.jsx';

/**
 * Templates page (HR / Super Admin)
 *
 * Supports BOTH template types side-by-side:
 *   - Task template: a checklist of tasks with point values.
 *   - Excel reporting template: HR uploads an .xlsx/.csv; backend parses
 *     the structure; HR marks which columns are mark-eligible and sets
 *     the max marks for each.  Employees later fill the report in a
 *     dynamic form (no Excel download/upload).
 */
const blankTask = { templateType: 'task', title: '', description: '', tasks: [] };
const blankExcel = { templateType: 'excel', title: '', description: '', excelColumns: [], statusTracking: false };
const blankSheet = {
  templateType: 'sheet',
  title: '',
  description: '',
  statusTracking: false,
  sheet: { sheetName: 'Sheet1', rowCount: 0, colCount: 0, columns: [], rows: [], cells: [], scoring: [], allowEmployeeAddRows: false },
};
// Custom Assignment: the field builder UI ships in a follow-up; the
// metadata + clone-from-existing flow lives here so HR can create new
// custom templates (e.g. Site Visit Report, Dealer Visit Report) by
// either starting blank or cloning an existing custom template (such
// as the seeded Daily Calling Report) as a starting point.
// Phase 12: full visual builder.  Sub-templates + tasks live here; the
// modal replaces the old metadata-only popup.
const blankCustom = {
  templateType: 'custom',
  title: '',
  description: '',
  customKind: '',
  analyticsName: '',
  reviewFlow: 'direct_hr',
  department: '',
  isActive: true,
  subTemplates: [],
  customFields: [],
};
const FIELD_TYPES = ['text', 'number', 'textarea', 'dropdown', 'date'];
// Phase 15: builder UI is intentionally limited to the two field types
// that cover almost every operational reporting use case --
//   * Number  (Bills Generated, Orders Processed, Collections, KYC Count,
//              Dispatch Count, Pending Orders, ...)
//   * Dropdown (Reason, Category, Status, ...)
// All the other value types (currency, percentage, text, long_text,
// yes_no, date, time, auto) remain VALID in the schema + accepted by
// the renderer + processed by analytics -- existing fields keep
// working -- but new tasks in the builder pick from this short list
// so HR doesn't have to think about edge cases that don't help
// analytics.  When a real need surfaces, the list can be widened
// without touching backend or renderer.
const CUSTOM_FIELD_TYPES = [
  { value: 'number',   label: 'Number' },
  { value: 'dropdown', label: 'Dropdown' },
  // Phase 53 -- status-only tasks (no numeric or text value).  Pair
  // with "Status enabled" to render Done / Pending / Work N/A only.
  { value: 'none',     label: 'None (status only)' },
];

/* Scoring helpers shared across the sheet builder */
const scoreKey = (s) =>
  s.type === 'cell' ? `cell:${s.rowIndex}:${s.colIndex}` : s.type === 'row' ? `row:${s.rowIndex}` : `col:${s.colIndex}`;
const buildScoreMap = (scoring) =>
  Object.fromEntries((scoring || []).map((s) => [scoreKey(s), s]));
const totalSheetMarks = (scoring) => (scoring || []).reduce((sum, s) => sum + (Number(s.maxMarks) || 0), 0);

export default function Templates({ embedded = false } = {}) {
  const [items, setItems] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [modal, setModal] = useState(null);
  const toast = useToast();

  const load = async () => {
    const [t, a] = await Promise.all([
      api.get('/templates'),
      api.get('/assignments').catch(() => ({ data: [] })),
    ]);
    setItems(t.data); setAssignments(a.data || []);
  };
  useEffect(() => { load(); }, []);

  // Per-template stats (assignments using this template).
  const statsByTpl = (() => {
    const m = new Map();
    for (const a of assignments) {
      const k = String(a.template?._id || a.template);
      if (!m.has(k)) m.set(k, { total: 0, active: 0, freq: new Set() });
      const r = m.get(k); r.total += 1; if (a.active) r.active += 1; r.freq.add(a.frequency);
    }
    return m;
  })();

  const save = async (form) => {
    try {
      // Diagnostic: log the exact payload + endpoint so a failing save
      // shows up in the Network tab and the console at the same time.
      const url = modal.mode === 'create' ? '/templates' : `/templates/${modal.data._id}`;
      const method = modal.mode === 'create' ? 'POST' : 'PUT';
      console.log(`[Templates] ${method} ${url}`, form);
      if (modal.mode === 'create') await api.post(url, form);
      else                         await api.put(url, form);
      toast.success('Template saved'); setModal(null); load();
    } catch (err) {
      console.error('[Templates] save failed:', err?.response?.status, err?.response?.data || err.message);
      toast.error(errMsg(err) || 'Save failed -- see console for details');
    }
  };
  const del = async (id) => {
    if (!confirm('Delete template?')) return;
    try { await api.delete(`/templates/${id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  const startCreate = (type) => {
    const base = type === 'excel'  ? blankExcel
               : type === 'sheet'  ? blankSheet
               : type === 'custom' ? blankCustom
               : blankTask;
    setModal({ mode: 'create', data: JSON.parse(JSON.stringify(base)) });
  };

  // Clone a template.  Phase 12: routes through the backend clone
  // endpoint so sub-templates get fresh ObjectIds and the customFields'
  // subTemplateId refs are remapped to the new ids.  Falls back to the
  // legacy client-side copy if the API isn't available so older
  // template types keep working.
  const startClone = async (t) => {
    try {
      const { data } = await api.post(`/templates/${t._id}/clone`);
      await load();
      toast.success('Template cloned');
      setModal({ mode: 'edit', data });
    } catch (err) {
      // Fallback for older backends.
      const data = JSON.parse(JSON.stringify(t));
      delete data._id; delete data.createdAt; delete data.updatedAt;
      data.title = `${data.title || 'Untitled'} (Copy)`;
      setModal({ mode: 'create', data });
    }
  };

  return (
    <div className="space-y-4">
      <div className={`flex ${embedded ? 'justify-end' : 'justify-between'} items-center`}>
        {!embedded && <h1 className="text-2xl font-bold">Templates</h1>}
        <div className="flex gap-2 flex-wrap">
          <button className="btn-secondary" onClick={() => startCreate('task')}>+ Task Template</button>
          <button className="btn-secondary" onClick={() => startCreate('excel')}>+ Excel Report Template</button>
          <button className="btn-secondary" onClick={() => startCreate('sheet')}>+ Spreadsheet Template</button>
          <button className="btn-primary"   onClick={() => startCreate('custom')}>+ Custom Assignment Template</button>
        </div>
      </div>

      {items.length === 0 && <EmptyState title="No templates yet" subtitle="Create a Task or Excel template to assign to employees." />}

      <div className="space-y-3">
        {items.map((t) => {
          const st = statsByTpl.get(String(t._id)) || { total: 0, active: 0, freq: new Set() };
          const baseSub = t.templateType === 'excel'
            ? `${t.excelColumns?.length || 0} field(s) • ${(t.excelColumns || []).filter((c) => c.markEligible).reduce((s, c) => s + (c.maxMarks || 0), 0)} total marks`
            : t.templateType === 'sheet'
            ? `${t.sheet?.rowCount || 0}×${t.sheet?.colCount || 0} grid • ${(t.sheet?.scoring || []).length} scoring target(s) • ${totalSheetMarks(t.sheet?.scoring)} total marks`
            : t.templateType === 'custom'
            ? (() => {
                const fc = (t.customFields || []).length;
                const sc = (t.customSections || []).length;
                const parts = [];
                if (fc > 0) parts.push(`${fc} field(s)`);
                if (sc > 0) parts.push(`${sc} sub-table(s) (${(t.customSections || []).join(', ')})`);
                if (parts.length === 0) parts.push('empty');
                if (t.customKind) parts.push(`kind: ${t.customKind}`);
                if (t.isActive === false) parts.push('inactive');
                return parts.join(' • ');
              })()
            : `${t.tasks.length} task(s) • ${t.tasks.reduce((s, x) => s + (x.points || 0), 0)} total points`;
          const usageSub = st.total > 0
            ? ` • ${st.total} assignment(s) (${st.active} active, ${st.total - st.active} paused) • ${[...st.freq].join(', ')}`
            : ' • not assigned yet';
          return (
          <Collapsible
            key={t._id}
            title={
              <span className="flex items-center gap-2">
                {t.title}
                {t.templateType === 'excel'
                  ? <span className="badge-blue">Excel Report</span>
                  : t.templateType === 'sheet'
                  ? <span className="badge-green">Spreadsheet</span>
                  : t.templateType === 'custom'
                  ? <span className="badge bg-indigo-50 text-indigo-700">Custom</span>
                  : <span className="badge-gray">Task</span>}
                {st.total > 0 && <span className="badge-amber">{st.total} assigned</span>}
              </span>
            }
            subtitle={baseSub + usageSub}
            right={<div className="flex gap-1">
              <button className="btn-ghost" onClick={() => setModal({ mode: 'edit', data: t })}>Edit</button>
              <button className="btn-ghost" onClick={() => startClone(t)}>Clone</button>
              <button className="btn-ghost text-red-600" onClick={() => del(t._id)}>Delete</button>
            </div>}
          >
            {t.templateType === 'excel'
              ? <ExcelColumnsPreview cols={t.excelColumns} />
              : t.templateType === 'sheet'
              ? <SheetGrid sheet={t.sheet} mode="readonly" showHidden scoreMap={buildScoreMap(t.sheet?.scoring)} height={260} />
              : t.templateType === 'custom'
              ? <CustomFieldsPreview tpl={t} />
              : <TaskPreview tasks={t.tasks} />}
          </Collapsible>
        ); })}
      </div>

      {modal && (modal.data.templateType === 'excel'
        ? <ExcelTemplateForm modal={modal} setModal={setModal} onSave={save} />
        : modal.data.templateType === 'sheet'
        ? <SheetTemplateForm modal={modal} setModal={setModal} onSave={save} />
        : modal.data.templateType === 'custom'
        ? <CustomTemplateForm modal={modal} setModal={setModal} onSave={save} />
        : <TaskTemplateForm modal={modal} setModal={setModal} onSave={save} />)}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Custom Assignment template -- read-only preview + metadata editor.  */
/*                                                                     */
/* The visual field-builder ships as a follow-up.  For now HR can:     */
/*   - View every defined field (name, type, group, formula, required, */
/*     visibility) in a clean table.                                   */
/*   - Edit the metadata (title / description / kind / active flag).   */
/*   - Clone an existing custom template (from the Templates list) so  */
/*     they get the field structure as a starting point.               */
/* ------------------------------------------------------------------ */
/* Friendly label + description for each well-known sub-table. */
const CUSTOM_SECTION_META = {
  productSales: {
    label: 'Product Sales',
    description: 'Repeating rows of (Product, Quantity). Sales Value and NBV are auto-calculated from Product Master at submit time.',
    employeeCols: ['Product (dropdown)', 'Quantity (dropdown)', 'Sales Value (auto)', 'NBV Value (auto)'],
  },
  farmerRecords: {
    label: 'Farmer Records',
    description: 'Repeating farmer-detail rows (name, mobile, village, dealer, product, quantity).',
    employeeCols: ['Farmer Name', 'Mobile', 'Village', 'Dealer Location', 'Product', 'Quantity'],
  },
};

function CustomFieldsPreview({ tpl }) {
  const fields = (tpl.customFields || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const sections = (tpl.customSections || []).filter(Boolean);

  // Group scalar fields by their `group` (for the bottom table view).
  const groups = [];
  const seenGroups = new Map();
  for (const f of fields) {
    const g = f.group || 'General';
    if (!seenGroups.has(g)) { seenGroups.set(g, groups.length); groups.push({ name: g, items: [] }); }
    groups[seenGroups.get(g)].items.push(f);
  }

  return (
    <div className="space-y-3">
      {tpl.customKind && (
        <div className="text-[12px] text-slate-600">
          Analytics kind: <code className="px-1 py-0.5 bg-slate-100 rounded">{tpl.customKind}</code>
          {tpl.customKind === 'calling' && <span className="ml-2 text-slate-500">(surfaced in Performance → Calling Analytics)</span>}
          {tpl.customKind === 'product_farmer' && <span className="ml-2 text-slate-500">(surfaced in Performance → Calling Analytics → Product &amp; Farmer Report)</span>}
        </div>
      )}

      {/* Opt-in repeating sub-tables (productSales, farmerRecords, ...). */}
      {sections.length > 0 && (
        <div className="space-y-3">
          {sections.map((s) => {
            const meta = CUSTOM_SECTION_META[s] || { label: s, description: '', employeeCols: [] };
            return (
              <div key={s} className="rounded-lg border border-indigo-100 bg-indigo-50/40">
                <div className="px-3 py-2 bg-indigo-50 text-[11px] font-semibold uppercase tracking-wide text-indigo-800 flex items-center justify-between">
                  <span>Section: {meta.label}</span>
                  <span className="text-[10px] text-indigo-700 font-mono">{s}</span>
                </div>
                <div className="p-3 space-y-2 text-sm">
                  {meta.description && <div className="text-slate-600">{meta.description}</div>}
                  {meta.employeeCols.length > 0 && (
                    <div className="text-[12px] text-slate-700">
                      <span className="font-semibold">Row columns:</span> {meta.employeeCols.join(' · ')}
                    </div>
                  )}
                  <div className="text-[11px] text-slate-500">Employee can add unlimited rows.</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state -- no fields AND no sections. */}
      {fields.length === 0 && sections.length === 0 && (
        <div className="text-sm text-slate-500 italic">
          No fields or sections defined yet. Use Clone on an existing custom template (e.g. Daily Calling Report) to copy its structure, or wait for the visual field builder.
        </div>
      )}

      {/* Scalar custom fields, grouped. */}
      {groups.map((g) => (
        <div key={g.name} className="rounded-lg border border-slate-200">
          <div className="px-3 py-2 bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-700">{g.name}</div>
          <table className="table">
            <thead>
              <tr>
                <th>Label</th><th>Key</th><th>Type</th>
                <th>Required</th><th>Visible To</th><th>Formula</th>
              </tr>
            </thead>
            <tbody>
              {g.items.map((f) => (
                <tr key={f.key}>
                  <td className="font-medium text-slate-800">{f.label}</td>
                  <td className="font-mono text-[11px] text-slate-500">{f.key}</td>
                  <td><span className="badge-gray">{f.fieldType}</span></td>
                  <td>{f.required ? <span className="badge-amber">required</span> : <span className="text-slate-400">-</span>}</td>
                  <td className="text-[11px] text-slate-600">{(f.visibleTo || []).join(', ') || 'everyone'}</td>
                  <td className="font-mono text-[11px] text-slate-600">
                    {f.formula ? f.formula : f.systemGenerated ? <span className="text-indigo-600">system-generated</span> : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Phase 12: Custom Template Builder                                  */
/* ------------------------------------------------------------------ */
function CustomTemplateForm({ modal, setModal, onSave }) {
  const form = modal.data;
  const set = (k, v) => setModal({ ...modal, data: { ...form, [k]: v } });
  const [departments, setDepartments] = useState([]);
  const [errors, setErrors] = useState({}); // { errorKey: 'message' }
  const fieldRefs = useRef({});             // { errorKey: DOM input/textarea/select }
  const summaryRef = useRef(null);
  const toast = useToast();
  useEffect(() => {
    api.get('/departments').then((r) => setDepartments(r.data || [])).catch(() => setDepartments([]));
  }, []);

  /* ---- Error registry helpers ---- */
  const setRef = (errorKey) => (el) => { if (el) fieldRefs.current[errorKey] = el; };
  const focusField = (errorKey) => {
    const el = fieldRefs.current[errorKey];
    if (!el) return;
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
    setTimeout(() => { try { el.focus(); } catch (_) {} }, 280);
  };
  const clearError = (errorKey) => {
    setErrors((prev) => {
      if (!prev[errorKey]) return prev;
      const { [errorKey]: _drop, ...rest } = prev;
      return rest;
    });
  };

  /**
   * Single-pass validator.  Collects EVERY error rather than bailing on
   * the first one so the summary panel can list them all and HR can
   * fix in any order.  Returns a map of errorKey -> message; empty
   * map = ready to save.
   *
   * errorKey conventions (must match setRef + focusField):
   *   title                       Template Name
   *   sub_<subId>_name            Sub-template name
   *   field_<idx>_label           Task Work Name
   *   field_<idx>_key             Task Field Key
   *   field_<idx>_formula         Auto-calc formula
   *   field_<idx>_options         Dropdown options
   *   _noTasks                    Template-level "needs at least one task"
   */
  const validate = (fieldsRaw, subsRaw) => {
    const errs = {};
    if (!(form.title || '').trim()) errs.title = 'Template Name is required';
    subsRaw.forEach((s, i) => {
      if (!(s.name || '').trim()) errs[`sub_${s._id}_name`] = `Sub-Template #${i + 1}: Name is required`;
    });
    const seenKeys = new Set();
    let filledRows = 0;
    fieldsRaw.forEach((f, idx) => {
      const label = (f.label || '').trim();
      const key   = (f.key   || '').trim();
      const desc  = (f.description || '').trim();
      const anyFilled = !!(label || key || desc || (f.formula || '').trim() || (Array.isArray(f.options) && f.options.length > 0));
      if (!anyFilled) return;             // fully blank rows are dropped, not errored
      filledRows += 1;
      const tag = label || `Task #${idx + 1}`;
      if (!label) errs[`field_${idx}_label`] = `Task #${idx + 1}: Work Name is required`;
      if (!key) {
        errs[`field_${idx}_key`] = `Task "${tag}": Field Key is required`;
      } else if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
        errs[`field_${idx}_key`] = `Task "${tag}": Field Key must start with a letter and use only letters, digits, or underscores`;
      } else if (seenKeys.has(key)) {
        errs[`field_${idx}_key`] = `Task "${tag}": Field Key "${key}" is duplicated`;
      } else {
        seenKeys.add(key);
      }
      if (f.fieldType === 'auto' && !(f.formula || '').trim()) {
        errs[`field_${idx}_formula`] = `Auto-calc task "${tag}": Formula is required`;
      }
      if (f.fieldType === 'dropdown' && (!Array.isArray(f.options) || f.options.filter(Boolean).length === 0)) {
        errs[`field_${idx}_options`] = `Dropdown task "${tag}": at least one option is required`;
      }
    });
    if (filledRows === 0) errs._noTasks = 'Add at least one task. The template has no fields to submit.';
    return errs;
  };

  /**
   * Submit pipeline.  Runs validate() up front and, if anything blocks,
   * shows the summary + red borders + inline messages and scrolls to
   * the first invalid field.  The Save button stays enabled in every
   * state so HR always gets feedback.
   */
  const handleSave = () => {
    try {
      const fieldsRaw = Array.isArray(form.customFields) ? form.customFields : [];
      const subsRaw   = Array.isArray(form.subTemplates) ? form.subTemplates : [];

      const errs = validate(fieldsRaw, subsRaw);
      const errKeys = Object.keys(errs);
      if (errKeys.length > 0) {
        setErrors(errs);
        // Scroll the summary into view first, then focus the first
        // invalid field so the user sees the full context.
        setTimeout(() => {
          try { summaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {}
          const first = errKeys[0] === '_noTasks' && errKeys.length > 1 ? errKeys[1] : errKeys[0];
          if (first !== '_noTasks') focusField(first);
        }, 50);
        return;
      }
      setErrors({});

      // Strip fully-empty rows + sanitise survivors.  Same logic the
      // validator implicitly approved.
      const cleaned = [];
      for (let i = 0; i < fieldsRaw.length; i += 1) {
        const f = fieldsRaw[i];
        const label = (f.label || '').trim();
        const key   = (f.key   || '').trim();
        const desc  = (f.description || '').trim();
        const anyFilled = !!(label || key || desc || (f.formula || '').trim() || (Array.isArray(f.options) && f.options.length > 0));
        if (!anyFilled) continue;
        const sid = String(f.subTemplateId || '');
        const subStillExists = sid === '' || subsRaw.some((s) => String(s._id) === sid);
        cleaned.push({
          key, label,
          fieldType: f.fieldType || 'number',
          required: !!f.required,
          options: Array.isArray(f.options) ? f.options.map((o) => String(o).trim()).filter(Boolean) : [],
          group: (f.group || '').trim(),
          description: desc,
          formula: (f.formula || '').trim(),
          systemGenerated: !!f.systemGenerated,
          visibleTo: Array.isArray(f.visibleTo) && f.visibleTo.length > 0
            ? f.visibleTo
            : ['employee', 'hod', 'hr', 'super_admin'],
          order: Number(f.order) || 0,
          subTemplateId: subStillExists ? sid : '',
          supportsStatus: !!f.supportsStatus,
          supportsRemark: f.supportsRemark !== false,
          // Phase 52 -- keep the two remark flags consistent in the
          // outgoing payload.  Server does the same normalisation, but
          // this saves a round-trip when the checkbox is untouched.
          remarkRequired: (f.supportsRemark !== false) && !!f.remarkRequired,
          dependencyType: f.dependencyType === 'dependent' ? 'dependent' : 'independent',
          isAnalyticsEligible: f.isAnalyticsEligible !== false,
        });
      }

      const payload = {
        ...form,
        title:         (form.title || '').trim(),
        description:   (form.description || '').trim(),
        analyticsName: (form.analyticsName || '').trim(),
        customKind:    (form.customKind || '').trim().toLowerCase(),
        reviewFlow:    form.reviewFlow === 'hod_first' ? 'hod_first' : 'direct_hr',
        department:    form.department && /^[a-f0-9]{24}$/i.test(form.department) ? form.department : null,
        isActive:      form.isActive !== false,
        subTemplates:  subsRaw.map((s) => ({
          _id: typeof s._id === 'string' && s._id.startsWith('tmp_') ? undefined : s._id,
          name: String(s.name || '').trim(),
          description: String(s.description || '').trim(),
          isActive: s.isActive !== false,
          order: Number(s.order) || 0,
        })),
        customFields:  cleaned,
      };

      onSave(payload);
    } catch (err) {
      console.error('[CustomTemplateForm] handleSave failed:', err);
      toast.error(`Could not prepare save payload: ${err.message}`);
    }
  };

  // Stable temporary id for newly-created sub-templates so customFields
  // can reference them before the row hits the database.
  const _newSubId = () => `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const subs = form.subTemplates || [];
  const fields = form.customFields || [];

  const addSubTemplate = () => {
    set('subTemplates', [...subs, { _id: _newSubId(), name: '', description: '', isActive: true, order: subs.length * 10 }]);
  };
  const updateSubTemplate = (id, patch) => {
    set('subTemplates', subs.map((s) => (String(s._id) === String(id) ? { ...s, ...patch } : s)));
  };
  const removeSubTemplate = (id) => {
    if (!confirm('Delete this sub-template and unlink all its tasks? Tasks will be moved back to "Template root".')) return;
    set('subTemplates', subs.filter((s) => String(s._id) !== String(id)));
    // Re-parent any field that referenced this sub-template.
    set('customFields', fields.map((f) => (String(f.subTemplateId || '') === String(id) ? { ...f, subTemplateId: '' } : f)));
  };

  const _maxOrderIn = (subId) => fields
    .filter((f) => String(f.subTemplateId || '') === String(subId || ''))
    .reduce((m, f) => Math.max(m, Number(f.order) || 0), 0);

  const addField = (subId = '') => {
    const next = [...fields, {
      key: '',
      label: '',
      fieldType: 'number',
      required: false,
      options: [],
      group: '',
      description: '',
      formula: '',
      systemGenerated: false,
      visibleTo: ['employee', 'hod', 'hr', 'super_admin'],
      order: _maxOrderIn(subId) + 10,
      subTemplateId: subId || '',
      supportsStatus: false,
      supportsRemark: true,
      // Phase 52 -- new fields default to remark-not-required; HR
      // opts in via the checkbox when they want a hard remark gate.
      remarkRequired: false,
      dependencyType: 'independent',
      isAnalyticsEligible: true,
    }];
    set('customFields', next);
  };
  const updateField = (idx, patch) => {
    set('customFields', fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };
  const removeField = (idx) => set('customFields', fields.filter((_, i) => i !== idx));
  // Move a field up / down WITHIN its sub-template scope.
  const moveField = (idx, dir) => {
    const f = fields[idx]; if (!f) return;
    const sib = fields
      .map((x, i) => ({ x, i }))
      .filter(({ x }) => String(x.subTemplateId || '') === String(f.subTemplateId || ''));
    const pos = sib.findIndex(({ i }) => i === idx);
    const swapAt = pos + (dir === 'up' ? -1 : 1);
    if (swapAt < 0 || swapAt >= sib.length) return;
    const a = sib[pos].i, b = sib[swapAt].i;
    const next = fields.slice();
    [next[a], next[b]] = [next[b], next[a]];
    // Re-stamp order field so the backend persists the sequence.
    let counter = 10;
    set('customFields', next.map((x) => {
      if (String(x.subTemplateId || '') !== String(f.subTemplateId || '')) return x;
      return { ...x, order: (counter += 10) };
    }));
  };

  // Group fields for the UI: { 'root': [...], subId: [...] }.
  const groupedFields = (() => {
    const root = [];
    const bySub = new Map();
    fields.forEach((f, idx) => {
      const sid = String(f.subTemplateId || '');
      if (!sid) root.push({ ...f, __idx: idx });
      else {
        if (!bySub.has(sid)) bySub.set(sid, []);
        bySub.get(sid).push({ ...f, __idx: idx });
      }
    });
    return { root, bySub };
  })();

  return (
    <Modal
      open
      size="xl"
      onClose={() => setModal(null)}
      title={modal.mode === 'create' ? 'Create Custom Assignment Template' : `Edit ${form.title || 'Custom Template'}`}
      footer={<>
        <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
        {/* Phase 12 bug fix: never disable Save silently -- every
            blocking condition raises a specific toast inside handleSave
            so HR knows what to fix.  Empty / half-filled task rows are
            stripped before the payload is sent. */}
        <button className="btn-primary" onClick={handleSave}>Save</button>
      </>}
    >
      <div className="space-y-5">
        {/* ----- Validation summary panel (Phase 12.9) ----- */}
        {Object.keys(errors).length > 0 && (
          <div
            ref={summaryRef}
            className="rounded-lg border border-red-300 bg-red-50 p-3"
            role="alert"
            aria-live="polite"
          >
            <div className="text-sm font-semibold text-red-800 mb-1.5">
              Cannot save template. Fix {Object.keys(errors).length} issue(s):
            </div>
            <ul className="space-y-0.5 text-sm">
              {Object.entries(errors).map(([k, msg]) => (
                <li key={k}>
                  <button
                    type="button"
                    className={`text-left text-red-700 ${k === '_noTasks' ? '' : 'hover:underline cursor-pointer'}`}
                    onClick={() => k !== '_noTasks' && focusField(k)}
                  >
                    • {msg}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ----- Metadata ----- */}
        <Section title="Template Settings">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="label">
                Template Name <span className="text-red-500">*</span>
              </label>
              <input
                ref={setRef('title')}
                className={`input ${errors.title ? 'border-red-400 ring-1 ring-red-200' : ''}`}
                value={form.title || ''}
                onChange={(e) => { set('title', e.target.value); clearError('title'); }}
                placeholder="e.g. Accounts Template"
              />
              {errors.title && <div className="text-xs text-red-600 mt-1">{errors.title}</div>}
            </div>
            <div>
              <label className="label">Analytics Name</label>
              <input
                className="input"
                value={form.analyticsName || ''}
                onChange={(e) => set('analyticsName', e.target.value)}
                placeholder={`Auto: "${(form.title || '').replace(/\s*(Template|Report|Form)s?\s*$/i, '')} Analytics"`}
              />
              <div className="text-[11px] text-slate-500 mt-1">Defaults to "(Name) Analytics" if blank.</div>
            </div>
            <div>
              <label className="label">Department</label>
              <select className="input" value={form.department || ''} onChange={(e) => set('department', e.target.value)}>
                <option value="">— Global (all departments) —</option>
                {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
              </select>
              <div className="text-[11px] text-slate-500 mt-1">HOD analytics view shows only their department's templates.</div>
            </div>
            <div>
              <label className="label">Review Flow</label>
              <select className="input" value={form.reviewFlow || 'direct_hr'} onChange={(e) => set('reviewFlow', e.target.value)}>
                <option value="direct_hr">Employee → HR</option>
                <option value="hod_first">Employee → HOD → HR</option>
              </select>
            </div>
            <div>
              <label className="label">Analytics Kind (legacy)</label>
              <input
                className="input"
                value={form.customKind || ''}
                onChange={(e) => set('customKind', e.target.value.trim().toLowerCase())}
                placeholder="e.g. calling, product_farmer"
              />
              <div className="text-[11px] text-slate-500 mt-1">Optional. Reserved values: <code>calling</code>, <code>product_farmer</code>.</div>
            </div>
            <div>
              <label className="label">Status</label>
              <label className="flex items-center gap-2 text-sm input bg-white">
                <input type="checkbox" checked={form.isActive !== false} onChange={(e) => set('isActive', e.target.checked)} />
                Active (assignable to employees)
              </label>
            </div>
          </div>
          <div className="mt-3">
            <label className="label">Description</label>
            <textarea
              className="input"
              rows={2}
              value={form.description || ''}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Short description for HR and employees"
            />
          </div>
        </Section>

        {/* ----- Sub-templates ----- */}
        <Section
          title={`Sub-Templates (${subs.length})`}
          right={<button className="btn-secondary !py-1 !text-xs" type="button" onClick={addSubTemplate}>+ Add Sub-Template</button>}
        >
          {subs.length === 0 ? (
            <div className="text-xs text-slate-500 italic">No sub-templates yet — every task you add will live in the template root. Sub-templates let you group tasks (Billing / Collections / Ledger / Reconciliation, etc.) and assign just one sub-template to an employee.</div>
          ) : (
            <div className="space-y-2">
              {subs.map((s) => {
                const subErrKey = `sub_${s._id}_name`;
                const subErr = errors[subErrKey];
                return (
                <div key={s._id} className="rounded-lg border border-slate-200 p-2.5 bg-slate-50/40 space-y-2">
                  <div className="grid grid-cols-12 gap-2">
                    <div className="col-span-4">
                      <label className="label text-[10px] uppercase">
                        Sub-Template Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        ref={setRef(subErrKey)}
                        className={`input ${subErr ? 'border-red-400 ring-1 ring-red-200' : ''}`}
                        value={s.name}
                        onChange={(e) => { updateSubTemplate(s._id, { name: e.target.value }); clearError(subErrKey); }}
                        placeholder="e.g. Billing"
                      />
                      {subErr && <div className="text-xs text-red-600 mt-1">{subErr}</div>}
                    </div>
                    <div className="col-span-6">
                      <label className="label text-[10px] uppercase">Description</label>
                      <input className="input" value={s.description || ''} onChange={(e) => updateSubTemplate(s._id, { description: e.target.value })} placeholder="Optional" />
                    </div>
                    <div className="col-span-2 flex items-end justify-end">
                      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={s.isActive !== false} onChange={(e) => updateSubTemplate(s._id, { isActive: e.target.checked })} /> Active</label>
                      <button type="button" className="btn-ghost text-red-600 !px-2" onClick={() => removeSubTemplate(s._id)}>✕</button>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* ----- Task / Field builder, grouped by sub-template ----- */}
        <Section title={`Tasks / Fields (${fields.length})`}>
          <FieldsGroup
            label="Template root"
            subId=""
            entries={groupedFields.root}
            onAdd={() => addField('')}
            onUpdate={updateField}
            onRemove={removeField}
            onMove={moveField}
            disabled={subs.length > 0 && groupedFields.root.length === 0}
            errors={errors}
            setRef={setRef}
            clearError={clearError}
          />
          {subs.map((s) => (
            <FieldsGroup
              key={s._id}
              label={s.name || '(unnamed sub-template)'}
              subId={s._id}
              entries={groupedFields.bySub.get(String(s._id)) || []}
              onAdd={() => addField(s._id)}
              onUpdate={updateField}
              onRemove={removeField}
              onMove={moveField}
              errors={errors}
              setRef={setRef}
              clearError={clearError}
            />
          ))}
        </Section>
      </div>
    </Modal>
  );
}

function Section({ title, right, children }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="px-3 py-2 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">{title}</div>
        {right}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function FieldsGroup({ label, subId, entries, onAdd, onUpdate, onRemove, onMove, disabled, errors, setRef, clearError }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[11px] font-semibold text-slate-700 uppercase">{label} <span className="text-slate-400 font-normal">· {entries.length} task(s)</span></div>
        <button type="button" className="btn-ghost !text-xs !py-0.5" onClick={onAdd} disabled={disabled}>+ Add Task</button>
      </div>
      {entries.length === 0 ? (
        <div className="text-[11px] text-slate-400 italic px-2">No tasks yet.</div>
      ) : (
        <div className="space-y-2">
          {entries.map((f, i) => (
            <TaskFieldRow
              key={f.__idx}
              field={f}
              isFirst={i === 0}
              isLast={i === entries.length - 1}
              onPatch={(p) => onUpdate(f.__idx, p)}
              onRemove={() => onRemove(f.__idx)}
              onMove={(dir) => onMove(f.__idx, dir)}
              errors={errors}
              setRef={setRef}
              clearError={clearError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Phase 53 -- Dropdown Options editor.
 *
 * The previous implementation round-tripped the textarea's value
 * through `split('\n').map(trim).filter(Boolean)` on every keystroke.
 * That meant Enter (which creates an empty line for a moment while
 * the user starts typing the next option) was silently swallowed,
 * trailing spaces were eaten, and the caret jumped back when the
 * parent re-rendered.
 *
 * The fix: keep a local string that drives the textarea, only
 * commit the normalised array on blur (or when the field's options
 * prop is updated externally, e.g. after a reset).  Enter and
 * spaces now behave exactly like a native <textarea>.
 */
function DropdownOptionsEditor({ options, onCommit, hasError, errorMessage, registerRef, clearError, errCls }) {
  const initial = Array.isArray(options) ? options.join('\n') : '';
  const [text, setText] = useState(initial);
  // If the parent replaces the options array (e.g. reset / clone), fold
  // the change back into our local buffer.  We compare on the joined
  // string so identical arrays with different references don't cause
  // caret jumps.
  useEffect(() => {
    const next = Array.isArray(options) ? options.join('\n') : '';
    setText((cur) => (cur === next ? cur : next));
  }, [options]);

  const commit = () => {
    const normalised = text.split('\n').map((s) => s.trim()).filter(Boolean);
    // Only push upward if the normalised list actually changed —
    // avoids marking the form dirty on a bare focus/blur.
    const current = Array.isArray(options) ? options : [];
    const changed = current.length !== normalised.length
      || current.some((v, i) => v !== normalised[i]);
    if (changed) onCommit(normalised);
  };

  return (
    <div>
      <label className="label text-[10px] uppercase">
        Dropdown Options <span className="text-red-500">*</span>{' '}
        <span className="text-slate-400 normal-case font-normal">(one per line)</span>
      </label>
      <textarea
        ref={registerRef}
        className={`input font-mono text-xs ${hasError ? errCls : ''}`}
        rows={4}
        value={text}
        onChange={(e) => { setText(e.target.value); clearError?.(); }}
        onBlur={commit}
        placeholder={'Excellent\nGood\nAverage\nPoor'}
      />
      {hasError && <div className="text-[11px] text-red-600 mt-0.5">{errorMessage}</div>}
    </div>
  );
}

function TaskFieldRow({ field, isFirst, isLast, onPatch, onRemove, onMove, errors = {}, setRef = () => () => {}, clearError = () => {} }) {
  const f = field;
  const idx = f.__idx;
  // Error registry keys must match the ones validate() emits.
  const eLabel   = `field_${idx}_label`;
  const eKey     = `field_${idx}_key`;
  const eFormula = `field_${idx}_formula`;
  const eOpts    = `field_${idx}_options`;
  // Tailwind classnames for invalid inputs.
  const errCls = 'border-red-400 ring-1 ring-red-200';
  return (
    <div className="rounded-lg border border-slate-200 p-2.5 bg-slate-50/40 space-y-2">
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-3">
          <label className="label text-[10px] uppercase">
            Work Name <span className="text-red-500">*</span>
          </label>
          <input
            ref={setRef(eLabel)}
            className={`input ${errors[eLabel] ? errCls : ''}`}
            value={f.label}
            onChange={(e) => {
              const label = e.target.value;
              const next = { label };
              if (!f.key || f.key === _slug(f.__lastLabel || '')) {
                next.key = _slug(label);
                next.__lastLabel = label;
              }
              onPatch(next);
              clearError(eLabel);
              if (next.key) clearError(eKey);
            }}
            placeholder="e.g. Bills Generated Within 1 Hour"
          />
          {errors[eLabel] && <div className="text-[11px] text-red-600 mt-0.5">{errors[eLabel]}</div>}
        </div>
        <div className="col-span-2">
          <label className="label text-[10px] uppercase">
            Field Key <span className="text-red-500">*</span>
          </label>
          <input
            ref={setRef(eKey)}
            className={`input ${errors[eKey] ? errCls : ''}`}
            value={f.key}
            onChange={(e) => { onPatch({ key: _slug(e.target.value) }); clearError(eKey); }}
            placeholder="auto"
          />
          {errors[eKey] && <div className="text-[11px] text-red-600 mt-0.5">{errors[eKey]}</div>}
        </div>
        <div className="col-span-2">
          <label className="label text-[10px] uppercase">Value Type</label>
          <select className="input" value={f.fieldType} onChange={(e) => onPatch({ fieldType: e.target.value })}>
            {CUSTOM_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            {/* If an existing field uses a legacy type that's no longer in
                the builder list, surface it so HR can see it (and switch
                it to Number/Dropdown if they want).  Doesn't break the
                value; the backend still accepts the legacy type. */}
            {f.fieldType && !CUSTOM_FIELD_TYPES.some((t) => t.value === f.fieldType) && (
              <option value={f.fieldType}>{f.fieldType} (legacy)</option>
            )}
          </select>
        </div>
        <div className="col-span-2">
          <label className="label text-[10px] uppercase">Dependency</label>
          <select className="input" value={f.dependencyType || 'independent'} onChange={(e) => onPatch({ dependencyType: e.target.value })}>
            <option value="independent">Independent</option>
            <option value="dependent">Dependent</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className="label text-[10px] uppercase">Group</label>
          <input className="input" value={f.group || ''} onChange={(e) => onPatch({ group: e.target.value })} placeholder="(optional)" />
        </div>
        <div className="col-span-1 flex items-end justify-end gap-1">
          <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-xs" disabled={isFirst} onClick={() => onMove('up')} title="Move up">↑</button>
          <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-xs" disabled={isLast}  onClick={() => onMove('down')} title="Move down">↓</button>
          <button type="button" className="btn-ghost text-red-600 !px-1.5 !py-0.5 text-xs" onClick={onRemove} title="Remove">✕</button>
        </div>
      </div>
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-12">
          <label className="label text-[10px] uppercase">Description (shown read-only on employee form)</label>
          <input className="input" value={f.description || ''} onChange={(e) => onPatch({ description: e.target.value })} placeholder="Optional helper text" />
        </div>
      </div>
      {/* Phase 14 fix: the "System-generated (carry-forward)" checkbox
          is removed.  It was an internal flag for the seeded Calling
          Report's yesterdayPending field (which uses
          fieldType: 'readonly' and never needed a user-facing toggle).
          Keeping it on the builder produced a single-click landmine:
          accidentally ticking it disabled the value input on the
          employee form forever.  Editability is now driven solely by
          Value Type.  Existing fields that carry the flag are
          unaffected -- the renderer no longer reads it. */}
      <div className="flex items-center gap-4 flex-wrap text-xs text-slate-700">
        <label className="flex items-center gap-1"><input type="checkbox" checked={!!f.required}             onChange={(e) => onPatch({ required: e.target.checked })} /> Required</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={!!f.supportsStatus}       onChange={(e) => onPatch({ supportsStatus: e.target.checked })} /> Status enabled (Done / Pending / Work N/A)</label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={f.supportsRemark !== false}
            onChange={(e) => onPatch({
              supportsRemark: e.target.checked,
              // Phase 52 -- keep the two flags consistent: turning off
              // Remark Enabled also clears Remark Required.
              ...(e.target.checked ? {} : { remarkRequired: false }),
            })}
          /> Remark enabled
        </label>
        {/* Phase 52 -- Remark Required only makes sense when Remark
            Enabled is on.  We render it disabled + coerced to false
            when supportsRemark is false so HR can't accidentally
            configure a field that requires an unrendered remark. */}
        <label className={`flex items-center gap-1 ${f.supportsRemark === false ? 'opacity-40 cursor-not-allowed' : ''}`}>
          <input
            type="checkbox"
            disabled={f.supportsRemark === false}
            checked={!!f.remarkRequired && f.supportsRemark !== false}
            onChange={(e) => onPatch({ remarkRequired: e.target.checked })}
          /> Remark required
        </label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={f.isAnalyticsEligible !== false} onChange={(e) => onPatch({ isAnalyticsEligible: e.target.checked })} /> Show on analytics</label>
      </div>
      {f.fieldType === 'auto' && (
        <div>
          <label className="label text-[10px] uppercase">
            Formula <span className="text-red-500">*</span>
          </label>
          <input
            ref={setRef(eFormula)}
            className={`input font-mono text-xs ${errors[eFormula] ? errCls : ''}`}
            value={f.formula || ''}
            onChange={(e) => { onPatch({ formula: e.target.value }); clearError(eFormula); }}
            placeholder="e.g. assignedCalls - todayCallsCompleted"
          />
          {errors[eFormula]
            ? <div className="text-[11px] text-red-600 mt-0.5">{errors[eFormula]}</div>
            : <div className="text-[10px] text-slate-500 mt-1">Reference other field keys with arithmetic only (+, -, *, /, parentheses). No function calls.</div>
          }
        </div>
      )}
      {f.fieldType === 'dropdown' && (
        <DropdownOptionsEditor
          options={f.options}
          onCommit={(nextOptions) => onPatch({ options: nextOptions })}
          hasError={!!errors[eOpts]}
          errorMessage={errors[eOpts]}
          registerRef={setRef(eOpts)}
          clearError={() => clearError(eOpts)}
          errCls={errCls}
        />
      )}
    </div>
  );
}

const _slug = (s) => String(s || '').trim().replace(/[^a-zA-Z0-9]+/g, ' ').trim()
  .split(' ').filter(Boolean)
  .map((w, i) => i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())
  .join('');

function TaskPreview({ tasks }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>#</th><th>Task</th><th>Points</th></tr></thead>
        <tbody>
          {(tasks || []).map((ti, idx) => (
            <tr key={ti._id || idx}>
              <td>{idx + 1}</td>
              <td className="font-medium">{ti.title}</td>
              <td>{ti.points}</td>
            </tr>
          ))}
          {!tasks?.length && <tr><td colSpan="3" className="text-center py-4 text-slate-500">No tasks</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Spreadsheet template builder - Marking Configuration Mode          */
/* ------------------------------------------------------------------ */

const colLetter = (n) => {
  let s = '';
  n = Number(n);
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};
const cellRef = (r, c) => `${colLetter(c)}${r + 1}`;

function SheetTemplateForm({ modal, setModal, onSave }) {
  const form = modal.data;
  const sheet = form.sheet || blankSheet.sheet;
  const toast = useToast();
  const fileRef = useRef(null);
  const [parsing, setParsing] = useState(false);
  const [selected, setSelected] = useState(null); // { r, c }

  const setData = (patch) => setModal({ ...modal, data: { ...form, ...patch } });
  const setSheet = (patch) => setData({ sheet: { ...sheet, ...patch } });

  const cells = sheet.cells || [];
  const columns = sheet.columns || [];
  const rows = sheet.rows || [];
  const scoring = sheet.scoring || [];
  // Display copies in canonical index order (mutations still match by .index)
  const sortedColumns = [...columns].sort((a, b) => a.index - b.index);
  const sortedRows = [...rows].sort((a, b) => a.index - b.index);

  const getCell = (r, c) => cells.find((x) => x.r === r && x.c === c);
  const scoreMap = useMemo(() => buildScoreMap(scoring), [scoring]);

  /* ---- upload + parse ---- */
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/templates/sheet/parse', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setSheet({ ...data, scoring: [], allowEmployeeAddRows: sheet.allowEmployeeAddRows });
      setSelected(null);
      toast.success(`Parsed ${data.rowCount}×${data.colCount} grid from ${data.sheetName}`);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /* ---- cell mutation ---- */
  const updateCell = (r, c, patch) => {
    let found = false;
    const next = cells.map((x) => {
      if (x.r === r && x.c === c) { found = true; return { ...x, ...patch }; }
      return x;
    });
    if (!found) next.push({ r, c, value: '', role: 'input', fieldType: 'text', editable: true, hidden: false, options: [], ...patch });
    setSheet({ cells: next });
  };

  // Edits a cell's text, keeping header/row-label metadata in sync.
  const setCellValue = (r, c, value) => {
    updateCell(r, c, { value });
    if (r === 0) setSheet({ columns: columns.map((co) => (co.index === c ? { ...co, label: String(value) } : co)) });
    if (c === 0) setSheet({ rows: rows.map((rw) => (rw.index === r ? { ...rw, label: String(value) } : rw)) });
  };

  /* ---- column / row meta ---- */
  const updateColumn = (c, patch) => setSheet({ columns: columns.map((co) => (co.index === c ? { ...co, ...patch } : co)) });
  const updateRow = (r, patch) => setSheet({ rows: rows.map((rw) => (rw.index === r ? { ...rw, ...patch } : rw)) });

  const colFieldType = (c) => (cells.find((x) => x.c === c && x.role === 'input')?.fieldType) || 'text';
  const setColFieldType = (c, ft) =>
    setSheet({ cells: cells.map((x) => (x.c === c && x.role === 'input' ? { ...x, fieldType: ft } : x)) });

  /* ---- add / remove rows & columns ---- */
  const addRow = () => {
    const r = sheet.rowCount;
    const newCells = columns.map((co) => ({
      r, c: co.index, value: '',
      role: co.index === 0 ? 'label' : 'input',
      fieldType: colFieldType(co.index),
      editable: co.index !== 0, hidden: false, options: [],
    }));
    setSheet({ rowCount: r + 1, rows: [...rows, { index: r, label: String(r + 1), hidden: false }], cells: [...cells, ...newCells] });
  };
  const addColumn = () => {
    const c = sheet.colCount;
    const newCells = rows.map((rw) => ({
      r: rw.index, c, value: rw.index === 0 ? 'New Column' : '',
      role: rw.index === 0 ? 'label' : 'input',
      fieldType: 'text', editable: rw.index !== 0, hidden: false, options: [],
    }));
    setSheet({ colCount: c + 1, columns: [...columns, { index: c, label: 'New Column', width: 140, hidden: false }], cells: [...cells, ...newCells] });
  };
  const removeColumn = (c) => setSheet({
    columns: columns.filter((co) => co.index !== c),
    cells: cells.filter((x) => x.c !== c),
    scoring: scoring.filter((s) => !(s.colIndex === c)),
  });
  const removeRow = (r) => setSheet({
    rows: rows.filter((rw) => rw.index !== r),
    cells: cells.filter((x) => x.r !== r),
    scoring: scoring.filter((s) => !(s.rowIndex === r && s.type !== 'column')),
  });

  /* ---- scoring ---- */
  const upsertScore = (next) => {
    const key = scoreKey(next);
    setSheet({ scoring: [...scoring.filter((s) => scoreKey(s) !== key), next] });
  };
  const removeScore = (key) => setSheet({ scoring: scoring.filter((s) => scoreKey(s) !== key) });
  const scoreFor = (type, r, c) =>
    scoring.find((s) => s.type === type && (type === 'cell' ? s.rowIndex === r && s.colIndex === c : type === 'row' ? s.rowIndex === r : s.colIndex === c));

  const toggleColScore = (c, on) => on
    ? upsertScore({ type: 'column', colIndex: c, label: columns.find((x) => x.index === c)?.label || colLetter(c), maxMarks: 10 })
    : removeScore(`col:${c}`);
  const toggleRowScore = (r, on) => on
    ? upsertScore({ type: 'row', rowIndex: r, label: rows.find((x) => x.index === r)?.label || `Row ${r + 1}`, maxMarks: 10 })
    : removeScore(`row:${r}`);
  const toggleCellScore = (r, c, on) => on
    ? upsertScore({ type: 'cell', rowIndex: r, colIndex: c, label: cellRef(r, c), maxMarks: 5 })
    : removeScore(`cell:${r}:${c}`);
  // Per-row status tracking (only meaningful once the row is scored).
  const toggleRowStatus = (r, on) => {
    const sc = scoreFor('row', r, null);
    if (!sc) return;
    upsertScore({ ...sc, statusTracking: on });
  };

  const selCell = selected ? getCell(selected.r, selected.c) : null;
  const hasGrid = (sheet.colCount || 0) > 0;

  return (
    <Modal open size="xl" onClose={() => setModal(null)}
      title={modal.mode === 'create' ? 'Create Spreadsheet Template' : 'Edit Spreadsheet Template'}
      footer={<>
        <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn-primary" onClick={() => onSave(form)}>Save Template</button>
      </>}>
      <div className="space-y-4">
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="label">Title</label>
            <input className="input" value={form.title} onChange={(e) => setData({ title: e.target.value })} placeholder="e.g. Daily Telecalling Report" />
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" value={form.description || ''} onChange={(e) => setData({ description: e.target.value })} placeholder="What this report tracks" />
          </div>
        </div>

        {/* Upload */}
        <div className="bg-slate-50 border border-dashed border-slate-300 rounded-lg p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-800">Upload workbook (.xlsx / .xls / .csv)</div>
              <div className="text-xs text-slate-500">The original layout, labels and merged cells are preserved. You then configure scoring &amp; hidden fields below.</div>
            </div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={onFile} disabled={parsing} />
          </div>
          {parsing && <div className="text-xs text-brand-600 mt-2">Parsing...</div>}
        </div>

        {hasGrid ? (
          <>
            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-secondary !py-1" onClick={addRow}>+ Row</button>
                <button className="btn-secondary !py-1" onClick={addColumn}>+ Column</button>
                <label className="flex items-center gap-1 text-xs text-slate-600 ml-2">
                  <input type="checkbox" checked={!!sheet.allowEmployeeAddRows} onChange={(e) => setSheet({ allowEmployeeAddRows: e.target.checked })} />
                  Let employees add rows
                </label>
              </div>
              <div className="text-sm text-slate-600">
                {scoring.length} scoring target(s) • Total marks: <span className="text-brand-700 font-semibold">{totalSheetMarks(scoring)}</span>
              </div>
            </div>

            {/* Scoring modes + status tracking */}
            <div className="bg-indigo-50/60 border border-indigo-100 rounded-lg p-3 text-xs text-slate-600">
              <div>
                <span className="font-semibold text-slate-800">Scoring modes:</span>{' '}
                mark a whole <b>row</b> (Rows table), a whole <b>column</b> (Columns table), or an
                <b> individual cell</b> (click any cell). All three can be combined on the same sheet.
              </div>
              <div className="mt-1">
                <span className="font-semibold text-slate-800">Status tracking is per-row:</span>{' '}
                enable it on any scored row (Rows table) to turn that row into a workflow task —
                the employee then gets a <b>Done / Pending / Work Not Available</b> dropdown plus a dependency hand-off.
              </div>
            </div>

            {/* Live preview - click a cell to configure it */}
            <div>
              <div className="text-xs text-slate-500 mb-1">Click any cell to edit its label / type / scoring. Hidden rows &amp; columns are shown with a hatch pattern (HR-only).</div>
              <SheetGrid sheet={sheet} mode="readonly" showHidden scoreMap={scoreMap} selectedCell={selected} onCellClick={(r, c) => setSelected({ r, c })} height={320} />
            </div>

            {/* Cell inspector */}
            {selCell && (
              <div className="card card-body space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-900">Cell {cellRef(selected.r, selected.c)}</div>
                  <button className="btn-ghost !py-0.5" onClick={() => setSelected(null)}>Close</button>
                </div>
                <div className="grid md:grid-cols-3 gap-3">
                  <div>
                    <label className="label">Role</label>
                    <select className="input" value={selCell.role} onChange={(e) => updateCell(selected.r, selected.c, { role: e.target.value, editable: e.target.value === 'input' })}>
                      <option value="label">Label (read-only text)</option>
                      <option value="static">Static (preset value)</option>
                      <option value="input">Input (employee fills)</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Field type</label>
                    <select className="input" value={selCell.fieldType} disabled={selCell.role !== 'input'} onChange={(e) => updateCell(selected.r, selected.c, { fieldType: e.target.value })}>
                      {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">{selCell.role === 'input' ? 'Placeholder / preset' : 'Text'}</label>
                    <input className="input" value={selCell.role === 'input' ? '' : String(selCell.value ?? '')} placeholder={selCell.role === 'input' ? '(employee will fill)' : ''} disabled={selCell.role === 'input'} onChange={(e) => setCellValue(selected.r, selected.c, e.target.value)} />
                  </div>
                </div>
                {selCell.fieldType === 'dropdown' && selCell.role === 'input' && (
                  <div>
                    <label className="label">Dropdown options (comma-separated)</label>
                    <input className="input" value={(selCell.options || []).join(', ')} onChange={(e) => updateCell(selected.r, selected.c, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                  </div>
                )}
                <div className="flex items-center gap-3 bg-amber-50 border border-amber-100 rounded-lg p-3">
                  <label className="flex items-center gap-1 text-sm text-slate-700">
                    <input type="checkbox" checked={!!scoreFor('cell', selected.r, selected.c)} onChange={(e) => toggleCellScore(selected.r, selected.c, e.target.checked)} />
                    Score this cell
                  </label>
                  {scoreFor('cell', selected.r, selected.c) && (
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-slate-500">Max marks</span>
                      <input className="input w-20" type="number" min="0" value={scoreFor('cell', selected.r, selected.c).maxMarks}
                        onChange={(e) => upsertScore({ type: 'cell', rowIndex: selected.r, colIndex: selected.c, label: cellRef(selected.r, selected.c), maxMarks: Number(e.target.value) })} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Columns config */}
            <div>
              <div className="text-sm font-semibold text-slate-800 mb-2">Columns</div>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>#</th><th>Label</th><th>Input type</th><th>Hidden</th><th>Score column</th><th>Max</th><th></th></tr></thead>
                  <tbody>
                    {sortedColumns.map((co) => {
                      const sc = scoreFor('column', null, co.index);
                      return (
                        <tr key={co.index}>
                          <td className="text-slate-400">{colLetter(co.index)}</td>
                          <td><input className="input" value={co.label} onChange={(e) => { updateColumn(co.index, { label: e.target.value }); setCellValue(0, co.index, e.target.value); }} /></td>
                          <td>
                            <select className="input" value={colFieldType(co.index)} onChange={(e) => setColFieldType(co.index, e.target.value)}>
                              {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </td>
                          <td className="text-center"><input type="checkbox" checked={!!co.hidden} onChange={(e) => updateColumn(co.index, { hidden: e.target.checked })} /></td>
                          <td className="text-center"><input type="checkbox" checked={!!sc} onChange={(e) => toggleColScore(co.index, e.target.checked)} /></td>
                          <td><input className="input w-20" type="number" min="0" disabled={!sc} value={sc ? sc.maxMarks : ''} onChange={(e) => upsertScore({ type: 'column', colIndex: co.index, label: co.label || colLetter(co.index), maxMarks: Number(e.target.value) })} /></td>
                          <td><button className="btn-ghost text-red-600" onClick={() => removeColumn(co.index)}>✕</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Rows config */}
            <div>
              <div className="text-sm font-semibold text-slate-800 mb-2">Rows</div>
              <div className="text-[11px] text-slate-500 mb-2">
                Tick <b>Score row</b> to make a row scorable, then <b>Status tracking</b> to turn it into a
                workflow task row — the employee gets a Done / Pending / Work Not Available dropdown + dependency hand-off for that row.
              </div>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>#</th><th>Label</th><th>Hidden</th><th>Score row</th><th>Max</th><th>Status tracking</th><th></th></tr></thead>
                  <tbody>
                    {sortedRows.map((rw) => {
                      const sc = scoreFor('row', rw.index, null);
                      return (
                        <tr key={rw.index}>
                          <td className="text-slate-400">{rw.index + 1}</td>
                          <td><input className="input" value={rw.label} onChange={(e) => { updateRow(rw.index, { label: e.target.value }); setCellValue(rw.index, 0, e.target.value); }} /></td>
                          <td className="text-center"><input type="checkbox" checked={!!rw.hidden} onChange={(e) => updateRow(rw.index, { hidden: e.target.checked })} /></td>
                          <td className="text-center"><input type="checkbox" checked={!!sc} onChange={(e) => toggleRowScore(rw.index, e.target.checked)} /></td>
                          <td><input className="input w-20" type="number" min="0" disabled={!sc} value={sc ? sc.maxMarks : ''} onChange={(e) => upsertScore({ ...(sc || { type: 'row', rowIndex: rw.index, label: rw.label || `Row ${rw.index + 1}` }), type: 'row', rowIndex: rw.index, label: rw.label || `Row ${rw.index + 1}`, maxMarks: Number(e.target.value) })} /></td>
                          <td className="text-center" title={sc ? 'Make this row a Done/Pending/Work-Not-Available task row' : 'Enable Score row first'}>
                            <input type="checkbox" disabled={!sc} checked={!!(sc && sc.statusTracking)} onChange={(e) => toggleRowStatus(rw.index, e.target.checked)} />
                          </td>
                          <td><button className="btn-ghost text-red-600" onClick={() => removeRow(rw.index)}>✕</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <div className="text-xs text-slate-500 italic px-3 py-6 bg-slate-50 rounded-lg border border-dashed border-slate-200 text-center">
            Upload a workbook above to begin. Its rows, columns and labels will be preserved here for you to configure.
          </div>
        )}
      </div>
    </Modal>
  );
}

function ExcelColumnsPreview({ cols }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>#</th><th>Field</th><th>Type</th><th>Mark eligible?</th><th>Max marks</th>
          </tr>
        </thead>
        <tbody>
          {(cols || []).map((c, i) => (
            <tr key={c._id || i}>
              <td>{i + 1}</td>
              <td className="font-medium">{c.fieldName}</td>
              <td className="capitalize">{c.fieldType}</td>
              <td>{c.markEligible ? <span className="badge-green">Yes</span> : <span className="badge-gray">No</span>}</td>
              <td>{c.markEligible ? c.maxMarks : '-'}</td>
            </tr>
          ))}
          {!cols?.length && <tr><td colSpan="5" className="text-center py-4 text-slate-500">No fields</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Task template form (unchanged shape, just lives here now)          */
/* ------------------------------------------------------------------ */

/**
 * Parse a clipboard paste from Excel / Google Sheets / Numbers / etc.
 *
 * Each non-empty line becomes one task.  Accepts (in order of preference):
 *   - "Title\tPoints"     two columns, tab-separated (the native format
 *                         when you copy two columns from a spreadsheet)
 *   - "Title,Points"      comma-separated with a numeric tail
 *   - "Title 5"           plain text where the last whitespace-separated
 *                         token is a number
 *   - "Title"             single column / no points -> defaults to 1pt
 *
 * Negative or NaN point values fall back to 1.  Empty lines are dropped.
 */
function parsePastedTasks(text) {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.includes('\t')) {
        const [title, pts] = line.split('\t').map((s) => s.trim());
        return { title, points: Math.max(0, Number(pts) || 1) };
      }
      if (line.includes(',')) {
        const idx = line.lastIndexOf(',');
        const tail = line.slice(idx + 1).trim();
        if (/^\d+(\.\d+)?$/.test(tail)) {
          return { title: line.slice(0, idx).trim(), points: Math.max(0, Number(tail)) };
        }
      }
      const m = line.match(/^(.+?)\s+(\d+(?:\.\d+)?)$/);
      if (m) return { title: m[1].trim(), points: Math.max(0, Number(m[2])) };
      return { title: line, points: 1 };
    })
    .filter((t) => t.title);
}

function TaskTemplateForm({ modal, setModal, onSave }) {
  const form = modal.data;
  const set = (k, v) => setModal({ ...modal, data: { ...form, [k]: v } });
  const [pasteOpen, setPasteOpen] = useState(false);
  const addTask = () => set('tasks', [...(form.tasks || []), { title: '', points: 1 }]);
  const updateTask = (i, patch) => {
    const arr = [...form.tasks];
    arr[i] = { ...arr[i], ...patch };
    set('tasks', arr);
  };
  const removeTask = (i) => set('tasks', form.tasks.filter((_, idx) => idx !== i));

  return (
    <Modal open size="lg" onClose={() => setModal(null)} title={modal.mode === 'create' ? 'Create Task Template' : 'Edit Task Template'}
      footer={<>
        <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn-primary" onClick={() => onSave(form)}>Save</button>
      </>}>
      <div className="space-y-3">
        <div><label className="label">Title</label><input className="input" value={form.title} onChange={(e) => set('title', e.target.value)} /></div>
        <div><label className="label">Description</label><input className="input" value={form.description || ''} onChange={(e) => set('description', e.target.value)} /></div>
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="label !mb-0">Tasks</label>
            <div className="flex gap-2">
              <button className="btn-secondary !py-1" onClick={() => setPasteOpen(true)}>Paste from Excel</button>
              <button className="btn-secondary !py-1" onClick={addTask}>+ Add task</button>
            </div>
          </div>
          <div className="space-y-2">
            {(form.tasks || []).map((t, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input className="input flex-1" placeholder="Task title" value={t.title} onChange={(e) => updateTask(i, { title: e.target.value })} />
                <input className="input w-24" type="number" min="0" placeholder="0" value={t.points || ''} onChange={(e) => updateTask(i, { points: Number(e.target.value) })} />
                <button className="btn-ghost text-red-600" onClick={() => removeTask(i)}>✕</button>
              </div>
            ))}
            {!form.tasks?.length && <div className="text-sm text-slate-500">No tasks added yet.</div>}
          </div>
        </div>
      </div>

      {pasteOpen && (
        <PasteTasksModal
          existingCount={(form.tasks || []).length}
          onClose={() => setPasteOpen(false)}
          onSubmit={(rows, mode) => {
            const next = mode === 'replace'
              ? rows
              : [...(form.tasks || []), ...rows];
            set('tasks', next);
            setPasteOpen(false);
          }}
        />
      )}
    </Modal>
  );
}

/**
 * Sub-modal that takes a clipboard paste (one or two columns from Excel /
 * Sheets) and turns it into a list of { title, points }.  HR previews the
 * parse below the textarea so they can spot bad rows BEFORE inserting,
 * and chooses to Append (default) or Replace the template's task list.
 */
function PasteTasksModal({ existingCount, onClose, onSubmit }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState('append');
  const parsed = parsePastedTasks(text);
  const canSubmit = parsed.length > 0;
  return (
    <Modal
      open
      size="md"
      onClose={onClose}
      title="Paste tasks from Excel / Sheets"
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!canSubmit} onClick={() => onSubmit(parsed, mode)}>
          {mode === 'replace' ? 'Replace' : 'Append'} {parsed.length} task{parsed.length === 1 ? '' : 's'}
        </button>
      </>}
    >
      <div className="space-y-3">
        <div className="text-[12px] text-slate-600">
          Copy a column (titles) or two columns (titles + points) from Excel / Google Sheets
          and paste below. Each non-empty line becomes one task. Tab, comma, or "Title 5"
          are all accepted; rows with no points default to <code>1</code>.
        </div>
        <textarea
          className="input font-mono text-[13px]"
          rows={8}
          autoFocus
          placeholder={'Invoice Verification\t5\nBank Reconciliation\t10\nDaily Stock Check\t8'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="radio" name="paste-mode" checked={mode === 'append'} onChange={() => setMode('append')} />
            Append to existing tasks ({existingCount} already in template)
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="radio" name="paste-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
            Replace all existing tasks
          </label>
        </div>

        {parsed.length > 0 && (
          <div className="rounded-lg border border-slate-200 max-h-56 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-1.5 font-semibold text-slate-700 w-12">#</th>
                  <th className="text-left px-3 py-1.5 font-semibold text-slate-700">Title</th>
                  <th className="text-left px-3 py-1.5 font-semibold text-slate-700 w-20">Points</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map((t, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-1 font-mono text-xs text-slate-500">{i + 1}</td>
                    <td className="px-3 py-1 text-slate-800">{t.title}</td>
                    <td className="px-3 py-1 font-mono text-xs text-slate-600">{t.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {text.trim() && parsed.length === 0 && (
          <div className="text-xs text-amber-700">
            No valid task lines detected. Each non-empty line becomes one task.
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Excel template form - upload, parse, configure columns             */
/* ------------------------------------------------------------------ */

function ExcelTemplateForm({ modal, setModal, onSave }) {
  const form = modal.data;
  const set = (k, v) => setModal({ ...modal, data: { ...form, [k]: v } });
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState(null);
  const fileRef = useRef(null);
  const toast = useToast();

  const cols = form.excelColumns || [];

  const updateCol = (i, patch) => {
    const arr = [...cols];
    arr[i] = { ...arr[i], ...patch };
    set('excelColumns', arr);
  };
  const removeCol = (i) => set('excelColumns', cols.filter((_, idx) => idx !== i));
  const addCol = () => set('excelColumns', [
    ...cols,
    { fieldName: '', fieldType: 'text', markEligible: false, maxMarks: 0, options: [] },
  ]);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/templates/excel/parse', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setPreview({ rows: data.preview, totalRows: data.totalRows, sheetName: data.sheetName });
      // Merge parsed columns with whatever HR already configured (by name)
      const existingByName = new Map(cols.map((c) => [c.fieldName, c]));
      const merged = data.columns.map((c) => existingByName.get(c.fieldName) || c);
      set('excelColumns', merged);
      toast.success(`Parsed ${data.columns.length} column(s) from ${data.sheetName}`);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const totalMaxMarks = cols.filter((c) => c.markEligible).reduce((s, c) => s + Number(c.maxMarks || 0), 0);

  return (
    <Modal open size="xl" onClose={() => setModal(null)}
      title={modal.mode === 'create' ? 'Create Excel Reporting Template' : 'Edit Excel Reporting Template'}
      footer={<>
        <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn-primary" onClick={() => onSave(form)}>Save Template</button>
      </>}>
      <div className="space-y-4">
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="label">Title</label>
            <input className="input" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Daily Telecalling Report" />
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" value={form.description || ''} onChange={(e) => set('description', e.target.value)} placeholder="What this report tracks" />
          </div>
        </div>

        {/* Upload */}
        <div className="bg-slate-50 border border-dashed border-slate-300 rounded-lg p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-800">Upload sample workbook (.xlsx / .xls / .csv)</div>
              <div className="text-xs text-slate-500">
                We'll parse the column headers and suggest field types. Nothing is stored beyond the structure.
              </div>
            </div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={onFile} disabled={parsing} />
          </div>
          {parsing && <div className="text-xs text-brand-600 mt-2">Parsing...</div>}
          {preview && (
            <div className="mt-3 bg-white border border-slate-200 rounded p-2">
              <div className="text-[11px] text-slate-500 mb-1">
                Sheet: <b>{preview.sheetName}</b> • {preview.totalRows} data row(s) • preview of first {preview.rows.length}
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs border-collapse">
                  <thead>
                    <tr>
                      {Object.keys(preview.rows[0] || {}).map((k) => (
                        <th key={k} className="border border-slate-200 px-2 py-1 text-left font-semibold text-slate-600 bg-slate-50">{k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, i) => (
                      <tr key={i}>
                        {Object.values(row).map((v, j) => (
                          <td key={j} className="border border-slate-100 px-2 py-1 text-slate-700">{String(v ?? '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Status tracking toggle */}
        <label className="flex items-center gap-2 text-sm text-slate-700 bg-indigo-50/60 border border-indigo-100 rounded-lg p-3">
          <input type="checkbox" checked={!!form.statusTracking} onChange={(e) => set('statusTracking', e.target.checked)} />
          Enable Status Tracking
          <span className="text-[11px] text-slate-400">— each mark-eligible field gets a Done / Pending / Work Not Available status + dependency hand-off at submission time.</span>
        </label>

        {/* Column editor */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <div className="text-sm font-semibold text-slate-800">
              Columns ({cols.length}) • Total max marks: <span className="text-brand-700">{totalMaxMarks}</span>
            </div>
            <button className="btn-secondary !py-1" onClick={addCol}>+ Add field</button>
          </div>

          {cols.length === 0 ? (
            <div className="text-xs text-slate-500 italic px-3 py-4 bg-slate-50 rounded-lg border border-dashed border-slate-200">
              Upload a workbook above, or click + Add field to start from scratch.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Field name</th>
                    <th>Type</th>
                    <th>Mark eligible</th>
                    <th>Max marks</th>
                    <th>Options (dropdown)</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {cols.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <input className="input" value={c.fieldName} onChange={(e) => updateCol(i, { fieldName: e.target.value })} />
                      </td>
                      <td>
                        <select className="input" value={c.fieldType} onChange={(e) => updateCol(i, { fieldType: e.target.value })}>
                          {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      <td className="text-center">
                        <input type="checkbox" checked={!!c.markEligible} onChange={(e) => updateCol(i, { markEligible: e.target.checked, maxMarks: e.target.checked ? (c.maxMarks || 5) : 0 })} />
                      </td>
                      <td>
                        <input
                          className="input w-24"
                          type="number" min="0"
                          placeholder="0"
                          value={c.maxMarks || ''}
                          disabled={!c.markEligible}
                          onChange={(e) => updateCol(i, { maxMarks: Number(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          placeholder="Comma-separated"
                          disabled={c.fieldType !== 'dropdown'}
                          value={(c.options || []).join(', ')}
                          onChange={(e) => updateCol(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                        />
                      </td>
                      <td>
                        <button className="btn-ghost text-red-600" onClick={() => removeCol(i)}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
