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
import { useToast } from '../../context/ToastContext.jsx';
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
  // Phase 42 -- capture fetch errors so the analytics page renders an
  // explicit error fallback instead of leaving the Loader forever when
  // the backend returns 404 / 500.
  const [loadError, setLoadError] = useState(null);
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

  // Phase 56 -- restricted Employee dropdown: refetch the assigned roster
  // whenever the selected template changes, so the dropdown always
  // reflects "employees who were assigned this template".  The
  // previously-selected employee is cleared if they don't belong to
  // the new template's roster.
  const [templateRoster, setTemplateRoster] = useState([]);
  useEffect(() => {
    if (!templateId) { setTemplateRoster([]); return; }
    api.get(`/template-analytics/${templateId}/assigned-employees`)
      .then(({ data }) => {
        const roster = Array.isArray(data) ? data : [];
        setTemplateRoster(roster);
        // If the currently selected employee isn't in the new roster,
        // drop the filter so the user isn't looking at an empty view.
        setEmployee((cur) => (cur && !roster.some((r) => String(r._id) === String(cur)) ? '' : cur));
      })
      .catch(() => setTemplateRoster([]));
  }, [templateId]);

  // Fetch payload when filters change.
  useEffect(() => {
    if (!templateId) { setData(null); setLoading(false); return; }
    const params = {};
    if (range === 'custom') { if (!from || !to) return; params.from = from; params.to = to; params.range = 'custom'; }
    else params.range = range;
    // Phase 56 -- Department filter was removed from this page (the
    // page already represents ONE template).  Kept the param off the
    // request so the backend response reflects the full template scope.
    if (employee)   params.employee = employee;
    if (includeTest) params.includeTest = 'true';
    setLoading(true);
    setLoadError(null);
    api.get(`/template-analytics/${templateId}`, { params })
      .then(({ data }) => { setData(data); setLoading(false); })
      .catch((err) => {
        setData(null);
        // Phase 42 -- surface the backend error message so HR isn't
        // left staring at a perpetual loading spinner.  Most commonly
        // this is a 404 because a legacy template's `isActive` field
        // is missing on disk; the boot migration handles that on
        // restart but this fallback covers the in-session case too.
        setLoadError(err?.response?.data?.message || err?.message || 'Failed to load analytics for this template.');
        setLoading(false);
      });
  }, [templateId, range, from, to, department, employee, includeTest]);

  // Picker view (no templateId in URL).
  if (!templateId) {
    return (
      <TemplatePicker
        templates={templates}
        canDelete={user?.role === 'hr' || user?.role === 'super_admin'}
        onPick={(id) => navigate(`/template-analytics/${id}`)}
        onChange={() => api.get('/template-analytics').then((r) => setTemplates(r.data || []))}
      />
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
        {/* Phase 56 -- The Analytics page already scopes to ONE template,
            so a Department filter has no meaning at this level.  Replace
            it with a Template selector so HR can switch between
            templates without going back to the picker. */}
        <div className="min-w-[240px]">
          <label className="label">Template</label>
          <SearchableSelect
            value={templateId}
            onChange={(next) => { if (next && String(next) !== String(templateId)) navigate(`/template-analytics/${next}`); }}
            options={templates}
            getValue={(t) => t._id}
            getLabel={(t) => t.analyticsName || t.title || '(untitled)'}
            getSearchText={(t) => `${t.analyticsName || ''} ${t.title || ''}`}
            placeholder="Pick a template"
          />
        </div>
        {/* Phase 56 -- Employee dropdown restricted to employees actually
            assigned this template.  Refreshes whenever the template
            changes; a stale selection auto-clears if the new template's
            roster doesn't include them. */}
        <div className="min-w-[220px]">
          <label className="label">Employee</label>
          <SearchableSelect
            value={employee}
            onChange={setEmployee}
            options={templateRoster}
            getValue={(e) => e._id}
            getLabel={(e) => `${e.name} (${e.employeeId || ''})`}
            getSearchText={(e) => `${e.name} ${e.employeeId || ''}`}
            placeholder={templateRoster.length === 0
              ? 'No assignees on this template'
              : `All assigned (${templateRoster.length})`}
          />
        </div>
        {(user?.role === 'hr' || user?.role === 'super_admin') && (
          <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer ml-1 select-none">
            <input type="checkbox" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
            Include test data
          </label>
        )}
      </div>

      {loading ? <Loader /> : loadError ? (
        // Phase 42 -- explicit error state instead of perpetual Loader.
        <div className="card card-body">
          <EmptyState
            title="Couldn't load analytics for this template"
            subtitle={loadError + ' If this is a legacy template, restart the server so the boot-time backfill runs, or pick another template.'}
          />
        </div>
      ) : !data ? (
        <Loader />
      ) : (
        <TemplateAnalyticsBody data={data} setDrill={setDrill} />
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
/**
 * Phase 58 — Template Analytics body.
 *
 * Adds a segmented tab selector (Value / Marks) at the top so HR can
 * flip between the existing value-based analytics and the new marks
 * analytics without navigating away.  Custom templates get both tabs;
 * Task templates keep the legacy layout since marks already live inside
 * Point Summary + Task Status.
 */
function TemplateAnalyticsBody({ data, setDrill }) {
  const isCustom = data.template?.templateType === 'custom';
  const [tab, setTab] = useState('value');
  const drillProp = (metricId, title, extra) => setDrill({ metricId, title, extra });
  return (
    <div className="space-y-6">
      {isCustom && (
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
          {[
            ['value', 'Value Analytics'],
            ['marks', 'Marks Analytics'],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-5 py-2 text-sm font-medium rounded-lg transition ${
                tab === k ? 'bg-white shadow text-brand-700' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === 'value' || !isCustom ? (
        <>
          <OverviewCards data={data} onDrill={drillProp} />
          <SubTemplatesSection subTemplates={data.subTemplates || []} />
          <FieldsSection fields={data.fields || []} onDrill={drillProp} />
          <DropdownsSection dropdowns={data.dropdowns || []} />
          <TasksSection
            tasks={data.tasks || []}
            onDrill={drillProp}
            showPoints={data.template?.templateType === 'task'}
          />
          <EmployeePerformanceSection perf={data.employeePerformance || {}} onDrill={drillProp} />
          <ExtraWorkSection extra={data.extraWork || {}} onDrill={drillProp} />
          <ExtraTaskAnalyticsSection extras={data.extraTaskAnalytics || []} />
        </>
      ) : (
        <MarksAnalyticsSection marks={data.marksAnalytics || null} />
      )}
    </div>
  );
}

/**
 * Phase 58 — Marks Analytics view for Custom templates.
 *
 * Renders a friendly empty state when the template has no fields with
 * enableMarks set.  Otherwise: summary cards + employee ranking +
 * department ranking + daily trend + per-task marks/penalty table.
 */
function MarksAnalyticsSection({ marks }) {
  if (!marks || !marks.hasMarks) {
    return (
      <div className="card card-body">
        <div className="text-sm font-semibold text-slate-800 mb-1">Marks Analytics</div>
        <div className="text-xs italic text-slate-500">
          Marks are not configured on this template. Enable "Marks" on individual tasks in the template editor to populate this view.
        </div>
      </div>
    );
  }
  const s = marks.summary || {};
  const _n = (v) => (Number.isFinite(v) ? v : 0);
  const scoreAccent = _n(s.overallScorePct) >= 80 ? 'green' : _n(s.overallScorePct) >= 50 ? 'amber' : 'red';
  return (
    <div className="space-y-6">
      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Summary</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Total Available Marks" value={_n(s.totalAvailableMarks)} accent="brand" />
          <StatCard label="Total Earned Marks"    value={_n(s.totalEarnedMarks)}    accent="green" />
          <StatCard label="Penalty Marks"         value={_n(s.totalPenaltyMarks)}   accent="red" />
          <StatCard label="Net Marks"             value={_n(s.netMarks)}            accent="blue" />
          <StatCard label="Overall Score %"       value={`${_n(s.overallScorePct)}%`} accent={scoreAccent} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
          <StatCard label="Average Marks" value={_n(s.averageMarks)} accent="brand" />
          <StatCard label="Highest Marks" value={_n(s.highestMarks)} accent="green" />
          <StatCard label="Lowest Marks"  value={_n(s.lowestMarks)}  accent="amber" />
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Employee Ranking</div>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Employee</th><th>Dept</th><th className="text-right">Submissions</th><th className="text-right">Available</th><th className="text-right">Earned</th><th className="text-right">Penalty</th><th className="text-right">Net</th><th className="text-right">Score %</th></tr></thead>
            <tbody>
              {(marks.employeeRanking || []).length === 0 ? (
                <tr><td colSpan="8" className="text-slate-500 italic">No marks yet.</td></tr>
              ) : marks.employeeRanking.map((e) => (
                <tr key={e.employeeId || e.name}>
                  <td className="font-medium">{e.name}<div className="text-[10px] text-slate-400">{e.employeeId}</div></td>
                  <td>{e.department}</td>
                  <td className="text-right">{e.submissions}</td>
                  <td className="text-right font-mono">{e.available}</td>
                  <td className="text-right font-mono text-green-700">{e.earned}</td>
                  <td className="text-right font-mono text-red-700">{e.penalty}</td>
                  <td className="text-right font-mono">{e.final}</td>
                  <td className="text-right">{e.scorePct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Department Ranking</div>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Department</th><th className="text-right">Available</th><th className="text-right">Earned</th><th className="text-right">Penalty</th><th className="text-right">Net</th><th className="text-right">Score %</th></tr></thead>
            <tbody>
              {(marks.departmentRanking || []).length === 0 ? (
                <tr><td colSpan="6" className="text-slate-500 italic">No marks yet.</td></tr>
              ) : marks.departmentRanking.map((d) => (
                <tr key={d.department}>
                  <td className="font-medium">{d.department}</td>
                  <td className="text-right font-mono">{d.available}</td>
                  <td className="text-right font-mono text-green-700">{d.earned}</td>
                  <td className="text-right font-mono text-red-700">{d.penalty}</td>
                  <td className="text-right font-mono">{d.final}</td>
                  <td className="text-right">{d.scorePct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Task-wise Marks & Penalty</div>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Task</th><th className="text-right">Submissions</th><th className="text-right">Available</th><th className="text-right">Earned</th><th className="text-right">Penalty</th><th className="text-right">Score %</th></tr></thead>
            <tbody>
              {(marks.taskBreakdown || []).length === 0 ? (
                <tr><td colSpan="6" className="text-slate-500 italic">No marks yet.</td></tr>
              ) : marks.taskBreakdown.map((t) => (
                <tr key={t.key}>
                  <td className="font-medium">{t.label}</td>
                  <td className="text-right">{t.submissions}</td>
                  <td className="text-right font-mono">{t.available}</td>
                  <td className="text-right font-mono text-green-700">{t.earned}</td>
                  <td className="text-right font-mono text-red-700">{t.penalty}</td>
                  <td className="text-right">{t.scorePct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Daily Trend</div>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Date</th><th className="text-right">Available</th><th className="text-right">Earned</th><th className="text-right">Penalty</th><th className="text-right">Net</th><th className="text-right">Score %</th></tr></thead>
            <tbody>
              {(marks.dailyTrend || []).length === 0 ? (
                <tr><td colSpan="6" className="text-slate-500 italic">No marks yet.</td></tr>
              ) : marks.dailyTrend.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td className="text-right font-mono">{d.available}</td>
                  <td className="text-right font-mono text-green-700">{d.earned}</td>
                  <td className="text-right font-mono text-red-700">{d.penalty}</td>
                  <td className="text-right font-mono">{d.final}</td>
                  <td className="text-right">{d.scorePct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function OverviewCards({ data, onDrill = () => {} }) {
  const o = data.overview || {};
  // Phase 30: each overview card routes to a generic Breakdown metric.
  // taskDone/taskPending/taskWNA project taskRows by status; submissions
  // projects submissionRows; submissionRate/completionRate use the same
  // submissionRows and let the modal contextualise the rate.
  //
  // Phase 55 -- for Task templates, surface point-based summary cards
  // (Total Available Points / Total Earned Points / Overall Score %)
  // right at the top so HR sees the point picture before the raw
  // status counts.  Custom templates never render these because they
  // have no per-task point values.
  const isTaskTpl = data.template?.templateType === 'task';
  // Task Completion strip -- rendered only when at least one numeric
  // field on this template has "Enable Out Of" turned on.  Templates
  // without any Out Of field don't see the new cards, keeping the
  // existing UI identical for backward compatibility.
  const oOut = o.outOf || { hasOutOfFields: false };
  return (
    <div>
      {oOut.hasOutOfFields && (
        <div className="mb-3">
          <div className="text-sm font-semibold text-slate-800 mb-2">
            Task Completion
            <span className="ml-2 text-[11px] font-normal text-slate-500">
              across {oOut.fieldCount} Out-Of field{oOut.fieldCount === 1 ? '' : 's'}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Completed"
              value={fmtAvg(oOut.totalCompleted ?? 0)}
              sub="Sum of submitted values"
              accent="green"
            />
            <StatCard
              label="Target"
              value={fmtAvg(oOut.totalTarget ?? 0)}
              sub="Sum of Out Of values"
              accent="brand"
            />
            <StatCard
              label="Remaining"
              value={fmtAvg(oOut.totalRemaining ?? 0)}
              sub={`${fmtPct(oOut.pendingPct ?? 0)} pending`}
              accent={(oOut.totalRemaining ?? 0) > 0 ? 'amber' : 'green'}
            />
            <StatCard
              label="Completion %"
              value={fmtPct(oOut.completionPct ?? 0)}
              sub="Completed / Target"
              accent={(oOut.completionPct ?? 0) >= 80 ? 'green' : (oOut.completionPct ?? 0) >= 50 ? 'amber' : 'red'}
            />
          </div>
        </div>
      )}
      {isTaskTpl && (
        <div className="mb-3">
          <div className="text-sm font-semibold text-slate-800 mb-2">Point Summary</div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <StatCard
              label="Total Available Points"
              value={o.totalAvailablePoints ?? 0}
              sub="Excludes Work N/A"
              accent="brand"
            />
            <StatCard
              label="Total Earned Points"
              value={o.totalEarnedPoints ?? 0}
              sub="Sum of Done points"
              accent="green"
            />
            <StatCard
              label="Overall Score %"
              value={`${o.overallScorePct ?? 0}%`}
              sub="Earned / Available"
              accent={(o.overallScorePct ?? 0) >= 80 ? 'green' : (o.overallScorePct ?? 0) >= 50 ? 'amber' : 'red'}
            />
          </div>
        </div>
      )}
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
        {/* Phase 55 -- Done Rate + Pending Rate now use Applicable
            (Done+Ongoing+Pending) as the denominator; Work N/A no
            longer inflates or deflates completion.  The `sub` label
            spells that out so HR sees why the numbers may have moved. */}
        <ClickableCard onClick={() => onDrill('ta_doneRate', 'Done Rate', { statuses: ['done', 'ongoing'] })}>
          <StatCard
            label="Done Rate"
            value={`${o.doneRate ?? 0}%`}
            sub={o.totalTasksApplicable != null ? `of ${o.totalTasksApplicable} applicable` : undefined}
            accent="green"
          />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('ta_pendingRate', 'Pending Rate', { statuses: ['pending'] })}>
          <StatCard
            label="Pending Rate"
            value={`${o.pendingRate ?? 0}%`}
            sub={o.totalTasksApplicable != null ? `of ${o.totalTasksApplicable} applicable` : undefined}
            accent={(o.pendingRate ?? 0) <= 20 ? 'green' : 'red'}
          />
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
  // "Enable Out Of" enrichment: when the field has an Out Of pair,
  // replace the generic Total/Avg/Min/Max strip with a Completed /
  // Target / Remaining / Completion % strip and render a per-employee
  // Completed/Target/Remaining/Completion % table instead of the
  // one-column leaderboard.  Everything below stays identical for
  // regular numeric fields.
  const isOutOf = f.enableOutOf === true && f.outOf;
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
        <div className="font-semibold text-slate-800">{f.label || f.key}</div>
        <div className="text-[11px] text-slate-500">
          {f.fieldType} · {f.count} value(s) recorded
          {isOutOf && <span className="ml-2 text-emerald-700">· Out Of enabled ({f.outOfLabel || 'Out Of'})</span>}
        </div>
      </div>
      <div className="p-5 space-y-4">
        {isOutOf ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <ClickableCard onClick={() => onDrill('ta_field', `${f.label || f.key} — Completed`, fieldExtra('total'))}>
                <StatCard label="Completed" value={fmtAvg(f.outOf.completed)} sub="Sum of submitted values" accent="green" />
              </ClickableCard>
              <StatCard label="Target"    value={fmtAvg(f.outOf.target)}    sub="Sum of Out Of values" accent="brand" />
              <StatCard label="Remaining" value={fmtAvg(f.outOf.remaining)} sub={`${fmtPct(f.outOf.pendingPct)} pending`} accent={f.outOf.remaining > 0 ? 'amber' : 'green'} />
              <StatCard label="Completion" value={fmtPct(f.outOf.completionPct)} sub="Completed / Target"
                accent={(f.outOf.completionPct ?? 0) >= 80 ? 'green' : (f.outOf.completionPct ?? 0) >= 50 ? 'amber' : 'red'} />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Average Completed" value={fmtAvg(f.outOf.avgCompleted)} accent="blue" />
              <StatCard label="Average Target"    value={fmtAvg(f.outOf.avgTarget)}    accent="blue" />
              <StatCard label="Highest Completed" value={fmtAvg(f.outOf.highestCompleted)} accent="green" />
              <StatCard label="Lowest Completed"  value={fmtAvg(f.outOf.lowestCompleted)}  accent="amber" />
            </div>
          </>
        ) : (
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
        )}
        {isOutOf ? (
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-semibold text-slate-700 uppercase mb-2">Employees</div>
              <OutOfEmployeeTable rows={f.topEmployees || []} onRowClick={(r) => onDrill('ta_field', `${f.label || f.key} — ${r.name}`, { ...fieldExtra('total'), employeeId: r._id })} />
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-700 uppercase mb-2">By Department</div>
              <OutOfDepartmentTable rows={f.byDepartment || []} onRowClick={(r) => onDrill('ta_field', `${f.label || f.key} — ${r.name}`, { ...fieldExtra('total'), department: r.name })} />
            </div>
          </div>
        ) : (
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
        )}
        {f.trend && f.trend.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-slate-700 uppercase mb-2">Daily Trend</div>
            <AreaChart width={undefined} height={200} data={f.trend} style={{ width: '100%' }}>
              <CartesianGrid stroke="#eef2f7" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              {isOutOf ? (
                <>
                  <Area type="monotone" dataKey="target"    stroke="#94a3b8" fill="#94a3b8" fillOpacity={0.15} name="Target" />
                  <Area type="monotone" dataKey="completed" stroke="#16a34a" fill="#16a34a" fillOpacity={0.25} name="Completed" />
                  <Area type="monotone" dataKey="remaining" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.15} name="Remaining" />
                </>
              ) : (
                <Area type="monotone" dataKey="value" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.2} />
              )}
            </AreaChart>
          </div>
        )}
      </div>
    </div>
  );
}

/* Rich per-employee table shown for "Enable Out Of" numeric fields. */
function OutOfEmployeeTable({ rows, onRowClick }) {
  if (!rows || rows.length === 0) {
    return <div className="text-xs text-slate-500 italic px-1 py-2">No responses in range.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead className="text-[10px] uppercase text-slate-500">
          <tr>
            <th className="text-left py-1">Employee</th>
            <th className="text-right">Completed</th>
            <th className="text-right">Target</th>
            <th className="text-right">Remaining</th>
            <th className="text-right">Completion %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r._id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
              onClick={() => onRowClick && onRowClick(r)}>
              <td className="py-1">
                <div className="font-medium text-slate-800">{r.name}</div>
                {r.employeeId && <div className="text-[10px] text-slate-500">{r.employeeId} · {r.department}</div>}
              </td>
              <td className="py-1 text-right">{fmtAvg(r.completed ?? r.total)}</td>
              <td className="py-1 text-right">{fmtAvg(r.target ?? 0)}</td>
              <td className="py-1 text-right">{fmtAvg(r.remaining ?? 0)}</td>
              <td className="py-1 text-right font-medium"
                style={{ color: (r.completionPct ?? 0) >= 80 ? '#059669' : (r.completionPct ?? 0) >= 50 ? '#b45309' : '#b91c1c' }}>
                {fmtPct(r.completionPct ?? 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* Rich per-department table shown for "Enable Out Of" numeric fields. */
function OutOfDepartmentTable({ rows, onRowClick }) {
  if (!rows || rows.length === 0) {
    return <div className="text-xs text-slate-500 italic px-1 py-2">No department data in range.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead className="text-[10px] uppercase text-slate-500">
          <tr>
            <th className="text-left py-1">Department</th>
            <th className="text-right">Completed</th>
            <th className="text-right">Target</th>
            <th className="text-right">Remaining</th>
            <th className="text-right">Completion %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
              onClick={() => onRowClick && onRowClick(r)}>
              <td className="py-1 font-medium text-slate-800">{r.name}
                <span className="ml-1 text-[10px] text-slate-500">({r.employees})</span>
              </td>
              <td className="py-1 text-right">{fmtAvg(r.completed ?? r.total)}</td>
              <td className="py-1 text-right">{fmtAvg(r.target ?? 0)}</td>
              <td className="py-1 text-right">{fmtAvg(r.remaining ?? 0)}</td>
              <td className="py-1 text-right font-medium"
                style={{ color: (r.completionPct ?? 0) >= 80 ? '#059669' : (r.completionPct ?? 0) >= 50 ? '#b45309' : '#b91c1c' }}>
                {fmtPct(r.completionPct ?? 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
function TasksSection({ tasks, onDrill = () => {}, showPoints = false }) {
  if (tasks.length === 0) {
    return null;
  }
  // Phase 30: every cell in the Task Status table drills into the
  // Breakdown modal filtered by (title + status).  Title cell drills
  // into the union of all statuses for that task.
  const drillTask = (title, statuses, label) => onDrill('ta_task', label, { taskTitle: title, statuses });
  // Phase 55 -- Applicable / Total Points / Earned Points columns render
  // only for Task templates.  Custom-template analytics ride the same
  // component but never carry point data, so we skip those columns.
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
              {showPoints && <th className="text-right">Applicable</th>}
              {showPoints && <th className="text-right">Total Points</th>}
              {showPoints && <th className="text-right">Earned Points</th>}
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
                  {showPoints && t.points > 0 && (
                    <span className="ml-1 text-[10px] text-slate-400 font-normal">
                      ({t.points} pt{t.points === 1 ? '' : 's'})
                    </span>
                  )}
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
                {/* Phase 55 -- Applicable = Done + Ongoing + Pending.
                    Excludes Work N/A so the denominator for Done % and
                    Pending % matches HR's mental model. */}
                {showPoints && (
                  <td className="text-right font-medium text-slate-700">
                    {t.applicable ?? (t.counts.done + t.counts.ongoing + t.counts.pending)}
                  </td>
                )}
                {showPoints && (
                  <td className="text-right font-mono">{t.totalPoints ?? 0}</td>
                )}
                {showPoints && (
                  <td className="text-right font-mono text-green-700">{t.earnedPoints ?? 0}</td>
                )}
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
/**
 * Phase 53 -- Extra Task Analytics section.
 *
 * Renders one card per template-catalog Extra Task (grouped by key),
 * so multiple employees submitting the same Extra Task contribute to
 * a single aggregate.  Numeric types get Total/Avg/High/Low; status
 * types get Done/Pending/W-N-A + completion %.  Both types get a
 * top-employees leaderboard, department summary, and daily trend.
 *
 * Template-isolated: the endpoint's underlying Submission.find scopes
 * strictly by `template: <this templateId>`, so one template's cards
 * never leak into another's analytics.
 */
function ExtraTaskAnalyticsSection({ extras }) {
  if (!extras || extras.length === 0) {
    // Still render the heading so HR can tell the section exists but
    // hasn't been populated by any submitted extra tasks yet.
    return (
      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Extra Task Analytics</div>
        <div className="text-xs italic text-slate-500 bg-slate-50 rounded p-3 border border-slate-200">
          No extra tasks submitted in this range. Employees can add extra tasks from any Custom Assignment submission.
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="text-sm font-semibold text-slate-800 mb-2">
        Extra Task Analytics
        <span className="text-slate-400 font-normal text-[11px] ml-2">
          {extras.length} unique extra task{extras.length === 1 ? '' : 's'} across all submissions
        </span>
      </div>
      <div className="space-y-3">
        {extras.map((x) => <ExtraTaskCard key={x.key} data={x} />)}
      </div>
    </div>
  );
}

function ExtraTaskCard({ data }) {
  const { hasNumeric, hasStatus } = data._flags || {};
  const [tab, setTab] = useState('summary'); // summary | employees | departments | trend
  return (
    <div className="rounded-lg border border-indigo-100 bg-white overflow-hidden">
      <div className="px-4 py-3 bg-indigo-50/60 border-b border-indigo-100 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-indigo-900">{data.label}</div>
          {data.description && (
            <div className="text-[11px] text-indigo-800/70">{data.description}</div>
          )}
          <div className="text-[10px] uppercase tracking-wide text-indigo-700 mt-0.5">
            {EXTRA_LABEL[data.responseType] || data.responseType}
            {' · '}
            {data.submissionCount} submission{data.submissionCount === 1 ? '' : 's'}
            {' · '}
            {data.employeeCount} employee{data.employeeCount === 1 ? '' : 's'}
          </div>
        </div>
        <div className="flex items-center gap-1 text-xs">
          {[
            { id: 'summary',     label: 'Summary' },
            { id: 'employees',   label: 'Top Employees' },
            { id: 'departments', label: 'Departments' },
            { id: 'trend',       label: 'Daily Trend' },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-2 py-1 rounded ${tab === t.id ? 'bg-white text-indigo-800 font-semibold border border-indigo-200' : 'text-indigo-700 hover:bg-white/70'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="p-4">
        {tab === 'summary' && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            {hasNumeric && (
              <>
                <MiniStat label="Total"   value={data.total} />
                <MiniStat label="Average" value={data.average} />
                <MiniStat label="Highest" value={data.highest} />
                <MiniStat label="Lowest"  value={data.lowest} />
              </>
            )}
            {hasStatus && (
              <>
                <MiniStat label="Done"    value={data.statusCounts.done || 0}    cls="text-green-700" />
                <MiniStat label="Pending" value={data.statusCounts.pending || 0} cls="text-amber-700" />
                <MiniStat label="Work N/A" value={data.statusCounts.work_not_available || 0} cls="text-slate-600" />
                <MiniStat label="Completion %" value={`${data.completionPct}%`} cls="text-brand-700" />
              </>
            )}
            {!hasNumeric && !hasStatus && (
              <div className="col-span-4 text-xs italic text-slate-500">
                Response type "none" — no numeric or status metric to aggregate.
              </div>
            )}
          </div>
        )}
        {tab === 'employees' && (
          <div className="overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Dept</th>
                  <th>Submissions</th>
                  {hasNumeric && <th>Total</th>}
                  {hasStatus  && <th>Done</th>}
                </tr>
              </thead>
              <tbody>
                {data.topEmployees.length === 0 ? (
                  <tr><td colSpan="5" className="text-slate-500 italic">No submissions yet.</td></tr>
                ) : data.topEmployees.map((e) => (
                  <tr key={e.employeeId || e.name}>
                    <td className="font-medium">{e.name}<div className="text-[10px] text-slate-400">{e.employeeId}</div></td>
                    <td>{e.department}</td>
                    <td>{e.count}</td>
                    {hasNumeric && <td className="font-mono">{e.total}</td>}
                    {hasStatus  && <td className="font-mono">{e.done}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tab === 'departments' && (
          <div className="overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Department</th>
                  <th>Submissions</th>
                  {hasNumeric && <th>Total</th>}
                  {hasStatus  && <th>Done</th>}
                </tr>
              </thead>
              <tbody>
                {data.departmentSummary.length === 0 ? (
                  <tr><td colSpan="4" className="text-slate-500 italic">No submissions yet.</td></tr>
                ) : data.departmentSummary.map((d) => (
                  <tr key={d.department}>
                    <td className="font-medium">{d.department}</td>
                    <td>{d.count}</td>
                    {hasNumeric && <td className="font-mono">{d.total}</td>}
                    {hasStatus  && <td className="font-mono">{d.done}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tab === 'trend' && (
          <div className="overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Submissions</th>
                  {hasNumeric && <th>Total</th>}
                  {hasStatus  && <th>Done</th>}
                </tr>
              </thead>
              <tbody>
                {data.dailyTrend.length === 0 ? (
                  <tr><td colSpan="4" className="text-slate-500 italic">No submissions yet.</td></tr>
                ) : data.dailyTrend.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td>{d.count}</td>
                    {hasNumeric && <td className="font-mono">{d.total}</td>}
                    {hasStatus  && <td className="font-mono">{d.done}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const EXTRA_LABEL = {
  none: 'Status only (None)',
  number: 'Number',
  status: 'Status',
  number_status: 'Number + Status',
};

function MiniStat({ label, value, cls = 'text-slate-800' }) {
  return (
    <div className="border border-slate-200 rounded p-2">
      <div className="text-[10px] uppercase text-slate-500">{label}</div>
      <div className={`font-semibold ${cls}`}>{value ?? 0}</div>
    </div>
  );
}

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
 * Phase 41 — Template Analytics picker with multi-select + delete
 *
 * Per-card delete (HR / SA only) + a multi-select bar that mirrors the
 * pattern used elsewhere (Attendance / Salary / Submission Reviews).
 * Delete only hides the analytics-surface entry: the underlying
 * template, assignments, submissions, attendance, and historical
 * records all stay intact (backend sets `template.analyticsHidden=true`,
 * does not touch the Template document beyond that flag).
 * ===================================================================== */
function TemplatePicker({ templates, canDelete, onPick, onChange }) {
  const toast = useToast();
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [confirmIds, setConfirmIds] = useState(null); // null | [String]

  const toggleOne = (id) => setSelected((cur) => {
    const n = new Set(cur);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allSelected = templates.length > 0 && templates.every((t) => selected.has(t._id));
  const someSelected = templates.some((t) => selected.has(t._id));
  const toggleSelectAll = () => setSelected((cur) => {
    if (allSelected) return new Set();
    const n = new Set(cur);
    templates.forEach((t) => n.add(t._id));
    return n;
  });
  const clearSelection = () => setSelected(new Set());

  const performDelete = async (ids) => {
    setBusy(true);
    try {
      if (ids.length === 1) await api.delete(`/template-analytics/${ids[0]}`);
      else await api.post('/template-analytics/hide-bulk', { templateIds: ids });
      toast.success(`Removed analytics for ${ids.length} template${ids.length === 1 ? '' : 's'}`);
      setConfirmIds(null);
      clearSelection();
      onChange();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Template Analytics</h1>
        <p className="text-sm text-slate-500">
          Auto-generated analytics for every template. Pick a template below — the engine derives KPIs, leaderboards, and trends from the template definition itself.
        </p>
      </div>

      {/* Phase 41 -- bulk action bar.  Renders only when at least one
          template is selected so the page stays uncluttered. */}
      {canDelete && selected.size > 0 && (
        <div className="flex items-center justify-between gap-2 flex-wrap text-xs bg-brand-50 dark:bg-brand-500/10 border border-brand-200 dark:border-brand-500/30 rounded-lg px-3 py-2">
          <span><b>{selected.size}</b> template{selected.size === 1 ? '' : 's'} selected</span>
          <div className="flex items-center gap-2">
            <button className="btn-secondary !py-1 !text-xs" onClick={clearSelection}>Clear</button>
            <button
              className="btn-secondary !py-1 !text-xs text-red-600"
              onClick={() => setConfirmIds([...selected])}
            >
              {selected.size > 1 ? 'Delete Selected Analytics' : 'Delete Analytics'}
            </button>
          </div>
        </div>
      )}

      {/* Select-all toggle */}
      {canDelete && templates.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
            onChange={toggleSelectAll}
          />
          Select all templates on this page
        </label>
      )}

      {templates.length === 0 ? (
        <EmptyState title="No templates available" subtitle="HR can create templates from the Work Assignments page; they'll show up here automatically." />
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
          {templates.map((t) => {
            const isSelected = selected.has(t._id);
            return (
              <div
                key={t._id}
                className={`card card-body relative transition ${isSelected ? 'ring-2 ring-brand-400' : 'hover:shadow-md'}`}
              >
                {canDelete && (
                  <label
                    className="absolute top-2 left-2 cursor-pointer select-none"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(t._id)}
                    />
                  </label>
                )}
                <button
                  onClick={() => onPick(t._id)}
                  className={`text-left ${canDelete ? 'pl-6' : ''} w-full`}
                >
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.analyticsName}</div>
                  <div className="text-[11px] text-slate-500 mt-1">
                    {t.templateType}{t.customKind ? ` / ${t.customKind}` : ''}
                    {t.department?.name ? ` · ${t.department.name}` : ' · Global'}
                  </div>
                </button>
                {canDelete && (
                  <button
                    className="absolute top-2 right-2 text-[11px] text-red-600 hover:underline"
                    title="Remove this template's analytics entry"
                    onClick={(e) => { e.stopPropagation(); setConfirmIds([t._id]); }}
                  >
                    Delete
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {confirmIds && (
        <DeleteAnalyticsConfirm
          count={confirmIds.length}
          busy={busy}
          onCancel={() => setConfirmIds(null)}
          onConfirm={() => performDelete(confirmIds)}
        />
      )}
    </div>
  );
}

function DeleteAnalyticsConfirm({ count, busy, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl max-w-md w-full m-4 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Delete Analytics?
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-2">
            This will remove the analytics generated for the selected template{count === 1 ? '' : 's'}.
          </p>
          <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-2">
            The original work template, employee submissions, attendance, and historical data will NOT be deleted.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn-primary !bg-red-600 hover:!bg-red-700" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
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
