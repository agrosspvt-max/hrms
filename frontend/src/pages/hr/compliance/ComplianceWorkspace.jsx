import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../api/axios';
import { Loader, EmptyState } from '../../../components/Loader.jsx';
import ActionBadge from '../../../components/compliance/ActionBadge.jsx';
import { fmtDate, errMsg } from '../../../utils/helpers';
import { useToast } from '../../../context/ToastContext.jsx';
import RuleHistoryPanel from './RuleHistoryPanel.jsx';
import CreateIncidentModal from './CreateIncidentModal.jsx';
import IncidentDetailPanel from './IncidentDetailPanel.jsx';
import EmployeeHistoryDrawer from './EmployeeHistoryDrawer.jsx';
import LifecycleActionModal from './LifecycleActionModal.jsx';
import DateRangeFilter, { rangeFromPreset } from '../../../components/compliance/DateRangeFilter.jsx';
import { ruleTitle, statusTone, severityTone, fmtWhen } from '../../../utils/incidentPresenter.js';
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
  // Workspace-level global filters shared by Dashboard + Incidents.
  // Rules tab ignores them (rule config isn't date-scoped).
  const [range, setRange] = useState(rangeFromPreset('last30'));
  const [q, setQ] = useState('');
  // Employee drill-in.  When set, EmployeeHistoryDrawer overlays the
  // workspace with the employee's full history.  Any surface in the
  // workspace can trigger it (dashboard tile, incidents card, etc.).
  const [employeeDrill, setEmployeeDrill] = useState(null);   // {employeeId, employeeSeed}
  const openEmployee = (employeeId, employeeSeed) => setEmployeeDrill({ employeeId, employeeSeed });

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

      {/* Global toolbar -- search + date range apply across Dashboard
          and Incidents tabs.  Rules tab ignores them (rule config is
          not date-scoped and has its own search). */}
      <div className="flex items-center gap-2 flex-wrap border rounded-md bg-white p-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search employee, ID, department, designation or rule…"
          className="flex-1 min-w-[16rem] border rounded-md text-sm px-2 py-1.5"
        />
        <DateRangeFilter value={range} onChange={setRange} />
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
      {tab === 'dashboard' && <DashboardTab range={range} onEmployeeOpen={openEmployee} />}
      {tab === 'incidents' && <IncidentsTab range={range} q={q} onEmployeeOpen={openEmployee} />}
      {tab === 'rules'     && <RulesTab />}

      {employeeDrill && (
        <EmployeeHistoryDrawer
          employeeId={employeeDrill.employeeId}
          employeeSeed={employeeDrill.employeeSeed}
          range={range}
          onClose={() => setEmployeeDrill(null)}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------
// Dashboard tab
// -----------------------------------------------------------
function DashboardTab({ range, onEmployeeOpen }) {
  const [summary, setSummary] = useState(null);
  const [top, setTop]         = useState(null);
  const [common, setCommon]   = useState(null);
  const [waivers, setWaivers] = useState(null);
  const [err, setErr]         = useState(null);
  useEffect(() => {
    // Reuse existing dashboard endpoints; from/to already supported.
    const params = {};
    if (range && range.from) params.from = range.from;
    if (range && range.to)   params.to   = range.to;
    Promise.all([
      api.get('/compliance/dashboard/summary',           { params }),
      api.get('/compliance/dashboard/most-penalised',    { params }),
      api.get('/compliance/dashboard/common-violations', { params }),
      api.get('/compliance/dashboard/pending-waivers'),      // not date-scoped
    ]).then(([s, t, c, w]) => {
      setSummary(s.data); setTop(t.data); setCommon(c.data); setWaivers(w.data);
    }).catch((e) => setErr(errMsg(e)));
  }, [range && range.from, range && range.to]);

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
                  <li key={i} className="flex items-center justify-between text-sm gap-2">
                    {r.employee ? (
                      <button
                        className="text-left text-brand-700 hover:underline truncate"
                        onClick={() => onEmployeeOpen(r.employee._id, r.employee)}
                        title={`View ${r.employee.name}'s compliance history`}
                      >
                        {r.employee.name}
                        {r.employee.employeeId && <span className="text-slate-500"> · {r.employee.employeeId}</span>}
                      </button>
                    ) : (
                      <span className="text-slate-400 italic">(deleted employee)</span>
                    )}
                    <span className="text-slate-500 text-xs shrink-0">{r.incidentCount} incident(s)</span>
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
function IncidentsTab({ range, q, onEmployeeOpen }) {
  const [rows, setRows]     = useState(null);
  const [err, setErr]       = useState(null);
  const [status, setStatus] = useState('active');
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy]     = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const toast = useToast();

  const load = () => {
    setRows(null); setErr(null);
    // Batch-3 #18 -- includeEffects gives us the chips inline so the
    // employee-centric list can render without an N+1.  Employee is
    // populated on the list endpoint (new backend addition) so each
    // card can lead with the employee name.
    const params = { status, limit: 200, includeEffects: 'true' };
    if (range && range.from) params.from = range.from;
    if (range && range.to)   params.to   = range.to;
    api.get('/compliance/incidents', { params })
      .then(({ data }) => setRows(data))
      .catch((e) => setErr(errMsg(e)));
  };
  useEffect(load, [status, range && range.from, range && range.to]);

  // Client-side search over the loaded page.  Matches employee name,
  // employeeId, department, designation, rule title and rule code.
  const shown = useMemo(() => {
    if (!rows) return [];
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((inc) => {
      const emp = inc.employee || {};
      const dept = emp.department && emp.department.name;
      const desig = emp.designation && emp.designation.title;
      const hay = [
        emp.name, emp.employeeId, dept, desig,
        inc.ruleCode, ruleTitle(inc.ruleCode),
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, q]);

  const view = async (inc) => {
    try {
      const { data } = await api.get(`/compliance/incidents/${inc._id}`);
      setOpenId(data);
    } catch (e) { toast.error(errMsg(e)); }
  };

  // "+ New Incident" -- opens the reusable modal.  Manual incidents
  // start as `candidate` and become `active` on the next tick, so we
  // switch the filter to `candidate` after create and auto-select the
  // returned row.
  const onIncidentCreated = async (incident) => {
    if (!incident || !incident._id) { load(); return; }
    if (incident.status && incident.status !== status) setStatus(incident.status);
    load();
    // Best-effort auto-select via the same GET the row uses.
    try {
      const { data } = await api.get(`/compliance/incidents/${incident._id}`);
      setOpenId(data);
    } catch (_) { /* silent; the row will still appear in the list */ }
  };

  // Every lifecycle action goes through the shared LifecycleActionModal
  // so reason-required + preview + audit stay consistent with the
  // timeline drawer's flow.
  const [pending, setPending] = useState(null);   // { action, waiver? }
  const openAction = (action, waiver) => setPending({ action, waiver });
  const afterAction = () => {
    setPending(null);
    load();
    if (openId && openId.incident) view(openId.incident);
  };
  // Legacy per-button handlers now just open the shared modal.  The
  // modal itself performs the API call and handles the reason input.
  const cancel  = () => openAction('cancel');
  const waive   = () => openAction('waive');
  const recover = () => openAction('recover');
  const resolve = () => openAction('resolve');
  const activate = () => openAction('activate');
  const decideWaiver = (waiverId, decision) => {
    const waiver = (openId && openId.waivers || []).find((w) => String(w._id) === String(waiverId));
    if (!waiver) return;
    openAction(decision === 'approved' ? 'waive-approve' : 'waive-reject', waiver);
  };

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="md:col-span-1 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            {['candidate','active','resolved','waived','cancelled'].map((k) => (
              <button key={k} onClick={() => setStatus(k)}
                className={`px-2 py-1 text-[11px] rounded border capitalize ${status === k ? 'bg-brand-500 text-white border-brand-500' : 'bg-white text-slate-700 border-slate-200'}`}>
                {k}
              </button>
            ))}
          </div>
          <button
            className="btn-primary !py-1 !text-xs"
            onClick={() => setCreateOpen(true)}
            title="Create a manual compliance incident"
          >
            + New Incident
          </button>
        </div>
        <CreateIncidentModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={onIncidentCreated}
        />
        {err   ? <div className="text-sm text-red-600">Failed: {err}</div>
         : !rows ? <Loader />
         : rows.length === 0 ? <EmptyState title="No incidents in scope" subtitle="Try widening the date range or clearing the search box." />
         : shown.length === 0 ? <EmptyState title="No matches" subtitle="Clear the search box to see all incidents in range." />
         : shown.map((inc) => (
            <IncidentListCard
              key={inc._id}
              inc={inc}
              active={openId && openId.incident._id === inc._id}
              onOpen={() => view(inc)}
              onEmployeeOpen={() => inc.employee && inc.employee._id && onEmployeeOpen(inc.employee._id, inc.employee)}
            />
          ))}
      </div>
      <div className="md:col-span-2">
        <IncidentDetailPanel
          data={openId}
          viewer="hr"
          busy={busy}
          onWaive={waive}
          onRecover={recover}
          onCancel={cancel}
          onReload={() => view(openId.incident)}
          onDecideWaiver={(waiverId, decision) => decideWaiver(waiverId, decision)}
        />
      </div>
      {pending && openId && (
        <LifecycleActionModal
          open={true}
          onClose={() => setPending(null)}
          onDone={afterAction}
          action={pending.action}
          incident={openId.incident}
          effects={openId.effects || []}
          waiver={pending.waiver}
        />
      )}
    </div>
  );
}

/**
 * IncidentListCard -- employee-centric incident row.  Leads with the
 * employee name (largest), then the humanised rule, date, status,
 * severity.  Clicking the row body opens the detail; the small
 * "History" affordance opens the EmployeeHistoryDrawer instead.  We
 * stop click propagation on the affordance so the row selection
 * doesn't fire as a side effect.
 */
function IncidentListCard({ inc, active, onOpen, onEmployeeOpen }) {
  const emp = inc.employee && typeof inc.employee === 'object' ? inc.employee : null;
  const empName = emp ? emp.name : null;
  const empId = emp ? emp.employeeId : null;
  return (
    <div className={`border rounded-md bg-white transition ${active ? 'ring-2 ring-brand-500' : ''}`}>
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left p-3 hover:bg-slate-50 rounded-md"
      >
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-900 truncate">
              {empName || <span className="italic text-slate-500">(deleted employee)</span>}
              {empId && <span className="text-[11px] font-normal text-slate-500 ml-1">· {empId}</span>}
            </div>
            <div className="text-xs text-slate-700 mt-0.5">{ruleTitle(inc.ruleCode)}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">{fmtWhen(inc.incidentDate, false)}</div>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${statusTone(inc.status)}`}>
              {inc.status}
            </span>
            {inc.severity && (
              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${severityTone(inc.severity)}`}>
                {inc.severity}
              </span>
            )}
          </div>
        </div>
      </button>
      {emp && (
        <div className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-right">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEmployeeOpen(); }}
            className="text-brand-600 hover:underline"
            title={`View ${empName}'s compliance history`}
          >
            View history →
          </button>
        </div>
      )}
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
