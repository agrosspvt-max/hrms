import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import api from '../../../api/axios';
import { Loader } from '../../../components/Loader.jsx';
import { useToast } from '../../../context/ToastContext.jsx';
import { errMsg } from '../../../utils/helpers';
import {
  NOTIFICATION_EVENTS, NOTIFICATION_AUDIENCES,
} from '../../../utils/complianceEnums.js';
import useComplianceRegistry from '../../../hooks/useComplianceRegistry.js';
import RuleActionsEditor from '../../../components/compliance/RuleActionsEditor.jsx';
import RuleScopePicker from '../../../components/compliance/RuleScopePicker.jsx';
import RuleEscalationEditor from '../../../components/compliance/RuleEscalationEditor.jsx';

/**
 * RuleBuilderPage
 * ------------------------------------------------------------------
 * Full-page Create / Edit / Clone form for a ComplianceRule.  Drives
 * the entire backend schema (see backend/models/ComplianceRule.js);
 * every field on the rule shows up here.  Sections are collapsible so
 * HR can focus on one part at a time.
 *
 * Routing:
 *   /hr/compliance/rules/new           -> mode='create'
 *   /hr/compliance/rules/:id/edit      -> mode='edit'
 *   /hr/compliance/rules/:id/clone     -> mode='clone'   (loads :id, mangles code)
 *
 * Save path:
 *   create/clone -> POST /api/compliance/rules
 *   edit         -> PATCH /api/compliance/rules/:id
 */

const _EMPTY_RULE = () => ({
  code: '',
  name: '',
  description: '',
  category: 'submission',
  detector: 'built_in.missed_submission',
  enabled: false,
  severity: 'medium',
  trigger: {
    evaluationDelayDays: 0,
    thresholdDays: 0,
    workingDaysOnly: true,
    criticalTasksOnly: false,
    dedupeWindowHours: 24,
    cutoffTime: '',
  },
  scope: { departments: [], designations: [], templates: [], employeeIds: [] },
  actions: [],
  notifications: {
    onIncident:   { employee: false, manager: false, hr: false, template: '' },
    onEffective:  { employee: false, manager: false, hr: false, template: '' },
    onEscalation: { employee: false, manager: false, hr: false, template: '' },
    onRecovery:   { employee: false, manager: false, hr: false, template: '' },
    onWaiver:     { employee: false, manager: false, hr: false, template: '' },
  },
  recovery: {
    allowed: true, modes: ['restore', 'information', 'neutral'],
    requiredEvidence: false, autoResolveOnSubmit: false, autoResolveOnResolve: false,
  },
  waiver: {
    allowed: true, partialAllowed: true,
    approverRoles: ['hr', 'super_admin'], reasonRequired: true,
  },
  escalation: [],
});

// ---- shared UI atoms ----
function Section({ title, subtitle, children, defaultOpen = true, count }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border rounded-lg bg-white">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <div>
          <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            {title}
            {count != null && (
              <span className="text-[11px] font-medium bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full">
                {count}
              </span>
            )}
          </div>
          {subtitle && <div className="text-xs text-slate-500">{subtitle}</div>}
        </div>
        <span className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
      </button>
      {open && <div className="px-4 pb-4 border-t">{children}</div>}
    </div>
  );
}
const Label = ({ children }) => (
  <span className="block text-[11px] uppercase text-slate-500 font-semibold">{children}</span>
);
const Err = ({ msg }) => (msg ? <div className="text-[11px] text-red-600">{msg}</div> : null);

// ---- validation (client-side) ----
// QA-fix H4 -- validation lists come from the merged registry at
// call time so backend-added enum values pass through.
function validate(rule, registry) {
  const e = {};
  const categories = (registry && registry.categories) || [];
  const severities = (registry && registry.severities) || [];
  if (!rule.name || !rule.name.trim()) e.name = 'Name is required.';
  if (!rule.code || !rule.code.trim()) e.code = 'Code is required.';
  else if (!/^[a-z0-9_.-]+$/i.test(rule.code)) e.code = 'Use letters, digits, underscores, dashes or dots only.';
  if (!rule.detector) e.detector = 'Detector is required.';
  if (categories.length && !categories.some((c) => c.value === rule.category)) e.category = 'Category invalid.';
  if (severities.length && !severities.some((s) => s.value === rule.severity)) e.severity = 'Severity invalid.';
  const t = rule.trigger || {};
  if (!(t.evaluationDelayDays >= 0)) e['trigger.evaluationDelayDays'] = 'Must be ≥ 0.';
  if (!(t.thresholdDays >= 0)) e['trigger.thresholdDays'] = 'Must be ≥ 0.';
  if (!(t.dedupeWindowHours >= 1)) e['trigger.dedupeWindowHours'] = 'Must be ≥ 1.';
  if (t.cutoffTime && !/^\d{2}:\d{2}$/.test(t.cutoffTime)) e['trigger.cutoffTime'] = 'Use HH:MM.';
  // Duplicate action _ids within rule.actions
  const seenIds = new Set();
  const actionErrors = {};
  (rule.actions || []).forEach((a, i) => {
    if (a._id && seenIds.has(String(a._id))) actionErrors[i] = { ...(actionErrors[i] || {}), type: 'Duplicate action id.' };
    if (a._id) seenIds.add(String(a._id));
    // Percent bounds
    const c = a.config || {};
    if (a.type === 'percent_reduction') {
      const p = Number(c.percent);
      const ppd = Number(c.percentPerDay);
      if (Number.isFinite(p) && (p < 0 || p > 100)) actionErrors[i] = { ...(actionErrors[i] || {}), percent: '0–100 only.' };
      if (Number.isFinite(ppd) && (ppd < 0 || ppd > 100)) actionErrors[i] = { ...(actionErrors[i] || {}), percentPerDay: '0–100 only.' };
    }
  });
  if (Object.keys(actionErrors).length) e.actions = actionErrors;
  if (!Array.isArray(rule.actions) || rule.actions.length === 0) e._emptyActions = 'Add at least one action so the rule has something to do.';

  // Escalation
  const escErrors = {};
  (rule.escalation || []).forEach((s, i) => {
    if (!(Number(s.afterDays) >= 1)) escErrors[i] = { ...(escErrors[i] || {}), afterDays: 'Must be ≥ 1.' };
    if (!Array.isArray(s.actionsAdd) || s.actionsAdd.length === 0) escErrors[i] = { ...(escErrors[i] || {}), actionsAdd: { general: 'Add at least one action.' } };
  });
  if (Object.keys(escErrors).length) e.escalation = escErrors;
  return e;
}

// ---- code mangling for clone ----
const mangleCloneCode = (orig) => {
  const base = String(orig || 'rule').replace(/_copy_\d+$/, '');
  return `${base}_copy_${Date.now().toString(36)}`;
};

export default function RuleBuilderPage() {
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const registry = useComplianceRegistry();
  const { categories: CATEGORIES, severities: SEVERITIES, detectors: DETECTORS,
    recoveryModes: RECOVERY_MODES, approverRoles: APPROVER_ROLES } = registry;

  const isEdit  = location.pathname.endsWith('/edit');
  const isClone = location.pathname.endsWith('/clone');
  const mode = isEdit ? 'edit' : isClone ? 'clone' : 'create';
  const ruleId = params.id;

  const [rule, setRule] = useState(mode === 'create' ? _EMPTY_RULE() : null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [loadErr, setLoadErr] = useState(null);
  // QA-fix H3 -- dirty tracking.  Any user-driven edit through
  // patch() / patchDeep() flips this on.  Load-effect and successful
  // save both reset it to false so the guard doesn't nag.
  const [dirty, setDirty] = useState(false);

  // ---- load existing rule for edit / clone ----
  useEffect(() => {
    if (mode === 'create') return;
    let alive = true;
    api.get(`/compliance/rules/${ruleId}`)
      .then(({ data }) => {
        if (!alive) return;
        let next = { ..._EMPTY_RULE(), ...data };
        // Backend sub-docs may be partial; merge defaults so form inputs
        // never receive undefined values.
        next.trigger = { ..._EMPTY_RULE().trigger, ...(data.trigger || {}) };
        next.scope = { ..._EMPTY_RULE().scope, ...(data.scope || {}) };
        next.notifications = { ..._EMPTY_RULE().notifications, ...(data.notifications || {}) };
        next.recovery = { ..._EMPTY_RULE().recovery, ...(data.recovery || {}) };
        next.waiver = { ..._EMPTY_RULE().waiver, ...(data.waiver || {}) };
        next.actions = (data.actions || []).map((a) => ({ ...a }));
        next.escalation = (data.escalation || []).map((s) => ({ ...s, actionsAdd: (s.actionsAdd || []).map((a) => ({ ...a })) }));
        if (mode === 'clone') {
          next.code = mangleCloneCode(data.code);
          next.name = `${data.name} (copy)`;
          next.enabled = false;
          // Strip immutable fields.
          delete next._id;
          delete next.version;
          delete next.createdAt;
          delete next.updatedAt;
          delete next.createdBy;
          delete next.updatedBy;
          next.actions = next.actions.map(({ _id, ...rest }) => rest);
          next.escalation = next.escalation.map(({ _id, ...rest }) => ({ ...rest, actionsAdd: (rest.actionsAdd || []).map(({ _id, ...a }) => a) }));
        }
        setRule(next);
        // Reset dirty AFTER load so hydration doesn't count as an edit.
        setDirty(false);
      })
      .catch((e) => { if (alive) setLoadErr(errMsg(e)); });
    return () => { alive = false; };
  }, [mode, ruleId]);

  const patch = (key, next) => {
    setRule((r) => ({ ...r, [key]: next }));
    setDirty(true);
  };
  const patchDeep = (key, subKey, next) => {
    setRule((r) => ({ ...r, [key]: { ...(r[key] || {}), [subKey]: next } }));
    setDirty(true);
  };

  // QA-fix H3 -- warn on close/refresh when there are unsaved changes.
  // beforeunload is enough for tab-close, hard refresh, and closing
  // the window; in-app navigation is covered by guardedNavigate below.
  useEffect(() => {
    if (!dirty || saving) return;
    const handler = (e) => {
      e.preventDefault();
      // Chrome/Firefox both require returnValue to be set; the exact
      // string is ignored by modern browsers.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, saving]);

  // Best-effort popstate guard.  When the user hits browser back with
  // unsaved changes, we push the state back so they stay on this
  // page unless they confirm.  Not perfect (rapid double-back can
  // slip through) but covers the common case without pulling in
  // react-router-dom v6.4 data-router.
  useEffect(() => {
    if (!dirty || saving) return;
    // Prime a same-URL history entry so the first popstate lands
    // here rather than at the previous page.
    window.history.pushState({ ruleBuilderGuard: true }, '', location.pathname);
    const onPop = () => {
      if (window.confirm('You have unsaved changes on this rule. Discard and leave?')) {
        // Let the browser continue the navigation on the next popstate.
        return;
      }
      // Re-push so the user stays here.
      window.history.pushState({ ruleBuilderGuard: true }, '', location.pathname);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saving]);

  const guardedNavigate = (to, opts) => {
    if (dirty && !saving) {
      if (!window.confirm('You have unsaved changes on this rule. Discard and leave?')) return;
    }
    navigate(to, opts);
  };

  const detectorSpec = useMemo(
    () => DETECTORS.find((d) => d.value === rule?.detector),
    [rule?.detector],
  );

  if (loadErr) return <div className="text-sm text-red-600 border rounded-md p-3 bg-red-50">Rule load failed: {loadErr}</div>;
  if (!rule) return <Loader />;

  const onSubmit = async (e) => {
    e.preventDefault();
    const errs = validate(rule, registry);
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.error('Please fix the highlighted fields.');
      return;
    }
    setSaving(true);
    try {
      const payload = { ...rule };
      if (mode === 'edit') {
        // PATCH does not touch code; strip immutable fields.
        delete payload.code;
        delete payload.version;
        delete payload._id;
        delete payload.createdAt;
        delete payload.updatedAt;
        delete payload.createdBy;
        delete payload.updatedBy;
        // Strip _key placeholders we added for React keys.
        payload.actions = (payload.actions || []).map(({ _key, ...rest }) => rest);
        payload.escalation = (payload.escalation || []).map((s) => ({
          ...s,
          actionsAdd: (s.actionsAdd || []).map(({ _key, ...rest }) => rest),
        }));
        await api.patch(`/compliance/rules/${ruleId}`, payload);
        toast.success('Rule updated.');
        setDirty(false);
      } else {
        // create or clone
        payload.actions = (payload.actions || []).map(({ _key, ...rest }) => rest);
        payload.escalation = (payload.escalation || []).map((s) => ({
          ...s,
          actionsAdd: (s.actionsAdd || []).map(({ _key, ...rest }) => rest),
        }));
        const { data } = await api.post('/compliance/rules', payload);
        toast.success(mode === 'clone' ? 'Rule cloned.' : 'Rule created.');
        setDirty(false);
        // Bypass guardedNavigate: no longer dirty, straight navigate.
        navigate(`/hr/compliance/rules/${data._id || ''}/edit`, { replace: true });
        return;
      }
      navigate('/hr/compliance', { replace: true });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const summary = {
    actions: (rule.actions || []).length,
    escalation: (rule.escalation || []).length,
    scope: ['departments', 'designations', 'templates', 'employeeIds']
      .reduce((sum, k) => sum + ((rule.scope || {})[k] || []).length, 0),
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs text-slate-500">
            <button type="button" onClick={() => guardedNavigate('/hr/compliance')} className="text-brand-600 hover:underline">← Back to Compliance</button>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 truncate">
            {mode === 'create' ? 'New Compliance Rule' : mode === 'clone' ? 'Clone Rule' : rule.name || 'Edit Rule'}
          </h1>
          <div className="text-sm text-slate-500">
            {mode === 'edit' ? 'PATCHing preserves the version bump semantics your backend already implements.' : mode === 'clone' ? 'Save creates a new rule; the original is left untouched.' : 'A brand-new rule; will save disabled by default.'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary" onClick={() => guardedNavigate('/hr/compliance')}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : (mode === 'edit' ? 'Save changes' : 'Create rule')}
          </button>
        </div>
      </div>

      {errors._emptyActions && (
        <div className="text-sm text-red-700 border border-red-200 bg-red-50 rounded-md p-2">
          {errors._emptyActions}
        </div>
      )}

      {/* ------- Basic Information ------- */}
      <Section title="Basic information" defaultOpen>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <div>
            <Label>Rule name</Label>
            <input value={rule.name} onChange={(e) => patch('name', e.target.value)} className="w-full border rounded-md text-sm px-2 py-1.5" />
            <Err msg={errors.name} />
          </div>
          <div>
            <Label>Rule code {mode === 'edit' && <span className="text-slate-400">(cannot change)</span>}</Label>
            <input
              value={rule.code}
              onChange={(e) => patch('code', e.target.value.trim())}
              readOnly={mode === 'edit'}
              className={`w-full border rounded-md text-sm px-2 py-1.5 ${mode === 'edit' ? 'bg-slate-50 text-slate-500' : ''}`}
            />
            <Err msg={errors.code} />
          </div>
          <div className="md:col-span-2">
            <Label>Description</Label>
            <textarea value={rule.description} onChange={(e) => patch('description', e.target.value)} rows={2} className="w-full border rounded-md text-sm px-2 py-1.5" />
          </div>
          <div>
            <Label>Category</Label>
            <select value={rule.category} onChange={(e) => patch('category', e.target.value)} className="w-full border rounded-md text-sm px-2 py-1.5">
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <Err msg={errors.category} />
          </div>
          <div>
            <Label>Severity</Label>
            <select value={rule.severity} onChange={(e) => patch('severity', e.target.value)} className="w-full border rounded-md text-sm px-2 py-1.5">
              {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <Err msg={errors.severity} />
          </div>
          <div>
            <Label>Detector</Label>
            <select value={rule.detector} onChange={(e) => patch('detector', e.target.value)} className="w-full border rounded-md text-sm px-2 py-1.5">
              {DETECTORS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
            {detectorSpec && (
              <div className="text-[11px] text-slate-500 mt-1">
                {detectorSpec.automatic ? 'Runs automatically on the daily scheduler tick.' : 'HR-initiated (never fires from the scheduler).'}
              </div>
            )}
            <Err msg={errors.detector} />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!rule.enabled} onChange={(e) => patch('enabled', e.target.checked)} />
              Enabled (will start firing on next tick)
            </label>
          </div>
        </div>
      </Section>

      {/* ------- Trigger ------- */}
      <Section title="Trigger" subtitle="Rule-specific numeric thresholds and calendar behaviour.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <div>
            <Label>Evaluation delay (days)</Label>
            <input type="number" min={0} value={rule.trigger.evaluationDelayDays ?? 0}
              onChange={(e) => patchDeep('trigger', 'evaluationDelayDays', Number(e.target.value))}
              className="w-full border rounded-md text-sm px-2 py-1.5" />
            <Err msg={errors['trigger.evaluationDelayDays']} />
          </div>
          <div>
            <Label>Threshold days</Label>
            <input type="number" min={0} value={rule.trigger.thresholdDays ?? 0}
              onChange={(e) => patchDeep('trigger', 'thresholdDays', Number(e.target.value))}
              className="w-full border rounded-md text-sm px-2 py-1.5" />
            <Err msg={errors['trigger.thresholdDays']} />
          </div>
          <div>
            <Label>Dedupe window (hours)</Label>
            <input type="number" min={1} value={rule.trigger.dedupeWindowHours ?? 24}
              onChange={(e) => patchDeep('trigger', 'dedupeWindowHours', Number(e.target.value))}
              className="w-full border rounded-md text-sm px-2 py-1.5" />
            <Err msg={errors['trigger.dedupeWindowHours']} />
          </div>
          <div>
            <Label>Cutoff time (HH:MM, optional)</Label>
            <input value={rule.trigger.cutoffTime || ''} placeholder="18:00"
              onChange={(e) => patchDeep('trigger', 'cutoffTime', e.target.value)}
              className="w-full border rounded-md text-sm px-2 py-1.5" />
            <Err msg={errors['trigger.cutoffTime']} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={rule.trigger.workingDaysOnly !== false}
              onChange={(e) => patchDeep('trigger', 'workingDaysOnly', e.target.checked)} />
            Only fire on working days
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!rule.trigger.criticalTasksOnly}
              onChange={(e) => patchDeep('trigger', 'criticalTasksOnly', e.target.checked)} />
            Only fire on critical-task templates
          </label>
        </div>
      </Section>

      {/* ------- Scope ------- */}
      <Section title="Scope" count={summary.scope} subtitle="Restrict which employees this rule applies to.">
        <div className="pt-3">
          <RuleScopePicker value={rule.scope} onChange={(next) => patch('scope', next)} />
        </div>
      </Section>

      {/* ------- Actions ------- */}
      <Section title="Actions" count={summary.actions} subtitle="What the engine does when the rule fires. Drag to reorder.">
        <div className="pt-3">
          <RuleActionsEditor
            value={rule.actions}
            onChange={(next) => patch('actions', next)}
            errors={errors.actions || {}}
          />
        </div>
      </Section>

      {/* ------- Notifications ------- */}
      <Section title="Notifications" subtitle="Fan-out settings per lifecycle event.">
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm border">
            <thead className="bg-slate-50">
              <tr>
                <th className="p-2 text-left text-[11px] uppercase text-slate-500">Event</th>
                {NOTIFICATION_AUDIENCES.map((a) => (
                  <th key={a.value} className="p-2 text-[11px] uppercase text-slate-500">{a.label}</th>
                ))}
                <th className="p-2 text-left text-[11px] uppercase text-slate-500">Message template</th>
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_EVENTS.map((ev) => {
                const block = (rule.notifications || {})[ev.value] || {};
                const setBlock = (patchObj) => patchDeep('notifications', ev.value, { ...block, ...patchObj });
                return (
                  <tr key={ev.value} className="border-t">
                    <td className="p-2 text-sm">{ev.label}</td>
                    {NOTIFICATION_AUDIENCES.map((a) => (
                      <td key={a.value} className="p-2 text-center">
                        <input type="checkbox" checked={!!block[a.value]}
                          onChange={(e) => setBlock({ [a.value]: e.target.checked })} />
                      </td>
                    ))}
                    <td className="p-2">
                      <input value={block.template || ''} placeholder="Optional; blank = default"
                        onChange={(e) => setBlock({ template: e.target.value })}
                        className="w-full border rounded-md text-xs px-2 py-1" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ------- Recovery ------- */}
      <Section title="Recovery policy">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={rule.recovery.allowed !== false}
              onChange={(e) => patchDeep('recovery', 'allowed', e.target.checked)} />
            Recovery allowed
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!rule.recovery.requiredEvidence}
              onChange={(e) => patchDeep('recovery', 'requiredEvidence', e.target.checked)} />
            Requires evidence attachment
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!rule.recovery.autoResolveOnSubmit}
              onChange={(e) => patchDeep('recovery', 'autoResolveOnSubmit', e.target.checked)} />
            Auto-resolve when employee submits the missed work
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!rule.recovery.autoResolveOnResolve}
              onChange={(e) => patchDeep('recovery', 'autoResolveOnResolve', e.target.checked)} />
            Auto-resolve when the underlying dependency clears
          </label>
          <div className="md:col-span-2">
            <Label>Allowed recovery modes</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {RECOVERY_MODES.map((m) => {
                const on = (rule.recovery.modes || []).includes(m.value);
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => {
                      const list = new Set(rule.recovery.modes || []);
                      if (on) list.delete(m.value); else list.add(m.value);
                      patchDeep('recovery', 'modes', Array.from(list));
                    }}
                    className={`text-xs px-2 py-1 rounded-full border ${on ? 'bg-brand-50 border-brand-200 text-brand-700' : 'bg-white text-slate-600'}`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </Section>

      {/* ------- Waiver ------- */}
      <Section title="Waiver policy">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={rule.waiver.allowed !== false}
              onChange={(e) => patchDeep('waiver', 'allowed', e.target.checked)} />
            Waiver allowed
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={rule.waiver.partialAllowed !== false}
              onChange={(e) => patchDeep('waiver', 'partialAllowed', e.target.checked)} />
            Partial waiver allowed
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={rule.waiver.reasonRequired !== false}
              onChange={(e) => patchDeep('waiver', 'reasonRequired', e.target.checked)} />
            Reason required
          </label>
          <div className="md:col-span-2">
            <Label>Approver roles</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {APPROVER_ROLES.map((r) => {
                const on = (rule.waiver.approverRoles || []).includes(r.value);
                return (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => {
                      const list = new Set(rule.waiver.approverRoles || []);
                      if (on) list.delete(r.value); else list.add(r.value);
                      patchDeep('waiver', 'approverRoles', Array.from(list));
                    }}
                    className={`text-xs px-2 py-1 rounded-full border ${on ? 'bg-brand-50 border-brand-200 text-brand-700' : 'bg-white text-slate-600'}`}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </Section>

      {/* ------- Escalation ------- */}
      <Section title="Escalation" count={summary.escalation} subtitle="Progressive actions when an incident stays active for N days.">
        <div className="pt-3">
          <RuleEscalationEditor
            value={rule.escalation}
            onChange={(next) => patch('escalation', next)}
            errors={errors.escalation || {}}
          />
        </div>
      </Section>

      {/* ------- Review + submit ------- */}
      <div className="flex items-center justify-end gap-2 sticky bottom-0 bg-white/90 backdrop-blur px-3 py-2 rounded-lg border">
        <div className="text-xs text-slate-500 mr-auto flex items-center gap-2">
          <span>{summary.actions} action(s) · {summary.escalation} escalation step(s) · {summary.scope} scope target(s)</span>
          {dirty && !saving && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">Unsaved changes</span>
          )}
        </div>
        <button type="button" className="btn-secondary" onClick={() => navigate('/hr/compliance')}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : (mode === 'edit' ? 'Save changes' : mode === 'clone' ? 'Create clone' : 'Create rule')}
        </button>
      </div>
    </form>
  );
}
