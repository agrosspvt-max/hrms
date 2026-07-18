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
// Phase 47 -- realtime subscribe helper.  Each useEffect returns the
// unsubscribe function so React tears down listeners on unmount.
import { subscribe } from '../../realtime';
// Phase 50 -- shared notes modal + dashboard Today's / Upcoming panels.
import AttendanceNotesModal from '../../components/AttendanceNotesModal.jsx';

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

/**
 * Phase 60 -- shared Employee Private Remark textarea.  Rendered at
 * the bottom of every submission form when the template opts in.
 * The value is submission-scoped and stays hidden from the HOD.
 */
function PrivateRemarkBox({ sub, value, onChange }) {
  if (!sub?.template?.privateRemarkEnabled) return null;
  const label = sub.template?.privateRemarkLabel || 'Remark';
  const required = !!sub.template?.privateRemarkRequired;
  return (
    <div className="mt-4 border-t pt-4">
      <label className="label flex items-center gap-2">
        {label}
        {required && <span className="text-red-500">*</span>}
        <span className="text-[11px] text-slate-500 font-normal">(visible only to HR)</span>
      </label>
      <textarea
        className="input"
        rows={3}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={required
          ? 'Required note for HR / Super Admin only. Not shown to your HOD.'
          : 'Optional note for HR / Super Admin only. Not shown to your HOD.'}
      />
    </div>
  );
}

/**
 * Phase 61 -- Penalty warning card for the employee.  Shown at the
 * top of the Dashboard while there's anything to acknowledge.
 *   red    -- currently-enforced penalty (Final = 0 that day).
 *   amber  -- probable warning.
 *
 * Cards persist until the employee clicks "I've read this".  A
 * click POSTs /penalties/:id/acknowledge which stamps
 * acknowledgedAt server-side.  HR can see the timestamp on the
 * Fines & Penalties page.
 */
function PenaltyWarnings({ penalties, onAcknowledged }) {
  // Phase 64.1 Item 5 -- Performance Lock cards are always shown
  // (never merely "0 Marks"; the spec requires a full explanation)
  // even after the employee has acknowledged.  Every OTHER active /
  // probable row keeps the existing acknowledge-to-dismiss behaviour.
  const activeLocks = (penalties.active || []).filter((p) => p.category === 'performance_lock' && p.status === 'active');
  const activeMissed = (penalties.active || []).filter((p) => p.category === 'missed_submission' || p.category === 'absent_submission');
  // Phase 65 -- always-visible Financial Penalty cards (pending only).
  const activeFinancial = (penalties.active || []).filter((p) =>
    p.category === 'financial_penalty' && p.financialStatus === 'pending' && p.status === 'active');
  const unread = [
    ...(penalties.active   || []).filter((p) => !p.acknowledgedAt && p.category !== 'performance_lock' && p.category !== 'financial_penalty'),
    ...(penalties.probable || []).filter((p) => !p.acknowledgedAt),
  ];
  if (unread.length === 0 && activeLocks.length === 0 && activeMissed.length === 0 && activeFinancial.length === 0) return null;
  const ack = async (id) => {
    try {
      await api.post(`/penalties/${id}/acknowledge`);
      onAcknowledged?.();
    } catch (_) { /* silent */ }
  };
  // Phase 64.1 Item 5 -- Performance Lock explanation card.  Never
  // shows only "Performance Locked" -- always spells out the task,
  // pending-since, allowed window, resolve-by, current overdue days
  // and what the employee must do to unlock.
  const fmtDay = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—';
  const daysBetween = (a, b) => {
    if (!a || !b) return 0;
    return Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));
  };
  const now = new Date();

  return (
    <div className="space-y-2">
      {/* Phase 64.1 Item 5 -- always-visible Performance Lock cards. */}
      {activeLocks.map((p) => {
        const ref = p.overdueRef || {};
        const overdueDays = daysBetween(ref.resolveBy, now);
        return (
          <div key={p._id} className="border rounded-lg p-3 bg-red-50 border-red-300 text-red-800">
            <div className="text-[11px] uppercase tracking-wide font-semibold">
              Performance Lock Active
            </div>
            <div className="text-sm mt-1">
              <b>Task:</b> {ref.taskTitle || p.reason || '—'}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2 text-[12px]">
              <div><span className="opacity-70">Pending Since:</span> {fmtDay(ref.pendingSince)}</div>
              <div><span className="opacity-70">Resolve By:</span> {fmtDay(ref.resolveBy)}</div>
              <div><span className="opacity-70">Overdue:</span> {overdueDays} day{overdueDays === 1 ? '' : 's'}</div>
              <div><span className="opacity-70">Reason:</span> {p.reason || '—'}</div>
            </div>
            <div className="text-[11px] mt-2 opacity-80">
              Resolve this task to restore future performance.
            </div>
          </div>
        );
      })}
      {/* Phase 64.1 Item 5 -- Missed Submission cards get their own
          always-visible strip so the employee sees the reopen prompt
          without clicking through Fines & Penalties. */}
      {activeMissed.map((p) => (
        <div key={p._id} className="border rounded-lg p-3 bg-amber-50 border-amber-300 text-amber-800">
          <div className="text-[11px] uppercase tracking-wide font-semibold">Missed Submission</div>
          <div className="text-sm mt-0.5">{p.employeeMessage || p.reason || 'Yesterday\'s submission was not filed.'}</div>
          {p.targetDate && (
            <div className="text-[11px] mt-1 opacity-80">For date: {fmtDay(p.targetDate)}</div>
          )}
          <div className="text-[11px] mt-2 opacity-80">
            Open Fines &amp; Penalties to request reopening.
          </div>
        </div>
      ))}
      {/* Phase 65 -- Financial Penalty cards.  Never affect marks;
          shown alongside the other penalty warnings so the employee
          sees the ₹ amount + reason + status at a glance. */}
      {activeFinancial.map((p) => (
        <div key={p._id} className="border rounded-lg p-3 bg-emerald-50 border-emerald-300 text-emerald-900">
          <div className="text-[11px] uppercase tracking-wide font-semibold">Financial Penalty</div>
          <div className="text-sm mt-0.5">
            <b>₹{Number(p.amount) || 0}</b> — {p.employeeMessage || p.reason || 'A fine has been recorded on your account.'}
          </div>
          <div className="text-[11px] mt-1 opacity-80">
            Status: {p.financialStatus || 'pending'}
            {p.dueDate ? ` · Due by ${fmtDay(p.dueDate)}` : ''}
          </div>
        </div>
      ))}
      {unread.map((p) => {
        const enforced = !p.probable;
        const cls = enforced
          ? 'border-red-300 bg-red-50 text-red-800'
          : 'border-amber-300 bg-amber-50 text-amber-800';
        return (
          <div key={p._id} className={`border rounded-lg p-3 flex items-start justify-between gap-3 ${cls}`}>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wide font-semibold">
                {enforced ? 'Performance penalty applied' : 'Warning · possible penalty'}
              </div>
              <div className="text-sm mt-0.5">
                {p.employeeMessage || p.reason || 'A penalty has been recorded on your account.'}
              </div>
              {p.targetDate && (
                <div className="text-[11px] mt-1 opacity-80">
                  For date: {new Date(p.targetDate).toLocaleDateString()}
                </div>
              )}
            </div>
            <button
              className="btn-secondary shrink-0"
              onClick={() => ack(p._id)}
              title="Acknowledge and dismiss this card"
            >
              I've read this
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Phase 62 -- Probation Period info card for the employee dashboard.
 * Renders ONLY while the employee is currently inside their probation
 * window.  Informational -- no action buttons, no side effects.
 */
function ProbationInfoCard({ probation }) {
  if (!probation || !probation.onProbation) return null;
  const label = {
    paid: 'Paid Leave',
    casual: 'Casual Leave',
    sick: 'Sick Leave',
    unpaid: 'Unpaid Leave',
    other: 'Other Leave',
  };
  const fmt = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  return (
    <div className="border border-blue-300 bg-blue-50 rounded-lg p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide font-semibold text-blue-800">
            Probation Period
          </div>
          <div className="mt-1 text-sm text-slate-800">
            {fmt(probation.startDate)} <span className="mx-2 text-slate-500">↓</span> {fmt(probation.endDate)}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] uppercase tracking-wide text-blue-800/70">Days Remaining</div>
          <div className="text-lg font-semibold text-blue-900">{probation.daysRemaining}</div>
        </div>
      </div>
      {Array.isArray(probation.restrictedLeaveTypes) && probation.restrictedLeaveTypes.length > 0 && (
        <div className="mt-2 pt-2 border-t border-blue-200/70">
          <div className="text-[11px] uppercase tracking-wide text-blue-800/80 mb-0.5">Restricted Leave Types</div>
          <ul className="text-xs text-slate-700 list-disc pl-4">
            {probation.restrictedLeaveTypes.map((t) => <li key={t}>{label[t] || t}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function EmployeeDashboard({ embedded = false } = {}) {
  const [data, setData] = useState(null);
  // Phase 61 -- Penalty Engine feed { active, probable, resolved }.
  const [penalties, setPenalties] = useState({ active: [], probable: [], resolved: [] });
  // Phase 62 -- Probation window (informational card only).
  const [probation, setProbation] = useState(null);
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
  // Phase 53 -- Extra Tasks the employee added on top of the template's
  // predefined fields.  { subId: [{ key, label, description,
  // responseType, value, status, remark }] }.  Persisted on Save Draft
  // and on Submit; the backend upserts new (key) rows into the parent
  // template's extraTaskCatalog so future employees can pick them.
  const [extraTasks, setExtraTasks] = useState({});
  // Phase 60 -- Employee Private Remark per submission.  Only rendered
  // when the template has privateRemarkEnabled.  { subId: 'text' }.
  const [privateRemarks, setPrivateRemarks] = useState({});
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

  // Phase 45 -- Priority Notices (Important + Urgent broadcasts).  Each
  // item carries { _id, title, message, sender, priority, read, readAt,
  // createdAt }.  Read/clear state mirrors the existing inbox endpoints
  // so HR's Read receipts on the Sent Alerts page keep working untouched.
  const [priorityNotices, setPriorityNotices] = useState([]);
  // Which notice cards the employee currently has expanded.  Opening
  // one fires PATCH /:id/read so the read receipt is recorded.
  const [openedNoticeIds, setOpenedNoticeIds] = useState(() => new Set());

  // Roster of accounts a dependency can be handed to (any active user).
  useEffect(() => {
    api.get('/dependencies/assignable').then((r) => setAssignable(r.data || [])).catch(() => {});
  }, []);

  const loadDeps = () =>
    api.get('/dependencies/mine', { params: { status: 'all' } }).then((r) => setMyDeps(r.data || [])).catch(() => {});
  useEffect(() => { loadDeps(); }, []);

  // Initial + on-demand load of priority notices.
  const loadPriorityNotices = () =>
    api.get('/notifications/priority')
      .then((r) => setPriorityNotices(r.data || []))
      .catch(() => {});
  useEffect(() => { loadPriorityNotices(); }, []);

  // Phase 50 — Attendance Notes (Today + Upcoming).  Two separate
  // fetches so each panel can refresh independently; both are keyed on
  // UTC-day strings that match the backend's startOfDay storage.
  const [todayNotes, setTodayNotes]       = useState([]);
  const [upcomingNotes, setUpcomingNotes] = useState([]);
  const [notesModalDate, setNotesModalDate] = useState(null);

  const _ymd = (d) => new Date(d).toISOString().slice(0, 10);
  const loadNotes = () => {
    const todayISO = _ymd(new Date());
    // Phase 51 -- widened lookahead from 14 to 90 days so long-range
    // planning notes actually surface in Upcoming.  Employees can
    // create notes for ANY date, so the panel needs headroom.
    const in90 = new Date(); in90.setDate(in90.getDate() + 90);
    const upcomingToISO = _ymd(in90);
    // Today's notes — one small call.
    api.get('/attendance-notes', { params: { date: todayISO, archived: 'false' } })
      .then(({ data }) => setTodayNotes(data || []))
      .catch(() => setTodayNotes([]));
    // Upcoming — next 90 days from tomorrow, pending only.  Completed
    // notes stay out of the panel so it reflects "what's coming up".
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    api.get('/attendance-notes', {
      params: {
        from: _ymd(tomorrow), to: upcomingToISO,
        archived: 'false', completed: 'false',
      },
    })
      .then(({ data }) => setUpcomingNotes(data || []))
      .catch(() => setUpcomingNotes([]));
  };
  useEffect(() => { loadNotes(); }, []);

  // Note actions from the dashboard cards (Complete / Archive / Edit).
  // Edit opens the modal on the note's date; the modal handles patch.
  const setNoteStatus = async (n, patch) => {
    try {
      await api.patch(`/attendance-notes/${n._id}`, patch);
      loadNotes();
    } catch (err) { toast.error(errMsg(err)); }
  };

  // Phase 47 -- realtime subscriptions.  Server-pushed events trigger
  // a targeted re-fetch of just the affected slice; we never call
  // window.location.reload().  Each subscribe() returns its own
  // cleanup function so React tears the listener down on unmount.
  useEffect(() => {
    // New / changed priority notices land here; the panel refreshes.
    const u1 = subscribe('notification:new', (detail) => {
      if (!detail || detail.priority !== 'normal') loadPriorityNotices();
    });
    // Cleared/dismissed/resolved on another tab — keep both in sync.
    const u2 = subscribe('notification:resolved', loadPriorityNotices);
    return () => { u1(); u2(); };
  }, []);

  const openNotice = async (id) => {
    setOpenedNoticeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    // Already-read notices don't need another PATCH (the backend
    // endpoint is idempotent, but skipping saves a round-trip on
    // toggle-close).
    const target = priorityNotices.find((n) => n._id === id);
    if (target && !target.read) {
      try {
        const { data } = await api.patch(`/notifications/${id}/read`);
        setPriorityNotices((list) => list.map((n) =>
          n._id === id ? { ...n, read: true, readAt: data?.readAt || new Date().toISOString() } : n,
        ));
      } catch (_) { /* non-fatal */ }
    }
  };

  // Phase 46 -- Resolve fires for urgent (time-bound) notices.  Read
  // happens automatically on open; Resolve is the explicit "work done"
  // gesture HR/SA's Sent Alerts page reports as the Resolved column.
  const resolveNotice = async (n) => {
    if (n.priority !== 'urgent') return;
    try {
      const { data } = await api.post(`/notifications/${n._id}/resolve`);
      setPriorityNotices((list) => list.map((x) =>
        x._id === n._id ? { ...x, resolvedAt: data?.resolvedAt || new Date().toISOString(), read: true, readAt: x.readAt || data?.readAt || new Date().toISOString() } : x,
      ));
    } catch (err) { toast.error(errMsg(err)); }
  };

  // Phase 46 -- Clear from the Dashboard panel.  Calls the dedicated
  // dismiss-dashboard endpoint so the underlying Notification stays in
  // the inbox as permanent proof of delivery; only the Dashboard row
  // disappears.  Gating mirrors the spec: Important needs Read; Urgent
  // needs Resolve.
  const clearNotice = async (n) => {
    if (n.priority === 'important' && !n.read) {
      toast.error('Open the notice before clearing it.');
      return;
    }
    if (n.priority === 'urgent' && !n.resolvedAt) {
      toast.error('Resolve this time-bound notice before clearing it.');
      return;
    }
    try {
      await api.post(`/notifications/${n._id}/dismiss-dashboard`);
      setPriorityNotices((list) => list.filter((x) => x._id !== n._id));
    } catch (err) { toast.error(errMsg(err)); }
  };

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
    // Phase 60 -- include the private remark on every autosave so a
    // half-typed note isn't lost on page reload.  Backend refuses to
    // persist it when the template has the field disabled.
    if (sub.template?.privateRemarkEnabled) {
      payload.privateRemark = privateRemarks[sub._id] || '';
    }
    if (sub.templateType === 'custom') {
      const raw = customValues[sub._id] || {};
      const metaForSub = customMeta[sub._id] || {};
      payload.customResponses = Object.entries(raw).map(([key, value]) => {
        const m = metaForSub[key] || {};
        return { key, value, status: m.status || '', remark: m.remark || '' };
      });
      // Phase 53 -- draft the current Extra Tasks so autosave doesn't
      // lose half-typed ones (mirrors customResponses semantics).
      payload.extraTasks = (extraTasks[sub._id] || [])
        .filter((r) => (r.label || '').trim() || (r.key || '').trim())
        .map((r) => ({
          key: r.key || '',
          label: r.label,
          description: r.description || '',
          responseType: r.responseType || 'none',
          value: r.value ?? '',
          status: r.status || '',
          remark: r.remark || '',
        }));
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
      //
      // Draft save reads from the SAME local state the render + submit
      // paths use (`taskState`), not from the server-side snapshot
      // `sub.tasks`.  Previously the payload copied `t.status` / `t.pendingReason`
      // straight off `sub.tasks`, so the user's UI selections never
      // left the browser and every autosave / manual save wrote back
      // the initial 'pending_submit'.  The `?? t.status` fallback
      // preserves the seeded server value for tasks the employee has
      // not yet touched in the current session.
      payload.tasks = (sub.tasks || []).filter((t) => !t.addedByEmployee).map((t) => {
        const st = taskState[sub._id]?.[t._id] || {};
        return {
          taskId: t._id,
          status: st.status ?? t.status,
          pendingReason: st.pendingReason ?? t.pendingReason,
        };
      });
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
    // Phase 53 -- reseed extra tasks so a page reload / re-open of the
    // dashboard restores what the employee typed.
    const extraTasksSeed = {};
    // Phase 60 -- reseed the Employee Private Remark so a partial
    // autosave survives page reload.
    const privateRemarksSeed = {};
    // Task template: rehydrate the working copy of every task row from
    // the persisted Submission so a page refresh restores what the
    // employee saved as a draft.  Mirrors the custom-template seeding
    // pattern below: build a *Seed map keyed on submissionId, then
    // merge with `...prev` last so any in-flight typed edits win over
    // a background refetch.
    const taskStateSeed = {};
    const addedTasksSeed = {};
    (a.data.submissions || []).forEach((s) => {
      // Phase 60 -- reseed the private remark on every unsubmitted
      // template that has the feature turned on.  Works for both
      // task and custom templates because the field lives on the
      // submission, not on a task row.
      if (!s.submitted && s.template?.privateRemarkEnabled) {
        privateRemarksSeed[s._id] = typeof s.privateRemark === 'string' ? s.privateRemark : '';
      }
      if (s.templateType === 'sheet' && !s.submitted && s.sheet) {
        seed[s._id] = JSON.parse(JSON.stringify(s.sheet));
      }
      // Task template seeding.  `templateType` may be undefined on
      // very old submissions (pre-templateType field); treating that
      // as 'task' matches the render fallback further down.
      if ((s.templateType === 'task' || !s.templateType) && !s.submitted) {
        const rows = {};
        (s.tasks || []).filter((t) => !t.addedByEmployee).forEach((t) => {
          rows[String(t._id)] = {
            status: t.status || 'pending_submit',
            pendingReason: t.pendingReason || '',
          };
        });
        if (Object.keys(rows).length > 0) taskStateSeed[s._id] = rows;
        const added = (s.tasks || [])
          .filter((t) => t.addedByEmployee && (t.title || '').trim())
          .map((t) => ({ title: t.title }));
        if (added.length > 0) addedTasksSeed[s._id] = added;
      }
      if (s.templateType === 'custom' && !s.submitted) {
        const ctx = {};
        const metaCtx = {};
        (s.customResponses || []).forEach((r) => {
          ctx[r.key] = r.value;
          // Phase 14 status + remark survive reload too.
          // Phase 58 -- outOfValue also survives so Number tasks with
          // enableOutOf preserve their second field across reloads.
          const hasStatus = r.status && r.status !== '';
          const hasRemark = r.remark && r.remark !== '';
          const hasOutOf  = r.outOfValue !== undefined && Number(r.outOfValue) !== 0;
          if (hasStatus || hasRemark || hasOutOf) {
            metaCtx[r.key] = {
              status: r.status || '', remark: r.remark || '',
              outOfValue: Number(r.outOfValue) || 0,
            };
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
        // Phase 53 -- seed any extra tasks the employee has drafted.
        if (Array.isArray(s.extraTasks) && s.extraTasks.length > 0) {
          extraTasksSeed[s._id] = s.extraTasks.map((r) => ({
            key:          r.key || '',
            label:        r.label || '',
            description:  r.description || '',
            responseType: r.responseType || 'none',
            value:        r.value ?? '',
            status:       r.status || '',
            remark:       r.remark || '',
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
    setExtraTasks((prev) =>   ({ ...extraTasksSeed,    ...prev }));
    setProductSales((prev) => ({ ...productSalesSeed,  ...prev }));
    setFarmerRecords((prev) =>({ ...farmerRecordsSeed, ...prev }));
    // Task template -- same prev-wins spread order so in-flight typed
    // edits are not clobbered by a background refetch triggered by a
    // realtime event.
    setTaskState((prev) =>    ({ ...taskStateSeed,     ...prev }));
    setAddedTasks((prev) =>   ({ ...addedTasksSeed,    ...prev }));
    // Phase 60 -- seed the private remark drafts; keep any in-flight
    // typed text (prev) rather than clobbering with the server copy.
    setPrivateRemarks((prev) => ({ ...privateRemarksSeed, ...prev }));
    setSheetState(seed);
    setData(a.data);
    setSummary(b.data);
    setLoading(false);
    // Phase 61 -- pull the caller's own penalty feed for the
    // dashboard warning card.  Failure is non-fatal.
    try {
      const pr = await api.get('/penalties/mine');
      setPenalties(pr.data || { active: [], probable: [], resolved: [] });
    } catch (_) { /* card just stays empty */ }
    // Phase 62 -- probation info card.  Never blocks the dashboard.
    try {
      const pb = await api.get('/probation/mine');
      setProbation(pb.data || null);
    } catch (_) { /* card just stays hidden */ }
  };
  useEffect(() => { load(); }, []);

  // Phase 47 -- refresh today's tasks + summary counters whenever an
  // event affects them.  load() re-fetches /submissions/today and
  // /dashboard/employee/summary so the cards, backlog table and stat
  // tiles all reflect the new state.
  useEffect(() => {
    const u1 = subscribe('assignment:created',      load);
    const u2 = subscribe('leave:decision',          load);
    const u3 = subscribe('salary:slip:generated',   load);
    const u4 = subscribe('attendance:changed',      load);
    return () => { u1(); u2(); u3(); u4(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // Phase 60 -- client-side required check.  Server validates
      // again so a rogue client can't skip the required flag.
      if (sub.template?.privateRemarkEnabled && sub.template?.privateRemarkRequired) {
        const txt = (privateRemarks[sub._id] || '').trim();
        if (!txt) {
          toast.error(`${sub.template.privateRemarkLabel || 'Remark'} is required before submitting.`);
          setBusy(false);
          return;
        }
      }
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
          // Phase 60 -- optional Employee Private Remark.  Backend
          // ignores this when the template hasn't enabled it.
          privateRemark: sub.template?.privateRemarkEnabled ? (privateRemarks[sub._id] || '') : undefined,
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
          // Phase 60 -- optional Employee Private Remark.  Backend
          // ignores this when the template hasn't enabled it.
          privateRemark: sub.template?.privateRemarkEnabled ? (privateRemarks[sub._id] || '') : undefined,
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
        // Phase 52 -- per-field "Remark Required".  Only applies when
        // Remark Enabled (supportsRemark) is on.  Mirrors the backend
        // guard so the user sees the error before the round-trip.
        for (const f of fields) {
          if (!f.supportsRemark || !f.remarkRequired) continue;
          if (f.systemGenerated || f.fieldType === 'auto' || f.fieldType === 'readonly') continue;
          const m = metaForSub[f.key] || {};
          if (!(m.remark || '').trim()) {
            toast.error(`Remark is required for "${f.label}".`);
            setBusy(false);
            return;
          }
        }
        // Phase 21 (Issue 2): Agri-Advisor DR / Calling Report rule --
        // totalCallsCompleted must never exceed assignedCalls.  Pre-submit
        // client-side guard mirrors what HR enforces during review.  Run
        // customCompute against the live employee inputs so the formula
        // field (totalCallsCompleted = yesterday + today) reflects what's
        // actually about to be persisted.  Autosave / Save Draft / formula
        // logic untouched -- this only runs at submit time.
        if (sub.template?.customKind === 'calling') {
          const computedView = customCompute(sub.template?.customFields || [], raw);
          const assigned = Number(computedView.assignedCalls) || 0;
          const totalDone = Number(computedView.totalCallsCompleted) || 0;
          if (totalDone > assigned) {
            toast.error(`Total Calls Completed (${totalDone}) cannot exceed Assigned Calls (${assigned}).`);
            setBusy(false);
            return;
          }
        }
        const payload = Object.entries(raw).map(([key, value]) => {
          const m = metaForSub[key] || {};
          // Phase 58 -- Number tasks with enableOutOf pass their second
          // value via meta.outOfValue.  The submit handler picks this
          // up alongside status + remark.
          return {
            key,
            value,
            status: m.status || '',
            remark: m.remark || '',
            outOfValue: Number.isFinite(Number(m.outOfValue)) ? Number(m.outOfValue) : 0,
          };
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
        // Phase 53 -- Extra Tasks: only rows that carry BOTH a label
        // and (if their response type demands it) a value/status make
        // it into the submission.  Empty half-typed rows are dropped.
        const cleanExtras = (extraTasks[sub._id] || [])
          .filter((r) => (r.label || '').trim())
          .map((r) => ({
            key:          (r.key || '').trim(),
            label:        r.label.trim(),
            description:  (r.description || '').trim(),
            responseType: r.responseType || 'none',
            value:        r.value ?? '',
            status:       r.status || '',
            remark:       (r.remark || '').trim(),
          }));
        // Guard: number responses need a numeric value (matches the
        // backend's coercion; this just gives a clearer error).
        for (const r of cleanExtras) {
          if ((r.responseType === 'number' || r.responseType === 'number_status')
              && (r.value === '' || Number.isNaN(Number(r.value)))) {
            toast.error(`Enter a number for extra task "${r.label}".`);
            setBusy(false);
            return;
          }
        }
        await api.post(`/submissions/${sub._id}/submit`, {
          customResponses: payload,
          extraTasks: cleanExtras,
          productSales: cleanProductSales,
          farmerRecords: cleanFarmers,
          selfRating: selfRating[sub._id],
          selfNote: selfNote[sub._id],
          idea: idea[sub._id],
          // Phase 60 -- optional Employee Private Remark.  Backend
          // ignores this when the template hasn't enabled it.
          privateRemark: sub.template?.privateRemarkEnabled ? (privateRemarks[sub._id] || '') : undefined,
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
          // Phase 60 -- optional Employee Private Remark.  Backend
          // ignores this when the template hasn't enabled it.
          privateRemark: sub.template?.privateRemarkEnabled ? (privateRemarks[sub._id] || '') : undefined,
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

      {/* Phase 45 -- Priority Notices.  Renders Important + Urgent
          broadcasts from HR/Super Admin.  Defaults open when there's at
          least one unread; collapses when empty.  Each notice expands
          inline; opening marks it Read (which also fires the existing
          read-receipt on HR's Send Alerts page).  Clear / archive is
          gated on Read so urgent notices can't be silently dismissed. */}
      {!embedded && (() => {
        const unreadCount = priorityNotices.filter((n) => !n.read).length;
        const totalCount  = priorityNotices.length;
        return (
          <Collapsible
            title="Priority Notices"
            subtitle={totalCount === 0
              ? 'No important notices'
              : `${unreadCount} unread · ${totalCount} total`}
            right={totalCount === 0
              ? <span className="badge-gray">0</span>
              : unreadCount > 0
                ? <span className="badge-red">{unreadCount}</span>
                : <span className="badge-green">All read</span>}
            defaultOpen={totalCount > 0}
          >
            {totalCount === 0 ? (
              <div className="text-sm text-slate-500">No important or urgent notices right now.</div>
            ) : (
              <div className="space-y-2">
                {priorityNotices.map((n) => {
                  const open = openedNoticeIds.has(n._id);
                  const isUrgent = n.priority === 'urgent';
                  const resolved = !!n.resolvedAt;
                  // Phase 46 -- urgent cards switch their accent to
                  // green once resolved so the panel reads as a small
                  // to-do queue.
                  const cardCls = isUrgent
                    ? (resolved ? 'border-green-200 bg-green-50/40' : 'border-red-200 bg-red-50/40')
                    : 'border-amber-200 bg-amber-50/40';
                  const badgeCls = isUrgent ? 'badge-red' : 'badge-amber';
                  // Clear gate per spec:
                  //   important -> after Read
                  //   urgent    -> after Resolve
                  const canClear = isUrgent ? resolved : n.read;
                  const clearTitle = canClear
                    ? 'Clear from dashboard (notification stays in your inbox)'
                    : (isUrgent
                        ? 'Resolve this time-bound notice before clearing it'
                        : 'Open the notice before clearing it');
                  return (
                    <div key={n._id} className={`rounded-lg border ${cardCls} p-3`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <button
                          type="button"
                          className="flex-1 text-left min-w-0"
                          onClick={() => openNotice(n._id)}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={badgeCls}>
                              {isUrgent ? 'Urgent' : 'Important'}
                            </span>
                            {!n.read && <span className="badge-red text-[10px]">UNREAD</span>}
                            {isUrgent && (
                              resolved
                                ? <span className="badge-green text-[10px]">RESOLVED</span>
                                : <span className="badge-amber text-[10px]">PENDING</span>
                            )}
                            <span className={`text-sm font-semibold ${n.read ? 'text-slate-700' : 'text-slate-900'}`}>
                              {n.title}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            {n.sender?.name ? `From ${n.sender.name}` : 'From HR'}
                            {' · '}
                            Sent {new Date(n.createdAt).toLocaleString()}
                            {n.read && n.readAt && (
                              <> · <span className="text-green-700">Read {new Date(n.readAt).toLocaleString()}</span></>
                            )}
                            {resolved && (
                              <> · <span className="text-green-700">Resolved {new Date(n.resolvedAt).toLocaleString()}</span></>
                            )}
                          </div>
                          {/* Phase 46 -- prominent deadline ribbon for
                              urgent / time-bound notices. */}
                          {isUrgent && n.deadline && (
                            <div className="mt-2 inline-flex items-center gap-2 rounded-md bg-red-100 text-red-800 text-[11px] font-semibold px-2 py-1">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10" />
                                <polyline points="12 6 12 12 16 14" />
                              </svg>
                              Complete Before: {new Date(n.deadline).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}
                              {' · '}
                              {new Date(n.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          )}
                        </button>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            className="btn-secondary !py-1 !text-xs"
                            onClick={() => openNotice(n._id)}
                          >
                            {open ? 'Hide' : (n.read ? 'View' : 'Open')}
                          </button>
                          {isUrgent && !resolved && (
                            <button
                              type="button"
                              className="btn-primary !py-1 !text-xs"
                              title="Mark this time-bound work as completed"
                              onClick={() => resolveNotice(n)}
                            >
                              ✓ Resolve
                            </button>
                          )}
                          <button
                            type="button"
                            className={`btn-ghost !py-1 !text-xs ${canClear ? 'text-red-600' : 'text-slate-300 cursor-not-allowed'}`}
                            title={clearTitle}
                            disabled={!canClear}
                            onClick={() => clearNotice(n)}
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      {open && (
                        <div className="mt-3 bg-white border border-slate-200 rounded-md p-3 text-sm text-slate-800 whitespace-pre-wrap">
                          {n.message}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Collapsible>
        );
      })()}

      {/* Phase 50 — Today's Notes.  Silent reminders on the employee's
          attendance calendar (no notifications).  Each card supports
          Complete / Archive / Edit; Edit opens the shared modal on the
          note's date.  Phase 51 -- "+ New Note" opens the modal with
          today prefilled, but the date is editable so users can plan
          for any day (past / present / future). */}
      {!embedded && (() => {
        const pending = todayNotes.filter((n) => !n.completed);
        const total   = todayNotes.length;
        const todayISO = _ymd(new Date());
        return (
          <Collapsible
            title="Today's Notes"
            subtitle={total === 0 ? 'No notes for today' : `${pending.length} pending · ${total} total`}
            right={total === 0
              ? <span className="badge-gray">0</span>
              : pending.length > 0
                ? <span className="badge-amber">{pending.length}</span>
                : <span className="badge-green">All done</span>}
            defaultOpen={total > 0}
          >
            <div className="flex justify-end mb-2">
              <button
                className="btn-primary !py-1 !text-xs"
                onClick={() => setNotesModalDate(todayISO)}
                title="Create a note for any date"
              >
                + New Note
              </button>
            </div>
            {total === 0 ? (
              <div className="text-sm text-slate-500">
                No notes for today. Use <b>+ New Note</b> above to plan one for any date, or open the{' '}
                <a href="/my-attendance" className="text-brand-600 hover:underline">Attendance calendar</a>.
              </div>
            ) : (
              <div className="space-y-2">
                {todayNotes.map((n) => (
                  <div
                    key={n._id}
                    className={`rounded-lg border p-3 ${
                      n.completed
                        ? 'bg-green-50/40 border-green-200'
                        : n.priority === 'important'
                          ? 'bg-amber-50/40 border-amber-200'
                          : 'bg-white border-slate-200'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          {n.priority === 'important'
                            ? <span className="badge-amber">Important</span>
                            : <span className="badge-gray">Normal</span>}
                          {n.completed && <span className="badge-green text-[10px]">DONE</span>}
                          {n.locked   && <span className="badge bg-slate-100 text-slate-600 text-[10px]">🔒</span>}
                          <span className={`text-sm font-semibold ${n.completed ? 'line-through text-slate-500' : 'text-slate-900'}`}>
                            {n.title}
                          </span>
                        </div>
                        {n.description && (
                          <div className="text-xs text-slate-600 mt-1 whitespace-pre-wrap">{n.description}</div>
                        )}
                        <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap items-center gap-2">
                          {n.reminderTime && <span>⏰ {n.reminderTime}</span>}
                          <span>
                            Created by {n.createdBy?.name || n.createdByName || 'You'}
                            {n.createdByRole && ` (${n.createdByRole === 'super_admin' ? 'Super Admin' : n.createdByRole.toUpperCase()})`}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {!n.completed
                          ? <button className="btn-primary !py-1 !text-xs" onClick={() => setNoteStatus(n, { completed: true })}>Mark Complete</button>
                          : <button className="btn-ghost !py-1 !text-xs" onClick={() => setNoteStatus(n, { completed: false })}>Undo</button>}
                        <button
                          className="btn-secondary !py-1 !text-xs"
                          onClick={() => setNotesModalDate(new Date(n.date).toISOString().slice(0, 10))}
                        >
                          Edit
                        </button>
                        <button className="btn-ghost !py-1 !text-xs" onClick={() => setNoteStatus(n, { archived: true })}>Archive</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Collapsible>
        );
      })()}

      {/* Phase 50 — Upcoming Notes.  Phase 51 widens the lookahead to
          90 days and groups into Tomorrow / rest of this week / Next
          Week / This Month / Later.  Pending only; completed notes
          stay silent. */}
      {!embedded && (() => {
        const total = upcomingNotes.length;
        // Bucket by day-offset relative to today (UTC-day granularity).
        const today0 = new Date(); today0.setHours(0, 0, 0, 0);
        const buckets = [];
        const bucketMap = new Map();
        const _bucketFor = (dateISO) => {
          const d = new Date(dateISO);
          const diff = Math.round((d - today0) / 86400000);
          if (diff <= 1) return 'Tomorrow';
          if (diff <= 7) {
            const wd = d.toLocaleDateString(undefined, { weekday: 'long' });
            return wd;
          }
          if (diff <= 14) return 'Next Week';
          if (diff <= 30) return 'This Month';
          return 'Later';
        };
        for (const n of upcomingNotes) {
          const label = _bucketFor(n.date);
          if (!bucketMap.has(label)) { bucketMap.set(label, []); buckets.push(label); }
          bucketMap.get(label).push(n);
        }
        return (
          <Collapsible
            title="Upcoming Notes"
            subtitle={total === 0 ? 'Nothing scheduled in the next 90 days' : `${total} note${total === 1 ? '' : 's'} coming up`}
            right={total === 0 ? <span className="badge-gray">0</span> : <span className="badge-blue">{total}</span>}
            defaultOpen={total > 0}
          >
            {total === 0 ? (
              <div className="text-sm text-slate-500">Nothing scheduled in the next 90 days.</div>
            ) : (
              <div className="space-y-3">
                {buckets.map((label) => (
                  <div key={label}>
                    <div className="text-[11px] uppercase text-slate-500 font-semibold mb-1">{label}</div>
                    <ul className="space-y-1">
                      {bucketMap.get(label).map((n) => (
                        <li
                          key={n._id}
                          className="flex items-center justify-between gap-2 text-sm bg-white border border-slate-200 rounded-md px-3 py-2 cursor-pointer hover:bg-slate-50"
                          onClick={() => setNotesModalDate(new Date(n.date).toISOString().slice(0, 10))}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            {n.priority === 'important'
                              ? <span className="badge-amber text-[10px]">Important</span>
                              : <span className="badge-gray text-[10px]">Normal</span>}
                            <span className="font-medium text-slate-800 truncate">{n.title}</span>
                            {n.reminderTime && <span className="text-[11px] text-slate-500 shrink-0">⏰ {n.reminderTime}</span>}
                          </span>
                          <span className="text-[11px] text-slate-500 shrink-0">
                            {new Date(n.date).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Collapsible>
        );
      })()}

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

      {/* Phase 29: Attendance Confirmation card -- renders for
          attendance_review mode employees on working days only.  The
          backend already checks weekly-off / holiday / approved-leave
          state before reporting eligible=true, so we just render the
          payload it returns. */}
      {!data.onLeave && !data.weeklyOff && !data.holiday && (
        <AttendanceConfirmationCard />
      )}

      {/* Phase 62 -- Probation info card (informational). */}
      <ProbationInfoCard probation={probation} />

      {/* Phase 61 -- Penalty Engine dashboard warning card.  Renders
          only when there's something to show.  The employee can
          acknowledge each warning; acknowledgement time is stored
          on the Penalty document so HR can see it. */}
      <PenaltyWarnings
        penalties={penalties}
        onAcknowledged={async () => {
          try {
            const pr = await api.get('/penalties/mine');
            setPenalties(pr.data || { active: [], probable: [], resolved: [] });
          } catch (_) { /* silent */ }
        }}
      />

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
                  extraTasks={extraTasks[sub._id] || []}
                  setExtraTasks={(updater) =>
                    setExtraTasks((s) => ({
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
                  // Phase 60 -- Employee Private Remark plumbing.
                  privateRemark={privateRemarks[sub._id] || ''}
                  setPrivateRemark={(v) => setPrivateRemarks((s) => ({ ...s, [sub._id]: v }))}
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

                  {/* Phase 60 -- Employee Private Remark. */}
                  <PrivateRemarkBox
                    sub={sub}
                    value={privateRemarks[sub._id] || ''}
                    onChange={(v) => setPrivateRemarks((s) => ({ ...s, [sub._id]: v }))}
                  />

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

                  {/* Phase 60 -- Employee Private Remark. */}
                  <PrivateRemarkBox
                    sub={sub}
                    value={privateRemarks[sub._id] || ''}
                    onChange={(v) => setPrivateRemarks((s) => ({ ...s, [sub._id]: v }))}
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

                  {/* Phase 60 -- Employee Private Remark. */}
                  <PrivateRemarkBox
                    sub={sub}
                    value={privateRemarks[sub._id] || ''}
                    onChange={(v) => setPrivateRemarks((s) => ({ ...s, [sub._id]: v }))}
                  />

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

      {/* Phase 50 -- shared notes modal, opened from either the
          Today's Notes panel (Edit button) or the Upcoming list
          (click row). */}
      <AttendanceNotesModal
        open={!!notesModalDate}
        date={notesModalDate}
        onClose={() => setNotesModalDate(null)}
        onChanged={loadNotes}
      />
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
  extraTasks = [], setExtraTasks = () => {},
  products = [], quantities = [], dealers = [],
  selfRating, setSelfRating, selfNote, setSelfNote, idea, setIdea,
  busy, onSubmit,
  // Phase 60 -- Employee Private Remark inputs.
  privateRemark = '',
  setPrivateRemark = () => {},
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
      // Phase 58 — Number tasks may carry a second "Out Of" value.
      // When enableOutOf is on, render two inputs side-by-side; the
      // second value is stored in meta.outOfValue so the submission
      // handler can pick it up alongside status + remark.
      if (f.enableOutOf) {
        const outOf = m.outOfValue ?? '';
        const remaining = (Number(outOf) || 0) - (Number(v) || 0);
        valueControl = (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[10px] text-slate-500 mb-0.5">Completed</div>
              <input
                className="input"
                type="number"
                step="any"
                min="0"
                value={v ?? ''}
                onChange={(e) => onChange(f.key, e.target.value === '' ? '' : Number(e.target.value))}
              />
            </div>
            <div>
              <div className="text-[10px] text-slate-500 mb-0.5">{f.outOfLabel || 'Out Of'}</div>
              <input
                className="input"
                type="number"
                step="any"
                min="0"
                value={outOf}
                onChange={(e) => onMeta(f.key, { outOfValue: e.target.value === '' ? 0 : Number(e.target.value) })}
              />
              {Number(outOf) > 0 && Number(v) >= 0 && (
                <div className="text-[10px] text-slate-500 mt-0.5">
                  Remaining: <b>{Math.max(0, remaining)}</b>
                </div>
              )}
            </div>
          </div>
        );
      } else {
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
      }
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

        {/* Value (+ optional status + optional remark).
            Phase 20 fix: when the field has neither Status nor Remark
            (Calling Report / Agri-Advisor DR -- every field is a pure
            number or auto-calc), skip the inner 12-col grid entirely
            so the value input fills the whole card width.  The earlier
            renderer always wrapped the value in `md:col-span-${expr}`
            with template-literal interpolation; Tailwind's JIT can't
            generate dynamic class names, so md:col-span-12 was never
            present in the compiled CSS and the input collapsed to 1/12
            width.  Auto fields read as plain text and looked fine, but
            editable number inputs clipped their values -- the exact
            symptom HR reported.  Literal conditional class strings
            below replace the template literals so the col-spans Tailwind
            DOES need are reliably generated. */}
        {f.fieldType === 'none' ? (
          /* Phase 53 -- status-only field.  No value column: only the
              Status picker (and optional Remark) render below. */
          (f.supportsStatus || f.supportsRemark) ? (
            <div className="grid md:grid-cols-12 gap-2">
              {f.supportsStatus && (
                <div className={f.supportsRemark ? 'md:col-span-5' : 'md:col-span-12'}>
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
                <div className={f.supportsStatus ? 'md:col-span-7' : 'md:col-span-12'}>
                  <div className="label text-[10px] uppercase">
                    Remark
                    {(pendingNeedsRemark || f.remarkRequired) && <span className="text-red-500"> *</span>}
                  </div>
                  <input
                    className={`input ${(pendingNeedsRemark || f.remarkRequired) && !(m.remark || '').trim() ? 'border-red-400' : ''}`}
                    placeholder={
                      f.remarkRequired ? 'Remark required'
                      : pendingNeedsRemark ? 'Reason required for Pending'
                      : 'Optional'
                    }
                    value={m.remark || ''}
                    onChange={(e) => onMeta(f.key, { remark: e.target.value })}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="text-[11px] italic text-slate-400">
              Status-only task with no status enabled — nothing to record.
            </div>
          )
        ) : !f.supportsStatus && !f.supportsRemark ? (
          <div>
            <div className="label text-[10px] uppercase">Value</div>
            {valueControl}
          </div>
        ) : (
          <div className="grid md:grid-cols-12 gap-2">
            <div className={f.supportsRemark
              ? 'md:col-span-5'
              : 'md:col-span-9' /* status-only: give the value more room */
            }>
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
              <div className={f.supportsStatus ? 'md:col-span-4' : 'md:col-span-7'}>
                {/* Phase 52 -- Remark Required marks the label with a
                    red asterisk and pushes the input into an error
                    border when empty.  This mirrors the existing
                    pending-remark treatment and the backend guard. */}
                <div className="label text-[10px] uppercase">
                  Remark
                  {(pendingNeedsRemark || f.remarkRequired) && <span className="text-red-500"> *</span>}
                </div>
                <input
                  className={`input ${(pendingNeedsRemark || f.remarkRequired) && !(m.remark || '').trim() ? 'border-red-400' : ''}`}
                  placeholder={
                    f.remarkRequired ? 'Remark required'
                    : pendingNeedsRemark ? 'Reason required for Pending'
                    : 'Optional'
                  }
                  value={m.remark || ''}
                  onChange={(e) => onMeta(f.key, { remark: e.target.value })}
                />
              </div>
            )}
          </div>
        )}
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
          {/* Phase 20: responsive grid inside every section.  Replaces the
              previous vertical stack so a section like "Today" packs three
              small inputs (Assigned / Yesterday / Today) into one row on
              desktop, two on tablet, and one on mobile.  All renderField
              behaviour stays identical -- this is a layout-only change.

              Long-form types (textarea / long_text) span full row at every
              breakpoint so a multi-line note doesn't get squashed into a
              third of the width.  Every other field type -- including auto-
              calculated, currency, percentage, dropdown, date, time,
              yes/no -- participates in the grid as a single cell. */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {g.items.map((f) => {
              const wide = f.fieldType === 'textarea' || f.fieldType === 'long_text';
              return (
                <div key={f.key} className={wide ? 'md:col-span-2 xl:col-span-3' : ''}>
                  {renderField(f)}
                </div>
              );
            })}
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

      {/* Phase 53 -- Extra Tasks.  Employee-added ad-hoc rows on top of
          the predefined customFields.  Kept in its own section so HR
          review + template analytics can treat predefined and extra
          tasks as two independent buckets. */}
      <ExtraTasksSection
        templateId={sub.template?._id}
        catalog={sub.template?.extraTaskCatalog || []}
        rows={extraTasks}
        setRows={setExtraTasks}
      />

      {/* Self-observation + Idea moved to a single Daily Reflection card
          at the top of "Today's Tasks" (Phase 5 refactor). */}

      {/* Phase 60 -- Employee Private Remark, HR/SA-only downstream. */}
      <PrivateRemarkBox
        sub={sub}
        value={privateRemark}
        onChange={setPrivateRemark}
      />

      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy} onClick={onSubmit}>Submit Report</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Phase 53 -- Extra Tasks section                                    */
/*                                                                    */
/* Employees can add ad-hoc reminders / extra work to a Custom        */
/* Assignment submission.  Each row supports one of four response     */
/* types: none / number / status / number_status.  The picker offers  */
/* two flows: reuse an existing entry from the template's Extra Task  */
/* Catalog (with type-ahead search) or create a brand-new one that    */
/* the backend will fold into the catalog on submit.                  */
/* ------------------------------------------------------------------ */
const EXTRA_RESPONSE_TYPES = [
  { value: 'none',           label: 'None (status only)' },
  { value: 'number',         label: 'Number only' },
  { value: 'status',         label: 'Status only' },
  { value: 'number_status',  label: 'Number + Status' },
];
const _extraSlug = (s) => String(s || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

function ExtraTasksSection({ catalog = [], rows = [], setRows }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/30 p-3">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <div className="text-sm font-semibold text-indigo-900">Extra Tasks</div>
          <div className="text-[11px] text-indigo-700/80">
            Optional. Reuse a task from the template catalog or create a new one.
            HR review + analytics keep these separate from the predefined tasks.
          </div>
        </div>
        <button
          type="button"
          className="btn-secondary !py-1 !text-xs"
          onClick={() => setPickerOpen(true)}
        >
          + Add Extra Task
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="text-xs text-indigo-700/60 italic">
          No extra tasks yet. Click "+ Add Extra Task" to add one.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <ExtraTaskRow
              key={i}
              row={r}
              onChange={(patch) => setRows((cur) => cur.map((x, idx) => (idx === i ? { ...x, ...patch } : x)))}
              onRemove={() => setRows((cur) => cur.filter((_, idx) => idx !== i))}
            />
          ))}
        </div>
      )}

      {pickerOpen && (
        <ExtraTaskPickerModal
          catalog={catalog}
          existingKeys={new Set(rows.map((r) => r.key).filter(Boolean))}
          onClose={() => setPickerOpen(false)}
          onPick={(row) => {
            setRows((cur) => [...cur, row]);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ExtraTaskRow({ row, onChange, onRemove }) {
  const wantsValue  = row.responseType === 'number' || row.responseType === 'number_status';
  const wantsStatus = row.responseType === 'status' || row.responseType === 'number_status';
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-800">{row.label || <em className="text-slate-400">Unnamed</em>}</div>
          {row.description && (
            <div className="text-[11px] text-slate-500 mt-0.5">{row.description}</div>
          )}
          <div className="text-[10px] uppercase text-slate-400 mt-0.5">
            {EXTRA_RESPONSE_TYPES.find((t) => t.value === row.responseType)?.label || 'Response'}
          </div>
        </div>
        <button type="button" className="btn-ghost text-red-600 !py-0.5 !px-2 text-xs" onClick={onRemove}>Remove</button>
      </div>
      <div className="grid md:grid-cols-12 gap-2">
        {wantsValue && (
          <div className={wantsStatus ? 'md:col-span-5' : 'md:col-span-12'}>
            <div className="label text-[10px] uppercase">Value</div>
            <input
              className="input"
              type="number"
              step="any"
              value={row.value ?? ''}
              onChange={(e) => onChange({ value: e.target.value === '' ? '' : Number(e.target.value) })}
            />
          </div>
        )}
        {wantsStatus && (
          <div className={wantsValue ? 'md:col-span-3' : 'md:col-span-6'}>
            <div className="label text-[10px] uppercase">Status</div>
            <select
              className="input"
              value={row.status || ''}
              onChange={(e) => onChange({ status: e.target.value })}
            >
              <option value="">—</option>
              <option value="done">Done</option>
              <option value="pending">Pending</option>
              <option value="work_not_available">Work N/A</option>
            </select>
          </div>
        )}
        <div className={wantsValue && wantsStatus ? 'md:col-span-4' : wantsValue || wantsStatus ? 'md:col-span-6' : 'md:col-span-12'}>
          <div className="label text-[10px] uppercase">Remark</div>
          <input
            className="input"
            placeholder="Optional"
            value={row.remark || ''}
            onChange={(e) => onChange({ remark: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

function ExtraTaskPickerModal({ catalog, existingKeys, onClose, onPick }) {
  // Two-tab modal: Select Existing (searchable) OR Create New.
  const [tab, setTab] = useState('select');
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ label: '', description: '', responseType: 'none' });

  const filtered = (catalog || [])
    // Hide items already added to this submission so the same key
    // can't be added twice (backend would dedupe anyway; this keeps
    // the UI honest).
    .filter((c) => !existingKeys.has(c.key))
    .filter((c) => {
      if (!q) return true;
      const s = q.toLowerCase();
      return (c.label || '').toLowerCase().includes(s)
        || (c.description || '').toLowerCase().includes(s);
    })
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));

  const pickExisting = (c) => {
    onPick({
      key: c.key,
      label: c.label,
      description: c.description || '',
      responseType: c.responseType || 'none',
      value: '', status: '', remark: '',
    });
  };
  const pickNew = () => {
    if (!form.label.trim()) return;
    const key = _extraSlug(form.label);
    if (!key) return;
    onPick({
      key,
      label: form.label.trim(),
      description: form.description.trim(),
      responseType: form.responseType,
      value: '', status: '', remark: '',
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full m-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center border-b border-slate-200">
          {[
            { id: 'select', label: 'Select existing' },
            { id: 'new',    label: 'Create new' },
          ].map((t) => (
            <button
              key={t.id}
              className={`px-4 py-3 text-sm border-b-2 -mb-px ${tab === t.id ? 'border-brand-500 text-brand-700 font-semibold' : 'border-transparent text-slate-500'}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <button className="ml-auto px-4 text-slate-500 hover:text-slate-800" onClick={onClose}>✕</button>
        </div>
        <div className="p-4 space-y-3">
          {tab === 'select' ? (
            <>
              <input
                className="input"
                placeholder="Search extra tasks…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoFocus
              />
              <div className="max-h-[300px] overflow-y-auto space-y-1">
                {filtered.length === 0 ? (
                  <div className="text-xs italic text-slate-500 p-2">
                    {catalog.length === 0
                      ? 'No extra tasks in this template\'s catalog yet.  Use "Create new" to add the first one.'
                      : 'No matches — try a different search or the "Create new" tab.'}
                  </div>
                ) : filtered.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className="w-full text-left border border-slate-200 rounded p-2 hover:bg-slate-50"
                    onClick={() => pickExisting(c)}
                  >
                    <div className="text-sm font-medium text-slate-800">{c.label}</div>
                    {c.description && <div className="text-[11px] text-slate-500">{c.description}</div>}
                    <div className="text-[10px] uppercase text-slate-400 mt-0.5">
                      {EXTRA_RESPONSE_TYPES.find((t) => t.value === c.responseType)?.label || 'Response'}
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="label text-[10px] uppercase">Work Name</label>
                <input
                  className="input"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="e.g. Dealer Visit"
                />
              </div>
              <div>
                <label className="label text-[10px] uppercase">Description (optional)</label>
                <input
                  className="input"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <div>
                <label className="label text-[10px] uppercase">Response Type</label>
                <select
                  className="input"
                  value={form.responseType}
                  onChange={(e) => setForm({ ...form, responseType: e.target.value })}
                >
                  {EXTRA_RESPONSE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div className="text-[11px] text-slate-500">
                After you submit, this task is automatically added to this template's catalog so teammates can reuse it.
              </div>
              <div className="flex justify-end">
                <button
                  className="btn-primary !py-1 !text-xs"
                  disabled={!form.label.trim()}
                  onClick={pickNew}
                >
                  Add
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Daily Reflection card                                               */
/*                                                                     */
/* Phase 5: lives ONCE per day at the top of "Today's Tasks", regardless */
/* ------------------------------------------------------------------ */
/* Phase 29 — Attendance Confirmation card                              */
/*                                                                      */
/* Renders only for employees on `attendanceMode === 'attendance_review'`*/
/* on working days that aren't holidays / weekly offs / approved leaves.*/
/* The backend's /attendance-confirmation/today endpoint enforces that  */
/* gate and returns {eligible:false, reason} otherwise -- we just hide   */
/* the card in that case.                                               */
/* ------------------------------------------------------------------ */
function AttendanceConfirmationCard() {
  const [state, setState] = useState(null); // { eligible, todayIso, status, confirmedAt, reviewedAt }
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = async () => {
    try {
      const { data } = await api.get('/attendance-confirmation/today');
      setState(data);
    } catch (_) { setState({ eligible: false, reason: 'error' }); }
  };
  useEffect(() => { load(); }, []);
  // Phase 47 -- refresh when HR edits attendance.
  useEffect(() => subscribe('attendance:changed', load), []);

  const confirm = async () => {
    setBusy(true);
    try {
      await api.post('/attendance-confirmation/confirm');
      toast.success('Attendance confirmed for today');
      await load();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  if (!state || !state.eligible) return null;

  const STATUS_META = {
    pending:              { label: 'Awaiting HR Review', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    approved_present:     { label: 'Approved · Present', cls: 'bg-green-50 text-green-700 border-green-200' },
    marked_absent:        { label: 'Marked Absent',       cls: 'bg-red-50   text-red-700   border-red-200' },
    marked_half_paid:     { label: 'Marked Half Day (Paid)',   cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    marked_half_unpaid:   { label: 'Marked Half Day (Unpaid)', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    marked_paid_leave:    { label: 'Marked Leave (Paid)',      cls: 'bg-blue-50  text-blue-700  border-blue-200' },
    marked_unpaid_leave:  { label: 'Marked Leave (Unpaid)',    cls: 'bg-blue-50  text-blue-700  border-blue-200' },
  };
  const meta = state.status ? STATUS_META[state.status] : null;
  return (
    <div className="card card-body bg-brand-50/40 dark:bg-brand-500/10 border border-brand-200 dark:border-brand-500/30 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Daily Attendance Confirmation</div>
          <div className="text-[12px] text-slate-500">Date: {state.todayIso}</div>
        </div>
        {meta && <span className={`badge text-[11px] border ${meta.cls}`}>{meta.label}</span>}
      </div>
      {!state.status ? (
        <button className="btn-primary" onClick={confirm} disabled={busy}>
          {busy ? 'Confirming…' : 'Confirm Present'}
        </button>
      ) : (
        <div className="text-[12px] text-slate-600 dark:text-slate-300">
          Confirmed at {state.confirmedAt ? new Date(state.confirmedAt).toLocaleString() : '—'}.
          {state.reviewedAt && <> Reviewed at {new Date(state.reviewedAt).toLocaleString()}.</>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
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

  // Hydrate the card from the employee's OWN saved reflection so a
  // page refresh restores what was already filed today.  Uses the
  // dedicated `/daily-review/my-reflection` endpoint (req.user._id,
  // no employeeId param, no HR / HOD gate).  Returns null when the
  // employee hasn't filed yet -- the card simply stays empty.
  useEffect(() => {
    let cancelled = false;
    api.get('/daily-review/my-reflection', { params: { date: todayIso } })
      .then(({ data }) => {
        if (cancelled || !data) return;
        if (data.selfRating !== undefined && data.selfRating !== null) {
          setRating(String(data.selfRating));
        }
        if (typeof data.selfNote === 'string') setNote(data.selfNote);
        if (typeof data.idea === 'string')     setIdea(data.idea);
        // Prefer the persistence timestamp so the pill reads
        // "Saved HH:MM" after a page refresh -- falls back to
        // createdAt when a very old row predates the field.
        const ts = data.updatedAt || data.createdAt;
        if (ts) setSavedAt(new Date(ts));
      })
      .catch(() => { /* card starts empty on any error */ });
    return () => { cancelled = true; };
  }, [todayIso]);

  // Phase 69 -- Self Rating is required.  Validation runs both here
  // (helpful inline feedback) AND server-side (single source of truth).
  const ratingValid = rating !== '' && rating !== null && rating !== undefined
    && Number.isFinite(Number(rating))
    && Number(rating) >= 0 && Number(rating) <= 10;
  const ratingError = rating === '' || rating === null || rating === undefined
    ? 'Self Rating is required.'
    : !ratingValid
      ? 'Enter a number between 0 and 10.'
      : '';

  const save = async () => {
    if (!ratingValid) { toast.error(ratingError); return; }
    setBusy(true);
    try {
      await api.post('/daily-review/reflection', {
        date: todayIso,
        selfRating: Number(rating),
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
            Self Rating is required today. Note + Business Idea are optional.
            HR / HOD sees this once on the review screen.
          </div>
        </div>
        {savedAt && <span className="text-[11px] text-slate-500">Saved {savedAt.toLocaleTimeString()}</span>}
      </div>
      <div className="grid md:grid-cols-3 gap-3">
        <div>
          <label className="label">Self Rating (0-10) <span className="text-red-500">*</span></label>
          <input
            className={`input ${!ratingValid && rating !== '' ? 'border-red-400 focus:border-red-500' : ''}`}
            type="number" min="0" max="10" step="0.5" placeholder="0 - 10"
            required
            value={rating} onChange={(e) => setRating(e.target.value)} />
          {rating !== '' && !ratingValid && (
            <div className="text-[11px] text-red-600 mt-1">{ratingError}</div>
          )}
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
        <button className="btn-secondary" disabled={busy || !ratingValid} onClick={save}>
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
 * HR review (innovation marks + feedback) once it has been completed;
 * otherwise shows the work-only score with a "Pending Review" badge.
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

      {reviewed && sub.ideaFeedback && (
        <div className="grid sm:grid-cols-1 gap-3">
          <div className="bg-blue-50 rounded-lg p-3">
            <div className="text-[11px] uppercase text-blue-700">Feedback on your idea</div>
            <div className="text-sm text-slate-700 mt-1 italic">"{sub.ideaFeedback}"</div>
          </div>
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
