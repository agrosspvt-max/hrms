import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  AreaChart, Area, Cell,
} from 'recharts';
import api from '../../api/axios';
import StatCard from '../../components/StatCard.jsx';
import { Loader } from '../../components/Loader.jsx';

const RED = '#ef4444';
const ORANGE = '#f97316';
const AGING_COLORS = { '0-2d': '#fbbf24', '3-7d': '#f97316', '8-14d': '#ef4444', '15d+': '#b91c1c' };
const rateAccent = (r) => (r >= 50 ? 'red' : r >= 25 ? 'amber' : 'green');

const ChartCard = ({ title, subtitle, children, height = 240 }) => (
  <div className="card card-body">
    <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
    {subtitle && <div className="text-[11px] text-slate-400 mb-1">{subtitle}</div>}
    <div style={{ width: '100%', height }} className="mt-2"><ResponsiveContainer>{children}</ResponsiveContainer></div>
  </div>
);

/**
 * Per-employee PENDENCY analytics (never submission-based).  Counts only
 * work explicitly marked Pending; Work Not Available + non-submitted work
 * are excluded by the backend.  Dependency-blocked work is shown separately.
 */
export default function EmployeePendency({ employee }) {
  const deptId = employee.department?._id || '';
  const [range, setRange] = useState('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [templateType, setTemplateType] = useState('');
  const [recurrence, setRecurrence] = useState('');
  const [compareDept, setCompareDept] = useState(!!deptId);

  const [data, setData] = useState(null);
  const [deptData, setDeptData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = { employee: employee._id, range };
    if (range === 'custom') { if (!from || !to) return; params.from = from; params.to = to; }
    if (templateType) params.templateType = templateType;
    if (recurrence) params.recurrence = recurrence;
    setLoading(true);
    api.get('/dashboard/hr/pendency', { params })
      .then(({ data }) => setData(data)).catch(() => setData(null))
      .finally(() => setLoading(false));

    // Department average for comparison (same filters, no employee scope).
    if (compareDept && deptId) {
      const dparams = { ...params, department: deptId };
      delete dparams.employee;
      api.get('/dashboard/hr/pendency', { params: dparams })
        .then(({ data }) => setDeptData(data)).catch(() => setDeptData(null));
    } else {
      setDeptData(null);
    }
  }, [employee._id, range, from, to, templateType, recurrence, compareDept, deptId]);

  const c = data?.cards;
  const ch = data?.charts;
  const dep = data?.dependency;
  const overdue = ch ? ch.aging.filter((a) => a.bucket === '8-14d' || a.bucket === '15d+').reduce((s, a) => s + a.count, 0) : 0;
  const completionRate = c ? Math.max(0, Math.round((100 - c.avgPendencyRate) * 10) / 10) : 0;

  return (
    <div className="space-y-4">
      {/* Filters */}
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
        {range === 'custom' && (
          <>
            <div><label className="label">From</label><input className="input max-w-[150px]" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></div>
            <div><label className="label">To</label><input className="input max-w-[150px]" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
          </>
        )}
        <div>
          <label className="label">Template type</label>
          <select className="input max-w-[150px]" value={templateType} onChange={(e) => setTemplateType(e.target.value)}>
            <option value="">All types</option>
            <option value="task">Task</option>
            <option value="excel">Excel</option>
            <option value="sheet">Spreadsheet</option>
          </select>
        </div>
        <div>
          <label className="label">Recurrence</label>
          <select className="input max-w-[150px]" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
            <option value="">All recurrences</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="one-time">One-time</option>
          </select>
        </div>
        {deptId && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={compareDept} onChange={(e) => setCompareDept(e.target.checked)} />
            Compare to department
          </label>
        )}
      </div>

      {loading || !data ? <Loader /> : (
        <>
          {/* Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            <StatCard label="Pendency Rate" value={`${c.avgPendencyRate}%`} accent={rateAccent(c.avgPendencyRate)}
              sub={deptData ? `Dept avg ${deptData.cards.avgPendencyRate}%` : `${c.totalPendingTasks}/${c.totalPendingTasks + c.totalCompletedTasks} units`} />
            <StatCard label="Total Pending" value={c.totalPendingTasks} accent="red" />
            <StatCard label="Completion Rate" value={`${completionRate}%`} accent="green" sub={`${c.totalCompletedTasks} done`} />
            <StatCard label="Dependency Blocked" value={c.dependencyBlockedTasks} accent="amber" sub="open hand-offs" />
            <StatCard label="Overdue (>7d)" value={overdue} accent="red" />
            <StatCard label="Collaborative" value={dep.totalDependencies} accent="blue" sub={`${dep.openDependencies} open`} />
          </div>

          {/* Department comparison banner */}
          {deptData && (
            <div className="card card-body flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-slate-700">
                <b>{employee.name}</b> pendency <span className={`font-semibold ${c.avgPendencyRate >= deptData.cards.avgPendencyRate ? 'text-red-600' : 'text-green-600'}`}>{c.avgPendencyRate}%</span>
                {' '}vs <b>{employee.department?.name}</b> average <span className="font-semibold text-slate-700">{deptData.cards.avgPendencyRate}%</span>
              </div>
              <div className="text-xs text-slate-500">
                {c.avgPendencyRate > deptData.cards.avgPendencyRate
                  ? 'Above the department average — more pending work than peers.'
                  : c.avgPendencyRate < deptData.cards.avgPendencyRate
                    ? 'Below the department average — fewer pendencies than peers.'
                    : 'On par with the department average.'}
              </div>
            </div>
          )}

          {/* Charts */}
          <div className="grid md:grid-cols-2 gap-4">
            <ChartCard title="Pendency Trend" subtitle={`${data.range.from} → ${data.range.to}`}>
              <AreaChart data={ch.pendencyTrend}>
                <defs>
                  <linearGradient id="empPend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={RED} stopOpacity={0.5} />
                    <stop offset="95%" stopColor={RED} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Area type="monotone" dataKey="pending" stroke={RED} fill="url(#empPend)" strokeWidth={2} />
              </AreaChart>
            </ChartCard>

            <ChartCard title="Pending Aging" subtitle="How long work has been pending">
              <BarChart data={ch.aging}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {ch.aging.map((a) => <Cell key={a.bucket} fill={AGING_COLORS[a.bucket] || ORANGE} />)}
                </Bar>
              </BarChart>
            </ChartCard>
          </div>

          <ChartCard title="Weekly vs Monthly Pendency" subtitle="Pending units by recurrence" height={220}>
            <BarChart data={ch.weeklyVsMonthly}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="frequency" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="pending" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartCard>
        </>
      )}
    </div>
  );
}
