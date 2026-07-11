import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  AreaChart, Area, PieChart, Pie, Cell, Legend, ScatterChart, Scatter, ZAxis,
} from 'recharts';
import api from '../../api/axios';
import StatCard from '../../components/StatCard.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { ClickableCard, DrillDownModal } from '../../components/AnalyticsDrillDown.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { fmtCurrency, fmtPct, fmtAvg, fmtInt, errMsg } from '../../utils/helpers';

const RED = '#ef4444'; const ORANGE = '#f97316'; const AMBER = '#f59e0b';
const GREEN = '#22c55e'; const BLUE = '#3b82f6'; const VIOLET = '#8b5cf6'; const SLATE = '#94a3b8';
const AGING_COLORS = { '0-2d': '#fbbf24', '3-7d': '#f97316', '8-14d': '#ef4444', '15d+': '#b91c1c' };
const rateAccent = (r) => (r >= 50 ? 'red' : r >= 25 ? 'amber' : 'green');
const scoreAccent = (s) => (s >= 80 ? 'green' : s >= 60 ? 'amber' : 'red');

const ChartCard = ({ title, subtitle, onClick, children, height = 260 }) => (
  <div className="card card-body">
    <div className="flex items-start justify-between">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {subtitle && <div className="text-[11px] text-slate-400">{subtitle}</div>}
      </div>
      {onClick && <button className="text-[11px] text-brand-600 hover:underline" onClick={onClick}>Details →</button>}
    </div>
    <div style={{ width: '100%', height }} className="mt-3"><ResponsiveContainer>{children}</ResponsiveContainer></div>
  </div>
);

export default function Performance() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // ------------------------------------------------------------------
  // Role gating.  HR / Super Admin see every tab + every filter.  HOD
  // sees a dept-scoped subset:
  //   - Marketing HOD     -> Calling Analytics is the default tab; all
  //                           three modes (pendency / completion /
  //                           calling) remain available because the
  //                           dept Calling team uses them.
  //   - Other-dept HOD    -> only Pendency Review + Completion Review.
  //   The Department filter is hidden for HODs since their query is
  //   already clamped server-side.
  // Department name match is case-insensitive ("Marketing" / "marketing"
  // / "MARKETING" all detected).
  // ------------------------------------------------------------------
  const isHOD = !!user?.isHOD && !(user?.role === 'hr' || user?.role === 'super_admin');
  // Department.analyticsType is the source of truth (no longer name-
  // matched).  Prefer the HOD's headed-department row over their own
  // member department, falling back to 'standard'.
  const hodDeptName = (user?.hodDepartment?.name || user?.department?.name || '').trim();
  const hodAnalyticsType = (user?.hodDepartment?.analyticsType || user?.department?.analyticsType || 'standard');
  const isCallingHOD = isHOD && hodAnalyticsType === 'calling';
  const defaultMode = isHOD ? (isCallingHOD ? 'calling' : 'pendency') : 'pendency';
  const allowedModes = isHOD
    ? (isCallingHOD
        ? ['pendency', 'completion', 'calling']
        : ['pendency', 'completion'])
    : ['pendency', 'completion', 'calling'];

  const [mode, setMode] = useState(defaultMode);
  const [range, setRange] = useState('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('');
  const [designation, setDesignation] = useState('');
  const [employee, setEmployee] = useState('');
  const [templateType, setTemplateType] = useState('');
  const [recurrence, setRecurrence] = useState('');
  // Phase 4: HR/SA quick toggle to see analytics WITH test-marked rows
  // included.  Default off so analytics show the production picture.
  const [includeTest, setIncludeTest] = useState(false);

  const [opts, setOpts] = useState({ departments: [], designations: [], employees: [] });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState(null); // { metricId, title }
  // Phase 25: Calling Analytics drill-downs.  Held separately from the
  // pendency / completion drill state so the two flows can't collide --
  // the calling breakdown function projects rows differently per metric.
  const [callingDrill, setCallingDrill] = useState(null); // { metricId, title }
  // Phase 56 -- Calling-tab Employee dropdown is restricted to employees
  // with actual calling activity (submitted a report in range OR are
  // assigned to a calling template).  Refetched on every time-period
  // change so the roster tracks the visible period.
  const [callingRoster, setCallingRoster] = useState([]);

  useEffect(() => {
    // Phase 23.2: the /employees endpoint is HR-only (authorize('hr')),
    // so a HOD account previously got a 403 here and the Employee
    // SearchableSelect stayed empty -- "0 matches" no matter what the
    // user typed.  HOD has its own department-scoped endpoint at
    // /employees/team that returns { department, members[] }.  We route
    // HOD users to that endpoint and keep the HR/SA path on /employees.
    const empPromise = isHOD
      ? api.get('/employees/team').then((r) => (r.data?.members || []).map((m) => ({
          _id: m._id, name: m.name, employeeId: m.employeeId, email: m.email,
        }))).catch(() => [])
      : api.get('/employees', { params: { status: 'active', role: 'employee' } }).then((r) => r.data).catch(() => []);

    Promise.all([
      api.get('/departments').then((r) => r.data).catch(() => []),
      api.get('/designations').then((r) => r.data).catch(() => []),
      empPromise,
    ]).then(([departments, designations, employees]) => setOpts({
      departments: departments || [], designations: designations || [], employees: employees || [],
    }));
  }, [isHOD]);

  useEffect(() => {
    const params = {};
    if (range === 'custom') { if (!from || !to) return; params.from = from; params.to = to; }
    else params.range = range;
    if (department) params.department = department;
    if (designation) params.designation = designation;
    if (employee) params.employee = employee;
    if (templateType) params.templateType = templateType;
    if (recurrence) params.recurrence = recurrence;
    if (includeTest) params.includeTest = 'true';
    setLoading(true);
    // Calling mode hits its own analytics endpoint (role-scoped at the
    // controller).  Other modes keep their original pendency/completion
    // endpoints unchanged.
    const url = mode === 'calling'
      ? '/dashboard/calling/analytics'
      : `/dashboard/hr/${mode}`;
    api.get(url, { params })
      .then(({ data }) => { setData(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [mode, range, from, to, department, designation, employee, templateType, recurrence, includeTest]);

  // Phase 56 -- refetch the calling-mode roster whenever the visible
  // period changes.  Not tied to `employee` so a selection never
  // "clips" the roster to just that one person.  Only fires on the
  // Calling tab; the other modes keep using opts.employees.
  useEffect(() => {
    if (mode !== 'calling') return;
    const params = {};
    if (range === 'custom') { if (!from || !to) return; params.from = from; params.to = to; }
    else params.range = range;
    api.get('/dashboard/calling/roster', { params })
      .then(({ data }) => setCallingRoster(Array.isArray(data) ? data : []))
      .catch(() => setCallingRoster([]));
  }, [mode, range, from, to]);

  const openDrill = (metricId, title) => setDrill({ metricId, title });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Performance Analytics</h1>
        <p className="text-sm text-slate-500">
          {isHOD
            ? <>Department-scoped view: <b>{hodDeptName || 'your department'}</b>. You can only see employees from your team.</>
            : 'Dual-mode enterprise analytics. Click any card or chart for a detailed breakdown.'}
        </p>
      </div>

      {/* Mode toggle -- only tabs allowed for the caller's role appear. */}
      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        {[['pendency', 'Pendency Review'], ['completion', 'Completion Review'], ['calling', 'Calling Analytics']]
          .filter(([k]) => allowedModes.includes(k))
          .map(([k, label]) => (
          <button key={k} onClick={() => {
              setMode(k);
              setData(null);
              // Phase 56 -- clear filters that don't exist on the
              // Calling tab so a stale department / non-calling employee
              // selection doesn't silently narrow the calling view.
              if (k === 'calling') { setDepartment(''); setEmployee(''); }
            }}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition ${mode === k ? 'bg-white shadow text-brand-700' : 'text-slate-500 hover:text-slate-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Shared filters */}
      <div className="card card-body flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Period</label>
          <select className="input max-w-[150px]" value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 1 year</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        {range === 'custom' && (<>
          <div><label className="label">From</label><input className="input max-w-[150px]" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label className="label">To</label><input className="input max-w-[150px]" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
        </>)}
        {/* Phase 56 -- Calling tab hides Department entirely (calling
            work is its own operational workflow, not department-scoped)
            and swaps the Employee dropdown to a roster of only those
            with actual calling activity. */}
        {!isHOD && mode !== 'calling' && (
          <div className="min-w-[180px]"><label className="label">Department</label>
            <SearchableSelect
              value={department}
              onChange={setDepartment}
              options={opts.departments}
              getValue={(d) => d._id}
              getLabel={(d) => d.name}
              placeholder="All departments"
            />
          </div>
        )}
        <div className="min-w-[180px]"><label className="label">Designation</label>
          <SearchableSelect
            value={designation}
            onChange={setDesignation}
            options={opts.designations}
            getValue={(d) => d._id}
            getLabel={(d) => d.title}
            placeholder="All designations"
          />
        </div>
        <div className="min-w-[200px]"><label className="label">Employee</label>
          <SearchableSelect
            value={employee}
            onChange={setEmployee}
            options={mode === 'calling' ? callingRoster : opts.employees}
            getValue={(e) => e._id}
            getLabel={(e) => e.name + (e.employeeId ? ` (${e.employeeId})` : '')}
            getSearchText={(e) => `${e.name} ${e.employeeId || ''} ${e.email || ''}`}
            placeholder={mode === 'calling'
              ? (callingRoster.length === 0 ? 'No calling activity in range' : 'All calling employees')
              : 'All employees'}
          />
        </div>
        <div><label className="label">Template type</label>
          <select className="input max-w-[150px]" value={templateType} onChange={(e) => setTemplateType(e.target.value)}>
            <option value="">All types</option><option value="task">Task</option><option value="excel">Excel</option><option value="sheet">Spreadsheet</option>
          </select>
        </div>
        <div><label className="label">Recurrence</label>
          <select className="input max-w-[150px]" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
            <option value="">All</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="one-time">One-time</option>
          </select>
        </div>
        {(department || designation || employee || templateType || recurrence) && (
          <button className="btn-ghost" onClick={() => { setDepartment(''); setDesignation(''); setEmployee(''); setTemplateType(''); setRecurrence(''); }}>Clear</button>
        )}
        {/* HR / SA only -- include rows flagged as test data.  Default off. */}
        {(user?.role === 'hr' || user?.role === 'super_admin') && (
          <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer ml-1 select-none">
            <input type="checkbox" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
            Include test data
          </label>
        )}
      </div>

      {loading || !data ? <Loader /> : (
        mode === 'pendency' ? <PendencyMode data={data} onDrill={openDrill} />
        : mode === 'completion' ? <CompletionMode data={data} onDrill={openDrill} />
        : <CallingMode
            data={data}
            // Phase 25 -- open drill-down for any KPI / leaderboard card.
            // Leaderboards pass an `extra` payload (leaderboardId + metric
            // + suffix + title) so CallingBreakdown can rebuild the full
            // ranking from data.employees.
            onDrill={(metricId, title, extra) => setCallingDrill({ metricId, title, extra })}
            // Phase 24 -- pass the live filters so Export Report calls the
            // backend with the EXACT same params Calling Analytics used.
            exportParams={(() => {
              const p = {};
              if (range === 'custom') { if (from && to) { p.from = from; p.to = to; } }
              else p.range = range;
              if (department) p.department = department;
              if (designation) p.designation = designation;
              if (employee) p.employee = employee;
              if (templateType) p.templateType = templateType;
              if (recurrence) p.recurrence = recurrence;
              if (includeTest) p.includeTest = 'true';
              return p;
            })()}
            // Phase 24.3 -- a HOD's stored role is `employee` with
            // isHOD=true layered on top, so the old `role !== 'employee'`
            // check incorrectly hid the button for HODs even though the
            // backend's requireAnalyticsAccess gate accepts them.  Mirror
            // the backend predicate exactly so frontend visibility and
            // backend authorization stay in lock-step:
            //     HR | Super Admin | any isHOD user
            // Plain employees (no isHOD flag) still don't see the button.
            canExport={user?.role === 'hr' || user?.role === 'super_admin' || !!user?.isHOD}
          />
      )}

      {drill && (
        <DrillDownModal metricId={drill.metricId} title={drill.title} onClose={() => setDrill(null)}>
          <Breakdown metricId={drill.metricId} mode={mode} data={data} navigate={navigate} onClose={() => setDrill(null)} />
        </DrillDownModal>
      )}
      {/* Phase 25 -- calling-specific drill-down modal */}
      {callingDrill && data && (
        <DrillDownModal metricId={callingDrill.metricId} title={callingDrill.title} onClose={() => setCallingDrill(null)}>
          <CallingBreakdown
            metricId={callingDrill.metricId}
            extra={callingDrill.extra}
            data={data}
            onClose={() => setCallingDrill(null)}
          />
        </DrillDownModal>
      )}
    </div>
  );
}

/* ------------------------------- PENDENCY ------------------------------- */
function PendencyMode({ data, onDrill }) {
  const c = data.cards; const ch = data.charts; const dep = data.dependency;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <ClickableCard onClick={() => onDrill('avgPendencyRate')}><StatCard label="Avg Pendency Rate" value={`${c.avgPendencyRate}%`} accent={rateAccent(c.avgPendencyRate)} sub={`${c.totalPendingTasks} pending`} /></ClickableCard>
        <ClickableCard onClick={() => onDrill('totalPendingTasks')}><StatCard label="Total Pending Tasks" value={c.totalPendingTasks} accent="red" /></ClickableCard>
        <ClickableCard onClick={() => onDrill('dependencyBlocked')}><StatCard label="Dependency Blocked" value={c.dependencyBlockedTasks} accent="amber" /></ClickableCard>
        <ClickableCard onClick={() => onDrill('resolvedVsUnresolved')}><StatCard label="Resolved / Unresolved" value={`${c.resolvedVsUnresolved.resolved} / ${c.resolvedVsUnresolved.unresolved}`} accent="blue" /></ClickableCard>
        <ClickableCard onClick={() => onDrill('mostPendingDepartment')}><StatCard label="Most Pending Dept" value={c.mostPendingDepartment || '—'} accent="red" /></ClickableCard>
        <ClickableCard onClick={() => onDrill('mostDelayedEmployee')}><StatCard label="Most Delayed Employee" value={c.mostDelayedEmployee?.name || '—'} accent="amber" sub={c.mostDelayedEmployee ? `${c.mostDelayedEmployee.days}d waiting` : ''} /></ClickableCard>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Pendency Trend" subtitle={`${data.range.from} → ${data.range.to}`} onClick={() => onDrill('pendencyTrend')}>
          <AreaChart data={ch.pendencyTrend}>
            <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={RED} stopOpacity={0.5} /><stop offset="95%" stopColor={RED} stopOpacity={0.05} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="date" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} /><Tooltip />
            <Area type="monotone" dataKey="pending" stroke={RED} fill="url(#pg)" strokeWidth={2} />
          </AreaChart>
        </ChartCard>
        <ChartCard title="Department Pendency" subtitle="Pending units by department" onClick={() => onDrill('mostPendingDepartment')}>
          <BarChart data={ch.byDepartment}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={56} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} /><Tooltip /><Bar dataKey="pending" fill={ORANGE} radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Employee Pendency Ranking" onClick={() => onDrill('totalPendingTasks')}>
          <BarChart data={(ch.topUnresolvedEmployees || []).map((e) => ({ name: e.name, pending: e.pending }))} layout="vertical" margin={{ left: 20 }}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} /><YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={110} /><Tooltip /><Bar dataKey="pending" fill={RED} radius={[0, 4, 4, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="Dependency Bottlenecks" onClick={() => onDrill('dependencyBlocked')}>
          <BarChart data={(dep.mostBlockedEmployees || []).map((e) => ({ name: e.name, open: e.openCount }))}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={56} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} /><Tooltip /><Bar dataKey="open" fill={AMBER} radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <ChartCard title="Pending Aging" onClick={() => onDrill('totalPendingTasks')}>
          <BarChart data={ch.aging}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="bucket" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} /><Tooltip /><Bar dataKey="count" radius={[4, 4, 0, 0]}>{ch.aging.map((a) => <Cell key={a.bucket} fill={AGING_COLORS[a.bucket] || SLATE} />)}</Bar></BarChart>
        </ChartCard>
        <ChartCard title="Resolved vs Unresolved" onClick={() => onDrill('resolvedVsUnresolved')}>
          <PieChart><Pie data={[{ name: 'Resolved', value: c.resolvedVsUnresolved.resolved }, { name: 'Unresolved', value: c.resolvedVsUnresolved.unresolved }]} dataKey="value" nameKey="name" outerRadius={90} label><Cell fill={GREEN} /><Cell fill={RED} /></Pie><Legend /><Tooltip /></PieChart>
        </ChartCard>
        <ChartCard title="Weekly vs Monthly Pendency" onClick={() => onDrill('totalPendingTasks')}>
          <BarChart data={ch.weeklyVsMonthly}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="frequency" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} /><Tooltip /><Bar dataKey="pending" fill={VIOLET} radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
      </div>

      {/* Dependency analytics
          Phase 23.4: all four cards are clickable and open a drill-down
          modal with the related dependency records (Task / Shared By /
          Assigned To / Transfer Date / Resolved Date / Status).
          The "Longest Chain" card was replaced with "Dependent Work"
          (totalTransferred / totalResolved / resolution %). */}
      <div className="card card-body">
        <h2 className="text-sm font-semibold text-slate-800 mb-3">Dependency Analytics</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <ClickableCard onClick={() => onDrill('avgResolutionTime', 'Average Resolution Time')}>
            <div className="rounded-xl p-3 border bg-indigo-50 border-indigo-100 dark:bg-indigo-500/15 dark:border-indigo-500/30">
              <div className="text-[10px] font-bold text-indigo-700 dark:text-indigo-300">AVG RESOLUTION TIME</div>
              <div className="text-2xl font-bold mt-1">{dep.avgResolutionHours}h</div>
            </div>
          </ClickableCard>
          <ClickableCard onClick={() => onDrill('collaborativeCompletion', 'Collaborative Completion')}>
            <div className="rounded-xl p-3 border bg-green-50 border-green-100 dark:bg-green-500/15 dark:border-green-500/30">
              <div className="text-[10px] font-bold text-green-700 dark:text-green-300">COLLABORATIVE COMPLETION</div>
              <div className="text-2xl font-bold mt-1">{dep.collaborativeCompletionPct}%</div>
            </div>
          </ClickableCard>
          <ClickableCard onClick={() => onDrill('dependentWork', 'Dependent Work')}>
            <div className="rounded-xl p-3 border bg-orange-50 border-orange-100 dark:bg-orange-500/15 dark:border-orange-500/30">
              <div className="text-[10px] font-bold text-orange-700 dark:text-orange-300">DEPENDENT WORK</div>
              <div className="text-xl font-bold mt-1 leading-tight">
                {dep.dependentWork?.totalTransferred ?? dep.totalDependencies ?? 0}
                <span className="text-sm font-medium text-slate-500"> transferred</span>
              </div>
              <div className="text-[11px] text-slate-600 dark:text-slate-300">
                {dep.dependentWork?.totalResolved ?? dep.resolvedDependencies ?? 0} resolved
                <span className="text-slate-400"> · </span>
                {dep.dependentWork?.resolutionPct ?? dep.collaborativeCompletionPct ?? 0}% resolution
              </div>
            </div>
          </ClickableCard>
          <ClickableCard onClick={() => onDrill('openDependencies', 'Open Dependencies')}>
            <div className="rounded-xl p-3 border bg-red-50 border-red-100 dark:bg-red-500/15 dark:border-red-500/30">
              <div className="text-[10px] font-bold text-red-700 dark:text-red-300">OPEN DEPENDENCIES</div>
              <div className="text-2xl font-bold mt-1">{dep.openDependencies}</div>
            </div>
          </ClickableCard>
        </div>
      </div>

      <EmployeeRankTable rows={data.employeeRows} mode="pendency" onDrill={onDrill} />
    </>
  );
}

/* ------------------------------ COMPLETION ------------------------------ */
function CompletionMode({ data, onDrill }) {
  const c = data.cards; const ch = data.charts;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <ClickableCard onClick={() => onDrill('avgCompletionScore')}><StatCard label="Avg Completion Score" value={`${c.avgCompletionScore}%`} accent={scoreAccent(c.avgCompletionScore)} /></ClickableCard>
        <ClickableCard onClick={() => onDrill('avgQualityRating')}><StatCard label="Avg Quality Rating" value={`${c.avgQualityRating}%`} accent={scoreAccent(c.avgQualityRating)} /></ClickableCard>
        <ClickableCard onClick={() => onDrill('mostConsistentEmployee')}><StatCard label="Most Consistent" value={c.mostConsistentEmployee?.name || '—'} accent="green" sub={c.mostConsistentEmployee ? `${c.mostConsistentEmployee.consistency}% steady` : ''} /></ClickableCard>
        <ClickableCard onClick={() => onDrill('highestScoringDepartment')}><StatCard label="Highest Scoring Dept" value={c.highestScoringDepartment?.name || '—'} accent="blue" sub={c.highestScoringDepartment ? `${c.highestScoringDepartment.score}%` : ''} /></ClickableCard>
        <ClickableCard onClick={() => onDrill('fastestResolver')}><StatCard label="Fastest Resolver" value={c.fastestResolver?.name || '—'} accent="green" sub={c.fastestResolver ? `${c.fastestResolver.avgHours}h avg` : ''} /></ClickableCard>
        <ClickableCard onClick={() => onDrill('mostCollaborativeEmployee')}><StatCard label="Most Collaborative" value={c.mostCollaborativeEmployee?.name || '—'} accent="blue" sub={c.mostCollaborativeEmployee ? `${c.mostCollaborativeEmployee.interactions} interactions` : ''} /></ClickableCard>
        <ClickableCard onClick={() => onDrill('onTimeSubmissionRate')}><StatCard label="On-time Rate" value={`${c.onTimeSubmissionRate}%`} accent={scoreAccent(c.onTimeSubmissionRate)} /></ClickableCard>
        <ClickableCard onClick={() => onDrill('avgReviewMarks')}><StatCard label="Avg Review Marks" value={c.avgReviewMarks} accent="brand" /></ClickableCard>
        <ClickableCard onClick={() => onDrill('avgDisciplineScore')}><StatCard label="Avg Discipline" value={`${c.avgDisciplineScore}%`} accent={scoreAccent(c.avgDisciplineScore)} /></ClickableCard>
        <ClickableCard onClick={() => onDrill('reviewApprovalRate')}><StatCard label="Review Approval Rate" value={`${c.reviewApprovalRate}%`} accent="amber" /></ClickableCard>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Completion Trend" subtitle={`${data.range.from} → ${data.range.to}`} onClick={() => onDrill('completionTrend')}>
          <AreaChart data={ch.completionTrend}>
            <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={GREEN} stopOpacity={0.5} /><stop offset="95%" stopColor={GREEN} stopOpacity={0.05} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="date" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 11 }} domain={[0, 100]} /><Tooltip formatter={(v) => `${v}%`} />
            <Area type="monotone" dataKey="score" stroke="#16a34a" fill="url(#cg)" strokeWidth={2} />
          </AreaChart>
        </ChartCard>
        <ChartCard title="Marks Distribution" subtitle="Submissions by score band" onClick={() => onDrill('avgCompletionScore')}>
          <BarChart data={ch.marksDistribution}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="bucket" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} /><Tooltip /><Bar dataKey="count" fill={BLUE} radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Department-wise Completion" onClick={() => onDrill('highestScoringDepartment')}>
          <BarChart data={ch.byDepartment}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={56} /><YAxis tick={{ fontSize: 11 }} domain={[0, 100]} /><Tooltip formatter={(v) => `${v}%`} /><Bar dataKey="score" fill={BLUE} radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="Top Performers" onClick={() => onDrill('avgCompletionScore')}>
          <BarChart data={(ch.topPerformers || []).map((e) => ({ name: e.name, score: e.score }))} layout="vertical" margin={{ left: 20 }}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis type="number" tick={{ fontSize: 11 }} domain={[0, 100]} /><YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={110} /><Tooltip formatter={(v) => `${v}%`} /><Bar dataKey="score" fill={GREEN} radius={[0, 4, 4, 0]} /></BarChart>
        </ChartCard>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <ChartCard title="On-time vs Late" onClick={() => onDrill('onTimeSubmissionRate')}>
          <PieChart><Pie data={ch.onTimeVsLate} dataKey="value" nameKey="name" outerRadius={90} label><Cell fill={GREEN} /><Cell fill={RED} /></Pie><Legend /><Tooltip /></PieChart>
        </ChartCard>
        <ChartCard title="Weekly vs Monthly Completion" onClick={() => onDrill('avgCompletionScore')}>
          <BarChart data={ch.weeklyVsMonthly}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="frequency" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 11 }} domain={[0, 100]} /><Tooltip formatter={(v) => `${v}%`} /><Bar dataKey="score" fill={VIOLET} radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="Quality vs Speed Matrix" subtitle="Score vs on-time %" onClick={() => onDrill('avgCompletionScore')}>
          <ScatterChart><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis type="number" dataKey="speed" name="On-time %" tick={{ fontSize: 10 }} domain={[0, 100]} /><YAxis type="number" dataKey="quality" name="Score %" tick={{ fontSize: 10 }} domain={[0, 100]} /><ZAxis range={[60, 60]} /><Tooltip cursor={{ strokeDasharray: '3 3' }} /><Scatter data={ch.qualityVsSpeed} fill={BLUE} /></ScatterChart>
        </ChartCard>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Reviewer Score Distribution" onClick={() => onDrill('avgReviewMarks')}>
          <BarChart data={(ch.reviewerScores || []).map((r) => ({ name: r.name, score: r.avgScore }))}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={56} /><YAxis tick={{ fontSize: 11 }} domain={[0, 100]} /><Tooltip formatter={(v) => `${v}%`} /><Bar dataKey="score" fill={AMBER} radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="Dependency Resolution Performance" subtitle="Avg hours to resolve (lower = faster)" onClick={() => onDrill('fastestResolver')}>
          <BarChart data={(ch.resolverPerformance || []).map((r) => ({ name: r.name, hours: r.avgHours }))}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={56} /><YAxis tick={{ fontSize: 11 }} /><Tooltip formatter={(v) => `${v}h`} /><Bar dataKey="hours" fill={GREEN} radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
      </div>

      <EmployeeRankTable rows={data.employeeRows} mode="completion" onDrill={onDrill} />
    </>
  );
}

/* ------------------------- Shared ranking table ------------------------- */
function EmployeeRankTable({ rows = [], mode, onDrill }) {
  const navigate = useNavigate();
  return (
    <div className="card overflow-x-auto">
      <div className="px-4 pt-3 text-sm font-semibold text-slate-800">Employee Breakdown ({rows.length})</div>
      <table className="table mt-2">
        <thead><tr>
          <th>Employee</th><th>Department</th>
          {mode === 'pendency'
            ? <><th>Pending</th><th>Done</th><th>Pendency %</th><th>Oldest</th></>
            : <><th>Score %</th><th>Submissions</th><th>Consistency</th><th>On-time %</th></>}
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={6} className="text-center text-slate-400 py-6 text-sm">No data for this period.</td></tr>}
          {rows.map((r) => (
            <tr key={r._id || r.employeeId + r.name} className="cursor-pointer hover:bg-slate-50" onClick={() => r._id && navigate(`/employees/${r._id}`)} title="Open employee profile">
              <td className="font-medium text-slate-800">{r.name}</td>
              <td>{r.department}</td>
              {mode === 'pendency'
                ? <>
                    <td className={r.pending > 0 ? 'text-red-600 font-semibold' : ''}>{r.pending}</td>
                    <td>{r.done}</td>
                    <td><span className={r.pendencyRate >= 50 ? 'text-red-600 font-semibold' : r.pendencyRate >= 25 ? 'text-orange-600' : 'text-green-600'}>{r.pendencyRate}%</span></td>
                    <td>{r.oldestPendingDays > 0 ? `${r.oldestPendingDays}d` : '—'}</td>
                  </>
                : <>
                    <td><span className={r.score >= 80 ? 'text-green-600 font-semibold' : r.score >= 60 ? 'text-amber-600' : 'text-red-600'}>{r.score}%</span></td>
                    <td>{r.submissions}</td>
                    <td>{r.consistency}%</td>
                    <td>{r.onTimeRate}%</td>
                  </>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------- Drill breakdown --------------------------- */
function Breakdown({ metricId, mode, data, navigate, onClose }) {
  const go = (path) => { onClose(); navigate(path); };
  const rows = data.employeeRows || [];

  // Department breakdown
  if (metricId === 'mostPendingDepartment' || metricId === 'highestScoringDepartment') {
    const depRows = data.charts.byDepartment || [];
    return (
      <div className="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Department</th><th>{mode === 'pendency' ? 'Pending' : 'Score %'}</th>{mode === 'pendency' && <><th>Done</th><th>Pendency %</th></>}</tr></thead>
          <tbody>
            {depRows.map((d) => (
              <tr key={d.name}><td className="font-medium">{d.name}</td>
                {mode === 'pendency' ? <><td className="text-red-600">{d.pending}</td><td>{d.done}</td><td>{d.pendencyRate}%</td></> : <td>{d.score}%</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Dependency-focused breakdowns
  if (metricId === 'dependencyBlocked' || metricId === 'fastestResolver' || metricId === 'resolvedVsUnresolved') {
    const dep = data.dependency || {};
    const list = metricId === 'fastestResolver' ? (data.charts.resolverPerformance || data.dependency?.mostBlockedEmployees || []) : (dep.mostBlockedEmployees || []);
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">Open dependency hand-offs by current owner. Open the Dependencies view to inspect chains, remarks and timestamps.</div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Person</th><th>{metricId === 'fastestResolver' ? 'Avg hours' : 'Open'}</th></tr></thead>
            <tbody>
              {list.map((e) => <tr key={e.name}><td className="font-medium">{e.name}</td><td>{e.avgHours != null ? `${e.avgHours}h` : e.openCount}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Phase 23.4 -- Dependency Analytics drill-downs.
  // Every card uses the same per-record table below; the only thing
  // that changes is the row filter and the small metric summary above.
  if (metricId === 'dependentWork' || metricId === 'avgResolutionTime'
      || metricId === 'collaborativeCompletion' || metricId === 'openDependencies') {
    const dep = data.dependency || {};
    const records = dep.dependentWork?.records || [];
    const filtered = metricId === 'openDependencies'
      ? records.filter((r) => r.status !== 'resolved')
      : metricId === 'avgResolutionTime' || metricId === 'collaborativeCompletion'
        ? records.filter((r) => r.status === 'resolved')
        : records;
    const fmt = (d) => d ? new Date(d).toLocaleString() : '—';
    const STATUS_PILL = {
      open:        { label: 'Pending',     cls: 'bg-amber-50 text-amber-700 border-amber-200' },
      in_progress: { label: 'In Progress', cls: 'bg-blue-50  text-blue-700  border-blue-200' },
      resolved:    { label: 'Resolved',    cls: 'bg-green-50 text-green-700 border-green-200' },
    };
    return (
      <div className="space-y-3">
        {/* Headline summary -- different per card */}
        {metricId === 'dependentWork' && (
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-[10px] uppercase text-slate-500">Total Transferred</div>
              <div className="text-xl font-bold">{dep.dependentWork?.totalTransferred ?? 0}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-[10px] uppercase text-slate-500">Total Resolved</div>
              <div className="text-xl font-bold">{dep.dependentWork?.totalResolved ?? 0}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-[10px] uppercase text-slate-500">Resolution %</div>
              <div className="text-xl font-bold">{dep.dependentWork?.resolutionPct ?? 0}%</div>
            </div>
          </div>
        )}
        {metricId === 'avgResolutionTime' && (
          <div className="text-sm text-slate-600">
            Average wall-clock turnaround across <b>{dep.resolvedDependencies ?? 0}</b> resolved hand-offs:
            {' '}<b>{dep.avgResolutionHours ?? 0}h</b>.
          </div>
        )}
        {metricId === 'collaborativeCompletion' && (
          <div className="text-sm text-slate-600">
            <b>{dep.resolvedDependencies ?? 0}</b> of <b>{dep.totalDependencies ?? 0}</b> transferred tasks closed
            ({dep.collaborativeCompletionPct ?? 0}%).
          </div>
        )}
        {metricId === 'openDependencies' && (
          <div className="text-sm text-slate-600">
            <b>{dep.openDependencies ?? 0}</b> dependent tasks currently open or in progress.
          </div>
        )}
        {/* Per-record table */}
        <div className="overflow-x-auto max-h-96">
          {filtered.length === 0 ? (
            <div className="text-sm text-slate-400 italic">No dependency records in this view.</div>
          ) : (
            <table className="table">
              <thead><tr>
                <th>Task</th>
                <th>Shared By</th>
                <th>Assigned To</th>
                <th>Transfer Date</th>
                <th>Resolved Date</th>
                <th>Status</th>
              </tr></thead>
              <tbody>
                {filtered.map((r) => {
                  const pill = STATUS_PILL[r.status] || { label: r.status, cls: 'bg-slate-50 text-slate-700 border-slate-200' };
                  return (
                    <tr key={r._id}>
                      <td className="font-medium text-slate-800">{r.taskName || '—'}{r.templateTitle ? <div className="text-[11px] text-slate-500">{r.templateTitle}</div> : null}</td>
                      <td>{r.sharedBy || '—'}{r.sharedById ? <span className="text-[11px] text-slate-500"> · {r.sharedById}</span> : null}</td>
                      <td>{r.assignedTo || '—'}{r.assignedToId ? <span className="text-[11px] text-slate-500"> · {r.assignedToId}</span> : null}</td>
                      <td>{fmt(r.transferDate)}</td>
                      <td>{fmt(r.resolvedDate)}</td>
                      <td><span className={`badge border ${pill.cls}`}>{pill.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Trend breakdowns
  if (metricId === 'pendencyTrend' || metricId === 'completionTrend') {
    const series = metricId === 'pendencyTrend' ? data.charts.pendencyTrend : data.charts.completionTrend;
    const valKey = metricId === 'pendencyTrend' ? 'pending' : 'score';
    return (
      <div className="overflow-x-auto max-h-80">
        <table className="table"><thead><tr><th>Date</th><th>{metricId === 'pendencyTrend' ? 'Pending units' : 'Avg score %'}</th></tr></thead>
          <tbody>{series.map((p) => <tr key={p.date}><td>{p.date}</td><td>{p[valKey]}{valKey === 'score' ? '%' : ''}</td></tr>)}</tbody>
        </table>
      </div>
    );
  }

  // Default: employee ranking with navigation to profile
  const isPend = mode === 'pendency';
  const sorted = [...rows].sort((a, b) => isPend ? (b.pending - a.pending) : (b.score - a.score));
  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500">Click a row to open the employee's profile for the full timeline, attendance, leave and work history.</div>
      <div className="overflow-x-auto max-h-96">
        <table className="table">
          <thead><tr><th>Employee</th><th>Department</th>{isPend ? <><th>Pending</th><th>Pendency %</th><th>Oldest</th></> : <><th>Score %</th><th>On-time %</th><th>Consistency</th></>}</tr></thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r._id || r.employeeId + r.name} className="cursor-pointer hover:bg-slate-50" onClick={() => r._id && go(`/employees/${r._id}`)}>
                <td className="font-medium text-brand-700">{r.name}</td><td>{r.department}</td>
                {isPend ? <><td className="text-red-600">{r.pending}</td><td>{r.pendencyRate}%</td><td>{r.oldestPendingDays > 0 ? `${r.oldestPendingDays}d` : '—'}</td></>
                  : <><td>{r.score}%</td><td>{r.onTimeRate}%</td><td>{r.consistency}%</td></>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ===================================================================== */
/* CALLING ANALYTICS                                                     */
/*                                                                       */
/* Reads /dashboard/calling/analytics (role-scoped at the controller --   */
/* HR / SA see everything they're allowed to filter; HOD is auto-scoped  */
/* to their own department).                                              */
/*                                                                       */
/* Renders:                                                              */
/*   - 8 KPI cards (assigned, completed, attended, unattended,           */
/*     conversions + old/new, total pending)                              */
/*   - Rate-strip (connection / conversion / pending / completion %)     */
/*   - Six "Top callers by ..." leaderboards                              */
/*   - Three "Bottom performers" leaderboards                             */
/*   - Daily trend chart (calls / conversions / pending)                  */
/*   - Per-employee summary table                                         */
/* ===================================================================== */
function CallingMode({ data, exportParams = {}, canExport = false, onDrill = () => {} }) {
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  // Phase 24 -- download xlsx of the same on-screen dataset.  Uses an
  // axios responseType=blob fetch so the browser saves the file
  // directly without ever rendering the binary to the page.  Filename
  // is taken from Content-Disposition, with a sensible fallback.
  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const resp = await api.get('/dashboard/calling/analytics/export', {
        params: exportParams,
        responseType: 'blob',
      });
      const cd = resp.headers?.['content-disposition'] || '';
      const match = /filename="?([^";]+)"?/i.exec(cd);
      const filename = match ? match[1] : 'calling-analytics.xlsx';
      const url = window.URL.createObjectURL(new Blob([resp.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Calling Analytics exported');
    } catch (err) {
      // Blob 403 / 4xx still wraps the JSON error message but as a Blob
      // -- decode it before showing the toast so HR sees the real reason.
      let msg = errMsg(err);
      try {
        if (err?.response?.data instanceof Blob) {
          const text = await err.response.data.text();
          const parsed = JSON.parse(text);
          msg = parsed?.message || msg;
        }
      } catch (_) { /* keep the generic message */ }
      toast.error(msg);
    } finally {
      setExporting(false);
    }
  };

  const k = data.kpis || {};
  const lb = data.leaderboards || {};
  const trend = data.trend || [];
  const employees = data.employees || [];
  // Product & Farmer extension payload (only present when the backend
  // has product/farmer submissions in range; otherwise renders nothing).
  const pk = data.productKpis || {};
  const fk = data.farmerKpis || {};
  const cm = data.combinedMetrics || {};
  const pLb = data.productEmployeeLeaderboards || {};
  const productsTable = data.productsTable || [];
  const employeesPF   = data.employeesPF || [];
  // Dealer Analytics payload (Phase 2.6) -- always rendered, empty
  // state fires when there's no dealer-linked data in range.
  const dk        = data.dealerKpis || {};
  const dLb       = data.dealerLeaderboards || {};
  const dealers   = data.dealersTable || [];
  const dTrend    = data.dealerTrend || [];
  // Section is ALWAYS rendered so HR sees the structure on day one --
  // empty states + zero values are shown when there's no data yet,
  // not the section itself hidden.
  const pfTotalSales    = pk.totalSalesValue   || 0;
  const pfTotalProducts = pk.totalProductsSold || 0;
  const pfTotalFarmers  = fk.totalFarmersAdded || 0;
  const hasPF = pfTotalProducts > 0 || pfTotalFarmers > 0;

  return (
    <div className="space-y-6">
      {/* Phase 24 -- Export Report button.  Sits above the KPI strip so
          it's visible the moment Calling Analytics opens.  Hidden for
          plain employees (defensive -- they don't reach this page) and
          available to HR / SA / HOD.  The HOD's scope is enforced
          server-side by the same controller logic the JSON endpoint
          uses, so no extra access checks are needed here. */}
      {canExport && (
        <div className="flex justify-end">
          <button
            className="btn-primary"
            onClick={handleExport}
            disabled={exporting}
            title="Download the Calling Analytics dataset for the selected date range as an .xlsx file"
          >
            {exporting ? 'Exporting…' : '⬇ Export Report'}
          </button>
        </div>
      )}

      {/* Phase 25: every KPI card is now clickable.  ClickableCard adds
          cursor-pointer + hover affordance; the metric id routes to the
          calling-specific Breakdown function which projects appropriate
          columns from data.detailRows / data.employees / data.leaderboards. */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <ClickableCard onClick={() => onDrill('callAssigned', 'Assigned Calls')}>
          <StatCard label="Total Assigned Calls"     value={k.totalAssignedCalls   ?? 0} accent="brand" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callCompleted', 'Calls Completed')}>
          <StatCard label="Total Calls Completed"    value={k.totalCallsCompleted  ?? 0} accent="green" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callDialed', 'Dialed Calls')}>
          <StatCard label="Total Dialed Calls"       value={k.totalDialedCalls     ?? 0} accent="blue"
                    sub={k.totalAssignedCalls > 0 ? `vs ${k.totalAssignedCalls} assigned` : ''} />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callDialed', 'Avg Dialed / Employee')}>
          <StatCard label="Avg Dialed / Employee"    value={fmtAvg(k.averageDialedPerEmployee ?? 0)} accent="blue" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callAttended', 'Attended Calls')}>
          <StatCard label="Total Attended Calls"     value={k.totalAttendedCalls   ?? 0} accent="blue" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callUnattended', 'Unattended Calls')}>
          <StatCard label="Total Unattended Calls"   value={k.totalUnattendedCalls ?? 0} accent="amber" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callConversions', 'Conversions')}>
          <StatCard label="Total Conversions"        value={k.totalConversions     ?? 0} accent="green" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callConversions', 'Old Customer Conversions')}>
          <StatCard label="Old Customer Conversions" value={k.oldConversions       ?? 0} accent="blue" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callConversions', 'New Customer Conversions')}>
          <StatCard label="New Customer Conversions" value={k.newConversions       ?? 0} accent="green" />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callPending', 'Total Pending Calls')}>
          <StatCard label="Total Pending Calls"      value={k.totalPendingCalls    ?? 0} accent="red" />
        </ClickableCard>
      </div>

      {/* Rate strip — same clickable treatment.  Rate drill-downs route to
          an employee-ranked breakdown rather than per-day detail. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <ClickableCard onClick={() => onDrill('callConnectionRate', 'Connection Rate')}>
          <StatCard label="Connection Rate"      value={fmtPct(k.connectionRate     ?? 0)} accent={(k.connectionRate     || 0) >= 60 ? 'green' : 'amber'} />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callConversionRate', 'Conversion Rate')}>
          <StatCard label="Conversion Rate"      value={fmtPct(k.conversionRate     ?? 0)} accent={(k.conversionRate     || 0) >= 20 ? 'green' : 'amber'} />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callPendingRate', 'Pending Rate')}>
          <StatCard label="Pending Rate"         value={fmtPct(k.pendingRate        ?? 0)} accent={(k.pendingRate        || 0) <= 20 ? 'green' : 'red'} />
        </ClickableCard>
        <ClickableCard onClick={() => onDrill('callCompletionRate', 'Call Completion Rate')}>
          <StatCard label="Call Completion Rate" value={fmtPct(k.callCompletionRate ?? 0)} accent={(k.callCompletionRate || 0) >= 80 ? 'green' : 'amber'} />
        </ClickableCard>
      </div>

      {/* Daily trend chart -- assigned vs dialed vs completed/attended/conv/pending */}
      <ChartCard title="Daily Trend" subtitle="Assigned vs Dialed vs Completed plus connection / conversion / pending per day">
        <AreaChart data={trend}>
          <CartesianGrid stroke="#eef2f7" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Area type="monotone" dataKey="assigned"    stroke={BLUE}   fill={BLUE}   fillOpacity={0.18} name="Assigned" />
          <Area type="monotone" dataKey="dialed"      stroke={ORANGE} fill={ORANGE} fillOpacity={0.18} name="Dialed (attempts)" />
          <Area type="monotone" dataKey="completed"   stroke={GREEN}  fill={GREEN}  fillOpacity={0.18} name="Completed" />
          <Area type="monotone" dataKey="attended"    stroke={VIOLET} fill={VIOLET} fillOpacity={0.0}  name="Attended" />
          <Area type="monotone" dataKey="conversions" stroke={AMBER}  fill={AMBER}  fillOpacity={0.0}  name="Conversions" />
          <Area type="monotone" dataKey="pending"     stroke={RED}    fill={RED}    fillOpacity={0.0}  name="Pending" />
        </AreaChart>
      </ChartCard>

      {/* Six "Top" leaderboards -- each clickable to expand into the full
          ranking (not just top 5).  The leaderboardId carried in `extra`
          tells CallingBreakdown which sort key + direction + value-suffix
          to apply when rebuilding from data.employees. */}
      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Top Callers</div>
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          <LeaderboardCard onDrill={onDrill} drillId="topCallsCompleted" title="By Calls Completed"   rows={lb.topCallsCompleted}   metric="totalCallsCompleted" suffix="" />
          <LeaderboardCard onDrill={onDrill} drillId="topDialedCalls"    title="By Dialed Calls"      rows={lb.topDialedCalls}      metric="dialedCalls"         suffix="" />
          <LeaderboardCard onDrill={onDrill} drillId="topConversionRate" title="By Conversion Rate"   rows={lb.topConversionRate}   metric="conversionRate"      suffix="%" />
          <LeaderboardCard onDrill={onDrill} drillId="topNewCustomers"   title="By New Customers"     rows={lb.topNewCustomers}     metric="newConversions"      suffix="" />
          <LeaderboardCard onDrill={onDrill} drillId="topTotalConversions" title="By Total Conversions" rows={lb.topTotalConversions} metric="totalConversions" suffix="" />
          <LeaderboardCard onDrill={onDrill} drillId="lowestPending"     title="Lowest Pending Calls" rows={lb.lowestPending}       metric="totalPending"        suffix="" accent="green" />
          <LeaderboardCard onDrill={onDrill} drillId="bestConnectionRate" title="Best Connection Rate" rows={lb.bestConnectionRate} metric="connectionRate"      suffix="%" />
        </div>
      </div>

      {/* Three "Bottom" leaderboards -- same clickable treatment. */}
      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Needs Attention</div>
        <div className="grid md:grid-cols-3 gap-4">
          <LeaderboardCard onDrill={onDrill} drillId="bottomHighestPending"    title="Highest Pending"       rows={lb.bottomHighestPending}    metric="totalPending"        suffix=""  accent="red" />
          <LeaderboardCard onDrill={onDrill} drillId="bottomLowestConversion"  title="Lowest Conversion"     rows={lb.bottomLowestConversion}  metric="conversionRate"      suffix="%" accent="red" />
          <LeaderboardCard onDrill={onDrill} drillId="bottomLowestCompletion"  title="Lowest Call Completion" rows={lb.bottomLowestCompletion} metric="callCompletionRate" suffix="%" accent="red" />
        </div>
      </div>

      {/* =============================================================
            PRODUCT & FARMER section (additive -- ALWAYS rendered so HR
            sees the structure on day one; empty states fire when there
            are no product / farmer submissions yet).  The existing
            Calling KPIs above this block are untouched.
          ============================================================= */}
      {true && (
        <div className="space-y-4 pt-4">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-800">Product &amp; Farmer Report</h2>
            <span className="badge bg-indigo-50 text-indigo-700">Custom Assignment</span>
            {!hasPF && <span className="text-[11px] text-slate-500">— no submissions in range yet</span>}
          </div>
          {/* Product / Farmer headline KPIs -- all clickable (Phase 25.1) */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <ClickableCard onClick={() => onDrill('pfTotalProducts', 'Total Products Sold')}>
              <StatCard label="Total Products Sold"  value={pk.totalProductsSold ?? 0} accent="brand" />
            </ClickableCard>
            <ClickableCard onClick={() => onDrill('pfTotalQuantity', 'Total Quantity Sold')}>
              <StatCard label="Total Quantity Sold"  value={fmtAvg(pk.totalQuantitySold ?? 0)} accent="blue" sub="L / KG (canonical)" />
            </ClickableCard>
            <ClickableCard onClick={() => onDrill('pfTotalSales', 'Total Sales Value')}>
              <StatCard label="Total Sales Value"    value={fmtCurrency(pk.totalSalesValue ?? 0)} accent="green" />
            </ClickableCard>
            <ClickableCard onClick={() => onDrill('pfTotalNbv', 'Total NBV Value')}>
              <StatCard label="Total NBV Value"      value={fmtCurrency(pk.totalNbvValue ?? 0)} accent="green" />
            </ClickableCard>
            <ClickableCard onClick={() => onDrill('pfTotalFarmers', 'Total Farmers Added')}>
              <StatCard label="Total Farmers Added"  value={fk.totalFarmersAdded ?? 0} accent="amber" />
            </ClickableCard>
            <ClickableCard onClick={() => onDrill('pfRevenuePerCall', 'Revenue / Call')}>
              <StatCard label="Revenue / Call"       value={fmtCurrency(cm.revenuePerCall ?? 0)} accent="blue" />
            </ClickableCard>
            <ClickableCard onClick={() => onDrill('pfNbvPerCall', 'NBV / Call')}>
              <StatCard label="NBV / Call"           value={fmtCurrency(cm.nbvPerCall ?? 0)} accent="blue" />
            </ClickableCard>
            <ClickableCard onClick={() => onDrill('pfFarmersPerEmployee', 'Farmers / Employee')}>
              <StatCard label="Farmers / Employee"   value={fmtAvg(cm.farmersPerEmployee ?? 0)} accent="amber" />
            </ClickableCard>
          </div>

          {/* Product & Farmer leaderboards -- clickable, drill into full ranking */}
          <div>
            <div className="text-sm font-semibold text-slate-800 mb-2">Top Employees — Product &amp; Farmer</div>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              <LeaderboardCard onDrill={onDrill} drillId="pfTopSales"    title="By Sales Value (₹)" rows={pLb.topSales || []}    metric="salesValue"   suffix="" extraKind="pfEmployeeLeaderboard" />
              <LeaderboardCard onDrill={onDrill} drillId="pfTopNbv"      title="By NBV Value (₹)"   rows={pLb.topNbv || []}      metric="nbvValue"     suffix="" extraKind="pfEmployeeLeaderboard" />
              <LeaderboardCard onDrill={onDrill} drillId="pfTopQuantity" title="By Quantity Sold"   rows={pLb.topQuantity || []} metric="quantitySold" suffix="" extraKind="pfEmployeeLeaderboard" />
              <LeaderboardCard onDrill={onDrill} drillId="pfTopProducts" title="By Products Sold"   rows={pLb.topProducts || []} metric="productsSold" suffix="" extraKind="pfEmployeeLeaderboard" />
              <LeaderboardCard onDrill={onDrill} drillId="pfTopFarmers"  title="By Farmers Added"   rows={pLb.topFarmers || []}  metric="farmersAdded" suffix="" extraKind="pfEmployeeLeaderboard" />
            </div>
          </div>

          {/* Product breakdown table -- each row clickable for product profile */}
          <div className="card overflow-x-auto">
            <div className="px-5 py-3 border-b border-slate-100 text-sm font-semibold text-slate-800">
              Per-Product Breakdown ({productsTable.length})
            </div>
            {productsTable.length === 0 ? (
              <div className="p-5"><EmptyState title="No product sales in range" /></div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="text-right">Rows</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Sales (₹)</th>
                    <th className="text-right">NBV (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {productsTable.map((p) => (
                    <tr
                      key={p.name}
                      className="cursor-pointer hover:bg-brand-50 dark:hover:bg-brand-500/10"
                      title={`Click to see who sold ${p.name}`}
                      onClick={() => onDrill('pfProduct', p.name, { productName: p.name })}
                    >
                      <td className="font-medium text-brand-700">{p.name}</td>
                      <td className="text-right">{p.rows}</td>
                      <td className="text-right">{p.qty}</td>
                      <td className="text-right font-semibold text-green-700">{p.sales}</td>
                      <td className="text-right">{p.nbv}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* =============================================================
                DEALER ANALYTICS (Phase 2.6 -- additive).  Always rendered;
                empty state fires when no farmer records reference Dealer
                Master yet.
              ============================================================= */}
          <div className="space-y-4 pt-2">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-slate-800">Dealer Analytics</h2>
              <span className="badge bg-indigo-50 text-indigo-700">Dealer Master</span>
              {dealers.length === 0 && <span className="text-[11px] text-slate-500">— no dealer-linked farmer records in range</span>}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <ClickableCard onClick={() => onDrill('dealerActive', 'Total Active Dealers')}>
                <StatCard label="Total Active Dealers"  value={dk.totalActiveDealers ?? 0} accent="brand" />
              </ClickableCard>
              <ClickableCard onClick={() => onDrill('dealerCovered', 'Dealers Covered')}>
                <StatCard label="Dealers Covered"       value={dk.dealersCovered ?? 0}     accent="blue" sub="have at least 1 farmer in range" />
              </ClickableCard>
              <ClickableCard onClick={() => onDrill('dealerWithSales', 'Dealers With Sales')}>
                <StatCard label="Dealers With Sales"    value={dk.dealersWithSales ?? 0}   accent="green" />
              </ClickableCard>
              <ClickableCard onClick={() => onDrill('dealerAvgSales', 'Avg Sales / Dealer')}>
                <StatCard label="Avg Sales / Dealer"    value={fmtCurrency(dk.avgSalesPerDealer ?? 0)} accent="amber" />
              </ClickableCard>
            </div>

            <div>
              <div className="text-sm font-semibold text-slate-800 mb-2">Top Dealers</div>
              <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
                {/* Leaderboard label = "Firm — Place" because the same   */}
                {/* firm can exist in multiple places (per Phase 3 spec). */}
                <LeaderboardCard onDrill={onDrill} drillId="dealerTopSales"    title="By Sales (₹)"
                  rows={(dLb.topSales    || []).map((d) => ({ _id: d._id, name: `${d.firmName || d.name || '—'}${d.place ? ` — ${d.place}` : ''}`, employeeId: d.dealerName || '', sales: d.sales }))}
                  metric="sales"   suffix="" extraKind="dealerLeaderboard" />
                <LeaderboardCard onDrill={onDrill} drillId="dealerTopQuantity" title="By Quantity"
                  rows={(dLb.topQuantity || []).map((d) => ({ _id: d._id, name: `${d.firmName || d.name || '—'}${d.place ? ` — ${d.place}` : ''}`, employeeId: d.dealerName || '', qty: d.qty }))}
                  metric="qty"     suffix="" extraKind="dealerLeaderboard" />
                <LeaderboardCard onDrill={onDrill} drillId="dealerTopNbv"      title="By NBV (₹)"
                  rows={(dLb.topNbv      || []).map((d) => ({ _id: d._id, name: `${d.firmName || d.name || '—'}${d.place ? ` — ${d.place}` : ''}`, employeeId: d.dealerName || '', nbv: d.nbv }))}
                  metric="nbv"     suffix="" extraKind="dealerLeaderboard" />
                <LeaderboardCard onDrill={onDrill} drillId="dealerTopFarmers"  title="By Farmers"
                  rows={(dLb.topFarmers  || []).map((d) => ({ _id: d._id, name: `${d.firmName || d.name || '—'}${d.place ? ` — ${d.place}` : ''}`, employeeId: d.dealerName || '', farmers: d.farmers }))}
                  metric="farmers" suffix="" extraKind="dealerLeaderboard" />
              </div>
            </div>

            <div className="card overflow-x-auto">
              <div className="px-5 py-3 border-b border-slate-100 text-sm font-semibold text-slate-800">
                Per-Dealer Breakdown ({dealers.length})
              </div>
              {dealers.length === 0 ? (
                <div className="p-5"><EmptyState title="No dealer records in range" subtitle="Use the Dealer dropdown on Farmer Records to feed this view." /></div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Firm Name</th>
                      <th>Place</th>
                      <th>Dealer Name</th>
                      <th className="text-right">Farmers</th>
                      <th className="text-right">Products</th>
                      <th className="text-right">Quantity</th>
                      <th className="text-right">Sales (₹)</th>
                      <th className="text-right">NBV (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dealers.map((d) => (
                      <tr
                        key={d._id}
                        className="cursor-pointer hover:bg-brand-50 dark:hover:bg-brand-500/10"
                        title="Open dealer profile"
                        onClick={() => onDrill('dealerProfile', d.firmName || d.name || 'Dealer profile', { dealerId: String(d._id) })}
                      >
                        <td className="font-medium text-brand-700">{d.firmName || d.name || '—'}</td>
                        <td>{d.place || <span className="text-slate-400">—</span>}</td>
                        <td>{d.dealerName || <span className="text-slate-400">—</span>}</td>
                        <td className="text-right">{d.farmers}</td>
                        <td className="text-right">{d.products}</td>
                        <td className="text-right">{d.qty}</td>
                        <td className="text-right font-semibold text-green-700">{d.sales}</td>
                        <td className="text-right">{d.nbv}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {dTrend.length > 0 && (
              <ChartCard title="Dealer Trend" subtitle="Org-wide totals across all dealers per day">
                <AreaChart data={dTrend}>
                  <CartesianGrid stroke="#eef2f7" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="sales"   stroke={GREEN}  fill={GREEN}  fillOpacity={0.18} name="Sales (₹)" />
                  <Area type="monotone" dataKey="nbv"     stroke={BLUE}   fill={BLUE}   fillOpacity={0.12} name="NBV (₹)" />
                  <Area type="monotone" dataKey="farmers" stroke={AMBER}  fill={AMBER}  fillOpacity={0.0}  name="Farmers" />
                </AreaChart>
              </ChartCard>
            )}
          </div>

          {/* Per-employee Product & Farmer summary */}
          <div className="card overflow-x-auto">
            <div className="px-5 py-3 border-b border-slate-100 text-sm font-semibold text-slate-800">
              Per-Employee Sales &amp; Farmer Summary ({employeesPF.length})
            </div>
            {employeesPF.length === 0 ? (
              <div className="p-5"><EmptyState title="No product / farmer submissions in range" /></div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Employee</th><th>Department</th>
                    <th className="text-right">Sales (₹)</th>
                    <th className="text-right">NBV (₹)</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Products</th>
                    <th className="text-right">Farmers</th>
                  </tr>
                </thead>
                <tbody>
                  {employeesPF.map((e) => (
                    <tr key={e._id}>
                      <td className="font-medium text-slate-800">{e.name}<div className="text-[11px] text-slate-500">{e.employeeId}</div></td>
                      <td>{e.department}</td>
                      <td className="text-right font-semibold text-green-700">{fmtCurrency(e.salesValue)}</td>
                      <td className="text-right">{fmtCurrency(e.nbvValue)}</td>
                      <td className="text-right">{fmtAvg(e.quantitySold)}</td>
                      <td className="text-right">{e.productsSold}</td>
                      <td className="text-right">{e.farmersAdded}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Per-employee summary table */}
      <div className="card overflow-x-auto">
        <div className="px-5 py-3 border-b border-slate-100 text-sm font-semibold text-slate-800">
          Per-Employee Summary ({employees.length})
        </div>
        {employees.length === 0
          ? <div className="p-5"><EmptyState title="No calling submissions in range" /></div>
          : (
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th><th>Department</th>
                  <th className="text-right">Assigned</th>
                  <th className="text-right">Completed</th>
                  <th className="text-right">Dialed</th>
                  <th className="text-right">Attended</th>
                  <th className="text-right">Conversions</th>
                  <th className="text-right">Pending</th>
                  <th className="text-right">Conn %</th>
                  <th className="text-right">Conv %</th>
                  <th className="text-right">Pend %</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((r) => (
                  <tr key={r._id}>
                    <td className="font-medium text-slate-800">{r.name}<div className="text-[11px] text-slate-500">{r.employeeId}</div></td>
                    <td>{r.department}</td>
                    <td className="text-right">{r.assignedCalls}</td>
                    <td className="text-right">{r.totalCallsCompleted}</td>
                    <td className="text-right">{r.dialedCalls || 0}</td>
                    <td className="text-right">{r.attendedCalls}</td>
                    <td className="text-right">{r.totalConversions}</td>
                    <td className={`text-right ${(r.totalPending || 0) > 0 ? 'text-red-600 font-semibold' : 'text-slate-400'}`}>{r.totalPending}</td>
                    <td className="text-right">{fmtPct(r.connectionRate)}</td>
                    <td className="text-right">{fmtPct(r.conversionRate)}</td>
                    <td className="text-right">{fmtPct(r.pendingRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}

/* =====================================================================
 * Phase 25 — Calling Leaderboard with drill-down
 *
 * Wraps the bare Leaderboard in a ClickableCard, adds a "View all" hint
 * row at the bottom, and routes clicks to the parent's onDrill handler
 * with a `extra` payload that carries the metric key + direction + suffix
 * so CallingBreakdown can rebuild the complete ranking (not just top 5)
 * from data.employees, applying the same filter the leaderboard used
 * (e.g. dialedCalls >= 1 for Best Connection Rate).
 * ===================================================================== */
function LeaderboardCard({ onDrill, drillId, title, rows = [], metric, suffix = '', accent, extraKind = 'callLeaderboard' }) {
  // Phase 25.1: `extraKind` lets the same wrapper drive three kinds of
  // leaderboards (calling, product-farmer employee, dealer) -- each
  // routes to a different branch of CallingBreakdown.
  return (
    <ClickableCard onClick={() => onDrill(extraKind, title, { leaderboardId: drillId, metric, suffix, accent, title })}>
      <Leaderboard title={title} rows={rows} metric={metric} suffix={suffix} accent={accent} showHint />
    </ClickableCard>
  );
}

/** Compact leaderboard card -- one row per employee with the named metric. */
function Leaderboard({ title, rows = [], metric, suffix = '', accent, showHint = false }) {
  const accentCls = accent === 'red' ? 'text-red-600' : accent === 'green' ? 'text-green-600' : 'text-slate-800';
  return (
    <div className="card card-body">
      <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-2">{title}</div>
      {rows.length === 0 ? <div className="text-xs text-slate-400 italic">No data in range.</div> : (
        <ol className="space-y-1.5">
          {rows.map((r, i) => (
            <li key={r._id} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 min-w-0">
                <span className="w-5 text-[11px] text-slate-400 text-right">{i + 1}.</span>
                <span className="truncate text-slate-800">{r.name}</span>
              </span>
              <span className={`font-semibold ${accentCls}`}>{r[metric] ?? 0}{suffix}</span>
            </li>
          ))}
        </ol>
      )}
      {showHint && rows.length > 0 && (
        <div className="mt-2 text-[10px] text-brand-600 hover:underline cursor-pointer text-right select-none">
          View full ranking →
        </div>
      )}
    </div>
  );
}

/* =====================================================================
 * Phase 25 — CallingBreakdown
 *
 * Projects per-metric columns from the captured analytics payload:
 *
 *   metricId             source                       columns rendered
 *   -------------------- ---------------------------- ------------------------------------
 *   callAssigned         data.detailRows              Employee | Date | Assigned Calls
 *   callCompleted        data.detailRows              Employee | Date | Calls Completed
 *   callDialed           data.detailRows              Employee | Date | Dialed Calls
 *   callAttended         data.detailRows              Employee | Date | Attended Calls
 *   callUnattended       data.detailRows              Employee | Date | Unattended Calls
 *   callConversions      data.detailRows              Employee | Date | Old | New | Total
 *   callPending          data.detailRows              Employee | Date | Yesterday | Current
 *   callConnectionRate   data.employees (full)        Employee | Dept | Dialed | Attended | %
 *   callConversionRate   data.employees (full)        Employee | Dept | Attended | Conv | %
 *   callPendingRate      data.employees (full)        Employee | Dept | Assigned | Pending | %
 *   callCompletionRate   data.employees (full)        Employee | Dept | Assigned | Completed | %
 *   callLeaderboard      data.employees (filtered)    Rank | Employee | Dept | Metric value
 *
 * No new aggregation logic -- everything is read from the captured
 * payload which already had filter + role scope applied by the backend.
 * ===================================================================== */
function CallingBreakdown({ metricId, extra = {}, data, onClose }) {
  const detail = data.detailRows || [];
  const employees = data.employees || [];

  // ---- Per-(employee, date) views ----
  // Filter out zero-value rows so the modal only shows submissions that
  // actually contributed to the metric being drilled.
  if (['callAssigned','callCompleted','callDialed','callAttended','callUnattended','callConversions','callPending'].includes(metricId)) {
    const COLS = {
      callAssigned:    [{ label: 'Assigned Calls', key: 'assignedCalls' }],
      callCompleted:   [{ label: 'Calls Completed', key: 'totalCallsCompleted' }],
      callDialed:      [{ label: 'Dialed Calls', key: 'dialedCalls' }],
      callAttended:    [{ label: 'Attended Calls', key: 'attendedCalls' }],
      callUnattended:  [{ label: 'Unattended Calls', key: 'unattendedCalls' }],
      callConversions: [
        { label: 'Old Conversions', key: 'oldConversions' },
        { label: 'New Conversions', key: 'newConversions' },
        { label: 'Total Conversions', key: 'totalConversions' },
      ],
      callPending: [
        { label: 'Yesterday Pending', key: 'yesterdayPending' },
        { label: 'Current Pending',   key: 'totalPending' },
      ],
    }[metricId];
    const rows = detail.filter((d) => COLS.some((c) => (d[c.key] || 0) > 0));
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">
          One row per (employee, day) submission contributing to this metric.  Filtered by the same date range, department, employee and HOD scope as the on-screen view.
        </div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No records for this metric in the selected range.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Date</th>
                  {COLS.map((c) => <th key={c.key} className="text-right">{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r._id}>
                    <td className="font-medium text-slate-800">{r.employeeName}<div className="text-[11px] text-slate-500">{r.employeeCode}</div></td>
                    <td>{r.department}</td>
                    <td>{r.date}</td>
                    {COLS.map((c) => <td key={c.key} className="text-right">{r[c.key] ?? 0}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // ---- Rate views: per-employee ranking from the rollup ----
  if (['callConnectionRate','callConversionRate','callPendingRate','callCompletionRate'].includes(metricId)) {
    const SCHEMA = {
      callConnectionRate: { sortKey: 'connectionRate', filter: (e) => (e.dialedCalls || 0) >= 1, dir: 'desc',
        cols: [{ label: 'Dialed', key: 'dialedCalls' }, { label: 'Attended', key: 'attendedCalls' }, { label: 'Connection %', key: 'connectionRate', suffix: '%' }] },
      callConversionRate: { sortKey: 'conversionRate', filter: (e) => (e.attendedCalls || 0) >= 1, dir: 'desc',
        cols: [{ label: 'Attended', key: 'attendedCalls' }, { label: 'Conversions', key: 'totalConversions' }, { label: 'Conversion %', key: 'conversionRate', suffix: '%' }] },
      callPendingRate: { sortKey: 'pendingRate', filter: (e) => (e.assignedCalls || 0) >= 1, dir: 'desc',
        cols: [{ label: 'Assigned', key: 'assignedCalls' }, { label: 'Pending', key: 'totalPending' }, { label: 'Pending %', key: 'pendingRate', suffix: '%' }] },
      callCompletionRate: { sortKey: 'callCompletionRate', filter: (e) => (e.assignedCalls || 0) >= 1, dir: 'desc',
        cols: [{ label: 'Assigned', key: 'assignedCalls' }, { label: 'Completed', key: 'totalCallsCompleted' }, { label: 'Completion %', key: 'callCompletionRate', suffix: '%' }] },
    }[metricId];
    const rows = [...employees].filter(SCHEMA.filter).sort((a, b) =>
      SCHEMA.dir === 'asc'
        ? (a[SCHEMA.sortKey] || 0) - (b[SCHEMA.sortKey] || 0)
        : (b[SCHEMA.sortKey] || 0) - (a[SCHEMA.sortKey] || 0)
    );
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">
          Full per-employee ranking — same employee scope as the on-screen view.  Click outside or press Esc to close.
        </div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No employees in the selected range have enough data for this rate.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Rank</th><th>Employee</th><th>Department</th>
                  {SCHEMA.cols.map((c) => <th key={c.key} className="text-right">{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r._id}>
                    <td>{i + 1}</td>
                    <td className="font-medium text-slate-800">{r.name}<div className="text-[11px] text-slate-500">{r.employeeId}</div></td>
                    <td>{r.department}</td>
                    {SCHEMA.cols.map((c) => <td key={c.key} className="text-right">{r[c.key] ?? 0}{c.suffix || ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // ---- Leaderboard expansion: full ranking on the chosen metric ----
  if (metricId === 'callLeaderboard') {
    const { leaderboardId, metric, suffix = '', title } = extra;
    // Mirror the filter + direction the backend uses when assembling the
    // top-5 list inside callingAnalytics.leaderboards.  This is the only
    // place where the front-end re-derives a "full" ranking; the rule
    // table below is read-only documentation of the backend's selection.
    const RULES = {
      topCallsCompleted:    { dir: 'desc', filter: () => true },
      topDialedCalls:       { dir: 'desc', filter: () => true },
      topConversionRate:    { dir: 'desc', filter: (e) => (e.attendedCalls || 0) >= 1 },
      topNewCustomers:      { dir: 'desc', filter: () => true },
      topTotalConversions:  { dir: 'desc', filter: () => true },
      lowestPending:        { dir: 'asc',  filter: (e) => (e.assignedCalls || 0) >= 1 },
      bestConnectionRate:   { dir: 'desc', filter: (e) => (e.dialedCalls || 0) >= 1 },
      bottomHighestPending: { dir: 'desc', filter: (e) => (e.assignedCalls || 0) >= 1 },
      bottomLowestConversion: { dir: 'asc', filter: (e) => (e.attendedCalls || 0) >= 1 },
      bottomLowestCompletion: { dir: 'asc', filter: (e) => (e.assignedCalls || 0) >= 1 },
    };
    const rule = RULES[leaderboardId] || { dir: 'desc', filter: () => true };
    const rows = [...employees].filter(rule.filter).sort((a, b) =>
      rule.dir === 'asc'
        ? (a[metric] || 0) - (b[metric] || 0)
        : (b[metric] || 0) - (a[metric] || 0)
    );
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">
          Full ranking for "{title}" — all employees in scope, not just the top 5.  Same scope / filter as the on-screen Calling Analytics view.
        </div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No employees match the ranking criteria in this range.</div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Rank</th><th>Employee</th><th>Department</th><th className="text-right">{title}</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r._id}>
                    <td>{i + 1}</td>
                    <td className="font-medium text-slate-800">{r.name}<div className="text-[11px] text-slate-500">{r.employeeId}</div></td>
                    <td>{r.department}</td>
                    <td className="text-right font-semibold">{r[metric] ?? 0}{suffix}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // ===================================================================
  // Phase 25.1 -- Product & Farmer drill-downs
  // ===================================================================
  const productsTable = data.productsTable || [];
  const employeesPF = data.employeesPF || [];
  const productEmployeeRows = data.productEmployeeRows || [];
  const farmerRows = data.farmerRows || [];
  const productKpis = data.productKpis || {};
  const combinedMetrics = data.combinedMetrics || {};

  // Total Products Sold -- show product table with employee contributions.
  if (metricId === 'pfTotalProducts') {
    const byProduct = new Map();
    for (const r of productEmployeeRows) {
      if (!byProduct.has(r.productName)) byProduct.set(r.productName, []);
      byProduct.get(r.productName).push(r);
    }
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">{productsTable.length} product(s) sold in this range, with employee contributions.</div>
        <div className="overflow-x-auto max-h-[60vh]">
          {productsTable.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No product sales in this range.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Product</th><th>Employee</th><th className="text-right">Qty</th><th className="text-right">Sales (₹)</th><th className="text-right">NBV (₹)</th></tr></thead>
              <tbody>
                {productsTable.flatMap((p) => {
                  const contribs = (byProduct.get(p.name) || []).sort((a, b) => (b.sales || 0) - (a.sales || 0));
                  if (contribs.length === 0) {
                    return [(
                      <tr key={`${p.name}-totals`}>
                        <td className="font-medium text-slate-800">{p.name}</td>
                        <td className="text-slate-400 italic">(no per-employee breakdown)</td>
                        <td className="text-right">{p.qty}</td>
                        <td className="text-right text-green-700">{p.sales}</td>
                        <td className="text-right">{p.nbv}</td>
                      </tr>
                    )];
                  }
                  return contribs.map((c, i) => (
                    <tr key={`${p.name}-${c.employeeId}-${i}`}>
                      <td className="font-medium text-slate-800">{i === 0 ? p.name : ''}</td>
                      <td>{c.employeeName}<div className="text-[11px] text-slate-500">{c.department}</div></td>
                      <td className="text-right">{c.qty}</td>
                      <td className="text-right text-green-700">{c.sales}</td>
                      <td className="text-right">{c.nbv}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Total Quantity Sold -- per (product, employee) rows.
  if (metricId === 'pfTotalQuantity' || metricId === 'pfTotalSales' || metricId === 'pfTotalNbv') {
    const sortKey = metricId === 'pfTotalQuantity' ? 'qty' : metricId === 'pfTotalSales' ? 'sales' : 'nbv';
    const rows = [...productEmployeeRows].sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">One row per (employee, product) aggregation within the selected range.</div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No product sales in this range.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Employee</th><th>Department</th><th>Product</th><th className="text-right">Quantity</th><th className="text-right">Sales (₹)</th><th className="text-right">NBV (₹)</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.employeeId}-${r.productName}-${i}`}>
                    <td className="font-medium text-slate-800">{r.employeeName}<div className="text-[11px] text-slate-500">{r.employeeCode}</div></td>
                    <td>{r.department}</td>
                    <td>{r.productName}</td>
                    <td className="text-right">{r.qty}</td>
                    <td className="text-right text-green-700">{r.sales}</td>
                    <td className="text-right">{r.nbv}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Total Farmers Added -- one row per farmer record.
  if (metricId === 'pfTotalFarmers') {
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">{farmerRows.length} farmer record(s) added in this range.</div>
        <div className="overflow-x-auto max-h-[60vh]">
          {farmerRows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No farmer records in this range.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Farmer</th><th>Employee</th><th>Dealer</th><th>Place</th><th>Products</th><th>Date</th></tr></thead>
              <tbody>
                {farmerRows.map((f, i) => (
                  <tr key={`${f.farmerName}-${i}`}>
                    <td className="font-medium text-slate-800">{f.farmerName || '—'}{f.mobile ? <div className="text-[11px] text-slate-500">{f.mobile}</div> : null}</td>
                    <td>{f.employeeName}<div className="text-[11px] text-slate-500">{f.department}</div></td>
                    <td>{f.dealerFirm || '—'}{f.dealerName ? <div className="text-[11px] text-slate-500">{f.dealerName}</div> : null}</td>
                    <td>{f.dealerPlace || '—'}</td>
                    <td className="text-[11px]">{f.products.length === 0 ? <span className="text-slate-400">—</span> : f.products.map((p, j) => <div key={j}>{p.productName} · {p.quantity}</div>)}</td>
                    <td>{f.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Revenue / Call -- per-employee ranking.
  if (metricId === 'pfRevenuePerCall' || metricId === 'pfNbvPerCall') {
    const valueKey = metricId === 'pfRevenuePerCall' ? 'salesValue' : 'nbvValue';
    const valueLabel = metricId === 'pfRevenuePerCall' ? 'Revenue (₹)' : 'NBV (₹)';
    const perCallLabel = metricId === 'pfRevenuePerCall' ? 'Revenue / Call' : 'NBV / Call';
    const callsByEmp = new Map(employees.map((e) => [String(e._id), e.totalCallsCompleted || 0]));
    const rows = employeesPF.map((e) => {
      const calls = callsByEmp.get(String(e._id)) || 0;
      return { ...e, calls, perCall: calls > 0 ? Math.round(((e[valueKey] || 0) / calls) * 100) / 100 : 0 };
    }).sort((a, b) => (b.perCall || 0) - (a.perCall || 0));
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">Per-employee ranking joined across calling and Product &amp; Farmer datasets.</div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No matching rows in this range.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Rank</th><th>Employee</th><th>Department</th><th className="text-right">{valueLabel}</th><th className="text-right">Calls</th><th className="text-right">{perCallLabel}</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r._id}>
                    <td>{i + 1}</td>
                    <td className="font-medium text-slate-800">{r.name}<div className="text-[11px] text-slate-500">{r.employeeId}</div></td>
                    <td>{r.department}</td>
                    <td className="text-right text-green-700">{r[valueKey] || 0}</td>
                    <td className="text-right">{r.calls}</td>
                    <td className="text-right font-semibold">{r.perCall}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Farmers / Employee -- per-employee ranking with products + revenue.
  if (metricId === 'pfFarmersPerEmployee') {
    const rows = [...employeesPF].sort((a, b) => (b.farmersAdded || 0) - (a.farmersAdded || 0));
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">Per-employee farmer reach within the selected range.</div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No farmer records in this range.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Rank</th><th>Employee</th><th>Department</th><th className="text-right">Farmers</th><th className="text-right">Products</th><th className="text-right">Revenue (₹)</th><th className="text-right">NBV (₹)</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r._id}>
                    <td>{i + 1}</td>
                    <td className="font-medium text-slate-800">{r.name}<div className="text-[11px] text-slate-500">{r.employeeId}</div></td>
                    <td>{r.department}</td>
                    <td className="text-right">{r.farmersAdded || 0}</td>
                    <td className="text-right">{r.productsSold || 0}</td>
                    <td className="text-right text-green-700">{r.salesValue || 0}</td>
                    <td className="text-right">{r.nbvValue || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Top Employees -- Product & Farmer leaderboard expansion.
  if (metricId === 'pfEmployeeLeaderboard') {
    const { metric, suffix = '', title } = extra;
    const rows = [...employeesPF].sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">Full ranking for "{title}" — all employees with Product &amp; Farmer activity in scope.</div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No matching rows in this range.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Rank</th><th>Employee</th><th>Department</th><th className="text-right">Quantity</th><th className="text-right">Sales (₹)</th><th className="text-right">NBV (₹)</th><th className="text-right">Farmers</th><th className="text-right">Products</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r._id}>
                    <td>{i + 1}</td>
                    <td className="font-medium text-slate-800">{r.name}<div className="text-[11px] text-slate-500">{r.employeeId}</div></td>
                    <td>{r.department}</td>
                    <td className="text-right">{r.quantitySold || 0}</td>
                    <td className="text-right text-green-700">{r.salesValue || 0}</td>
                    <td className="text-right">{r.nbvValue || 0}</td>
                    <td className="text-right">{r.farmersAdded || 0}</td>
                    <td className="text-right">{r.productsSold || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Per-product profile click.
  if (metricId === 'pfProduct') {
    const { productName } = extra;
    const product = productsTable.find((p) => p.name === productName) || { qty: 0, sales: 0, nbv: 0 };
    const empContribs = productEmployeeRows.filter((r) => r.productName === productName).sort((a, b) => (b.sales || 0) - (a.sales || 0));
    const farmerHits = farmerRows.filter((f) => (f.products || []).some((p) => (p.productName || '').trim() === productName.trim()));
    const dealersSet = new Map();
    for (const f of farmerHits) {
      const k = `${f.dealerFirm}|${f.dealerPlace}`;
      if (!dealersSet.has(k)) dealersSet.set(k, { firmName: f.dealerFirm, place: f.dealerPlace, farmers: 0 });
      dealersSet.get(k).farmers += 1;
    }
    const dealersList = [...dealersSet.values()].filter((d) => d.firmName).sort((a, b) => b.farmers - a.farmers);
    return (
      <div className="space-y-3">
        <div className="rounded border border-slate-200 px-3 py-2 text-sm">
          <div className="font-semibold text-slate-800">{productName}</div>
          <div className="text-[12px] text-slate-600">Qty <b>{product.qty}</b> · Sales <b className="text-green-700">{product.sales}</b> · NBV <b>{product.nbv}</b></div>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Employees who sold this product ({empContribs.length})</div>
          {empContribs.length === 0 ? <div className="text-xs text-slate-400 italic">—</div> : (
            <table className="table">
              <thead><tr><th>Employee</th><th>Department</th><th className="text-right">Qty</th><th className="text-right">Sales (₹)</th><th className="text-right">NBV (₹)</th></tr></thead>
              <tbody>
                {empContribs.map((c, i) => (
                  <tr key={`${c.employeeId}-${i}`}>
                    <td className="font-medium text-slate-800">{c.employeeName}<div className="text-[11px] text-slate-500">{c.employeeCode}</div></td>
                    <td>{c.department}</td>
                    <td className="text-right">{c.qty}</td>
                    <td className="text-right text-green-700">{c.sales}</td>
                    <td className="text-right">{c.nbv}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Dealers ({dealersList.length})</div>
          {dealersList.length === 0 ? <div className="text-xs text-slate-400 italic">—</div> : (
            <table className="table">
              <thead><tr><th>Dealer</th><th>Place</th><th className="text-right">Farmer hits</th></tr></thead>
              <tbody>{dealersList.map((d, i) => <tr key={i}><td>{d.firmName}</td><td>{d.place || '—'}</td><td className="text-right">{d.farmers}</td></tr>)}</tbody>
            </table>
          )}
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Farmers ({farmerHits.length})</div>
          {farmerHits.length === 0 ? <div className="text-xs text-slate-400 italic">—</div> : (
            <table className="table max-h-60 overflow-y-auto block">
              <thead><tr><th>Farmer</th><th>Employee</th><th>Dealer</th><th>Date</th></tr></thead>
              <tbody>
                {farmerHits.map((f, i) => (
                  <tr key={i}>
                    <td>{f.farmerName || '—'}{f.mobile ? <div className="text-[11px] text-slate-500">{f.mobile}</div> : null}</td>
                    <td>{f.employeeName}</td>
                    <td>{f.dealerFirm}{f.dealerPlace ? ` — ${f.dealerPlace}` : ''}</td>
                    <td>{f.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // ===================================================================
  // Phase 25.1 -- Dealer drill-downs
  // ===================================================================
  const dealersTable = data.dealersTable || [];
  const allActiveDealers = data.allActiveDealers || [];
  const dealerDayRows = data.dealerDayRows || [];

  // Total Active Dealers -- full active dealer roster.
  if (metricId === 'dealerActive') {
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">Full active Dealer Master list ({allActiveDealers.length}).  Independent of activity in the selected range.</div>
        <div className="overflow-x-auto max-h-[60vh]">
          {allActiveDealers.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No active dealers configured.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Firm Name</th><th>Place</th><th>Dealer Name</th></tr></thead>
              <tbody>{allActiveDealers.map((d) => <tr key={d._id}><td className="font-medium text-slate-800">{d.firmName || '—'}</td><td>{d.place || '—'}</td><td>{d.dealerName || '—'}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Dealers Covered -- dealers with ≥1 farmer in range.
  if (metricId === 'dealerCovered') {
    const rows = [...dealersTable].filter((d) => (d.farmers || 0) >= 1).sort((a, b) => (b.farmers || 0) - (a.farmers || 0));
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">Dealers with at least one farmer record in this range.</div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No dealers were covered in this range.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Dealer</th><th>Place</th><th className="text-right">Farmers</th><th className="text-right">Products</th></tr></thead>
              <tbody>{rows.map((d) => <tr key={d._id}><td className="font-medium text-slate-800">{d.firmName || d.name || '—'}{d.dealerName ? <div className="text-[11px] text-slate-500">{d.dealerName}</div> : null}</td><td>{d.place || '—'}</td><td className="text-right">{d.farmers}</td><td className="text-right">{d.products}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Dealers With Sales -- dealers whose farmer records mapped to sales.
  if (metricId === 'dealerWithSales') {
    const rows = [...dealersTable].filter((d) => (d.sales || 0) > 0).sort((a, b) => (b.sales || 0) - (a.sales || 0));
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">Dealers whose farmer records translated to product sales in this range.</div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No dealers had sales in this range.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Dealer</th><th>Place</th><th className="text-right">Quantity</th><th className="text-right">Sales (₹)</th><th className="text-right">NBV (₹)</th></tr></thead>
              <tbody>{rows.map((d) => <tr key={d._id}><td className="font-medium text-slate-800">{d.firmName || d.name || '—'}</td><td>{d.place || '—'}</td><td className="text-right">{d.qty}</td><td className="text-right text-green-700">{d.sales}</td><td className="text-right">{d.nbv}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Avg Sales / Dealer -- per-dealer totals with row count and average.
  if (metricId === 'dealerAvgSales') {
    const rows = [...dealersTable].sort((a, b) => (b.sales || 0) - (a.sales || 0));
    const totalSales = rows.reduce((s, d) => s + (d.sales || 0), 0);
    const avg = rows.length > 0 ? Math.round((totalSales / rows.length) * 100) / 100 : 0;
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">Per-dealer sales totals — average across the covered set is <b>{avg}</b>.</div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No dealers in this range.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Dealer</th><th>Place</th><th className="text-right">Total Sales (₹)</th><th className="text-right">Sales Rows</th><th className="text-right">Avg / Sale</th></tr></thead>
              <tbody>{rows.map((d) => {
                const perRow = (d.products || 0) > 0 ? Math.round(((d.sales || 0) / d.products) * 100) / 100 : 0;
                return <tr key={d._id}><td className="font-medium text-slate-800">{d.firmName || d.name || '—'}</td><td>{d.place || '—'}</td><td className="text-right text-green-700">{d.sales}</td><td className="text-right">{d.products}</td><td className="text-right">{perRow}</td></tr>;
              })}</tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Dealer leaderboard expansion -- full ranking on selected metric.
  if (metricId === 'dealerLeaderboard') {
    const { metric, title } = extra;
    const rows = [...dealersTable].sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
    return (
      <div className="space-y-2">
        <div className="text-xs text-slate-500">Full dealer ranking for "{title}".  Same scope as the on-screen view.</div>
        <div className="overflow-x-auto max-h-[60vh]">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-4 text-center">No dealers in this range.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Rank</th><th>Dealer Name</th><th>Place</th><th className="text-right">Quantity</th><th className="text-right">Sales (₹)</th><th className="text-right">NBV (₹)</th><th className="text-right">Farmers</th></tr></thead>
              <tbody>{rows.map((d, i) => <tr key={d._id}><td>{i + 1}</td><td className="font-medium text-slate-800">{d.firmName || d.name || '—'}{d.dealerName ? <div className="text-[11px] text-slate-500">{d.dealerName}</div> : null}</td><td>{d.place || '—'}</td><td className="text-right">{d.qty}</td><td className="text-right text-green-700">{d.sales}</td><td className="text-right">{d.nbv}</td><td className="text-right">{d.farmers}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // Per-dealer profile -- full picture of one dealer.
  if (metricId === 'dealerProfile') {
    const { dealerId } = extra;
    const dealer = dealersTable.find((d) => String(d._id) === String(dealerId));
    if (!dealer) {
      return <div className="text-sm text-slate-400 italic">Dealer not found in the current range.</div>;
    }
    // Employees who visited this dealer: derived from farmerRows that
    // match the dealer's firm + place snapshot.
    const empVisitors = new Map();
    const dealerFarmers = farmerRows.filter((f) =>
      (f.dealerFirm || '') === (dealer.firmName || '') && (f.dealerPlace || '') === (dealer.place || '')
    );
    for (const f of dealerFarmers) {
      if (!empVisitors.has(f.employeeId)) empVisitors.set(f.employeeId, { name: f.employeeName, code: f.employeeCode, dept: f.department, count: 0 });
      empVisitors.get(f.employeeId).count += 1;
    }
    const empVisitorList = [...empVisitors.values()].sort((a, b) => b.count - a.count);
    const productsList = new Map();
    for (const f of dealerFarmers) {
      for (const p of (f.products || [])) {
        const k = p.productName || '—';
        if (!productsList.has(k)) productsList.set(k, { name: k, qty: 0 });
        productsList.get(k).qty += Number(p.quantity) || 0;
      }
    }
    const productsArr = [...productsList.values()].sort((a, b) => b.qty - a.qty);
    const dayActivity = dealerDayRows.filter((r) => String(r.dealerId) === String(dealerId));

    return (
      <div className="space-y-3">
        <div className="rounded border border-slate-200 px-3 py-2 text-sm">
          <div className="font-semibold text-slate-800">{dealer.firmName || dealer.name || '—'}</div>
          <div className="text-[12px] text-slate-600">Place: <b>{dealer.place || '—'}</b> · Dealer: <b>{dealer.dealerName || '—'}</b></div>
          <div className="text-[12px] text-slate-600 mt-1">Farmers <b>{dealer.farmers}</b> · Products <b>{dealer.products}</b> · Qty <b>{dealer.qty}</b> · Sales <b className="text-green-700">{dealer.sales}</b> · NBV <b>{dealer.nbv}</b></div>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Employees who visited ({empVisitorList.length})</div>
          {empVisitorList.length === 0 ? <div className="text-xs text-slate-400 italic">—</div> : (
            <table className="table"><thead><tr><th>Employee</th><th>Department</th><th className="text-right">Farmer records</th></tr></thead>
              <tbody>{empVisitorList.map((e, i) => <tr key={i}><td className="font-medium text-slate-800">{e.name}<div className="text-[11px] text-slate-500">{e.code}</div></td><td>{e.dept}</td><td className="text-right">{e.count}</td></tr>)}</tbody>
            </table>
          )}
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Products sold ({productsArr.length})</div>
          {productsArr.length === 0 ? <div className="text-xs text-slate-400 italic">—</div> : (
            <table className="table"><thead><tr><th>Product</th><th className="text-right">Quantity</th></tr></thead>
              <tbody>{productsArr.map((p, i) => <tr key={i}><td>{p.name}</td><td className="text-right">{p.qty}</td></tr>)}</tbody>
            </table>
          )}
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Date-wise activity ({dayActivity.length})</div>
          {dayActivity.length === 0 ? <div className="text-xs text-slate-400 italic">—</div> : (
            <table className="table"><thead><tr><th>Date</th><th className="text-right">Farmers</th><th className="text-right">Sales (₹)</th><th className="text-right">NBV (₹)</th></tr></thead>
              <tbody>{dayActivity.map((r) => <tr key={r.date}><td>{r.date}</td><td className="text-right">{r.farmers}</td><td className="text-right text-green-700">{r.sales}</td><td className="text-right">{r.nbv}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  return <div className="text-sm text-slate-400 italic">No drill-down available for this metric.</div>;
}
