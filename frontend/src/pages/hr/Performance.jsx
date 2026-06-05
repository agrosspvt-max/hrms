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
  const [mode, setMode] = useState('pendency'); // 'pendency' | 'completion'
  const [range, setRange] = useState('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('');
  const [designation, setDesignation] = useState('');
  const [employee, setEmployee] = useState('');
  const [templateType, setTemplateType] = useState('');
  const [recurrence, setRecurrence] = useState('');

  const [opts, setOpts] = useState({ departments: [], designations: [], employees: [] });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState(null); // { metricId, title }

  useEffect(() => {
    Promise.all([
      api.get('/departments').then((r) => r.data).catch(() => []),
      api.get('/designations').then((r) => r.data).catch(() => []),
      api.get('/employees', { params: { status: 'active', role: 'employee' } }).then((r) => r.data).catch(() => []),
    ]).then(([departments, designations, employees]) => setOpts({
      departments: departments || [], designations: designations || [], employees: employees || [],
    }));
  }, []);

  useEffect(() => {
    const params = {};
    if (range === 'custom') { if (!from || !to) return; params.from = from; params.to = to; }
    else params.range = range;
    if (department) params.department = department;
    if (designation) params.designation = designation;
    if (employee) params.employee = employee;
    if (templateType) params.templateType = templateType;
    if (recurrence) params.recurrence = recurrence;
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
  }, [mode, range, from, to, department, designation, employee, templateType, recurrence]);

  const openDrill = (metricId, title) => setDrill({ metricId, title });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Performance Analytics</h1>
        <p className="text-sm text-slate-500">Dual-mode enterprise analytics. Click any card or chart for a detailed breakdown.</p>
      </div>

      {/* Mode toggle */}
      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        {[['pendency', 'Pendency Review'], ['completion', 'Completion Review'], ['calling', 'Calling Analytics']].map(([k, label]) => (
          <button key={k} onClick={() => { setMode(k); setData(null); }}
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
        <div><label className="label">Department</label>
          <select className="input max-w-[160px]" value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">All departments</option>
            {opts.departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </select>
        </div>
        <div><label className="label">Designation</label>
          <select className="input max-w-[160px]" value={designation} onChange={(e) => setDesignation(e.target.value)}>
            <option value="">All designations</option>
            {opts.designations.map((d) => <option key={d._id} value={d._id}>{d.title}</option>)}
          </select>
        </div>
        <div><label className="label">Employee</label>
          <select className="input max-w-[170px]" value={employee} onChange={(e) => setEmployee(e.target.value)}>
            <option value="">All employees</option>
            {opts.employees.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}
          </select>
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
      </div>

      {loading || !data ? <Loader /> : (
        mode === 'pendency' ? <PendencyMode data={data} onDrill={openDrill} />
        : mode === 'completion' ? <CompletionMode data={data} onDrill={openDrill} />
        : <CallingMode data={data} />
      )}

      {drill && (
        <DrillDownModal metricId={drill.metricId} title={drill.title} onClose={() => setDrill(null)}>
          <Breakdown metricId={drill.metricId} mode={mode} data={data} navigate={navigate} onClose={() => setDrill(null)} />
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

      {/* Dependency analytics */}
      <div className="card card-body">
        <h2 className="text-sm font-semibold text-slate-800 mb-3">Dependency Analytics</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-xl p-3 border bg-indigo-50 border-indigo-100"><div className="text-[10px] font-bold text-indigo-700">AVG RESOLUTION TIME</div><div className="text-2xl font-bold mt-1">{dep.avgResolutionHours}h</div></div>
          <div className="rounded-xl p-3 border bg-green-50 border-green-100"><div className="text-[10px] font-bold text-green-700">COLLABORATIVE COMPLETION</div><div className="text-2xl font-bold mt-1">{dep.collaborativeCompletionPct}%</div></div>
          <div className="rounded-xl p-3 border bg-orange-50 border-orange-100"><div className="text-[10px] font-bold text-orange-700">LONGEST CHAIN</div><div className="text-2xl font-bold mt-1">{dep.longestChain?.length || 0} hops</div></div>
          <div className="rounded-xl p-3 border bg-red-50 border-red-100"><div className="text-[10px] font-bold text-red-700">OPEN DEPENDENCIES</div><div className="text-2xl font-bold mt-1">{dep.openDependencies}</div></div>
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
function CallingMode({ data }) {
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
  const hasPF = (pk.totalProductsSold || 0) > 0 || (fk.totalFarmersAdded || 0) > 0;

  return (
    <div className="space-y-6">
      {/* 8 KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Assigned Calls"     value={k.totalAssignedCalls   ?? 0} accent="brand" />
        <StatCard label="Total Calls Completed"    value={k.totalCallsCompleted  ?? 0} accent="green" />
        <StatCard label="Total Attended Calls"     value={k.totalAttendedCalls   ?? 0} accent="blue" />
        <StatCard label="Total Unattended Calls"   value={k.totalUnattendedCalls ?? 0} accent="amber" />
        <StatCard label="Total Conversions"        value={k.totalConversions     ?? 0} accent="green" />
        <StatCard label="Old Customer Conversions" value={k.oldConversions       ?? 0} accent="blue" />
        <StatCard label="New Customer Conversions" value={k.newConversions       ?? 0} accent="green" />
        <StatCard label="Total Pending Calls"      value={k.totalPendingCalls    ?? 0} accent="red" />
      </div>

      {/* Rate strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Connection Rate"      value={`${k.connectionRate     ?? 0}%`} accent={(k.connectionRate     || 0) >= 60 ? 'green' : 'amber'} />
        <StatCard label="Conversion Rate"      value={`${k.conversionRate     ?? 0}%`} accent={(k.conversionRate     || 0) >= 20 ? 'green' : 'amber'} />
        <StatCard label="Pending Rate"         value={`${k.pendingRate        ?? 0}%`} accent={(k.pendingRate        || 0) <= 20 ? 'green' : 'red'} />
        <StatCard label="Call Completion Rate" value={`${k.callCompletionRate ?? 0}%`} accent={(k.callCompletionRate || 0) >= 80 ? 'green' : 'amber'} />
      </div>

      {/* Daily trend chart */}
      <ChartCard title="Daily Trend" subtitle="Calls, conversions, pending — per day across the filter range">
        <AreaChart data={trend}>
          <CartesianGrid stroke="#eef2f7" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Area type="monotone" dataKey="assigned"    stroke={BLUE}   fill={BLUE}   fillOpacity={0.18} name="Assigned" />
          <Area type="monotone" dataKey="completed"   stroke={GREEN}  fill={GREEN}  fillOpacity={0.18} name="Completed" />
          <Area type="monotone" dataKey="attended"    stroke={VIOLET} fill={VIOLET} fillOpacity={0.0}  name="Attended" />
          <Area type="monotone" dataKey="conversions" stroke={AMBER}  fill={AMBER}  fillOpacity={0.0}  name="Conversions" />
          <Area type="monotone" dataKey="pending"     stroke={RED}    fill={RED}    fillOpacity={0.0}  name="Pending" />
        </AreaChart>
      </ChartCard>

      {/* Six "Top" leaderboards */}
      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Top Callers</div>
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          <Leaderboard title="By Calls Completed"    rows={lb.topCallsCompleted}   metric="totalCallsCompleted" suffix="" />
          <Leaderboard title="By Conversion Rate"    rows={lb.topConversionRate}   metric="conversionRate"      suffix="%" />
          <Leaderboard title="By New Customers"      rows={lb.topNewCustomers}     metric="newConversions"      suffix="" />
          <Leaderboard title="By Total Conversions"  rows={lb.topTotalConversions} metric="totalConversions"    suffix="" />
          <Leaderboard title="Lowest Pending Calls"  rows={lb.lowestPending}       metric="totalPending"        suffix="" accent="green" />
          <Leaderboard title="Best Connection Rate"  rows={lb.bestConnectionRate}  metric="connectionRate"      suffix="%" />
        </div>
      </div>

      {/* Three "Bottom" leaderboards */}
      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Needs Attention</div>
        <div className="grid md:grid-cols-3 gap-4">
          <Leaderboard title="Highest Pending"       rows={lb.bottomHighestPending}    metric="totalPending"        suffix=""  accent="red" />
          <Leaderboard title="Lowest Conversion"     rows={lb.bottomLowestConversion}  metric="conversionRate"      suffix="%" accent="red" />
          <Leaderboard title="Lowest Call Completion" rows={lb.bottomLowestCompletion} metric="callCompletionRate" suffix="%" accent="red" />
        </div>
      </div>

      {/* =============================================================
            PRODUCT & FARMER section (additive -- shown only when there
            are product/farmer submissions in the filter range).  The
            existing Calling KPIs above this block are untouched.
          ============================================================= */}
      {hasPF && (
        <div className="space-y-4 pt-4">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-800">Product &amp; Farmer Report</h2>
            <span className="badge bg-indigo-50 text-indigo-700">Custom Assignment</span>
          </div>
          {/* Product / Farmer headline KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Total Products Sold"  value={pk.totalProductsSold ?? 0} accent="brand" />
            <StatCard label="Total Quantity Sold"  value={pk.totalQuantitySold ?? 0} accent="blue" sub="L / KG (canonical)" />
            <StatCard label="Total Sales Value"    value={`₹${pk.totalSalesValue ?? 0}`} accent="green" />
            <StatCard label="Total NBV Value"      value={`₹${pk.totalNbvValue ?? 0}`} accent="green" />
            <StatCard label="Total Farmers Added"  value={fk.totalFarmersAdded ?? 0} accent="amber" />
            <StatCard label="Revenue / Call"       value={`₹${cm.revenuePerCall ?? 0}`} accent="blue" />
            <StatCard label="NBV / Call"           value={`₹${cm.nbvPerCall ?? 0}`} accent="blue" />
            <StatCard label="Farmers / Employee"   value={cm.farmersPerEmployee ?? 0} accent="amber" />
          </div>

          {/* Product & Farmer leaderboards */}
          <div>
            <div className="text-sm font-semibold text-slate-800 mb-2">Top Employees — Product &amp; Farmer</div>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              <Leaderboard title="By Sales Value (₹)"   rows={pLb.topSales}    metric="salesValue"   suffix="" />
              <Leaderboard title="By NBV Value (₹)"     rows={pLb.topNbv}      metric="nbvValue"     suffix="" />
              <Leaderboard title="By Quantity Sold"     rows={pLb.topQuantity} metric="quantitySold" suffix="" />
              <Leaderboard title="By Products Sold"     rows={pLb.topProducts} metric="productsSold" suffix="" />
              <Leaderboard title="By Farmers Added"     rows={pLb.topFarmers}  metric="farmersAdded" suffix="" />
            </div>
          </div>

          {/* Product breakdown table */}
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
                    <tr key={p.name}>
                      <td className="font-medium text-slate-800">{p.name}</td>
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
                      <td className="text-right font-semibold text-green-700">{e.salesValue}</td>
                      <td className="text-right">{e.nbvValue}</td>
                      <td className="text-right">{e.quantitySold}</td>
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
                    <td className="text-right">{r.attendedCalls}</td>
                    <td className="text-right">{r.totalConversions}</td>
                    <td className={`text-right ${(r.totalPending || 0) > 0 ? 'text-red-600 font-semibold' : 'text-slate-400'}`}>{r.totalPending}</td>
                    <td className="text-right">{r.connectionRate}%</td>
                    <td className="text-right">{r.conversionRate}%</td>
                    <td className="text-right">{r.pendingRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}

/** Compact leaderboard card -- one row per employee with the named metric. */
function Leaderboard({ title, rows = [], metric, suffix = '', accent }) {
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
    </div>
  );
}
