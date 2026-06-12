import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import Collapsible from '../../components/Collapsible.jsx';
import StatCard from '../../components/StatCard.jsx';
import SheetGrid from '../../components/SheetGrid.jsx';
import SheetWorkflowGrid from '../../components/SheetWorkflowGrid.jsx';
import UpcomingEventsWidget from '../../components/UpcomingEventsWidget.jsx';
import ScheduleTag from '../../components/ScheduleTag.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import useDraftAutosave from '../../hooks/useDraftAutosave';
import { useToast } from '../../context/ToastContext.jsx';
import { delayBadgeClass, delayLabel, errMsg, fmtDate } from '../../utils/helpers';

/* ------------------------------------------------------------------ */
/* Phase 19: Draft autosave status pill + Save Draft button.          */
/*                                                                    */
/* Renders a thin strip at the top of every unsubmitted submission    */
/* card.  Mounts useDraftAutosave for THIS submission only -- each    */
/* card gets its own hook instance so they autosave independently.    */
/* ------------------------------------------------------------------ */
function DraftAutosaveBar({ sub, buildPayload }) {
  const { status, savedAt, saveNow } = useDraftAutosave({
    submissionId: sub._id,
    buildPayload,
    initialSavedAt: sub.lastDraftSavedAt,
    enabled: !sub.submitted,
  });
  const fmt = (d) => d
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  let label = '';
  let cls = 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  if (status === 'saving') { label = 'Saving…'; cls = 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'; }
  else if (status === 'dirty') { label = 'Unsaved changes'; cls = 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'; }
  else if (status === 'saved' && savedAt) { label = `Saved at ${fmt(savedAt)}`; cls = 'bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-300'; }
  else if (status === 'error') { label = 'Save failed — will retry'; cls = 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'; }
  else if (savedAt)              { label = `Last saved at ${fmt(savedAt)}`; }
  else                           { label = 'Draft autosaves every 30s'; }
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-slate-100 bg-slate-50/40 dark:bg-slate-800/40 dark:border-slate-700 flex-wrap">
      <div className="flex items-center gap-2 text-[12px]">
        <span className={`badge text-[10px] ${cls}`}>{label}</span>
        <span className="text-slate-500 dark:text-slate-400 text-[11px]">
          Your work is saved as you go. Refreshes are safe.
        </span>
      </div>
      <button
        type="button"
        className="btn-secondary !py-1 !text-xs"
        onClick={saveNow}
        disabled={status === 'saving'}
      >
        {status === 'saving' ? 'Saving…' : 'Save Draft'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tiny client-side mirror of the backend formula evaluator.           */
/* Same alphabet whitelist + key substitution.  Used only for the live */
/* preview as the employee types; the server re-evaluates on submit.   */
/* ------------------------------------------------------------------ */
const CUSTOM_SAFE_RE = /^[\s\d+\-*/().a-zA-Z_]+$/;
const customEval = (expr, values) => {
  if (!expr || !CUSTOM_SAFE_RE.test(expr)) return 0;
  let s = expr;
  const keys = Object.keys(values).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const v = Number(values[k]) || 0;
    s = s.replace(new RegExp(`\\b${k}\\b`, 'g'), `(${v})`);
  }
  s = s.replace(/[a-zA-Z_][a-zA-Z0-9_]*/g, '0');
  try {
    // eslint-disable-next-line no-new-func
    const out = Number(new Function(`"use strict"; return (${s});`)());
    return Number.isFinite(out) ? out : 0;
  } catch (_) { return 0; }
};
const customCompute = (fields, raw) => {
  const ctx = { ...raw };
  const ordered = (fields || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const f of ordered) {
    if (f.fieldType === 'auto' && f.formula) ctx[f.key] = customEval(f.formula, ctx);
    else if (f.fieldType === 'number') ctx[f.key] = Number(ctx[f.key]) || 0;
    else if (ctx[f.key] === undefined) ctx[f.key] = '';
  }
  return ctx;
};

export default function EmployeeDashboard({ embedded = false } = {}) {
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  // Local UI state per task
  const [taskState, setTaskState] = useState({}); // { submissionId: { taskId: {status, pendingReason} } }
  const [selfRating, setSelfRating] = useState({});
  const [selfNote, setSelfNote] = useState({});
  const [idea, setIdea] = useState({});
  const [excelValues, setExcelValues] = useState({}); // { subId: { fieldName: value } }
  // Employee-added tasks per submission: title-only rows the employee
  // can append.  Marks come later from HR review.
  const [addedTasks, setAddedTasks] = useState({}); // { subId: [{ title }] }
  // Custom-template field values per submission: { subId: { key: value } }.
  const [customValues, setCustomValues] = useState({});
  // Phase 14: per-field { status, remark } sidecar so the renderer can
  // expose status + remark controls without breaking the existing
  // values shape.  Stored as { subId: { fieldKey: { status, remark } } }.
  const [customMeta, setCustomMeta] = useState({});
  // Product Sales rows per submission: { subId: [{ productId, quantityId }] }
  const [productSales, setProductSales] = useState({});
  // Farmer rows per submission: { subId: [{ name, mobile, ... }] }
  const [farmerRecords, setFarmerRecords] = useState({});
  // Master data (Products / Quantities / Dealers) for the custom-template dropdowns.
  const [products, setProducts] = useState([]);
  const [quantities, setQuantities] = useState([]);
  const [dealers, setDealers] = useState([]);
  const [sheetState, setSheetState] = useState({}); // { subId: workingSheet }
  // Per-row task status for sheet "task rows" (scored rows with statusTracking)
  // { subId: { [scoreKey]: { rowStatus, pendingReason, dependencyType, dependencyAssignedTo, dependencyRemark } } }
  const [sheetStatus, setSheetStatus] = useState({});
  const [assignable, setAssignable] = useState([]); // users for dependency hand-off
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const [myDeps, setMyDeps] = useState([]); // dependency work assigned to me

  // Roster of accounts a dependency can be handed to (any active user).
  useEffect(() => {
    api.get('/dependencies/assignable').then((r) => setAssignable(r.data || [])).catch(() => {});
  }, []);

  const loadDeps = () =>
    api.get('/dependencies/mine', { params: { status: 'all' } }).then((r) => setMyDeps(r.data || [])).catch(() => {});
  useEffect(() => { loadDeps(); }, []);

  // Pre-load active master data so custom-template forms have ready
  // dropdowns.  Cheap (small payload), single fetch on mount, used only
  // when a custom template with productSales / farmerRecords surfaces.
  useEffect(() => {
    api.get('/products', { params: { activeOnly: 'true' } }).then((r) => setProducts(r.data || [])).catch(() => setProducts([]));
    api.get('/quantities', { params: { activeOnly: 'true' } }).then((r) => setQuantities(r.data || [])).catch(() => setQuantities([]));
    api.get('/dealers',  { params: { activeOnly: 'true' } }).then((r) => setDealers(r.data || [])).catch(() => setDealers([]));
  }, []);

  const resolveDep = async (id) => {
    try { await api.post(`/dependencies/${id}/resolve`, {}); toast.success('Dependency resolved'); loadDeps(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  /**
   * Phase 19: build the draft payload for ONE submission, using the
   * same shape the submit endpoint accepts so a manual Save Draft and
   * Submit Report produce identical bodies (only the URL differs).
   * Backend's /draft handler raw-persists this; /submit validates and
   * runs auto-formulas.  Because the same payload is reusable, the
   * autosave hook can call this on every interval without knowing
   * anything template-specific.
   */
  const buildDraftPayload = (sub) => {
    if (!sub || sub.submitted) return {};
    const payload = {
      selfRating: selfRating[sub._id],
      selfNote:   selfNote[sub._id],
      idea:       idea[sub._id],
    };
    if (sub.templateType === 'custom') {
      const raw = customValues[sub._id] || {};
      const metaForSub = customMeta[sub._id] || {};
      payload.customResponses = Object.entries(raw).map(([key, value]) => {
        const m = metaForSub[key] || {};
        return { key, value, status: m.status || '', remark: m.remark || '' };
      });
      const sections = sub.template?.customSections || [];
      if (sections.includes('productSales')) {
        payload.productSales = (productSales[sub._id] || [])
          .filter((r) => r.productId && (Number(r.quantity) > 0 || r.quantityId))
          .map((r) => ({
            productId: r.productId,
            quantity: Number(r.quantity) > 0 ? Number(r.quantity) : undefined,
            quantityId: r.quantityId || undefined,
          }));
      }
      if (sections.includes('farmerRecords')) {
        payload.farmerRecords = (farmerRecords[sub._id] || [])
          .filter((r) => (r.name || '').trim())
          .map((r) => ({
            name: r.name.trim(),
            mobile:  (r.mobile || '').trim(),
            village: (r.village || '').trim(),
            dealerLocation: (r.dealerLocation || '').trim(),
            dealerId: r.dealerId || undefined,
            products: (r.products || [])
              .filter((p) => p.productId && Number(p.quantity) > 0)
              .map((p) => ({ productId: p.productId, quantity: Number(p.quantity) })),
          }));
      }
    } else if (sub.templateType === 'excel') {
      const values = excelValues[sub._id] || {};
      payload.excelResponses = (sub.excelResponses || []).map((r) => ({
        fieldName: r.fieldName,
        value: values[r.fieldName] !== undefined ? values[r.fieldName] : r.value,
        rowStatus: r.rowStatus,
      }));
    } else if (sub.templateType === 'sheet') {
      const cur = sheetState[sub._id] || sub.sheet || { cells: [] };
      payload.sheet = {
        cells: (cur.cells || []).filter((c) => c.editable && c.role === 'input')
                                .map((c) => ({ r: c.r, c: c.c, value: c.value })),
        scores: ((sheetStatus[sub._id] && Object.entries(sheetStatus[sub._id]).map(([key, v]) => ({
          key, rowStatus: v.rowStatus, pendingReason: v.pendingReason,
        }))) || []),
      };
    } else {
      // Task template: tasks[] + addedTasks[].
      payload.tasks = (sub.tasks || []).map((t) => ({
        taskId: t._id,
        status: t.status,
        pendingReason: t.pendingReason,
      }));
      payload.addedTasks = (addedTasks[sub._id] || []).filter((t) => (t.title || '').trim());
    }
    return payload;
  };

  const load = async () => {
    setLoading(true);
    const [a, b] = await Promise.all([
      api.get('/submissions/today'),
      api.get('/dashboard/employee/summary'),
    ]);
    // Seed editable working copies for unsubmitted reports.
    //
    // Phase 19 fix: BEFORE this fix the loop only seeded `customValues`
    // (scalar custom-field values) and `sheetState`.  It did NOT seed
    // `productSales[sub._id]` / `farmerRecords[sub._id]` / `customMeta`.
    // Result: Save Draft persisted product / farmer rows correctly on
    // the server (the saveDraft endpoint writes them onto the
    // submission document), but on page reload the local state for
    // those two sub-tables stayed empty -- so the form rendered as if
    // the employee had never added anything.  Calling Report worked
    // because it only uses `customResponses` (scalar fields), which
    // WAS being seeded.
    //
    // We now seed productSales / farmerRecords / customMeta with the
    // SAME shape the form components expect (the ProductSalesSection
    // and FarmerRecordsSection row shapes).  Spread order keeps any
    // in-flight user edits in `prev` from being clobbered by a later
    // re-fetch.
    const seed = {};
    const customSeed = {};
    const customMetaSeed = {};
    const productSalesSeed = {};
    const farmerRecordsSeed = {};
    (a.data.submissions || []).forEach((s) => {
      if (s.templateType === 'sheet' && !s.submitted && s.sheet) {
        seed[s._id] = JSON.parse(JSON.stringify(s.sheet));
      }
      if (s.templateType === 'custom' && !s.submitted) {
        const ctx = {};
        const metaCtx = {};
        (s.customResponses || []).forEach((r) => {
          ctx[r.key] = r.value;
          // Phase 14 status + remark survive reload too.
          if ((r.status && r.status !== '') || (r.remark && r.remark !== '')) {
            metaCtx[r.key] = { status: r.status || '', remark: r.remark || '' };
          }
        });
        customSeed[s._id] = ctx;
        if (Object.keys(metaCtx).length > 0) customMetaSeed[s._id] = metaCtx;
        if (Array.isArray(s.productSales) && s.productSales.length > 0) {
          productSalesSeed[s._id] = s.productSales.map((r) => ({
            productId: r.productId ? String(r.productId) : '',
            // Prefer the raw `quantity` field (Phase 2 canonical input);
            // fall back to `quantityValue` for rows saved under the
            // legacy Quantity Master path.
            quantity:  r.quantity != null && r.quantity !== '' ? r.quantity
                     : r.quantityValue != null && r.quantityValue !== '' ? r.quantityValue : '',
            quantityId: r.quantityId ? String(r.quantityId) : '',
          }));
        }
        if (Array.isArray(s.farmerRecords) && s.farmerRecords.length > 0) {
          farmerRecordsSeed[s._id] = s.farmerRecords.map((r) => ({
            name:    r.name || '',
            mobile:  r.mobile || '',
            village: r.village || '',
            dealerLocation: r.dealerLocation || '',
            dealerId:    r.dealerId ? String(r.dealerId) : '',
            // Restore Place from the snapshot so it shows even if the
            // dealer was deactivated after the draft was saved.
            dealerPlace: r.dealerPlaceSnapshot || '',
            products: (r.products || []).map((p) => ({
              productId: p.productId ? String(p.productId) : '',
              quantity:  p.quantity != null && p.quantity !== '' ? p.quantity : '',
            })),
          }));
        }
      }
    });
    setCustomValues((prev) => ({ ...customSeed,        ...prev }));
    setCustomMeta((prev) =>   ({ ...customMetaSeed,    ...prev }));
    setProductSales((prev) => ({ ...productSalesSeed,  ...prev }));
    setFarmerRecords((prev) =>({ ...farmerRecordsSeed, ...prev }));
    setSheetState(seed);
    setData(a.data);
    setSummary(b.data);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  if (loading || !data) return <Loader />;

  const setTask = (subId, taskId, patch) =>
    setTaskState((s) => ({
      ...s,
      [subId]: { ...(s[subId] || {}), [taskId]: { ...(s[subId]?.[taskId] || { status: 'pending_submit' }), ...patch } },
    }));

  // ---- sheet (advanced spreadsheet) helpers ----
  const sheetColFieldType = (ws, c) =>
    (ws.cells.find((x) => x.c === c && x.role === 'input')?.fieldType) || 'text';

  const setSheetRowStatus = (subId, key, patch) =>
    setSheetStatus((s) => ({
      ...s,
      [subId]: { ...(s[subId] || {}), [key]: { ...(s[subId]?.[key] || { dependencyType: 'independent' }), ...patch } },
    }));

  const setSheetCell = (subId, r, c, value) =>
    setSheetState((s) => {
      const ws = s[subId];
      if (!ws) return s;
      const cells = ws.cells.map((x) => (x.r === r && x.c === c ? { ...x, value } : x));
      return { ...s, [subId]: { ...ws, cells } };
    });

  const addSheetRow = (subId) =>
    setSheetState((s) => {
      const ws = s[subId];
      if (!ws) return s;
      const r = ws.rowCount;
      const newCells = (ws.columns || []).map((co) => ({
        r, c: co.index, value: '', role: 'input',
        fieldType: sheetColFieldType(ws, co.index),
        editable: true, hidden: false, options: [], addedByEmployee: true,
      }));
      return {
        ...s,
        [subId]: {
          ...ws,
          rowCount: r + 1,
          rows: [...(ws.rows || []), { index: r, label: String(r + 1), hidden: false }],
          cells: [...ws.cells, ...newCells],
        },
      };
    });

  const submit = async (sub) => {
    setBusy(true);
    try {
      if (sub.templateType === 'sheet') {
        const ws = sheetState[sub._id] || sub.sheet;
        // Task rows = scored rows HR flagged with statusTracking.
        const taskRows = (ws.scores || []).filter((sc) => sc.statusTracking);
        const statusMap = sheetStatus[sub._id] || {};
        // Validate every task row has a status (+ reason / dependency fields).
        for (const sc of taskRows) {
          const st = statusMap[sc.key] || {};
          if (!['done', 'pending', 'work_not_available'].includes(st.rowStatus)) {
            toast.error(`Choose a status for: ${sc.label || 'task row'}`); setBusy(false); return;
          }
          if (st.rowStatus === 'pending' && !(st.pendingReason || '').trim()) {
            toast.error(`Reason required for pending row: ${sc.label || ''}`); setBusy(false); return;
          }
          if ((st.rowStatus === 'done' || st.rowStatus === 'pending') && st.dependencyType === 'dependent') {
            if (!st.dependencyAssignedTo) { toast.error(`Select who to assign: ${sc.label || ''}`); setBusy(false); return; }
            if (!(st.dependencyRemark || '').trim()) { toast.error(`Dependency remark required for: ${sc.label || ''}`); setBusy(false); return; }
          }
        }
        const scores = taskRows.map((sc) => {
          const st = statusMap[sc.key] || {};
          return {
            key: sc.key,
            rowStatus: st.rowStatus,
            pendingReason: st.pendingReason || '',
            dependencyType: st.dependencyType || 'independent',
            dependencyAssignedTo: st.dependencyType === 'dependent' ? st.dependencyAssignedTo : undefined,
            dependencyRemark: st.dependencyType === 'dependent' ? st.dependencyRemark : '',
          };
        });
        await api.post(`/submissions/${sub._id}/submit`, {
          sheet: { cells: ws.cells, scores },
          selfRating: selfRating[sub._id],
          selfNote: selfNote[sub._id],
          idea: idea[sub._id],
        });
      } else if (sub.templateType === 'excel') {
        const values = excelValues[sub._id] || {};
        const responses = sub.excelResponses.map((r) => ({
          fieldName: r.fieldName,
          value: values[r.fieldName] !== undefined ? values[r.fieldName] : r.value,
        }));
        await api.post(`/submissions/${sub._id}/submit`, {
          excelResponses: responses,
          selfRating: selfRating[sub._id],
          selfNote: selfNote[sub._id],
          idea: idea[sub._id],
        });
      } else if (sub.templateType === 'custom') {
        // Custom Assignment: send the employee-entered values; backend
        // will resolve `auto` formulas and validate `required` fields.
        const fields = sub.template?.customFields || [];
        const raw = customValues[sub._id] || {};
        // Required-field guard (matches backend); skip system / auto / readonly.
        for (const f of fields) {
          if (!f.required) continue;
          if (f.systemGenerated || f.fieldType === 'auto' || f.fieldType === 'readonly') continue;
          const v = raw[f.key];
          if (v === undefined || v === null || v === '') {
            toast.error(`Required field missing: ${f.label}`);
            setBusy(false);
            return;
          }
        }
        // Phase 14: include status + remark per field; dependent +
        // pending requires a remark (mirrors the backend guard).
        const metaForSub = customMeta[sub._id] || {};
        for (const f of fields) {
          const m = metaForSub[f.key] || {};
          if (m.status === 'pending' && !(m.remark || '').trim()) {
            toast.error(`Pending reason is required for "${f.label}".`);
            setBusy(false);
            return;
          }
        }
        const payload = Object.entries(raw).map(([key, value]) => {
          const m = metaForSub[key] || {};
          return { key, value, status: m.status || '', remark: m.remark || '' };
        });
        // Repeating sub-tables (any template that opts in via customSections).
        const sections = sub.template?.customSections || [];
        const cleanProductSales = sections.includes('productSales')
          ? (productSales[sub._id] || [])
              // New flow: productId + raw numeric quantity.  Legacy
              // submissions with quantityId still validate at backend.
              .filter((r) => r.productId && (Number(r.quantity) > 0 || r.quantityId))
              .map((r) => ({
                productId: r.productId,
                quantity: Number(r.quantity) > 0 ? Number(r.quantity) : undefined,
                quantityId: r.quantityId || undefined,
              }))
          : [];
        const cleanFarmers = sections.includes('farmerRecords')
          ? (farmerRecords[sub._id] || [])
              .filter((r) => (r.name || '').trim())
              .map((r) => ({
                name: r.name.trim(),
                mobile: (r.mobile || '').trim(),
                village: (r.village || '').trim(),
                // Legacy free-text dealer (unused by new flow but kept).
                dealerLocation: (r.dealerLocation || '').trim(),
                // New dealer dropdown.
                dealerId: r.dealerId || undefined,
                // Repeating products list.  Filter out half-filled rows.
                products: (r.products || [])
                  .filter((p) => p.productId && Number(p.quantity) > 0)
                  .map((p) => ({ productId: p.productId, quantity: Number(p.quantity) })),
              }))
          : [];
        await api.post(`/submissions/${sub._id}/submit`, {
          customResponses: payload,
          productSales: cleanProductSales,
          farmerRecords: cleanFarmers,
          selfRating: selfRating[sub._id],
          selfNote: selfNote[sub._id],
          idea: idea[sub._id],
        });
      } else {
        // Build per-task payload with the new Work Type + Forward To
        // fields.  When Dependent is chosen, the single Remark field
        // doubles as the `dependencyRemark` the backend's stampDependency
        // helper requires.
        const localTasks = sub.tasks.filter((t) => !t.addedByEmployee).map((t) => {
          const st = taskState[sub._id]?.[t._id] || { status: 'pending_submit' };
          const remark = (st.pendingReason || '').trim();
          // Dependency hand-off is meaningful for any actively-engaged
          // status (done / ongoing / pending) -- not for WNA or unselected.
          const engaged = st.status === 'done' || st.status === 'ongoing' || st.status === 'pending';
          const depType = engaged && st.dependencyType === 'dependent' ? 'dependent' : 'independent';
          const payload = {
            taskId: t._id,
            status: st.status,
            pendingReason: remark,
            dependencyType: depType,
          };
          if (depType === 'dependent') {
            payload.dependencyAssignedTo = st.dependencyAssignedTo || '';
            payload.dependencyRemark = remark;
          }
          return payload;
        });
        // ---- Validation ----
        if (localTasks.some((t) => t.status === 'pending_submit')) {
          toast.error('Please choose a status for every task');
          setBusy(false);
          return;
        }
        const missingRemark = localTasks.find((t) => t.status === 'pending' && !t.pendingReason);
        if (missingRemark) {
          toast.error('Remark required for all pending tasks');
          setBusy(false);
          return;
        }
        const dependentMissingAssignee = localTasks.find(
          (t) => t.dependencyType === 'dependent' && !t.dependencyAssignedTo,
        );
        if (dependentMissingAssignee) {
          toast.error('Select someone to forward to for every Dependent task');
          setBusy(false);
          return;
        }
        const dependentMissingRemark = localTasks.find(
          (t) => t.dependencyType === 'dependent' && !t.pendingReason,
        );
        if (dependentMissingRemark) {
          toast.error('Remark required for all Dependent tasks');
          setBusy(false);
          return;
        }
        // Trim and drop empty employee-added rows before sending.
        const myAdditions = (addedTasks[sub._id] || [])
          .map((x) => ({ title: String(x.title || '').trim() }))
          .filter((x) => x.title);
        await api.post(`/submissions/${sub._id}/submit`, {
          tasks: localTasks,
          addedTasks: myAdditions,
          selfRating: selfRating[sub._id],
          selfNote: selfNote[sub._id],
          idea: idea[sub._id],
        });
      }
      toast.success('Submitted!');
      load();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const markBacklogDone = async (item) => {
    try {
      await api.post('/submissions/backlog/complete', {
        submissionId: item.submissionId, taskId: item.taskId,
      });
      toast.success('Task marked complete');
      load();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <div className="space-y-6">
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold text-slate-900">My Dashboard</h1>
          <p className="text-sm text-slate-500">{fmtDate(data.date)}</p>
        </div>
      )}

      {!embedded && summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Replaced "30-day Completion %" -- a scoring metric -- with a
              plain submission count so employees still see their recent
              activity but no completion/evaluation score. */}
          <StatCard
            label="30-day Submissions"
            value={summary.last30Days.submissions}
            sub="submissions logged"
            accent="green"
          />
          <StatCard
            label="Pendency"
            value={summary.backlogCount}
            accent={summary.backlogCount > 0 ? 'red' : 'brand'}
          />
          <StatCard
            label="Leave Balance"
            value={(summary.leaveBalance?.yearlyAllowance || 0) - (summary.leaveBalance?.used || 0)}
            sub={`of ${summary.leaveBalance?.yearlyAllowance || 0}`}
            accent="blue"
            to="/my-leaves"
          />
          <StatCard
            label="Pending Leaves"
            value={summary.pendingLeaves}
            accent="amber"
            to="/my-leaves"
          />
        </div>
      )}

      {!embedded && <UpcomingEventsWidget limit={4} days={21} />}

      {/* Dependency Work assigned to me - hidden in embedded mode because
          the host (e.g. MyTasks) already has a richer, filterable inbox. */}
      {!embedded && myDeps.length > 0 && (() => {
        const open = myDeps.filter((d) => d.currentStatus !== 'resolved');
        return (
          <Collapsible
            title="Dependency Work"
            subtitle={`${open.length} open hand-off(s) assigned to you`}
            right={<span className={open.length === 0 ? 'badge-green' : 'badge-amber'}>{open.length}</span>}
            defaultOpen={open.length > 0}
          >
            {open.length === 0 ? (
              <div className="text-sm text-slate-500">No open dependency work. 🎉</div>
            ) : (
              <div className="space-y-2">
                {open.map((d) => {
                  const days = Math.max(0, Math.floor((Date.now() - new Date(d.waitingSince || d.createdAt)) / 86400000));
                  const prio = d.priority === 'high' ? 'badge-red' : d.priority === 'low' ? 'badge-gray' : 'badge-amber';
                  return (
                    <div key={d._id} className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-[200px]">
                          <div className="text-sm font-semibold text-slate-800">{d.originalTaskName || 'Dependency task'}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            From <b>{d.assignedBy?.name || d.assignedByName || 'Someone'}</b>
                            {d.departmentName ? ` · ${d.departmentName}` : ''}
                            {d.templateTitle ? ` · ${d.templateTitle}` : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={prio}>{(d.priority || 'normal').toUpperCase()}</span>
                          <span className="badge-gray">Waiting {days}d</span>
                          <button className="btn-secondary !py-1" onClick={() => resolveDep(d._id)}>Resolve</button>
                        </div>
                      </div>
                      {d.remark && <div className="text-xs text-slate-600 mt-2"><b>Remark:</b> {d.remark}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </Collapsible>
        );
      })()}

      {/* Leave / weekly off banners */}
      {data.onLeave && (
        <div className="card card-body bg-amber-50 border-amber-200">
          <div className="text-sm font-semibold text-amber-800">You are on approved leave today.</div>
          <div className="text-xs text-amber-700 mt-1">
            {data.leaveInfo.leaveType?.toUpperCase()} • {fmtDate(data.leaveInfo.fromDate)} – {fmtDate(data.leaveInfo.toDate)}
          </div>
        </div>
      )}
      {!data.onLeave && data.weeklyOff && (
        <div className="card card-body bg-blue-50 border-blue-200">
          <div className="text-sm font-semibold text-blue-800">Today is your weekly off. Enjoy your day!</div>
        </div>
      )}
      {!data.onLeave && data.holiday && (
        <div className="card card-body bg-purple-50 border-purple-200">
          <div className="text-sm font-semibold text-purple-800">Today is a holiday: {data.holiday.name}</div>
          {data.holiday.description && (
            <div className="text-xs text-purple-700 mt-1">{data.holiday.description}</div>
          )}
          <div className="text-[11px] text-purple-700 mt-1 capitalize">Type: {data.holiday.type}</div>
        </div>
      )}
      {!data.onLeave && data.workingDespiteOff && (
        <div className="card card-body bg-amber-50 border-amber-200">
          <div className="text-sm font-semibold text-amber-900">
            Working day today (HR override)
          </div>
          <div className="text-xs text-amber-800 mt-1">
            {data.weeklyOffOriginal
              ? 'Today is normally your weekly off, but HR has assigned override work below.'
              : data.holidayOriginal
              ? `Today is normally a holiday (${data.holidayOriginal.name}), but HR has assigned override work below.`
              : 'HR has assigned override work to a non-working day.'}
          </div>
        </div>
      )}

      {/* Today's tasks per submission */}
      {!data.onLeave && !data.weeklyOff && !data.holiday && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Today's Tasks</h2>
          {/* Phase 5: Daily Reflection lives ONCE per day, even if the
              employee has multiple assignments.  Stored at
              /api/daily-reflection keyed by (employee, date). */}
          <DailyReflectionCard />
          {data.submissions.length === 0 && (
            <EmptyState title="No tasks assigned for today" subtitle="HR has not assigned any templates to you yet." />
          )}
          {data.submissions.map((sub) => (
            <Collapsible
              key={sub._id}
              defaultOpen
              title={sub.template?.title || 'Template'}
              subtitle={sub.scheduleLabel || (sub.submitted ? 'Submitted'
                : sub.templateType === 'sheet' ? 'Spreadsheet report'
                : sub.templateType === 'excel' ? 'Excel report'
                : `${sub.tasks.length} task(s)`)}
              right={<span className="inline-flex items-center gap-2">
                <ScheduleTag frequency={sub.frequency} label={sub.scheduleLabel} />
                {sub.holidayOverride && (
                  <span
                    className="badge bg-orange-50 text-orange-700"
                    title={sub.overrideReason ? `Override reason: ${sub.overrideReason}` : 'Manually assigned on a non-working day'}
                  >
                    {new Date(sub.date).getUTCDay() === 0 ? 'Weekend Assignment' : 'Holiday Override'}
                  </span>
                )}
                {sub.submitted ? <span className="badge-green">Submitted</span> : <span className="badge-amber">Pending</span>}
              </span>}
            >
              {/* Phase 19: per-card autosave bar.  Renders only for
                  unsubmitted cards.  Mounts useDraftAutosave for this
                  submission so a refresh, deployment, or accidental
                  navigation doesn't lose the in-progress work. */}
              {!sub.submitted && (
                <DraftAutosaveBar sub={sub} buildPayload={() => buildDraftPayload(sub)} />
              )}
              {sub.submitted ? (
                <SubmittedSummary sub={sub} />
              ) : sub.templateType === 'custom' ? (
                <CustomTemplateForm
                  sub={sub}
                  values={customValues[sub._id] || {}}
                  onChange={(key, value) =>
                    setCustomValues((s) => ({
                      ...s,
                      [sub._id]: { ...(s[sub._id] || {}), [key]: value },
                    }))
                  }
                  meta={customMeta[sub._id] || {}}
                  onMeta={(key, patch) =>
                    setCustomMeta((s) => ({
                      ...s,
                      [sub._id]: {
                        ...(s[sub._id] || {}),
                        [key]: { ...((s[sub._id] || {})[key] || {}), ...patch },
                      },
                    }))
                  }
                  productSales={productSales[sub._id] || []}
                  setProductSales={(updater) =>
                    setProductSales((s) => ({
                      ...s,
                      [sub._id]: typeof updater === 'function' ? updater(s[sub._id] || []) : updater,
                    }))
                  }
                  farmerRecords={farmerRecords[sub._id] || []}
                  setFarmerRecords={(updater) =>
                    setFarmerRecords((s) => ({
                      ...s,
                      [sub._id]: typeof updater === 'function' ? updater(s[sub._id] || []) : updater,
                    }))
                  }
                  products={products}
                  quantities={quantities}
                  dealers={dealers}
                  selfRating={selfRating[sub._id]}
                  setSelfRating={(v) => setSelfRating((s) => ({ ...s, [sub._id]: v }))}
                  selfNote={selfNote[sub._id]}
                  setSelfNote={(v) => setSelfNote((s) => ({ ...s, [sub._id]: v }))}
                  idea={idea[sub._id]}
                  setIdea={(v) => setIdea((s) => ({ ...s, [sub._id]: v }))}
                  busy={busy}
                  onSubmit={() => submit(sub)}
                />
              ) : sub.templateType === 'sheet' ? (
                <>
                  <SheetReportForm
                    sub={sub}
                    ws={sheetState[sub._id] || sub.sheet}
                    onCellChange={(r, c, v) => setSheetCell(sub._id, r, c, v)}
                    onAddRow={() => addSheetRow(sub._id)}
                    status={sheetStatus[sub._id] || {}}
                    onStatusChange={(key, patch) => setSheetRowStatus(sub._id, key, patch)}
                    assignable={assignable}
                  />

                  {/* Self-observation + Idea moved to a single Daily Reflection
                      card at the top of "Today's Tasks" (Phase 5 refactor). */}

                  <div className="mt-4 flex justify-end">
                    <button className="btn-primary" disabled={busy} onClick={() => submit(sub)}>
                      Submit Report
                    </button>
                  </div>
                </>
              ) : sub.templateType === 'excel' ? (
                <>
                  <ExcelReportForm
                    sub={sub}
                    values={excelValues[sub._id] || {}}
                    onChange={(fieldName, value) => setExcelValues((s) => ({
                      ...s,
                      [sub._id]: { ...(s[sub._id] || {}), [fieldName]: value },
                    }))}
                  />

                  <div className="mt-4 flex justify-end">
                    <button className="btn-primary" disabled={busy} onClick={() => submit(sub)}>
                      Submit Report
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Task</th>
                          <th>Status</th>
                          <th>Work Type</th>
                          <th>Forward To</th>
                          <th>Remark</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sub.tasks.filter((t) => !t.addedByEmployee).map((t) => {
                          const taskRow = taskState[sub._id]?.[t._id] || {};
                          const st = taskRow.status || 'pending_submit';
                          const dt = taskRow.dependencyType || 'independent';
                          const isDoneOrPending = st === 'done' || st === 'pending';
                          const isDependent = isDoneOrPending && dt === 'dependent';
                          const remarkRequired = st === 'pending' || isDependent;
                          return (
                            <tr key={t._id}>
                              <td className="font-medium text-slate-800 align-top">{t.title}</td>
                              <td className="align-top">
                                <select
                                  className="input max-w-[140px]"
                                  value={st}
                                  onChange={(e) => setTask(sub._id, t._id, { status: e.target.value })}
                                >
                                  <option value="pending_submit">Select...</option>
                                  <option value="done">Done</option>
                                  <option value="ongoing">Ongoing</option>
                                  <option value="pending">Pending</option>
                                  <option value="work_not_available">Work Not Available</option>
                                </select>
                              </td>
                              <td className="align-top">
                                {isDoneOrPending ? (
                                  <select
                                    className="input max-w-[140px]"
                                    value={dt}
                                    onChange={(e) => setTask(sub._id, t._id, {
                                      dependencyType: e.target.value,
                                      // Clear the assignee if we go back to Independent.
                                      ...(e.target.value === 'independent' ? { dependencyAssignedTo: '' } : {}),
                                    })}
                                  >
                                    <option value="independent">Independent</option>
                                    <option value="dependent">Dependent</option>
                                  </select>
                                ) : (
                                  <span className="text-slate-300">—</span>
                                )}
                              </td>
                              <td className="align-top">
                                {isDependent ? (
                                  <select
                                    className="input max-w-[200px]"
                                    value={taskRow.dependencyAssignedTo || ''}
                                    onChange={(e) => setTask(sub._id, t._id, { dependencyAssignedTo: e.target.value })}
                                  >
                                    <option value="">Select person...</option>
                                    {assignable.map((u) => (
                                      <option key={u._id} value={u._id}>
                                        {u.name} ({u.employeeId || u.role})
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="text-slate-300">—</span>
                                )}
                              </td>
                              <td className="align-top">
                                <input
                                  className="input"
                                  placeholder={
                                    !isDoneOrPending ? 'N/A'
                                    : remarkRequired ? 'Required'
                                    : 'Optional'
                                  }
                                  disabled={!isDoneOrPending}
                                  value={taskRow.pendingReason || ''}
                                  onChange={(e) => setTask(sub._id, t._id, { pendingReason: e.target.value })}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* ----- Employee-added tasks ----- */}
                  <div className="mt-4 bg-indigo-50/60 border border-indigo-100 rounded-lg p-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                      <div>
                        <div className="text-sm font-semibold text-indigo-900">Additional Tasks You Did</div>
                        <div className="text-[11px] text-indigo-700">
                          Anything extra you did today that isn't listed above. HR will award marks during review.
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn-secondary !py-1 !text-xs"
                        onClick={() =>
                          setAddedTasks((s) => ({
                            ...s,
                            [sub._id]: [...(s[sub._id] || []), { title: '' }],
                          }))
                        }
                      >
                        + Add my task
                      </button>
                    </div>
                    {(addedTasks[sub._id] || []).length === 0 ? (
                      <div className="text-xs text-indigo-600/80 italic">
                        No additional tasks. Click "+ Add my task" to add one.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {(addedTasks[sub._id] || []).map((row, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <input
                              className="input flex-1"
                              placeholder="e.g. Helped onboard a new vendor"
                              value={row.title}
                              onChange={(e) => {
                                const v = e.target.value;
                                setAddedTasks((s) => {
                                  const arr = [...(s[sub._id] || [])];
                                  arr[i] = { ...arr[i], title: v };
                                  return { ...s, [sub._id]: arr };
                                });
                              }}
                            />
                            <button
                              type="button"
                              className="btn-ghost text-red-600 !px-2"
                              onClick={() =>
                                setAddedTasks((s) => ({
                                  ...s,
                                  [sub._id]: (s[sub._id] || []).filter((_, idx) => idx !== i),
                                }))
                              }
                              aria-label="Remove"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Self-observation + Idea moved to a single Daily Reflection
                      card at the top of "Today's Tasks" (Phase 5 refactor). */}

                  <div className="mt-4 flex justify-end">
                    <button className="btn-primary" disabled={busy} onClick={() => submit(sub)}>
                      Submit
                    </button>
                  </div>
                </>
              )}
            </Collapsible>
          ))}
        </div>
      )}

      {/* Pendency */}
      <Collapsible
        title="Pendency"
        subtitle={`${data.backlog.length} pending task(s)`}
        right={<span className={data.backlog.length === 0 ? 'badge-green' : 'badge-red'}>{data.backlog.length}</span>}
        defaultOpen={data.backlog.length > 0}
      >
        {data.backlog.length === 0
          ? <div className="text-sm text-slate-500">No pending work. Great job!</div>
          : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Template</th>
                    <th>Schedule</th>
                    <th>Reason</th>
                    <th>Pending since</th>
                    <th>Delay</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.backlog.map((b) => (
                    <tr key={`${b.submissionId}-${b.taskId}`}>
                      <td className="font-medium">{b.title}</td>
                      <td>{b.templateTitle}</td>
                      <td><ScheduleTag frequency={b.frequency} label={b.scheduleLabel} /></td>
                      <td className="text-slate-500">{b.pendingReason}</td>
                      <td>{fmtDate(b.pendingSince)}</td>
                      <td><span className={delayBadgeClass(b.daysPending)}>{delayLabel(b.daysPending)}</span></td>
                      <td><button className="btn-secondary" onClick={() => markBacklogDone(b)}>Mark Done</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Collapsible>
    </div>
  );
}

/**
 * Custom-template form.  Renders fields grouped by `field.group`,
 * ordered by `field.order`.  Live-computes `auto` fields against the
 * current employee inputs using customCompute() (same shape as the
 * server-side evaluator); `readonly` / `auto` / `systemGenerated`
 * fields render as muted, non-editable values so the employee sees
 * the running calculation.
 *
 * Visibility: only fields with 'employee' in `visibleTo` render here.
 */
function CustomTemplateForm({
  sub, values, onChange,
  meta = {}, onMeta = () => {},
  productSales = [], setProductSales,
  farmerRecords = [], setFarmerRecords,
  products = [], quantities = [], dealers = [],
  selfRating, setSelfRating, selfNote, setSelfNote, idea, setIdea,
  busy, onSubmit,
}) {
  // Phase 14: scope-aware filter.  The daily engine only seeds
  // customResponses for fields belonging to the assignment's
  // sub-templates (Phase 13).  So a field key that didn't get seeded
  // shouldn't render here either, even if the template defines it.
  // Falls back to "render everything" when the submission has no
  // seeded responses at all (covers legacy submissions + the moment
  // before the employee starts typing).
  const seededKeys = new Set((sub.customResponses || []).map((r) => r.key));
  const fields = (sub.template?.customFields || [])
    .filter((f) => !f.visibleTo || f.visibleTo.includes('employee'))
    .filter((f) => seededKeys.size === 0 || seededKeys.has(f.key))
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  // Live-derived view including auto fields.
  const computed = customCompute(sub.template?.customFields || [], values);

  const sections = sub.template?.customSections || [];
  const showProductSales   = sections.includes('productSales');
  const showFarmerRecords  = sections.includes('farmerRecords');

  // Bucket fields by group, preserving order.
  const groups = [];
  const seen = new Map();
  for (const f of fields) {
    const g = f.group || 'General';
    if (!seen.has(g)) { seen.set(g, groups.length); groups.push({ name: g, items: [] }); }
    groups[seen.get(g)].items.push(f);
  }

  /**
   * Phase 14 renderer.  One card per task with:
   *   - Work Name (label) + Required asterisk + Dependent badge
   *   - Description (read-only helper text)
   *   - Value control matching fieldType (number/currency/percentage/
   *     text/textarea/yes_no/dropdown/date/time/auto-readonly)
   *   - Status dropdown (when supportsStatus)
   *   - Remark input (when supportsRemark, mandatory if status=pending)
   */
  const renderField = (f) => {
    const m = meta[f.key] || {};
    // Editability is decided by fieldType ALONE.  Earlier versions
    // also gated on `systemGenerated`, but that flag was a sentinel
    // for the seeded Calling Report's `yesterdayPending` carry-forward
    // field -- and that field ALREADY carries `fieldType: 'readonly'`
    // independently.  Including systemGenerated here turned every
    // builder-created field whose checkbox was accidentally ticked
    // into a read-only zero, which is the bug HR reported.  The fix:
    // trust fieldType and only fieldType.  Carry-forward fields stay
    // read-only via their own `fieldType: 'readonly'`; Number /
    // Currency / Percentage / Text / etc. are always editable.
    const isAuto = f.fieldType === 'auto' || f.fieldType === 'readonly';
    const v = values[f.key];
    const computedValue = computed[f.key];

    // ----- value input -----
    let valueControl;
    if (isAuto) {
      const display = typeof computedValue === 'number'
        ? (Number.isInteger(computedValue) ? computedValue : computedValue.toFixed(2))
        : (computedValue ?? '');
      valueControl = (
        <div className="input bg-slate-50 font-mono text-sm flex items-center text-slate-700">
          {display === '' || display == null ? <span className="text-slate-400">auto-calculated</span> : display}
        </div>
      );
    } else if (f.fieldType === 'dropdown') {
      valueControl = (
        <select className="input" value={v ?? ''} onChange={(e) => onChange(f.key, e.target.value)}>
          <option value="">Select…</option>
          {(f.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      );
    } else if (f.fieldType === 'yes_no') {
      valueControl = (
        <select className="input" value={v ?? ''} onChange={(e) => onChange(f.key, e.target.value)}>
          <option value="">Select…</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    } else if (f.fieldType === 'textarea' || f.fieldType === 'long_text') {
      valueControl = (
        <textarea className="input" rows={3} value={v ?? ''} onChange={(e) => onChange(f.key, e.target.value)} />
      );
    } else if (f.fieldType === 'date') {
      valueControl = (
        <input className="input" type="date" value={v ?? ''} onChange={(e) => onChange(f.key, e.target.value)} />
      );
    } else if (f.fieldType === 'time') {
      valueControl = (
        <input className="input" type="time" value={v ?? ''} onChange={(e) => onChange(f.key, e.target.value)} />
      );
    } else if (f.fieldType === 'number' || f.fieldType === 'currency' || f.fieldType === 'percentage') {
      const prefix = f.fieldType === 'currency'   ? '₹' : '';
      const suffix = f.fieldType === 'percentage' ? '%' : '';
      valueControl = (
        <div className="relative">
          {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm pointer-events-none">{prefix}</span>}
          <input
            className={`input ${prefix ? 'pl-7' : ''} ${suffix ? 'pr-7' : ''}`}
            type="number"
            step="any"
            min="0"
            value={v ?? ''}
            onChange={(e) => onChange(f.key, e.target.value === '' ? '' : Number(e.target.value))}
          />
          {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm pointer-events-none">{suffix}</span>}
        </div>
      );
    } else {
      // text + any unknown future type fall through here.
      valueControl = (
        <input className="input" type="text" value={v ?? ''} onChange={(e) => onChange(f.key, e.target.value)} />
      );
    }

    const isDependent = f.dependencyType === 'dependent';
    const pendingNeedsRemark = m.status === 'pending';

    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
        {/* Header: label + required + dependent badge */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-800">
              {f.label}
              {f.required && <span className="text-red-500"> *</span>}
            </div>
            {f.description && (
              <div className="text-[11px] text-slate-500 mt-0.5">{f.description}</div>
            )}
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {isDependent && <span className="badge bg-indigo-50 text-indigo-700 text-[10px]">Dependent Task</span>}
            {isAuto && <span className="badge bg-slate-100 text-slate-600 text-[10px]">Auto</span>}
          </div>
        </div>

        {/* Value + status + remark side by side when room, stacked when narrow */}
        <div className="grid md:grid-cols-12 gap-2">
          <div className={`md:col-span-${f.supportsStatus || f.supportsRemark ? '5' : '12'}`}>
            <div className="label text-[10px] uppercase">Value</div>
            {valueControl}
          </div>
          {f.supportsStatus && (
            <div className="md:col-span-3">
              <div className="label text-[10px] uppercase">Status</div>
              <select
                className="input"
                value={m.status || ''}
                onChange={(e) => onMeta(f.key, { status: e.target.value })}
              >
                <option value="">—</option>
                <option value="done">Done</option>
                <option value="pending">Pending</option>
                <option value="work_not_available">Work N/A</option>
              </select>
            </div>
          )}
          {f.supportsRemark && (
            <div className={`md:col-span-${f.supportsStatus ? '4' : '7'}`}>
              <div className="label text-[10px] uppercase">
                Remark
                {pendingNeedsRemark && <span className="text-red-500"> *</span>}
              </div>
              <input
                className={`input ${pendingNeedsRemark && !(m.remark || '').trim() ? 'border-red-400' : ''}`}
                placeholder={pendingNeedsRemark ? 'Reason required for Pending' : 'Optional'}
                value={m.remark || ''}
                onChange={(e) => onMeta(f.key, { remark: e.target.value })}
              />
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.name}>
          {g.name !== 'General' && (
            <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-2">{g.name}</div>
          )}
          <div className="space-y-2">
            {g.items.map((f) => (
              <div key={f.key}>{renderField(f)}</div>
            ))}
          </div>
        </div>
      ))}

      {showProductSales && (
        <ProductSalesSection
          rows={productSales}
          setRows={setProductSales}
          products={products}
          quantities={quantities}
        />
      )}

      {showFarmerRecords && (
        <FarmerRecordsSection
          rows={farmerRecords}
          setRows={setFarmerRecords}
          products={products}
          dealers={dealers}
        />
      )}

      {/* Self-observation + Idea moved to a single Daily Reflection card
          at the top of "Today's Tasks" (Phase 5 refactor). */}

      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy} onClick={onSubmit}>Submit Report</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Daily Reflection card                                               */
/*                                                                     */
/* Phase 5: lives ONCE per day at the top of "Today's Tasks", regardless */
/* of how many assignments the employee has.  Upserts to               */
/* /api/daily-reflection.                                              */
/* ------------------------------------------------------------------ */
function DailyReflectionCard() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [rating, setRating] = useState('');
  const [note, setNote]     = useState('');
  const [ideaTxt, setIdea]  = useState('');
  const [busy, setBusy]     = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const toast = useToast();

  // Best-effort load of today's reflection so HR-side edits / prior
  // saves don't get wiped if the page is refreshed.
  useEffect(() => {
    api.get('/daily-review/day', { params: { employeeId: 'self', date: todayIso } })
      .then(({ data }) => {
        // 'self' isn't supported server-side -- this fails 400 -- which
        // is fine; the employee just starts with empty fields.
      })
      .catch(() => {});
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/daily-review/reflection', {
        date: todayIso,
        selfRating: rating,
        selfNote: note,
        idea: ideaTxt,
      });
      setSavedAt(new Date());
      toast.success('Daily reflection saved');
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="card card-body bg-slate-50 border-slate-200 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-800">Daily Reflection</div>
          <div className="text-[11px] text-slate-500">
            One reflection per day, even when you have multiple assignments. HR / HOD sees this once on the review screen.
          </div>
        </div>
        {savedAt && <span className="text-[11px] text-slate-500">Saved {savedAt.toLocaleTimeString()}</span>}
      </div>
      <div className="grid md:grid-cols-3 gap-3">
        <div>
          <label className="label">Rating (0-10)</label>
          <input className="input" type="number" min="0" max="10" step="0.5" placeholder="0 - 10"
            value={rating} onChange={(e) => setRating(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <label className="label">Note</label>
          <input className="input" placeholder="Anything you want HR to know"
            value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label">Business Idea / Innovation</label>
        <textarea className="input" rows={2} placeholder="Optional — share any improvement idea"
          value={ideaTxt} onChange={(e) => setIdea(e.target.value)} />
      </div>
      <div className="flex justify-end">
        <button className="btn-secondary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save Reflection'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Product Sales sub-table                                             */
/* ------------------------------------------------------------------ */
function ProductSalesSection({ rows, setRows, products /*, quantities */ }) {
  // Quantity is now a raw numeric (canonical) value the employee types.
  // 0.5 = 500 ml on an L-unit product, 25 = 25 kg on a KG-unit product.
  // Quantity Master is no longer required for new submissions.
  const addRow = () => setRows((cur) => [...cur, { productId: '', quantity: '' }]);
  const removeRow = (i) => setRows((cur) => cur.filter((_, idx) => idx !== i));
  const editRow = (i, patch) => setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const productById = new Map((products || []).map((p) => [p._id, p]));
  const calcRow = (r) => {
    const p = productById.get(r.productId);
    const q = Number(r.quantity);
    if (!p || !Number.isFinite(q) || q <= 0) return { sales: 0, nbv: 0, unit: p?.unit || '' };
    const sales = (Number(p.pricePerUnit) || 0) * q;
    const nbv   = sales * (Number(p.nbvPercentage) || 0) / 100;
    return { sales: Math.round(sales * 100) / 100, nbv: Math.round(nbv * 100) / 100, unit: p.unit };
  };
  const totalSales = rows.reduce((s, r) => s + calcRow(r).sales, 0);
  const totalNbv   = rows.reduce((s, r) => s + calcRow(r).nbv,   0);

  return (
    <div className="bg-indigo-50/60 border border-indigo-100 rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div>
          <div className="text-sm font-semibold text-indigo-900">Product Sales</div>
          <div className="text-[11px] text-indigo-700">
            Enter canonical quantity directly. Examples: 0.1 = 100 ml · 0.5 = 500 ml ·
            1 = 1 L · 25 = 25 KG. Sales Value and NBV are auto-calculated from the product master.
          </div>
        </div>
        <button type="button" className="btn-secondary !py-1 !text-xs" onClick={addRow}>+ Add Product</button>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-indigo-600/80 italic">No products yet. Click "+ Add Product" to record a sale.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => {
            const c = calcRow(r);
            const p = productById.get(r.productId);
            return (
              <div key={i} className="grid grid-cols-12 gap-2 items-start bg-white rounded-lg p-2 border border-indigo-100">
                <div className="col-span-4">
                  <label className="label text-[10px] uppercase">Product</label>
                  <SearchableSelect
                    value={r.productId}
                    onChange={(v) => editRow(i, { productId: v })}
                    options={products || []}
                    getValue={(p) => p._id}
                    getLabel={(p) => `${p.name} (${p.unit})`}
                    getSearchText={(p) => `${p.name} ${p.unit}`}
                    placeholder="Select product…"
                  />
                </div>
                <div className="col-span-3">
                  <label className="label text-[10px] uppercase">
                    Quantity {p ? `(${p.unit})` : ''}
                  </label>
                  <input
                    className="input"
                    type="number"
                    step="any"
                    min="0"
                    placeholder={p ? `e.g. ${p.unit === 'KG' ? '25' : '0.5'}` : 'e.g. 0.5'}
                    value={r.quantity}
                    onChange={(e) => editRow(i, { quantity: e.target.value })}
                    disabled={!r.productId}
                  />
                </div>
                <div className="col-span-2">
                  <label className="label text-[10px] uppercase">Sales Value</label>
                  <div className="input bg-slate-50 font-mono text-sm">{c.sales > 0 ? `₹${c.sales}` : '—'}</div>
                </div>
                <div className="col-span-2">
                  <label className="label text-[10px] uppercase">NBV</label>
                  <div className="input bg-slate-50 font-mono text-sm">{c.nbv > 0 ? `₹${c.nbv}` : '—'}</div>
                </div>
                <div className="col-span-1 flex items-end justify-end">
                  <button type="button" className="btn-ghost text-red-600 !px-2" onClick={() => removeRow(i)} title="Remove row">✕</button>
                </div>
              </div>
            );
          })}
          <div className="flex justify-end gap-6 text-sm pt-1 px-1">
            <span className="text-slate-600">Total Sales Value: <b className="text-slate-900">₹{Math.round(totalSales * 100) / 100}</b></span>
            <span className="text-slate-600">Total NBV: <b className="text-slate-900">₹{Math.round(totalNbv * 100) / 100}</b></span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Farmer Records sub-table                                            */
/*                                                                     */
/* v2: each farmer carries a Dealer Master dropdown (Place auto-fills) */
/* + a repeating Products list (+ Add Product) where quantity is the   */
/* raw canonical number (0.5 = 500 ml, 25 = 25 KG, ...).               */
/* ------------------------------------------------------------------ */
function FarmerRecordsSection({ rows, setRows, products, dealers = [] }) {
  const blank = {
    name: '', mobile: '', village: '',
    dealerId: '',          // dropdown value
    dealerPlace: '',       // mirrored from dealer choice (read-only)
    products: [],          // repeating [{ productId, quantity }]
  };
  const addRow = () => setRows((cur) => [...cur, { ...blank, products: [] }]);
  const removeRow = (i) => setRows((cur) => cur.filter((_, idx) => idx !== i));
  const editRow = (i, patch) => setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const productById = new Map((products || []).map((p) => [p._id, p]));
  const dealerById  = new Map((dealers  || []).map((d) => [d._id, d]));
  // Sort dealers by firm + place so the dropdown is easy to skim, and
  // resolve a display label that disambiguates same-firm rows across
  // different places.  Dealer Name is intentionally NOT shown to
  // employees -- per Phase 3 spec it lives in HR + analytics only.
  const dealerLabel = (d) => {
    const firm  = d.firmName || d.name || '—';
    const place = d.place    || '';
    return place ? `${firm} — ${place}` : firm;
  };
  const sortedDealers = [...(dealers || [])].sort((a, b) => dealerLabel(a).localeCompare(dealerLabel(b)));

  const editProduct = (rowIdx, prodIdx, patch) => setRows((cur) => cur.map((r, i) => {
    if (i !== rowIdx) return r;
    const ps = [...(r.products || [])];
    ps[prodIdx] = { ...ps[prodIdx], ...patch };
    return { ...r, products: ps };
  }));
  const addProduct = (rowIdx) => setRows((cur) => cur.map((r, i) =>
    i === rowIdx ? { ...r, products: [...(r.products || []), { productId: '', quantity: '' }] } : r));
  const removeProduct = (rowIdx, prodIdx) => setRows((cur) => cur.map((r, i) =>
    i === rowIdx ? { ...r, products: (r.products || []).filter((_, j) => j !== prodIdx) } : r));

  return (
    <div className="bg-emerald-50/60 border border-emerald-100 rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div>
          <div className="text-sm font-semibold text-emerald-900">Farmer Details</div>
          <div className="text-[11px] text-emerald-700">
            Pick a dealer from the master list (Place auto-fills). Each farmer can have one or more products.
          </div>
        </div>
        <button type="button" className="btn-secondary !py-1 !text-xs" onClick={addRow}>+ Add Farmer</button>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-emerald-700/80 italic">No farmers yet. Click "+ Add Farmer" to add one.</div>
      ) : (
        <div className="space-y-3">
          {rows.map((r, i) => {
            const dealer = dealerById.get(r.dealerId);
            const place  = dealer?.place || r.dealerPlace || '';
            return (
              <div key={i} className="bg-white rounded-lg p-3 border border-emerald-100 space-y-2">
                {/* Identity row */}
                <div className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-3">
                    <label className="label text-[10px] uppercase">Farmer Name *</label>
                    <input className="input" value={r.name} onChange={(e) => editRow(i, { name: e.target.value })} placeholder="Full name" />
                  </div>
                  <div className="col-span-2">
                    <label className="label text-[10px] uppercase">Mobile</label>
                    <input className="input" value={r.mobile} onChange={(e) => editRow(i, { mobile: e.target.value })} placeholder="9000000000" />
                  </div>
                  <div className="col-span-2">
                    <label className="label text-[10px] uppercase">Village</label>
                    <input className="input" value={r.village} onChange={(e) => editRow(i, { village: e.target.value })} />
                  </div>
                  <div className="col-span-2">
                    <label className="label text-[10px] uppercase">Firm Name</label>
                    <SearchableSelect
                      value={r.dealerId || ''}
                      onChange={(v) => {
                        const d = dealerById.get(v);
                        editRow(i, { dealerId: v, dealerPlace: d?.place || '' });
                      }}
                      options={sortedDealers}
                      getValue={(d) => d._id}
                      getLabel={(d) => dealerLabel(d)}
                      // Per spec: dealer search matches firmName, place,
                      // and dealerName (so "modi", "bhopal", or "rahul"
                      // all surface the same Modi Traders row).
                      getSearchText={(d) => `${d.firmName || d.name || ''} ${d.place || ''} ${d.dealerName || ''}`}
                      placeholder="Select firm…"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="label text-[10px] uppercase">Place</label>
                    <input className="input bg-slate-50" value={place} readOnly placeholder="—" />
                  </div>
                  <div className="col-span-1 flex items-end justify-end">
                    <button type="button" className="btn-ghost text-red-600 !px-2" onClick={() => removeRow(i)} title="Remove farmer">✕</button>
                  </div>
                </div>

                {/* Repeating products list */}
                <div className="bg-emerald-50/50 rounded p-2 border border-emerald-100">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[11px] font-semibold text-emerald-900">Products purchased</div>
                    <button type="button" className="btn-ghost !text-xs !py-0.5 text-emerald-800" onClick={() => addProduct(i)}>+ Add Product</button>
                  </div>
                  {(r.products || []).length === 0 ? (
                    <div className="text-[11px] text-emerald-700/70 italic px-1 py-1">No products yet. Click "+ Add Product".</div>
                  ) : (
                    <div className="space-y-1.5">
                      {(r.products || []).map((pr, j) => {
                        const p = productById.get(pr.productId);
                        return (
                          <div key={j} className="grid grid-cols-12 gap-2 items-end">
                            <div className="col-span-6">
                              <label className="label text-[10px] uppercase">Product</label>
                              <SearchableSelect
                                value={pr.productId || ''}
                                onChange={(v) => editProduct(i, j, { productId: v })}
                                options={products || []}
                                getValue={(p) => p._id}
                                getLabel={(p) => `${p.name} (${p.unit})`}
                                getSearchText={(p) => `${p.name} ${p.unit}`}
                                placeholder="Select product…"
                              />
                            </div>
                            <div className="col-span-5">
                              <label className="label text-[10px] uppercase">
                                Quantity {p ? `(${p.unit})` : ''}
                              </label>
                              <input
                                className="input"
                                type="number"
                                step="any"
                                min="0"
                                placeholder={p ? (p.unit === 'KG' ? 'e.g. 25' : 'e.g. 0.5') : 'e.g. 0.5'}
                                value={pr.quantity ?? ''}
                                onChange={(e) => editProduct(i, j, { quantity: e.target.value })}
                                disabled={!pr.productId}
                              />
                            </div>
                            <div className="col-span-1 flex items-end justify-end">
                              <button type="button" className="btn-ghost text-red-600 !px-2" onClick={() => removeProduct(i, j)} title="Remove product">✕</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Post-submission summary shown on the employee dashboard.  Reveals the
 * HR review (discipline + innovation marks + feedback) once it has been
 * completed; otherwise shows the work-only score with a "Pending Review"
 * badge.
 */
function SubmittedSummary({ sub }) {
  const reviewed = sub.reviewStatus === 'reviewed';
  return (
    <div className="space-y-3">
      {/* Score / marks panels are intentionally hidden from the employee
          view per spec.  Backend continues to compute & store every score
          for HR analytics and reviews.  Employee only sees submission /
          review status here and (further down) any qualitative feedback
          notes the reviewer left. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-slate-600">
          Submitted{sub.submittedAt ? ` at ${new Date(sub.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </div>
        {reviewed
          ? <span className="badge-green">Reviewed by HR</span>
          : <span className="badge-amber">Awaiting HR review</span>}
      </div>

      {reviewed && (sub.disciplineNote || sub.ideaFeedback) && (
        <div className="grid sm:grid-cols-2 gap-3">
          {sub.disciplineNote && (
            <div className="bg-slate-50 rounded-lg p-3">
              <div className="text-[11px] uppercase text-slate-500">HR Note</div>
              <div className="text-sm text-slate-700 mt-1 italic">"{sub.disciplineNote}"</div>
            </div>
          )}
          {sub.ideaFeedback && (
            <div className="bg-blue-50 rounded-lg p-3">
              <div className="text-[11px] uppercase text-blue-700">Feedback on your idea</div>
              <div className="text-sm text-slate-700 mt-1 italic">"{sub.ideaFeedback}"</div>
            </div>
          )}
        </div>
      )}

      {/* Custom templates (read-only): the submitted values grouped by
          field group.  Only employee-visible fields are rendered (the
          system already filters when the API responds, but we
          double-check here for defence in depth). */}
      {sub.templateType === 'custom' && (sub.customResponses || []).length > 0 && (() => {
        const fields = (sub.template?.customFields || [])
          .filter((f) => !f.visibleTo || f.visibleTo.includes('employee'))
          .slice()
          .sort((a, b) => (a.order || 0) - (b.order || 0));
        const map = {};
        (sub.customResponses || []).forEach((r) => { map[r.key] = r.value; });
        const groups = [];
        const seen = new Map();
        for (const f of fields) {
          const g = f.group || 'General';
          if (!seen.has(g)) { seen.set(g, groups.length); groups.push({ name: g, items: [] }); }
          groups[seen.get(g)].items.push(f);
        }
        const fmt = (v) => typeof v === 'number'
          ? (Number.isInteger(v) ? v : v.toFixed(1))
          : (v === '' || v === null || v === undefined ? '—' : String(v));
        return (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.name} className="bg-slate-50 rounded-lg p-3">
                <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-2">{g.name}</div>
                <div className="grid md:grid-cols-3 gap-3">
                  {g.items.map((f) => (
                    <div key={f.key} className="bg-white rounded-lg border border-slate-200 px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-slate-500">{f.label}</div>
                      <div className="text-base font-semibold text-slate-900 mt-0.5">{fmt(map[f.key])}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Task templates (read-only): status + remark + dependency only --
          no points / marks / awarded values, per spec. */}
      {sub.templateType === 'task' && (sub.tasks || []).length > 0 && (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>Work Type</th>
                <th>Remark</th>
              </tr>
            </thead>
            <tbody>
              {(sub.tasks || [])
                .filter((t) => ['done', 'ongoing', 'pending', 'work_not_available'].includes(t.status))
                .map((t) => (
                  <tr key={t._id}>
                    <td className="font-medium text-slate-800">
                      {t.title}
                      {t.addedByEmployee && <span className="ml-2 badge-blue">Added</span>}
                    </td>
                    <td>
                      {t.status === 'done'                 && <span className="badge-green">Done</span>}
                      {t.status === 'ongoing'              && <span className="badge-blue">Ongoing</span>}
                      {t.status === 'pending'              && <span className="badge-amber">Pending</span>}
                      {t.status === 'work_not_available'   && <span className="badge-gray">Work N/A</span>}
                    </td>
                    <td>
                      {t.dependencyType === 'dependent'
                        ? <span className="badge bg-indigo-50 text-indigo-700">Forwarded</span>
                        : <span className="text-slate-400 text-xs">Independent</span>}
                    </td>
                    <td className="text-slate-600 text-sm">
                      {t.pendingReason || <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Sheet report: read-only grid only; per-target marks and remarks
          are HR-only data so they're hidden from the employee view. */}
      {sub.templateType === 'sheet' && sub.sheet && (
        <div className="space-y-3">
          <SheetGrid sheet={sub.sheet} mode="readonly" showHidden={false} scoreMap={{}} height={280} />
        </div>
      )}

      {/* Excel report: show submitted values only; the per-field marks
          column is hidden from the employee per spec. */}
      {sub.templateType === 'excel' && (sub.excelResponses || []).length > 0 && (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Your value</th>
              </tr>
            </thead>
            <tbody>
              {sub.excelResponses.map((r) => (
                <tr key={r._id || r.fieldName}>
                  <td className="font-medium">{r.fieldName}</td>
                  <td className="text-slate-700 whitespace-pre-wrap">{String(r.value ?? '') || <span className="text-slate-400">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sub.idea && (
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
          <div className="text-[11px] uppercase text-blue-700 mb-1">Your idea</div>
          <div className="text-sm text-slate-700 whitespace-pre-wrap">{sub.idea}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Dynamic, spreadsheet-style report form rendered from the submission's
 * excelResponses (which mirror the template's columns).  Renders the
 * right input per fieldType and surfaces which fields are scored.
 */
function ExcelReportForm({ sub, values, onChange }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">
        Fill in your report below. Fields marked <span className="badge-blue">scored</span> contribute to your performance marks (awarded by HR on review).
      </div>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Value</th>
              <th className="w-28">Max marks</th>
            </tr>
          </thead>
          <tbody>
            {sub.excelResponses.map((r) => {
              const v = values[r.fieldName] !== undefined ? values[r.fieldName] : (r.value ?? '');
              return (
                <tr key={r._id || r.fieldName}>
                  <td className="font-medium align-top pt-3">
                    {r.fieldName}
                    {r.markEligible && <span className="ml-1 badge-blue">scored</span>}
                  </td>
                  <td>
                    <ExcelField type={r.fieldType} value={v} onChange={(val) => onChange(r.fieldName, val)} options={r.options} />
                  </td>
                  <td className="align-top pt-3 text-slate-500">
                    {r.markEligible ? r.maxMarks : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* Build a scoreMap (keyed) from a submission's sheet.scores for highlighting */
function buildScoreMapFromScores(scores) {
  return Object.fromEntries((scores || []).map((s) => [s.key, s]));
}

/**
 * Editable spreadsheet the employee fills directly in the HRMS - the
 * layout HR uploaded, with only the input cells editable.  Hidden rows /
 * columns are never shown to the employee.
 */
function SheetReportForm({ sub, ws, onCellChange, onAddRow, status = {}, onStatusChange, assignable = [] }) {
  const sheet = ws || sub.sheet;
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">
        Fill the highlighted cells of your report. Task rows (right-hand columns) capture the workflow
        status &amp; dependency directly on the same row.
      </div>
      <SheetWorkflowGrid
        sheet={sheet}
        onCellChange={onCellChange}
        status={status}
        onStatusChange={onStatusChange}
        assignable={assignable}
      />
      {sheet.allowEmployeeAddRows && (
        <button className="btn-secondary !py-1" onClick={onAddRow}>+ Add row</button>
      )}
    </div>
  );
}

function ExcelField({ type, value, onChange, options = [] }) {
  if (type === 'number') {
    return <input className="input" type="number" value={value === 0 ? 0 : (value || '')} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  }
  if (type === 'textarea') {
    return <textarea className="input" rows={2} value={value || ''} onChange={(e) => onChange(e.target.value)} />;
  }
  if (type === 'date') {
    return <input className="input" type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} />;
  }
  if (type === 'dropdown') {
    return (
      <select className="input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select...</option>
        {(options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return <input className="input" value={value || ''} onChange={(e) => onChange(e.target.value)} />;
}
