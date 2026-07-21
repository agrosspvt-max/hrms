import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../api/axios';
import { Loader, EmptyState } from '../../../components/Loader.jsx';
import ActionBadge from '../../../components/compliance/ActionBadge.jsx';
import { fmtDate, errMsg } from '../../../utils/helpers';
import { useToast } from '../../../context/ToastContext.jsx';
import RuleHistoryPanel from './RuleHistoryPanel.jsx';
import useComplianceRegistry from '../../../hooks/useComplianceRegistry.js';

/**
 * ComplianceWorkspace -- unified HR page.  Three tabs:
 *   - Dashboard  (summary + trends + most-penalised + common)
 *   - Incidents  (filterable feed + bulk waive/recover)
 *   - Rules      (list + edit + enable/disable)
 * All handlers gate on the backend feature flags via the API's 404
 * response; when a flag is off the tab renders an inline hint instead
 * of blowing up.
 */
export default function ComplianceWorkspace() {
  const [tab, setTab] = useState('dashboard');
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Compliance &amp; Accountability</h1>
          <p className="text-sm text-slate-500">
            Rules, incidents, waivers, recoveries, and a full compliance ledger for every employee.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 border-b border-slate-200">
        {['dashboard', 'incidents', 'rules'].map((k) => (
          <button key={k}
            className={`px-4 py-2 text-sm capitalize border-b-2 -mb-px ${tab === k ? 'border-brand-500 text-brand-700 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            onClick={() => setTab(k)}
          >
            {k}
          </button>
        ))}
      </div>
      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'incidents' && <IncidentsTab />}
      {tab === 'rules'     && <RulesTab />}
    </div>
  );
}

// -----------------------------------------------------------
// Dashboard tab
// -----------------------------------------------------------
function DashboardTab() {
  const [summary, setSummary] = useState(null);
  const [top, setTop]         = useState(null);
  const [common, setCommon]   = useState(null);
  const [waivers, setWaivers] = useState(null);
  const [err, setErr]         = useState(null);
  useEffect(() => {
    Promise.all([
      api.get('/compliance/dashboard/summary'),
      api.get('/compliance/dashboard/most-penalised'),
      api.get('/compliance/dashboard/common-violations'),
      api.get('/compliance/dashboard/pending-waivers'),
    ]).then(([s, t, c, w]) => {
      setSummary(s.data); setTop(t.data); setCommon(c.data); setWaivers(w.data);
    }).catch((e) => setErr(errMsg(e)));
  }, []);

  if (err) return <div className="text-sm text-red-600 border rounded-md p-3 bg-red-50">Dashboard load failed: {err}</div>;
  if (!summary) return <Loader />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryTile label="Total" value={summary.total} />
        <SummaryTile label="Active" value={summary.active} accent="red" />
        <SummaryTile label="Waived" value={summary.waived} accent="amber" />
        <SummaryTile label="Resolved" value={summary.resolved} accent="green" />
        <SummaryTile label="Pending waivers" value={summary.pendingWaivers} accent="blue" />
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <Panel title="Most-penalised employees">
          {top.length === 0
            ? <EmptyState title="No incidents in scope" />
            : <ol className="space-y-1">
                {top.map((r, i) => (
                  <li key={i} className="flex items-center justify-between text-sm">
                    <span>{r.employee ? `${r.employee.name} (${r.employee.employeeId})` : '(deleted employee)'}</span>
                    <span className="text-slate-500">{r.incidentCount}</span>
                  </li>
                ))}
              </ol>}
        </Panel>
        <Panel title="Most-common violations">
          {common.length === 0
            ? <EmptyState title="No incidents in scope" />
            : <ol className="space-y-1">
                {common.map((r, i) => (
                  <li key={i} className="flex items-center justify-between text-sm">
                    <span className="capitalize">{r.ruleCode.replace(/_/g, ' ')}</span>
                    <span className="text-slate-500">{r.count}</span>
                  </li>
                ))}
              </ol>}
        </Panel>
        <Panel title="Pending waiver requests" span={2}>
          {waivers.length === 0
            ? <EmptyState title="No pending waivers" />
            : <ul className="space-y-1">
                {waivers.map((w) => (
                  <li key={w._id} className="flex items-center justify-between text-sm border-b border-slate-100 pb-1">
                    <div>
                      <div className="font-medium">{w.employee ? w.employee.name : '(deleted employee)'}</div>
                      <div className="text-xs text-slate-500">
                        {w.incident ? w.incident.ruleCode.replace(/_/g, ' ') : '?'} · {fmtDate(w.requestedAt)}
                      </div>
                    </div>
                    <a className="btn-secondary !py-1 !text-xs"
                       href={`/hr/compliance?incident=${w.incidentId}`}>
                      Review
                    </a>
                  </li>
                ))}
              </ul>}
        </Panel>
      </div>
    </div>
  );
}

function SummaryTile({ label, value, accent }) {
  const cls = {
    red:   'bg-red-50 text-red-700 border-red-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    blue:  'bg-blue-50 text-blue-700 border-blue-200',
  }[accent] || 'bg-white text-slate-800 border-slate-200';
  return (
    <div className={`border rounded-md p-3 ${cls}`}>
      <div className="text-[11px] uppercase tracking-wide font-semibold opacity-70">{label}</div>
      <div className="text-xl font-bold">{value}</div>
    </div>
  );
}

function Panel({ title, span = 1, children }) {
  return (
    <div className={`card card-body ${span === 2 ? 'md:col-span-2' : ''}`}>
      <div className="text-sm font-semibold text-slate-800 mb-2">{title}</div>
      {children}
    </div>
  );
}

// -----------------------------------------------------------
// Incidents tab
// -----------------------------------------------------------
function IncidentsTab() {
  const [rows, setRows]     = useState(null);
  const [err, setErr]       = useState(null);
  const [status, setStatus] = useState('active');
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy]     = useState(false);
  const toast = useToast();

  const load = () => {
    setRows(null); setErr(null);
    api.get('/compliance/incidents', { params: { status, limit: 200 } })
      .then(({ data }) => setRows(data))
      .catch((e) => setErr(errMsg(e)));
  };
  useEffect(load, [status]);

  const view = async (inc) => {
    try {
      const { data } = await api.get(`/compliance/incidents/${inc._id}`);
      setOpenId(data);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const cancel = async (inc) => {
    const reason = window.prompt('Cancel reason?');
    if (reason === null) return;
    setBusy(true);
    try {
      await api.post(`/compliance/incidents/${inc._id}/cancel`, { reason });
      toast.success('Incident cancelled.');
      load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const waive = async (inc) => {
    const reason = window.prompt('Waiver reason?');
    if (reason === null) return;
    setBusy(true);
    try {
      await api.post(`/compliance/incidents/${inc._id}/waive`, { scope: 'full', reason });
      toast.success('Incident waived.');
      load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const recover = async (inc) => {
    const mode = window.prompt('Recovery mode? (restore | information | neutral)', 'restore');
    if (!mode) return;
    const reason = window.prompt('Recovery reason?') || '';
    setBusy(true);
    try {
      await api.post(`/compliance/incidents/${inc._id}/recover`, { mode, reason });
      toast.success('Recovery applied.');
      load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const decideWaiver = async (wid, decision) => {
    const note = decision === 'rejected' ? (window.prompt('Rejection note?') || '') : '';
    setBusy(true);
    try {
      await api.post(`/compliance/incidents/${openId.incident._id}/waive/decide`, {
        waiverId: wid, decision, note,
      });
      toast.success(`Waiver ${decision}.`);
      view(openId.incident);
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="md:col-span-1 space-y-2">
        <div className="flex items-center gap-1">
          {['candidate','active','resolved','waived','cancelled'].map((k) => (
            <button key={k} onClick={() => setStatus(k)}
              className={`px-2 py-1 text-[11px] rounded border capitalize ${status === k ? 'bg-brand-500 text-white border-brand-500' : 'bg-white text-slate-700 border-slate-200'}`}>
              {k}
            </button>
          ))}
        </div>
        {err   ? <div className="text-sm text-red-600">Failed: {err}</div>
         : !rows ? <Loader />
         : rows.length === 0 ? <EmptyState title="No incidents" />
         : rows.map((inc) => (
            <button key={inc._id}
              className={`w-full text-left border rounded-md p-3 hover:bg-slate-50 ${openId && openId.incident._id === inc._id ? 'ring-2 ring-brand-500' : ''}`}
              onClick={() => view(inc)}
            >
              <div className="text-sm font-medium">{inc.ruleCode.replace(/_/g, ' ')}</div>
              <div className="text-xs text-slate-500">
                {fmtDate(inc.incidentDate)} · {inc.severity}
              </div>
            </button>
          ))}
      </div>
      <div className="md:col-span-2">
        {!openId
          ? <div className="text-sm text-slate-500 border rounded-md p-6 bg-slate-50">Select an incident on the left.</div>
          : <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <div className="text-lg font-semibold capitalize">{openId.incident.ruleCode.replace(/_/g, ' ')}</div>
                  <div className="text-xs text-slate-500">
                    {fmtDate(openId.incident.incidentDate)} · <span className="capitalize">{openId.incident.status}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {['candidate','active'].includes(openId.incident.status) && (
                    <>
                      <button className="btn-secondary !py-1 !text-xs" disabled={busy} onClick={() => waive(openId.incident)}>Waive</button>
                      <button className="btn-secondary !py-1 !text-xs" disabled={busy} onClick={() => recover(openId.incident)}>Recover</button>
                      <button className="btn-ghost !py-1 !text-xs text-red-600" disabled={busy} onClick={() => cancel(openId.incident)}>Cancel</button>
                    </>
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase font-semibold text-slate-500 mb-1">Actions applied</div>
                <div className="flex flex-wrap gap-1">
                  {openId.effects.map((e) => <ActionBadge key={e._id} effect={e} />)}
                </div>
              </div>
              {openId.waivers && openId.waivers.length > 0 && (
                <div>
                  <div className="text-xs uppercase font-semibold text-slate-500 mb-1">Waivers</div>
                  <ul className="space-y-1">
                    {openId.waivers.map((w) => (
                      <li key={w._id} className="border rounded-md p-2 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="capitalize">{w.status}</span>
                          <span className="text-slate-500">{new Date(w.requestedAt).toLocaleString()}</span>
                        </div>
                        {w.reason && <div className="mt-0.5">Reason: {w.reason}</div>}
                        {w.status === 'pending' && (
                          <div className="mt-1 flex items-center gap-2">
                            <button className="btn-primary !py-1 !text-xs" disabled={busy} onClick={() => decideWaiver(w._id, 'approved')}>Approve</button>
                            <button className="btn-ghost !py-1 !text-xs text-red-600" disabled={busy} onClick={() => decideWaiver(w._id, 'rejected')}>Reject</button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
        }
      </div>
    </div>
  );
}

// -----------------------------------------------------------
// Rules tab -- rich management view.
//
// Search + category / status / severity filter + sort +
// summary counters + per-row quick actions (Edit / Clone /
// History / Enable / Disable).  Create button routes to the
// full-page Rule Builder at /hr/compliance/rules/new.
// -----------------------------------------------------------
function RulesTab() {
  const [rows, setRows] = useState(null);
  const [err, setErr]   = useState(null);
  const [q, setQ]       = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus]     = useState('');
  const [severity, setSeverity] = useState('');
  const [sort, setSort]         = useState('name');
  const [historyRule, setHistoryRule] = useState(null);
  const toast = useToast();
  const navigate = useNavigate();
  // QA-fix H4 -- registry-driven filter dropdowns.
  const { categories: CATEGORIES, severities: SEVERITIES } = useComplianceRegistry();

  const load = () => {
    setRows(null); setErr(null);
    api.get('/compliance/rules')
      .then(({ data }) => setRows(data))
      .catch((e) => setErr(errMsg(e)));
  };
  useEffect(load, []);
  // QA-fix H2 -- confirmation dialog before enable/disable.
  //
  // Enabling a scoped-to-all-employees rule can materialise thousands
  // of incidents on the very next scheduler tick (00:15 local) and
  // may write real financial fines.  We block the action behind
  // window.confirm with a message that surfaces:
  //   - direction (enable vs. disable)
  //   - the rule's severity + code
  //   - a heightened warning when the rule contains financial fines
  //     or actions marked as recurring
  const _highImpactWarnings = (rule) => {
    const warnings = [];
    const actions = rule.actions || [];
    if (actions.some((a) => a.enabled !== false && a.type === 'financial_fine')) {
      warnings.push('• contains a FINANCIAL FINE');
    }
    if (actions.some((a) => a.enabled !== false && a.config && a.config.recurring === true)) {
      warnings.push('• contains RECURRING actions that re-fire every day the incident stays active');
    }
    if ((rule.escalation || []).length > 0) {
      warnings.push(`• has ${rule.escalation.length} escalation step(s) that will fire on aged incidents`);
    }
    return warnings;
  };
  const toggle = async (rule) => {
    const goingToEnable = !rule.enabled;
    const verb = goingToEnable ? 'ENABLE' : 'DISABLE';
    const warnings = goingToEnable ? _highImpactWarnings(rule) : [];
    const lines = [
      `${verb} the rule "${rule.name}" (${rule.code})?`,
      '',
      goingToEnable
        ? 'Enabling this rule may start generating compliance incidents on the next scheduler run.'
        : 'Disabling this rule stops it from firing on the next scheduler run. Existing incidents are not affected.',
    ];
    if (warnings.length) {
      lines.push('', 'This rule:', ...warnings);
    }
    lines.push('', 'Continue?');
    if (!window.confirm(lines.join('\n'))) return;
    try {
      await api.post(`/compliance/rules/${rule._id}/${rule.enabled ? 'disable' : 'enable'}`);
      toast.success(`Rule ${rule.enabled ? 'disabled' : 'enabled'}.`);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (needle && !(r.name || '').toLowerCase().includes(needle)
          && !(r.code || '').toLowerCase().includes(needle)
          && !(r.description || '').toLowerCase().includes(needle)) return false;
      if (category && r.category !== category) return false;
      if (severity && r.severity !== severity) return false;
      if (status === 'enabled'  && !r.enabled) return false;
      if (status === 'disabled' &&  r.enabled) return false;
      return true;
    });
    const sevRank = { low: 0, medium: 1, high: 2, critical: 3 };
    out.sort((a, b) => {
      if (sort === 'name')      return (a.name || '').localeCompare(b.name || '');
      if (sort === 'code')      return (a.code || '').localeCompare(b.code || '');
      if (sort === 'category')  return (a.category || '').localeCompare(b.category || '');
      if (sort === 'severity')  return (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0);
      if (sort === 'updated')   return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
      if (sort === 'actions')   return (b.actions || []).length - (a.actions || []).length;
      return 0;
    });
    return out;
  }, [rows, q, category, status, severity, sort]);

  const counts = useMemo(() => {
    const total = rows ? rows.length : 0;
    const enabled = rows ? rows.filter((r) => r.enabled).length : 0;
    return { total, enabled, disabled: total - enabled, shown: filtered.length };
  }, [rows, filtered]);

  if (err) return <div className="text-sm text-red-600 border rounded-md p-3 bg-red-50">Rules load failed: {err}</div>;
  if (!rows) return <Loader />;

  return (
    <div className="space-y-3">
      {/* header + counters + create ------------------------------- */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-2 text-xs">
          <span className="px-2 py-1 rounded-full bg-slate-100 text-slate-700 font-medium">
            {counts.total} total
          </span>
          <span className="px-2 py-1 rounded-full bg-green-100 text-green-800 font-medium">
            {counts.enabled} enabled
          </span>
          <span className="px-2 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">
            {counts.disabled} disabled
          </span>
          <span className="px-2 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">
            {counts.shown} shown
          </span>
        </div>
        <div className="ml-auto">
          <button className="btn-primary !text-xs" onClick={() => navigate('/hr/compliance/rules/new')}>
            + Create rule
          </button>
        </div>
      </div>

      {/* filters -------------------------------------------------- */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <input
          type="search" placeholder="Search name / code / description"
          value={q} onChange={(e) => setQ(e.target.value)}
          className="md:col-span-2 border rounded-md text-sm px-2 py-1.5"
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="border rounded-md text-sm px-2 py-1.5">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="border rounded-md text-sm px-2 py-1.5">
          <option value="">All severities</option>
          {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="border rounded-md text-sm px-2 py-1.5">
          <option value="">All statuses</option>
          <option value="enabled">Enabled only</option>
          <option value="disabled">Disabled only</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} className="border rounded-md text-sm px-2 py-1.5">
          <option value="name">Sort: Name (A–Z)</option>
          <option value="code">Sort: Code</option>
          <option value="category">Sort: Category</option>
          <option value="severity">Sort: Severity ↓</option>
          <option value="actions">Sort: Action count ↓</option>
          <option value="updated">Sort: Recently updated</option>
        </select>
      </div>

      {/* empty state --------------------------------------------- */}
      {filtered.length === 0 && (
        <div className="border rounded-md p-6 text-center bg-white">
          <div className="text-sm font-semibold">No rules match these filters.</div>
          <div className="text-xs text-slate-500 mt-1">
            {counts.total === 0
              ? 'No rules exist yet. Click "Create rule" to add the first one.'
              : 'Try removing filters or the search term.'}
          </div>
        </div>
      )}

      {/* rows ---------------------------------------------------- */}
      {filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((r) => (
            <RuleRow
              key={r._id}
              rule={r}
              severities={SEVERITIES}
              onEdit={() => navigate(`/hr/compliance/rules/${r._id}/edit`)}
              onClone={() => navigate(`/hr/compliance/rules/${r._id}/clone`)}
              onToggle={() => toggle(r)}
              onHistory={() => setHistoryRule(r)}
            />
          ))}
        </div>
      )}

      {historyRule && (
        <RuleHistoryPanel
          ruleId={historyRule._id}
          ruleLabel={`${historyRule.name} (${historyRule.code})`}
          onClose={() => setHistoryRule(null)}
        />
      )}
    </div>
  );
}

function RuleRow({ rule: r, severities, onEdit, onClone, onToggle, onHistory }) {
  // QA-fix H4 -- registry-driven severity + detector labels.
  const { detectors: DETECTORS } = useComplianceRegistry();
  const sev = (severities || []).find((s) => s.value === r.severity)
    || { tone: 'bg-slate-100 text-slate-700', label: r.severity };
  const det = (DETECTORS || []).find((d) => d.value === r.detector) || null;
  const scope = ['departments', 'designations', 'templates', 'employeeIds']
    .reduce((sum, k) => sum + (((r.scope || {})[k]) || []).length, 0);
  const updated = r.updatedAt ? fmtDate(r.updatedAt) : '';
  return (
    <div className="border rounded-md p-3 bg-white">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-semibold truncate">{r.name}</div>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${sev.tone}`}>{sev.label}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${r.enabled ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'}`}>
              {r.enabled ? 'ENABLED' : 'DISABLED'}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-700 capitalize">
              {r.category}
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            <code className="text-slate-600 mr-2">{r.code}</code>
            {det ? det.label : r.detector} · v{r.version}
          </div>
          <div className="text-xs text-slate-500 mt-1 flex flex-wrap gap-x-3">
            <span>{(r.actions || []).length} action(s)</span>
            <span>{(r.escalation || []).length} escalation step(s)</span>
            <span>{scope === 0 ? 'scope: all employees' : `scope: ${scope} target(s)`}</span>
            {updated && <span>updated {updated}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button className="btn-secondary !py-1 !text-xs" onClick={onHistory}>History</button>
          <button className="btn-secondary !py-1 !text-xs" onClick={onClone}>Clone</button>
          <button className="btn-secondary !py-1 !text-xs" onClick={onEdit}>Edit</button>
          <button className="btn-secondary !py-1 !text-xs" onClick={onToggle}>
            {r.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>
    </div>
  );
}
