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
          <OverviewCards data={data} />
          <SubTemplatesSection subTemplates={data.subTemplates || []} />
          <FieldsSection fields={data.fields || []} />
          <DropdownsSection dropdowns={data.dropdowns || []} />
          <TasksSection tasks={data.tasks || []} />
          <EmployeePerformanceSection perf={data.employeePerformance || {}} />
          <ExtraWorkSection extra={data.extraWork || {}} />
        </div>
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
function OverviewCards({ data }) {
  const o = data.overview || {};
  return (
    <div>
      <div className="text-sm font-semibold text-slate-800 mb-2">Overview</div>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
        <StatCard label="Submissions"        value={o.totalSubmissions ?? 0} accent="brand" sub={`${o.generatedSubmissions ?? 0} assigned`} />
        <StatCard label="Submission Rate"    value={`${o.submissionRate ?? 0}%`} accent={o.submissionRate >= 80 ? 'green' : 'amber'} />
        <StatCard label="Completion Rate"    value={`${o.completionRate ?? 0}%`} accent={o.completionRate >= 80 ? 'green' : 'amber'} />
        <StatCard label="Done Rate"          value={`${o.doneRate ?? 0}%`} accent="green" />
        <StatCard label="Pending Rate"       value={`${o.pendingRate ?? 0}%`} accent={(o.pendingRate ?? 0) <= 20 ? 'green' : 'red'} />
        <StatCard label="Work N/A Rate"      value={`${o.wnaRate ?? 0}%`} accent="amber" />
        <StatCard label="Tasks Done"         value={(o.totalTasksDone ?? 0) + (o.totalTasksOngoing ?? 0)} accent="green" />
        <StatCard label="Tasks Pending"      value={o.totalTasksPending ?? 0} accent="red" />
        <StatCard label="Tasks Unavailable"  value={o.totalTasksWNA ?? 0} accent="amber" />
      </div>
    </div>
  );
}

/* =================================================================== */
/* FIELD ANALYTICS                                                      */
/* =================================================================== */
function FieldsSection({ fields }) {
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
      {fields.map((f) => <FieldCard key={f.key} field={f} />)}
    </div>
  );
}

function FieldCard({ field }) {
  const f = field;
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
        <div className="font-semibold text-slate-800">{f.label || f.key}</div>
        <div className="text-[11px] text-slate-500">{f.fieldType} · {f.count} value(s) recorded</div>
      </div>
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total"   value={f.fieldType === 'currency' ? fmtCurrency(f.total) : f.fieldType === 'percentage' ? fmtPct(f.total) : fmtAvg(f.total)} accent="brand" />
          <StatCard label="Average" value={f.fieldType === 'currency' ? fmtCurrency(f.avg)   : f.fieldType === 'percentage' ? fmtPct(f.avg)   : fmtAvg(f.avg)}   accent="blue" />
          <StatCard label="Lowest"  value={f.fieldType === 'currency' ? fmtCurrency(f.min)   : f.fieldType === 'percentage' ? fmtPct(f.min)   : fmtAvg(f.min)}   accent="amber" />
          <StatCard label="Highest" value={f.fieldType === 'currency' ? fmtCurrency(f.max)   : f.fieldType === 'percentage' ? fmtPct(f.max)   : fmtAvg(f.max)}   accent="green" />
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-xs font-semibold text-slate-700 uppercase mb-2">Top Employees</div>
            <Leaderboard rows={f.topEmployees || []} valueKey="total" />
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-700 uppercase mb-2">By Department</div>
            <Leaderboard rows={(f.byDepartment || []).map((d) => ({ name: d.name, employeeId: '', total: d.total }))} valueKey="total" />
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

function Leaderboard({ rows, valueKey, suffix = '' }) {
  if (rows.length === 0) {
    return <div className="text-xs text-slate-500 italic">No data in range.</div>;
  }
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
          <tr key={(r._id || r.name) + ':' + i} className="border-t border-slate-100">
            <td className="py-1 text-slate-500">{i + 1}</td>
            <td className="py-1 text-slate-800">
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
function TasksSection({ tasks }) {
  if (tasks.length === 0) {
    return null;
  }
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
                <td className="font-medium text-slate-800">{t.title}</td>
                <td className="text-right text-green-700">{t.counts.done + t.counts.ongoing}</td>
                <td className="text-right text-red-700">{t.counts.pending}</td>
                <td className="text-right text-amber-700">{t.counts.wna}</td>
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
function EmployeePerformanceSection({ perf }) {
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
function ExtraWorkSection({ extra }) {
  return (
    <div>
      <div className="text-sm font-semibold text-slate-800 mb-2">Extra Work</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Extra Tasks" value={extra.total ?? 0} accent="brand" />
        <StatCard label="Done"              value={extra.done ?? 0}  accent="green" />
        <StatCard label="Pending"           value={extra.pending ?? 0} accent="red" />
        <StatCard label="Work N/A"          value={extra.wna ?? 0}  accent="amber" />
      </div>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3 mt-3">
        <div className="card card-body">
          <div className="text-xs font-semibold text-slate-700 uppercase mb-2">Top Employees</div>
          <Leaderboard rows={(extra.topEmployees || []).map((e) => ({ ...e, total: e.extra }))} valueKey="total" />
        </div>
        <div className="card card-body">
          <div className="text-xs font-semibold text-slate-700 uppercase mb-2">By Department</div>
          <Leaderboard rows={(extra.byDepartment || []).map((d) => ({ name: d.name, employeeId: '', total: d.count }))} valueKey="total" />
        </div>
        <div className="card card-body">
          <div className="text-xs font-semibold text-slate-700 uppercase mb-2">Common Extra Tasks</div>
          <Leaderboard rows={(extra.byTitle || []).map((t) => ({ name: t.title, employeeId: `${t.done} done · ${t.pending} pending`, total: t.count }))} valueKey="total" />
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
