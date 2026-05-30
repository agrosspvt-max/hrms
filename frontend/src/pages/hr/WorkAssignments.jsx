import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import api from '../../api/axios';
import StatCard from '../../components/StatCard.jsx';
import { Loader } from '../../components/Loader.jsx';
import { ClickableCard, DrillDownModal } from '../../components/AnalyticsDrillDown.jsx';
import Templates from './Templates.jsx';
import Assignments from './Assignments.jsx';

const RED = '#ef4444'; const ORANGE = '#f97316'; const AMBER = '#f59e0b';
const GREEN = '#22c55e'; const BLUE = '#3b82f6'; const VIOLET = '#8b5cf6';

/**
 * Work Assignment Management - unified module merging Templates +
 * Assignments + Assignment Analytics into one tabbed page.  Reuses the
 * existing Templates and Assignments components in "embedded" mode (no
 * inner page headers) so all CRUD / spreadsheet / dependency-workflow
 * functionality continues to work exactly as before.
 */
export default function WorkAssignments() {
  const [tab, setTab] = useState('templates');
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Assignments</h1>
        <p className="text-sm text-slate-500">Templates, active assignments &amp; analytics — your work assignment control center.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {[['templates', 'Templates'], ['assignments', 'Active Assignments'], ['analytics', 'Assignment Analytics']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 transition ${tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'templates' && <Templates embedded />}
      {tab === 'assignments' && <Assignments embedded />}
      {tab === 'analytics' && <AssignmentAnalyticsTab />}
    </div>
  );
}

const ChartCard = ({ title, subtitle, onClick, children, height = 260 }) => (
  <div className="card card-body">
    <div className="flex items-start justify-between">
      <div>
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {subtitle && <div className="text-[11px] text-slate-400">{subtitle}</div>}
      </div>
      {onClick && <button className="text-[11px] text-brand-600 hover:underline" onClick={onClick}>Details →</button>}
    </div>
    <div style={{ width: '100%', height }} className="mt-3"><ResponsiveContainer>{children}</ResponsiveContainer></div>
  </div>
);

function AssignmentAnalyticsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState(null);

  useEffect(() => {
    setLoading(true);
    api.get('/dashboard/hr/assignment-analytics')
      .then(({ data }) => setData(data)).catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading || !data) return <Loader />;
  const c = data.cards; const ch = data.charts;
  const open = (id) => setDrill({ id });

  return (
    <div className="space-y-4">
      {/* Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <ClickableCard onClick={() => open('mostUsedTemplates')}><StatCard label="Total Assignments" value={c.totalAssignments} accent="brand" /></ClickableCard>
        <ClickableCard onClick={() => open('mostUsedTemplates')}><StatCard label="Active Assignments" value={c.activeAssignments} accent="green" /></ClickableCard>
        <ClickableCard onClick={() => open('mostUsedTemplates')}><StatCard label="Templates In Use" value={c.totalTemplates} accent="blue" /></ClickableCard>
        <ClickableCard onClick={() => open('overdueAssignmentCount')}><StatCard label="Overdue Assignments" value={c.overdueAssignmentCount} accent={c.overdueAssignmentCount > 0 ? 'red' : 'green'} sub=">7d pending tasks" /></ClickableCard>
      </div>

      {/* Charts row 1 */}
      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Most Used Templates" subtitle="By active assignment count" onClick={() => open('mostUsedTemplates')}>
          <BarChart data={(ch.mostUsedTemplates || []).map((t) => ({ name: t.title, count: t.assignments }))} layout="vertical" margin={{ left: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={140} />
            <Tooltip /><Bar dataKey="count" fill={BLUE} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Highest Pendency Templates" onClick={() => open('highestPendency')}>
          <BarChart data={(ch.highestPendency || []).map((t) => ({ name: t.title, rate: t.pendencyRate }))} layout="vertical" margin={{ left: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis type="number" tick={{ fontSize: 11 }} domain={[0, 100]} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={140} />
            <Tooltip formatter={(v) => `${v}%`} /><Bar dataKey="rate" fill={RED} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
      </div>

      {/* Charts row 2 */}
      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Highest Completion Templates" onClick={() => open('highestCompletion')}>
          <BarChart data={(ch.highestCompletion || []).map((t) => ({ name: t.title, rate: t.completionRate }))} layout="vertical" margin={{ left: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis type="number" tick={{ fontSize: 11 }} domain={[0, 100]} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={140} />
            <Tooltip formatter={(v) => `${v}%`} /><Bar dataKey="rate" fill={GREEN} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Dependency-Heavy Templates" onClick={() => open('dependencyHeavyTemplates')}>
          <BarChart data={(ch.dependencyHeavyTemplates || []).map((t) => ({ name: t.title, count: t.count }))} layout="vertical" margin={{ left: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={140} />
            <Tooltip /><Bar dataKey="count" fill={AMBER} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
      </div>

      {/* Charts row 3 */}
      <div className="grid md:grid-cols-3 gap-4">
        <ChartCard title="Department Load" subtitle="Active assignments" onClick={() => open('departmentLoad')}>
          <BarChart data={ch.departmentLoad}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={56} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} /><Tooltip /><Bar dataKey="count" fill={ORANGE} radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="Employee Load" subtitle="Applicable assignments per employee" onClick={() => open('employeeLoad')}>
          <BarChart data={(ch.employeeLoad || []).map((e) => ({ name: e.name, count: e.assignments }))}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={56} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} /><Tooltip /><Bar dataKey="count" fill={VIOLET} radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="Recurring vs One-time" onClick={() => open('recurrenceDistribution')}>
          <PieChart>
            <Pie data={ch.recurrenceDistribution} dataKey="count" nameKey="frequency" outerRadius={90} label>
              <Cell fill={BLUE} /><Cell fill={VIOLET} /><Cell fill={ORANGE} /><Cell fill="#94a3b8" />
            </Pie>
            <Legend /><Tooltip />
          </PieChart>
        </ChartCard>
      </div>

      {drill && (
        <DrillDownModal metricId={drill.id} onClose={() => setDrill(null)}>
          <Breakdown id={drill.id} ch={ch} />
        </DrillDownModal>
      )}
    </div>
  );
}

/** Drill-down data breakdown per metric. */
function Breakdown({ id, ch }) {
  if (id === 'mostUsedTemplates') {
    return <Tbl head={['Template', 'Type', 'Assignments', 'Active']} rows={ch.mostUsedTemplates.map((t) => [t.title, t.type, t.assignments, t.active])} />;
  }
  if (id === 'highestPendency') {
    return <Tbl head={['Template', 'Pending', 'Done', 'Pendency %']} rows={ch.highestPendency.map((t) => [t.title, t.pending, t.done, `${t.pendencyRate}%`])} />;
  }
  if (id === 'highestCompletion') {
    return <Tbl head={['Template', 'Done', 'Pending', 'Completion %']} rows={ch.highestCompletion.map((t) => [t.title, t.done, t.pending, `${t.completionRate}%`])} />;
  }
  if (id === 'departmentLoad') {
    return <Tbl head={['Department', 'Active Assignments']} rows={ch.departmentLoad.map((d) => [d.name, d.count])} />;
  }
  if (id === 'employeeLoad') {
    return <Tbl head={['Employee', 'Applicable Assignments']} rows={ch.employeeLoad.map((e) => [e.name, e.assignments])} />;
  }
  if (id === 'dependencyHeavyTemplates') {
    return <Tbl head={['Template', 'Dependencies']} rows={ch.dependencyHeavyTemplates.map((t) => [t.title, t.count])} />;
  }
  if (id === 'recurrenceDistribution') {
    return <Tbl head={['Recurrence', 'Active Assignments']} rows={ch.recurrenceDistribution.map((r) => [r.frequency, r.count])} />;
  }
  if (id === 'overdueAssignmentCount') {
    return <div className="text-sm text-slate-600">Open the <b>Active Assignments</b> tab and filter by Active to triage individual assignments with pending tasks &gt; 7 days.</div>;
  }
  return null;
}

const Tbl = ({ head, rows }) => (
  <div className="overflow-x-auto max-h-96">
    <table className="table">
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={j === 0 ? 'font-medium' : ''}>{v}</td>)}</tr>)}</tbody>
    </table>
  </div>
);
