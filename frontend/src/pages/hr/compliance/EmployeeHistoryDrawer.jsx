import { useEffect, useMemo, useState } from 'react';
import api from '../../../api/axios';
import { Loader, EmptyState } from '../../../components/Loader.jsx';
import ActionBadge from '../../../components/compliance/ActionBadge.jsx';
import IncidentDetailPanel from './IncidentDetailPanel.jsx';
import { errMsg } from '../../../utils/helpers';
import { ruleTitle, statusTone, severityTone, fmtWhen } from '../../../utils/incidentPresenter.js';

/**
 * EmployeeHistoryDrawer -- large right-side overlay showing a single
 * employee's complete compliance history: KPI strip + filter row +
 * vertical timeline of incidents, newest first.  Selecting an event
 * on the timeline expands the full IncidentDetailPanel underneath
 * without leaving the drawer.
 *
 * Data reuse (no new endpoints):
 *   GET /api/compliance/incidents?employee=<id>&includeEffects=true&from&to
 *   GET /api/compliance/incidents/:id                      (drill-in)
 *   GET /api/compliance/ledgers/:name?employee=<id>        (impact KPIs)
 *
 * Props:
 *   employeeId  -- User._id
 *   employeeSeed -- optional { name, employeeId, department, designation }
 *                    to render the header before the first incident row
 *                    hydrates the identity.
 *   range       -- { from, to } from the workspace-level DateRangeFilter
 *   onClose     -- () => void
 */
export default function EmployeeHistoryDrawer({ employeeId, employeeSeed, range, onClose }) {
  const [rows, setRows] = useState(null);
  const [rowsErr, setRowsErr] = useState(null);
  const [impact, setImpact] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedData, setExpandedData] = useState(null);

  // ---- filters local to the drawer ------------------------------
  const [fStatus, setFStatus] = useState('');
  const [fRule, setFRule]     = useState('');
  const [fSeverity, setFSeverity] = useState('');
  const [fSource, setFSource] = useState('');

  // ---- load incidents (with effects for the chip rendering) -----
  useEffect(() => {
    if (!employeeId) return;
    let alive = true;
    setRows(null); setRowsErr(null); setExpandedId(null); setExpandedData(null);
    const params = { employee: employeeId, includeEffects: 'true', limit: 200 };
    if (range && range.from) params.from = range.from;
    if (range && range.to)   params.to   = range.to;
    api.get('/compliance/incidents', { params })
      .then(({ data }) => { if (alive) setRows(data); })
      .catch((e) => { if (alive) setRowsErr(errMsg(e)); });
    return () => { alive = false; };
  }, [employeeId, range && range.from, range && range.to]);

  // ---- current impact KPIs -- latest ledger balance across all 4 --
  useEffect(() => {
    if (!employeeId) return;
    let alive = true;
    setImpact(null);
    const kinds = ['marks', 'financial', 'percentage', 'attendance'];
    Promise.all(kinds.map((k) =>
      api.get(`/compliance/ledgers/${k}`, { params: { employee: employeeId } })
        .then(({ data }) => [k, data || []])
        .catch(() => [k, []]),
    )).then((pairs) => {
      if (!alive) return;
      const out = {};
      for (const [k, list] of pairs) {
        out[k] = {
          count: list.length,
          balance: list.length ? Number(list[list.length - 1].runningBalance) || 0 : 0,
        };
      }
      setImpact(out);
    });
    return () => { alive = false; };
  }, [employeeId]);

  const seedEmp = employeeSeed || (rows && rows[0] && typeof rows[0].employee === 'object' ? rows[0].employee : null);

  // ---- derive filter options + counts --------------------------
  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (fStatus   && r.status !== fStatus) return false;
      if (fRule     && r.ruleCode !== fRule) return false;
      if (fSeverity && r.severity !== fSeverity) return false;
      if (fSource   && r.source !== fSource) return false;
      return true;
    });
  }, [rows, fStatus, fRule, fSeverity, fSource]);

  const summary = useMemo(() => {
    if (!rows) return null;
    const acc = { total: rows.length, active: 0, resolved: 0, waived: 0, cancelled: 0, candidate: 0 };
    for (const r of rows) acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, [rows]);

  const uniqueRuleCodes = useMemo(() => {
    if (!rows) return [];
    return [...new Set(rows.map((r) => r.ruleCode))];
  }, [rows]);

  // ---- expansion -----------------------------------------------
  const expand = async (inc) => {
    if (expandedId === inc._id) {
      setExpandedId(null); setExpandedData(null);
      return;
    }
    setExpandedId(inc._id); setExpandedData(null);
    try {
      const { data } = await api.get(`/compliance/incidents/${inc._id}`);
      setExpandedData(data);
    } catch (e) { /* silent; timeline chip still shown */ }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 w-full sm:w-[720px] max-w-full bg-white border-l shadow-2xl flex flex-col">
        <Header seedEmp={seedEmp} onClose={onClose} />
        <ImpactStrip summary={summary} impact={impact} />
        <FilterBar
          rows={rows} uniqueRuleCodes={uniqueRuleCodes}
          fStatus={fStatus}   setFStatus={setFStatus}
          fRule={fRule}       setFRule={setFRule}
          fSeverity={fSeverity} setFSeverity={setFSeverity}
          fSource={fSource}   setFSource={setFSource}
          filteredCount={filtered.length}
          totalCount={rows ? rows.length : 0}
        />
        <div className="flex-1 overflow-y-auto p-4 bg-slate-50">
          {rowsErr && <div className="text-sm text-red-600 border rounded-md p-2 bg-red-50">{rowsErr}</div>}
          {!rowsErr && !rows && <Loader />}
          {rows && filtered.length === 0 && (
            <EmptyState
              title={rows.length === 0 ? 'No incidents in range' : 'No incidents match these filters'}
              subtitle={rows.length === 0
                ? 'The employee has no compliance events in the selected date range.'
                : 'Clear filters above to see the full history.'}
            />
          )}
          {filtered.length > 0 && (
            <Timeline
              rows={filtered}
              expandedId={expandedId}
              expandedData={expandedData}
              onExpand={expand}
            />
          )}
        </div>
      </aside>
    </>
  );
}

/* ---------- Header ------------------------------------------------ */
function Header({ seedEmp, onClose }) {
  const name  = seedEmp && seedEmp.name;
  const empId = seedEmp && seedEmp.employeeId;
  const dept  = seedEmp && seedEmp.department && (seedEmp.department.name || seedEmp.department);
  const desig = seedEmp && seedEmp.designation && (seedEmp.designation.title || seedEmp.designation);
  const initials = (n = '?') =>
    n.trim().split(/\s+/).slice(0, 2).map((w) => (w[0] || '')).join('').toUpperCase() || '?';
  return (
    <header className="sticky top-0 z-10 bg-white border-b px-4 py-3 flex items-center gap-3">
      <div className="w-10 h-10 rounded-full bg-brand-50 text-brand-700 grid place-items-center font-semibold shrink-0">
        {name ? initials(name) : '?'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase text-slate-500 font-semibold">Employee compliance history</div>
        <div className="text-base font-semibold truncate">{name || 'Employee'}</div>
        <div className="text-xs text-slate-500 truncate">
          {[empId && `ID: ${empId}`, dept, desig].filter(Boolean).join(' · ') || '—'}
        </div>
      </div>
      <button className="btn-secondary !py-1 !text-xs" onClick={onClose}>Close</button>
    </header>
  );
}

/* ---------- KPI strip -------------------------------------------- */
function ImpactStrip({ summary, impact }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-3 border-b bg-white">
      <Kpi label="Total incidents" value={summary ? summary.total : '—'} />
      <Kpi label="Active"   value={summary ? summary.active : '—'} accent="red" />
      <Kpi label="Resolved" value={summary ? summary.resolved : '—'} accent="green" />
      <Kpi label="Waived"   value={summary ? summary.waived : '—'} accent="amber" />
      <Kpi label="Marks impact"      value={impact ? fmtBalance(impact.marks?.balance,     'pts') : '—'} />
      <Kpi label="Financial impact"  value={impact ? fmtBalance(impact.financial?.balance, '₹',   true) : '—'} />
      <Kpi label="Percentage impact" value={impact ? fmtBalance(impact.percentage?.balance,'%') : '—'} />
      <Kpi label="Attendance impact" value={impact ? fmtBalance(impact.attendance?.balance,'unit') : '—'} />
    </div>
  );
}
const fmtBalance = (v, unit, prefix = false) => {
  if (v == null || v === '—') return '—';
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return `0${unit === 'pts' || unit === 'unit' || unit === '%' ? ` ${unit}` : ''}`;
  const abs = Math.abs(n);
  if (prefix) return `${n < 0 ? '−' : ''}${unit}${abs}`;
  return `${n < 0 ? '−' : ''}${abs} ${unit}`;
};
function Kpi({ label, value, accent }) {
  const tone = accent === 'red' ? 'text-red-700' : accent === 'green' ? 'text-emerald-700' : accent === 'amber' ? 'text-amber-700' : 'text-slate-800';
  return (
    <div className="border rounded-md p-2 bg-white">
      <div className="text-[10px] uppercase text-slate-500 font-semibold">{label}</div>
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

/* ---------- Filter bar ------------------------------------------- */
function FilterBar({ rows, uniqueRuleCodes, fStatus, setFStatus, fRule, setFRule, fSeverity, setFSeverity, fSource, setFSource, filteredCount, totalCount }) {
  return (
    <div className="border-b bg-white px-3 py-2 flex items-center gap-2 flex-wrap">
      <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="border rounded-md text-xs px-2 py-1">
        <option value="">All statuses</option>
        <option value="candidate">Candidate</option>
        <option value="active">Active</option>
        <option value="resolved">Resolved</option>
        <option value="waived">Waived</option>
        <option value="cancelled">Cancelled</option>
      </select>
      <select value={fRule} onChange={(e) => setFRule(e.target.value)} className="border rounded-md text-xs px-2 py-1 max-w-[180px] truncate">
        <option value="">All rules</option>
        {uniqueRuleCodes.map((c) => (
          <option key={c} value={c}>{ruleTitle(c)}</option>
        ))}
      </select>
      <select value={fSeverity} onChange={(e) => setFSeverity(e.target.value)} className="border rounded-md text-xs px-2 py-1">
        <option value="">All severities</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="critical">Critical</option>
      </select>
      <select value={fSource} onChange={(e) => setFSource(e.target.value)} className="border rounded-md text-xs px-2 py-1">
        <option value="">All sources</option>
        <option value="automatic">Automatic</option>
        <option value="manual">Manual</option>
      </select>
      <span className="text-[11px] text-slate-500 ml-auto">
        {rows ? `${filteredCount} of ${totalCount}` : ''}
      </span>
    </div>
  );
}

/* ---------- Vertical timeline ------------------------------------ */
function Timeline({ rows, expandedId, expandedData, onExpand }) {
  return (
    <ol className="relative border-l-2 border-slate-200 ml-3 space-y-3">
      {rows.map((r) => {
        const isOpen = expandedId === r._id;
        return (
          <li key={r._id} className="pl-4 -ml-[9px]">
            <span className="absolute -translate-x-1/2 mt-1 w-4 h-4 rounded-full bg-white border-2 border-brand-400" />
            <TimelineCard row={r} isOpen={isOpen} onExpand={() => onExpand(r)} />
            {isOpen && (
              <div className="mt-2 border rounded-lg bg-white shadow-sm p-1">
                {expandedData ? (
                  <IncidentDetailPanel data={expandedData} viewer="hr" />
                ) : (
                  <div className="p-4"><Loader /></div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
function TimelineCard({ row, isOpen, onExpand }) {
  return (
    <div className="border rounded-lg bg-white p-3">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">{ruleTitle(row.ruleCode)}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {fmtWhen(row.incidentDate, false)}
            {row.effectiveDate && row.effectiveDate !== row.incidentDate
              ? <> · effective {fmtWhen(row.effectiveDate, false)}</>
              : null}
            {row.source === 'manual' && <> · manual</>}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${statusTone(row.status)}`}>
            {row.status}
          </span>
          {row.severity && (
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${severityTone(row.severity)}`}>
              {row.severity}
            </span>
          )}
        </div>
      </div>
      {Array.isArray(row.effects) && row.effects.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {row.effects.map((e) => <ActionBadge key={e._id} effect={e} />)}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button className="btn-secondary !py-1 !text-xs" onClick={onExpand}>
          {isOpen ? 'Hide details' : 'Quick view'}
        </button>
        {row.ruleCode && (
          <span className="text-[11px] text-slate-400"><code>{row.ruleCode}</code> · v{row.ruleVersion}</span>
        )}
      </div>
    </div>
  );
}
