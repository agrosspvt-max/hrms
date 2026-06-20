import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, Legend,
  BarChart, Bar,
} from 'recharts';
import api from '../../api/axios';
import StatCard from '../../components/StatCard.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { ClickableCard, DrillDownModal } from '../../components/AnalyticsDrillDown.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { errMsg, fmtCurrency, fmtPct, fmtAvg, fmtInt } from '../../utils/helpers';

/**
 * Dynamic Analytics page (Phase 11).
 *
 * Routes:
 *   /template-analytics                 → picker
 *   /template-analytics/:templateId     → auto-generated analytics for one template
 *
 * The page renders a uniformly-shaped KPI grid + per-field analytics +
 * task status breakdown + employee leaderboards + Extra Work section,
 * driven entirely by the backend payload.  No template-specific JSX --
 * any new template HR creates gets analytics for free.
 */
export default function TemplateAnalytics() {
  const { templateId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // Phase 30 -- drill-down state.  `extra` carries metric-specific
  // payload (status filter, taskTitle, fieldKey, employeeId, etc) so
  // the Breakdown component projects the right rows from data.detail.
  const [drill, setDrill] = useState(null); // { metricId, title, extra }

  // Filters
  const [range, setRange] = useState('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('');
  const [employee, setEmployee] = useState('');
  const [includeTest, setIncludeTest] = useState(false);

  // Bootstrap: load templates + employee filter options.
  useEffect(() => {
    api.get('/template-analytics').then((r) => setTemplates(r.data || [])).catch(() => setTemplates([]));
    api.get('/departments').then((r) => setDepartments(r.data || [])).catch(() => setDepartments([]));
    api.get('/employees', { params: { status: 'active', role: 'employee' } }).then((r) => setEmployees(r.data || [])).catch(() => setEmployees([]));
  }, []);

  // Fetch payload when filters change.
  useEffect(() => {
    if (!templateId) { setData(null); setLoading(false); return; }
    const params = {};
    if (range === 'custom') { if (!from || !to) return; params.from = from; params.to = to; params.range = 'custom'; }
    else params.range = range;
    if (department) params.department = department;
    if (employee)   params.employee = employee;
    if (includeTest) params.includeTest = 'true';
    setLoading(true);
    api.get(`/template-analytics/${templateId}`, { params })
      .then(({ data }) => { setData(data); setLoading(false); })
      .catch(() => { setData(null); setLoading(false); });
  }, [templateId, range, from, to, department, employee, includeTest]);

  // Picker view (no templateId in URL).
  if (!templateId) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Template Analytics</h1>
          <p className="text-sm text-slate-500">
            Auto-generated analytics for every custom template. Pick a template below — the engine derives KPIs, leaderboards, and trends from the template definition itself.
          </p>
        </div>
        {templates.length === 0 ? (
          <EmptyState title="No templates available" subtitle="HR can create custom templates from the Work Assignments page; they'll show up here automatically." />
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
            {templates.map((t) => (
              <button
                key={t._id}
                onClick={() => navigate(`/template-analytics/${t._id}`)}
                className="card card-body text-left hover:shadow-md transition"
              >
                <div className="text-sm font-semibold text-slate-800">{t.analyticsName}</div>
                <div className="text-[11px] text-slate-500 mt-1">
                  {t.templateType}{t.customKind ? ` / ${t.customKind}` : ''}
                  {t.department?.name ? ` · ${t.department.name}` : ' · Global'}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{data?.template?.analyticsName || 'Analytics'}</h1>
          <p className="text-sm text-slate-500">
            Auto-generated from the {data?.template?.title || 'template'} definition.
          </p>
        </div>
        <button className="btn-ghost" onClick={() => navigate('/template-analytics')}>← Pick another template</button>
      </div>

      {/* Filter bar */}
      <div className="card card-body flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Period</label>
          <select className="input max-w-[150px]" value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 1 year</option>
            <option value="month">This month</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        {range === 'custom' && (<>
          <div><label className="label">From</label><input className="input max-w-[150px]" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label className="label">To</label><input className="input max-w-[150px]" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
        </>)}
        <div className="min-w-[200px]">
          <label className="label">Department</label>
          <SearchableSelect
            value={department}
            onChange={setDepartment}
            options={departments}
            getValue={(d) => d._id}
            getLabel={(d) => d.name}
            placeholder="All departments"
          />
        </div>
        <div className="min-w-[220px]">
          <label className="label">Employee</label>
          <SearchableSelect
            value={employee}
            onChange={setEmployee}
            options={employees}
            getValue={(e) => e._id}
            getLabel={(e) => `${e.name} (${e.employeeId || ''})`}
            getSearchText={(e) => `${e.name} ${e.employeeId || ''} ${e.email || ''}`}
            placeholder="All employees"
          />
        </div>
        {(user?.role === 'hr' || user?.role === 'super_admin') && (
          <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer ml-1 select-none">
            <input type="checkbox" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
            Include test data
          </label>
        )}
      </div>

      {loading || !data ? <Loader /> : (
        <div className="space-y-6">
          {/* Phase 30: every section accepts an onDrill prop so every
              card / row can route into the same Breakdown modal. */}
          <OverviewCards data={data} onDrill={(metricId, title, extra) => setDrill({ metricId, title, extra })} />
          <SubTemplatesSection subTemplates={data.subTemplates || []} />
          <FieldsSection fields={data.fields || []} onDrill={(metricId, title, extra) => setDrill({ metricId, title, extra })} />
          <DropdownsSection dropdowns={data.dropdowns || []} />
          <TasksSection tasks={data.tasks || []} onDrill={(metricId, title, extra) => setDrill({ metricId, title, extra })} />
          <EmployeePerformanceSection perf={data.employeePerformance || {}} onDrill={(metricId, title, extra) => setDrill({ metricId, title, extra })} />
          <ExtraWorkSection extra={data.extraWork || {}} onDrill={(metricId, title, extra) => setDrill({ metricId, title, extra })} />
        </div>
      )}

      {drill && data && (
        <DrillDownModal metricId={drill.metricId} title={drill.title} onClose={() => setDrill(null)}>
          <Breakdown metricId={drill.metricId} extra={drill.extra} data={data} />
        </DrillDownModal>
      )}
    </div>
  );
}

/* =================================================================== */
/* SUB-TEMPLATE BREAKDOWN                                               */
/* =================================================================== */
function SubTemplatesSection({ subTemplates }) {
  if (!subTemplates || subTemplates.length === 0) return null;
  return (
    <div>
      <div className="text-sm font-semibold text-slate-800 mb-2">Sub-Template Comparison</div>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {subTemplates.map((s) => (
          <div key={s._id} className="card overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-100 bg-slate-50">
              <div className="font-semibold text-slate-800">{s.name || '(unnamed)'}</div>
              {s.description && <div className="text-[11px] text-slate-500">{s.description}</div>}
            </div>
            <div className="p-3 space-y-3">
              {/* Phase 13: assigned / submitted / rates strip. */}
              <div className="grid grid-cols-2 gap-2">
                <StatCard label="Assigned"        value={fmtInt(s.overview.assignedCount ?? 0)}  accent="brand" />
                <StatCard label="Submitted"       value={fmtInt(s.overview.submittedCount ?? 0)} accent="blue" />
                <StatCard label="Completion %"    value={fmtPct(s.overview.completionRate ?? 0)} accent={(s.overview.completionRate ?? 0) >= 80 ? 'green' : 'amber'} />
                <StatCard label="Submission %"    value={fmtPct(s.overview.submissionRate ?? 0)} accent={(s.overview.submissionRate ?? 0) >= 80 ? 'green' : 'amber'} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <StatCard label="Done %"    value={fmtPct(s.overview.donePct ?? 0)}    accent="green" />
                <StatCard label="Pending %" value={fmtPct(s.overview.pendingPct ?? 0)} accent="red" />
                <StatCard label="W/N A %"   value={fmtPct(s.overview.wnaPct ?? 0)}     accent="amber" />
              </div>
              {s.fields && s.fields.length > 0 && (
                <table className="w-full text-xs">
                  <thead className="text-[10px] text-slate-500 uppercase">
                    <tr><th className="text-left">Field</th><th className="text-right">Total</th><th className="text-right">Avg</th><th className="text-right">Max</th></tr>
                  </thead>
                  <tbody>
                    {s.fields.map((f) => (
                      <tr key={f.key} className="border-t border-slate-100">
                        <td className="py-0.5 text-slate-700">{f.label}</td>
                        <td className="py-0.5 text-right font-medium">{fmtAvg(f.total)}</td>
                        <td className="py-0.5 text-right">{fmtAvg(f.avg)}</td>
                        <td className="py-0.5 text-right">{fmtAvg(f.max)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {/* Phase 13: employee ranking + trend per sub-template. */}
              {s.employeeRanking && s.employeeRanking.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Top Employees</div>
                  <table className="w-full text-xs">
                    <thead className="text-[10px] text-slate-500 uppercase">
                      <tr><th className="text-left">Name</th><th className="text-right">Subs</th><th className="text-right">Completion %</th></tr>
                    </thead>
                    <tbody>
                      {s.employeeRanking.slice(0, 5).map((e) => (
                        <tr key={e._id} className="border-t border-slate-100">
                          <td className="py-0.5 text-slate-700">{e.name} <span className="text-slate-400">({e.employeeId})</span></td>
                          <td className="py-0.5 text-right">{e.submissions}</td>
                          <td className="py-0.5 text-right font-medium">{e.completionPct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {s.trend && s.trend.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Daily Submissions</div>
                  <AreaChart width={undefined} height={120} data={s.trend} style={{ width: '100%' }}>
                    <CartesianGrid stroke="#eef2f7" />
                    <XAxis dataKey="date" tick={{ fontSize: 9 }} />
                    <YAxis tick={{ fontSize: 9 }} />
                    <Tooltip />
                    <Area type="monotone" dataKey="submissions" stroke="#6366f1" fill="#6366f1" fillOpacity={0.2} />
                  </AreaChart>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =================================================================== */
/* OVERVIEW                                                             */
/* =================================================================== */
function OverviewCards({ data, onDrill = () => {} }) {
  const o = data.overview || {};
  // Phase 30: each overview card routes to a generic Breakdown metric.
  // taskDone/taskPending/taskWNA project taskRows by status; submissions
  // projects submissionRows; submissionRate/completionRate use the same
  // submissionRows and let the modal contextualise the rate.
  return (
    <div>
      <div className="text-sm font-semibold text-slate-800 mb-2">Overview</div>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
        <ClickableCard onClick={() => onDrill('ta_submissions', 'Submissions')}>
          <StatCard label="Submissions"        value={o.totalSubmissions ?? 0} accent="brand" sub={`${o.generatedSubmissions ?? 0} assigned`} />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_submissionRate', 'Submission Rate')}>
          <StatCard label="Submission Rate"    value={`${o.submissionRate ?? 0}%`} accent={o.submissionRate >= 80 ? 'green' : 'amber'} />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_completionRate', 'Completion Rate')}>
          <StatCard label="Completion Rate"    value={`${o.completionRate ?? 0}%`} accent={o.completionRate >= 80 ? 'green' : 'amber'} />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_doneRate', 'Done Rate', { statuses: ['done', 'ongoing'] })}>
          <StatCard label="Done Rate"          value={`${o.doneRate ?? 0}%`} accent="green" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_pendingRate', 'Pending Rate', { statuses: ['pending'] })}>
          <StatCard label="Pending Rate"       value={`${o.pendingRate ?? 0}%`} accent={(o.pendingRate ?? 0) <= 20 ? 'green' : 'red'} />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_wnaRate', 'Work N/A Rate', { statuses: ['work_not_available'] })}>
          <StatCard label="Work N/A Rate"      value={`${o.wnaRate ?? 0}%`} accent="amber" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_tasksDone', 'Tasks Done', { statuses: ['done', 'ongoing'] })}>
          <StatCard label="Tasks Done"         value={(o.totalTasksDone ?? 0) + (o.totalTasksOngoing ?? 0)} accent="green" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_tasksPending', 'Tasks Pending', { statuses: ['pending'] })}>
          <StatCard label="Tasks Pending"      value={o.totalTasksPending ?? 0} accent="red" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_tasksWNA', 'Tasks Unavailable', { statuses: ['work_not_available'] })}>
          <StatCard label="Tasks Unavailable"  value={o.totalTasksWNA ?? 0} accent="amber" />
        </ClickableCard>
      </div>
    </div>
  );
}

/* =================================================================== */
/* FIELD ANALYTICS                                                      */
/* =================================================================== */
function FieldsSection({ fields, onDrill = () => {} }) {
  if (fields.length === 0) {
    return (
      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Field Analytics</div>
        <div className="card card-body"><EmptyState title="No numeric fields on this template" subtitle="The engine generates KPIs automatically for any Number / Currency / Percentage / Auto field." /></div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="text-sm font-semibold text-slate-800">Field Analytics</div>
      {fields.map((f) => <FieldCard key={f.key} field={f} onDrill={onDrill} />)}
    </div>
  );
}

function FieldCard({ field, onDrill = () => {} }) {
  const f = field;
  // Phase 30: every Total/Avg/Min/Max + leaderboard row drills into the
  // Breakdown modal filtered to this field key.  `agg` selects which
  // aggregate label the modal shows above the table.
  const fieldExtra = (agg) => ({ fieldKey: f.key, fieldLabel: f.label || f.key, fieldType: f.fieldType, agg });
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
        <div className="font-semibold text-slate-800">{f.label || f.key}</div>
        <div className="text-[11px] text-slate-500">{f.fieldType} · {f.count} value(s) recorded</div>
      </div>
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <ClickableCard onClick={() => onDrill('ta_field', `${f.label || f.key} — Total`, fieldExtra('total'))}>
            <StatCard label="Total"   value={f.fieldType === 'currency' ? fmtCurrency(f.total) : f.fieldType === 'percentage' ? fmtPct(f.total) : fmtAvg(f.total)} accent="brand" />
          </ClickableCard>
          <ClickableCard onClick={() => onDrill('ta_field', `${f.label || f.key} — Average`, fieldExtra('avg'))}>
            <StatCard label="Average" value={f.fieldType === 'currency' ? fmtCurrency(f.avg)   : f.fieldType === 'percentage' ? fmtPct(f.avg)   : fmtAvg(f.avg)}   accent="blue" />
          </ClickableCard>
          <ClickableCard onClick={() => onDrill('ta_field', `${f.label || f.key} — Lowest`,  fieldExtra('min'))}>
            <StatCard label="Lowest"  value={f.fieldType === 'currency' ? fmtCurrency(f.min)   : f.fieldType === 'percentage' ? fmtPct(f.min)   : fmtAvg(f.min)}   accent="amber" />
          </ClickableCard>
          <ClickableCard onClick={() => onDrill('ta_field', `${f.label || f.key} — Highest`, fieldExtra('max'))}>
            <StatCard label="Highest" value={f.fieldType === 'currency' ? fmtCurrency(f.max)   : f.fieldType === 'percentage' ? fmtPct(f.max)   : fmtAvg(f.max)}   accent="green" />
          </ClickableCard>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-xs font-semibold text-slate-700 uppercase mb-2">Top Employees</div>
            <Leaderboard rows={f.topEmployees || []} valueKey="total"
              onRowClick={(r) => onDrill('ta_field', `${f.label || f.key} — ${r.name}`, { ...fieldExtra('total'), employeeId: r._id })} />
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-700 uppercase mb-2">By Department</div>
            <Leaderboard rows={(f.byDepartment || []).map((d) => ({ name: d.name, employeeId: '', total: d.total }))} valueKey="total"
              onRowClick={(r) => onDrill('ta_field', `${f.label || f.key} — ${r.name}`, { ...fieldExtra('total'), department: r.name })} />
          </div>
        </div>
        {f.trend && f.trend.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-slate-700 uppercase mb-2">Daily Trend</div>
            <AreaChart width={undefined} height={200} data={f.trend} style={{ width: '100%' }}>
              <CartesianGrid stroke="#eef2f7" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Area type="monotone" dataKey="value" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.2} />
            </AreaChart>
          </div>
        )}
      </div>
    </div>
  );
}

/* =================================================================== */
/* DROPDOWN ANALYTICS                                                   */
/* =================================================================== */
function DropdownsSection({ dropdowns }) {
  if (!dropdowns || dropdowns.length === 0) return null;
  return (
    <div className="space-y-4">
      <div className="text-sm font-semibold text-slate-800">Dropdown Analytics</div>
      {dropdowns.map((d) => <DropdownCard key={d.key} data={d} />)}
    </div>
  );
}

function DropdownCard({ data }) {
  // Stacked colour palette per option.  Loop through a small palette so
  // repeating colours don't matter; each option gets a stable index.
  const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#a855f7', '#14b8a6', '#ec4899'];
  const colourFor = (i) => PALETTE[i % PALETTE.length];
  const top = data.options.slice(0, 12);
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
        <div className="font-semibold text-slate-800">{data.label}</div>
        <div className="text-[11px] text-slate-500">
          {data.totalAnswered} answer(s) recorded
          {data.options.length > 0 && <> · {data.options.length} distinct value(s)</>}
        </div>
      </div>
      <div className="p-5 space-y-4">
        {data.options.length === 0 ? (
          <EmptyState title="No answers in range" />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="text-[11px] text-slate-500 uppercase">
                <tr>
                  <th className="text-left py-1">Option</th>
                  <th className="text-right py-1">Count</th>
                  <th className="text-right py-1">Share</th>
                  <th className="text-left py-1">Top Employees</th>
                </tr>
              </thead>
              <tbody>
                {top.map((o, i) => (
                  <tr key={o.option} className="border-t border-slate-100">
                    <td className="py-1.5">
                      <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ background: colourFor(i) }} />
                      <span className="font-medium text-slate-800">{o.option}</span>
                    </td>
                    <td className="py-1.5 text-right">{o.count}</td>
                    <td className="py-1.5 text-right">{o.pct}%</td>
                    <td className="py-1.5 text-[12px] text-slate-700">
                      {o.topEmployees.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        o.topEmployees.slice(0, 3).map((e, j) => (
                          <span key={e._id}>
                            {j > 0 && <span className="text-slate-300"> · </span>}
                            {e.name} <span className="text-slate-400">({e.count})</span>
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.trend && data.trend.length > 0 && data.seriesKeys && data.seriesKeys.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold text-slate-500 uppercase mb-1">Daily Trend</div>
                <BarChart width={undefined} height={220} data={data.trend} style={{ width: '100%' }}>
                  <CartesianGrid stroke="#eef2f7" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  {data.seriesKeys.slice(0, 8).map((k, i) => (
                    <Bar key={k} dataKey={k} stackId="opts" fill={colourFor(i)} />
                  ))}
                </BarChart>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Leaderboard({ rows, valueKey, suffix = '', onRowClick }) {
  if (rows.length === 0) {
    return <div className="text-xs text-slate-500 italic">No data in range.</div>;
  }
  // Phase 30: rows are clickable when an onRowClick handler is supplied.
  return (
    <table className="w-full text-sm">
      <thead className="text-[11px] text-slate-500 uppercase">
        <tr>
          <th className="text-left py-1 w-6">#</th>
          <th className="text-left py-1">Name</th>
          <th className="text-right py-1">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={(r._id || r.name) + ':' + i}
            className={`border-t border-slate-100 ${onRowClick ? 'cursor-pointer hover:bg-brand-50 dark:hover:bg-brand-500/10' : ''}`}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            title={onRowClick ? 'Click for record-level details' : ''}>
            <td className="py-1 text-slate-500">{i + 1}</td>
            <td className={`py-1 ${onRowClick ? 'text-brand-700' : 'text-slate-800'}`}>
              {r.name}
              {r.employeeId && <span className="text-slate-400"> ({r.employeeId})</span>}
              {r.department && <div className="text-[10px] text-slate-400">{r.department}</div>}
            </td>
            <td className="py-1 text-right font-semibold">{r[valueKey]}{suffix}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* =================================================================== */
/* TASK STATUS                                                          */
/* =================================================================== */
function TasksSection({ tasks, onDrill = () => {} }) {
  if (tasks.length === 0) {
    return null;
  }
  // Phase 30: every cell in the Task Status table drills into the
  // Breakdown modal filtered by (title + status).  Title cell drills
  // into the union of all statuses for that task.
  const drillTask = (title, statuses, label) => onDrill('ta_task', label, { taskTitle: title, statuses });
  return (
    <div>
      <div className="text-sm font-semibold text-slate-800 mb-2">Task Status</div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Task</th>
              <th className="text-right">Done</th>
              <th className="text-right">Pending</th>
              <th className="text-right">Work N/A</th>
              <th className="text-right">Done %</th>
              <th className="text-right">Pending %</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t, i) => (
              <tr key={i}>
                <td className="font-medium text-brand-700 cursor-pointer hover:underline"
                  onClick={() => drillTask(t.title, ['done', 'ongoing', 'pending', 'work_not_available'], `${t.title} — All`)}>
                  {t.title}
                </td>
                <td className="text-right text-green-700 cursor-pointer hover:underline"
                  onClick={() => drillTask(t.title, ['done', 'ongoing'], `${t.title} — Done`)}>
                  {t.counts.done + t.counts.ongoing}
                </td>
                <td className="text-right text-red-700 cursor-pointer hover:underline"
                  onClick={() => drillTask(t.title, ['pending'], `${t.title} — Pending`)}>
                  {t.counts.pending}
                </td>
                <td className="text-right text-amber-700 cursor-pointer hover:underline"
                  onClick={() => drillTask(t.title, ['work_not_available'], `${t.title} — Work N/A`)}>
                  {t.counts.wna}
                </td>
                <td className="text-right">{t.donePct}%</td>
                <td className="text-right">{t.pendingPct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* =================================================================== */
/* EMPLOYEE PERFORMANCE                                                 */
/* =================================================================== */
function EmployeePerformanceSection({ perf, onDrill = () => {} }) {
  const groups = [
    { title: 'Top Performers',    rows: perf.topPerformers,    metric: 'score',        suffix: '%' },
    { title: 'Lowest Performers', rows: perf.lowestPerformers, metric: 'score',        suffix: '%' },
    { title: 'Most Consistent',   rows: perf.mostConsistent,   metric: 'consistency',  suffix: '%' },
    { title: 'Most Pending',      rows: perf.mostPending,      metric: 'pendingCount', suffix: '' },
    { title: 'Most Active',       rows: perf.mostActive,       metric: 'submissions',  suffix: '' },
  ];
  return (
    <div>
      <div className="text-sm font-semibold text-slate-800 mb-2">Employee Performance</div>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {groups.map((g) => (
          <div key={g.title} className="card card-body">
            <div className="text-xs font-semibold text-slate-700 uppercase mb-2">{g.title}</div>
            <Leaderboard
              rows={(g.rows || []).map((r) => ({ ...r, total: r[g.metric] }))}
              valueKey="total"
              suffix={g.suffix}
              onRowClick={(r) => onDrill('ta_employee', `${r.name}`, { employeeId: r._id })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* =================================================================== */
/* EXTRA WORK                                                           */
/* =================================================================== */
function ExtraWorkSection({ extra, onDrill = () => {} }) {
  // Phase 30: extras have addedByEmployee=true on the taskRows projection.
  // Every card / row in this section drills into the same Breakdown
  // modal with the addedByEmployee filter pre-set.
  return (
    <div>
      <div className="text-sm font-semibold text-slate-800 mb-2">Extra Work</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <ClickableCard onClick={() => onDrill('ta_extra', 'Total Extra Tasks', {})}>
          <StatCard label="Total Extra Tasks" value={extra.total ?? 0} accent="brand" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_extra', 'Extra Tasks · Done', { statuses: ['done', 'ongoing'] })}>
          <StatCard label="Done"              value={extra.done ?? 0}  accent="green" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_extra', 'Extra Tasks · Pending', { statuses: ['pending'] })}>
          <StatCard label="Pending"           value={extra.pending ?? 0} accent="red" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_extra', 'Extra Tasks · Work N/A', { statuses: ['work_not_available'] })}>
          <StatCard label="Work N/A"          value={extra.wna ?? 0}  accent="amber" />
        </ClickableCard>
      </div>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3 mt-3">
        <div className="card card-body">
          <div className="text-xs font-semibold text-slate-700 uppercase mb-2">Top Employees</div>
          <Leaderboard rows={(extra.topEmployees || []).map((e) => ({ ...e, total: e.extra }))} valueKey="total"
            onRowClick={(r) => onDrill('ta_extra', `Extra Tasks — ${r.name}`, { employeeId: r._id })} />
        </div>
        <div className="card card-body">
          <div className="text-xs font-semibold text-slate-700 uppercase mb-2">By Department</div>
          <Leaderboard rows={(extra.byDepartment || []).map((d) => ({ name: d.name, employeeId: '', total: d.count }))} valueKey="total"
            onRowClick={(r) => onDrill('ta_extra', `Extra Tasks — ${r.name}`, { department: r.name })} />
        </div>
        <div className="card card-body">
          <div className="text-xs font-semibold text-slate-700 uppercase mb-2">Common Extra Tasks</div>
          <Leaderboard rows={(extra.byTitle || []).map((t) => ({ name: t.title, employeeId: `${t.done} done · ${t.pending} pending`, total: t.count }))} valueKey="total"
            onRowClick={(r) => onDrill('ta_extra', `Extra Tasks — ${r.name}`, { taskTitle: r.name })} />
        </div>
      </div>
      {extra.trend && extra.trend.length > 0 && (
        <div className="card card-body mt-3">
          <div className="text-xs font-semibold text-slate-700 uppercase mb-2">Daily Trend</div>
          <BarChart width={undefined} height={200} data={extra.trend} style={{ width: '100%' }}>
            <CartesianGrid stroke="#eef2f7" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="count" fill="#6366f1" name="Extra Tasks" />
          </BarChart>
        </div>
      )}
    </div>
  );
}

/* =====================================================================
 * Phase 30 — Breakdown component (generic, template-agnostic)
 *
 * Projects rows from the captured payload's `detail` arrays based on the
 * metric id + extra payload.  Because every projection reads from the
 * already-loaded `detail` arrays (which the backend built from the same
 * `subs` cursor that produces the headline KPIs), it auto-covers any
 * future custom template -- no template-specific JSX needed.
 *
 * Routing:
 *   ta_submissions / ta_submissionRate / ta_completionRate → submission rows
 *   ta_doneRate / ta_pendingRate / ta_wnaRate              → task rows by status
 *   ta_tasksDone / ta_tasksPending / ta_tasksWNA           → task rows by status
 *   ta_task   { taskTitle, statuses }                       → task rows filtered
 *   ta_field  { fieldKey, employeeId?, department?, agg }   → field rows sorted
 *   ta_extra  { statuses?, employeeId?, department?, taskTitle? } → extra rows
 *   ta_employee { employeeId }                              → per-employee bundle
 * =====================================================================*/
function Breakdown({ metricId, extra = {}, data }) {
  const detail = data.detail || { submissionRows: [], taskRows: [], fieldRows: [] };
  const submissions = detail.submissionRows || [];
  const taskRows    = detail.taskRows || [];
  const fieldRows   = detail.fieldRows || [];

  // -------- Submission-list drill-downs (Submissions / Submission Rate / Completion Rate) --------
  if (metricId === 'ta_submissions' || metricId === 'ta_submissionRate' || metricId === 'ta_completionRate') {
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">
          {submissions.length} submission(s) in scope · same date range / department / employee / HOD filter as the page.
        </div>
        <div className="overflow-x-auto max-h-[60vh]">
          {submissions.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No submissions in this range.</div>
          ) : (
            <table className="table">
              <thead><tr>
                <th>Employee</th><th>Department</th><th>Date</th>
                <th className="text-right">Earned</th><th className="text-right">Total</th><th className="text-right">Completion %</th>
                <th>Review Status</th>
              </tr></thead>
              <tbody>
                {[...submissions].sort((a, b) => a.date.localeCompare(b.date)).map((r) => (
                  <tr key={r._id}>
                    <td className="font-medium text-slate-800">{r.employeeName}<div className="text-[11px] text-slate-500">{r.employeeCode}</div></td>
                    <td>{r.department}</td>
                    <td>{r.date}</td>
                    <td className="text-right">{r.earnedPoints}</td>
                    <td className="text-right">{r.totalPoints}</td>
                    <td className="text-right">{r.totalPoints > 0 ? Math.round((r.earnedPoints / r.totalPoints) * 100) : 0}%</td>
                    <td>{r.reviewStatus || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // -------- Task-rows drill-downs (overview status + Task Status cells) --------
  if (['ta_doneRate','ta_pendingRate','ta_wnaRate','ta_tasksDone','ta_tasksPending','ta_tasksWNA','ta_task'].includes(metricId)) {
    const statuses = extra.statuses || ['done','ongoing','pending','work_not_available'];
    const titleFilter = extra.taskTitle;
    const rows = taskRows.filter((r) => !r.addedByEmployee
      && statuses.includes(r.status)
      && (!titleFilter || r.title === titleFilter));
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">
          {rows.length} task row(s) · status: {statuses.join(', ')}
          {titleFilter ? ` · task: ${titleFilter}` : ''}
        </div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No task rows match this filter.</div>
          ) : (
            <table className="table">
              <thead><tr>
                <th>Employee</th><th>Department</th><th>Date</th><th>Task</th><th>Status</th>
                <th className="text-right">Points</th><th>Reason / Remark</th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.submissionId}-${r.taskId || r.fieldKey || i}`}>
                    <td className="font-medium text-slate-800">{r.employeeName}<div className="text-[11px] text-slate-500">{r.employeeCode}</div></td>
                    <td>{r.department}</td>
                    <td>{r.date}</td>
                    <td>{r.title}</td>
                    <td>{r.status || '—'}</td>
                    <td className="text-right">{r.points ?? 0}</td>
                    <td className="text-[11px] text-slate-600">{r.pendingReason || r.remark || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // -------- Field detail (numeric Field Analytics drill) --------
  if (metricId === 'ta_field') {
    const { fieldKey, fieldLabel, fieldType, agg, employeeId, department } = extra;
    let rows = fieldRows.filter((r) => r.fieldKey === fieldKey);
    if (employeeId) rows = rows.filter((r) => String(r.employeeId) === String(employeeId));
    if (department) rows = rows.filter((r) => r.department === department);
    const dir = agg === 'min' ? 'asc' : 'desc';
    rows = [...rows].sort((a, b) => dir === 'asc' ? a.value - b.value : b.value - a.value);
    const fmtV = (v) =>
        fieldType === 'currency'   ? fmtCurrency(v)
      : fieldType === 'percentage' ? fmtPct(v)
      : fmtAvg(v);
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">
          {rows.length} value(s) for <b>{fieldLabel || fieldKey}</b>
          {employeeId ? ' · employee-filtered' : ''}
          {department ? ` · department: ${department}` : ''}
        </div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No values for this field in this range.</div>
          ) : (
            <table className="table">
              <thead><tr>
                <th>Employee</th><th>Department</th><th>Date</th>
                <th className="text-right">{fieldLabel || fieldKey}</th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.submissionId}-${i}`}>
                    <td className="font-medium text-slate-800">{r.employeeName}<div className="text-[11px] text-slate-500">{r.employeeCode}</div></td>
                    <td>{r.department}</td>
                    <td>{r.date}</td>
                    <td className="text-right font-semibold">{fmtV(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // -------- Extra Work drill --------
  if (metricId === 'ta_extra') {
    const { statuses, employeeId, department, taskTitle } = extra;
    let rows = taskRows.filter((r) => r.addedByEmployee);
    if (statuses && statuses.length) rows = rows.filter((r) => statuses.includes(r.status));
    if (employeeId) rows = rows.filter((r) => String(r.employeeId) === String(employeeId));
    if (department) rows = rows.filter((r) => r.department === department);
    if (taskTitle)  rows = rows.filter((r) => r.title === taskTitle);
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">
          {rows.length} extra task row(s)
          {statuses?.length ? ` · status: ${statuses.join(', ')}` : ''}
          {employeeId ? ' · employee-filtered' : ''}
          {department ? ` · department: ${department}` : ''}
          {taskTitle ? ` · title: ${taskTitle}` : ''}
        </div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No extra task rows match this filter.</div>
          ) : (
            <table className="table">
              <thead><tr>
                <th>Task</th><th>Employee</th><th>Department</th><th>Date</th><th>Status</th>
                <th className="text-right">Awarded Marks</th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.submissionId}-${r.taskId || i}`}>
                    <td className="font-medium text-slate-800">{r.title}</td>
                    <td>{r.employeeName}<div className="text-[11px] text-slate-500">{r.employeeCode}</div></td>
                    <td>{r.department}</td>
                    <td>{r.date}</td>
                    <td>{r.status || '—'}</td>
                    <td className="text-right">{r.awardedMarks ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // -------- Per-Employee detail bundle --------
  if (metricId === 'ta_employee') {
    const { employeeId } = extra;
    const empSubs = submissions.filter((r) => String(r.employeeId) === String(employeeId));
    const empTasks = taskRows.filter((r) => String(r.employeeId) === String(employeeId));
    const empFields = fieldRows.filter((r) => String(r.employeeId) === String(employeeId));
    if (empSubs.length === 0 && empTasks.length === 0 && empFields.length === 0) {
      return <div className="text-sm text-slate-400 italic">No records for this employee in scope.</div>;
    }
    const e0 = empSubs[0] || empTasks[0] || empFields[0];
    const taskByTitle = new Map();
    for (const t of empTasks) {
      if (t.addedByEmployee) continue;
      const k = t.title;
      if (!taskByTitle.has(k)) taskByTitle.set(k, { title: k, done: 0, pending: 0, wna: 0 });
      const b = taskByTitle.get(k);
      if (t.status === 'done' || t.status === 'ongoing') b.done += 1;
      else if (t.status === 'pending') b.pending += 1;
      else if (t.status === 'work_not_available') b.wna += 1;
    }
    return (
      <div className="space-y-4">
        <div className="rounded border border-slate-200 px-3 py-2 text-sm">
          <div className="font-semibold text-slate-800">{e0?.employeeName}</div>
          <div className="text-[12px] text-slate-600">{e0?.employeeCode || ''} · {e0?.department || ''}</div>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Submission History ({empSubs.length})</div>
          <table className="table">
            <thead><tr><th>Date</th><th className="text-right">Earned</th><th className="text-right">Total</th><th className="text-right">%</th><th>Status</th></tr></thead>
            <tbody>
              {[...empSubs].sort((a, b) => a.date.localeCompare(b.date)).map((s) => (
                <tr key={s._id}>
                  <td>{s.date}</td>
                  <td className="text-right">{s.earnedPoints}</td>
                  <td className="text-right">{s.totalPoints}</td>
                  <td className="text-right">{s.totalPoints > 0 ? Math.round((s.earnedPoints / s.totalPoints) * 100) : 0}%</td>
                  <td>{s.reviewStatus || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {taskByTitle.size > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Task Breakdown</div>
            <table className="table">
              <thead><tr><th>Task</th><th className="text-right">Done</th><th className="text-right">Pending</th><th className="text-right">Work N/A</th></tr></thead>
              <tbody>
                {[...taskByTitle.values()].sort((a, b) => b.done + b.pending + b.wna - (a.done + a.pending + a.wna)).map((t, i) => (
                  <tr key={i}>
                    <td>{t.title}</td>
                    <td className="text-right text-green-700">{t.done}</td>
                    <td className="text-right text-red-700">{t.pending}</td>
                    <td className="text-right text-amber-700">{t.wna}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {empFields.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Field Values ({empFields.length})</div>
            <table className="table">
              <thead><tr><th>Field</th><th>Date</th><th className="text-right">Value</th></tr></thead>
              <tbody>
                {[...empFields].sort((a, b) => a.date.localeCompare(b.date)).map((r, i) => {
                  const fmtV = r.fieldType === 'currency' ? fmtCurrency(r.value) : r.fieldType === 'percentage' ? fmtPct(r.value) : fmtAvg(r.value);
                  return (
                    <tr key={i}><td>{r.fieldLabel}</td><td>{r.date}</td><td className="text-right">{fmtV}</td></tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return <div className="text-sm text-slate-400 italic">No drill-down available for this metric.</div>;
}
