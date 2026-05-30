import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  AreaChart, Area, Cell,
} from 'recharts';
import api from '../../api/axios';
import StatCard from '../../components/StatCard.jsx';
import { Loader } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';

const STATUS_COLORS = {
  Present: '#22c55e', Absent: '#ef4444', 'Half Day': '#f59e0b',
  'Paid Leave': '#3b82f6', 'Unpaid Leave': '#f97316', 'Weekly Off': '#94a3b8',
};

/** ISO-ish week key (UTC) for trend bucketing. */
const weekKey = (d) => {
  const dt = new Date(d);
  const onejan = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((dt - onejan) / 86400000) + onejan.getUTCDay() + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
};

export default function EmployeeAttendanceTab({ employee }) {
  const toast = useToast();
  const [range, setRange] = useState('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = {};
    if (range === 'custom') { if (!from || !to) return; params.from = from; params.to = to; }
    else params.range = range;
    setLoading(true);
    api.get(`/employees/${employee._id}/attendance`, { params })
      .then(({ data }) => setData(data)).catch((e) => toast.error(errMsg(e)))
      .finally(() => setLoading(false));
    /* eslint-disable-next-line */
  }, [employee._id, range, from, to]);

  const pct = data && data.workingDays > 0 ? Math.round((data.payableDays / data.workingDays) * 1000) / 10 : 0;
  const halfDays = data ? (data.halfPaidDays || 0) + (data.halfUnpaidDays || 0) : 0;

  const distribution = data ? [
    { name: 'Present', value: data.presentDays || 0 },
    { name: 'Absent', value: data.absentDays || 0 },
    { name: 'Half Day', value: halfDays },
    { name: 'Paid Leave', value: data.paidLeaves || 0 },
    { name: 'Unpaid Leave', value: data.unpaidLeaves || 0 },
    { name: 'Weekly Off', value: data.weeklyOffDays || 0 },
  ] : [];

  // Weekly present-rate trend from perDay.
  const trend = (() => {
    if (!data?.perDay) return [];
    const buckets = new Map();
    for (const d of data.perDay) {
      if (d.status === 'weekly_off' || d.status === 'holiday' || d.status === 'future') continue;
      const k = weekKey(d.date);
      if (!buckets.has(k)) buckets.set(k, { week: k, working: 0, present: 0 });
      const b = buckets.get(k);
      b.working += 1;
      if (d.status === 'present' || d.status === 'full_paid' || d.status === 'half_paid') b.present += 1;
      else if (d.status === 'half_unpaid') b.present += 0.5;
    }
    return [...buckets.values()].map((b) => ({ week: b.week, rate: b.working ? Math.round((b.present / b.working) * 100) : 0 }));
  })();

  return (
    <div className="space-y-4">
      <div className="card card-body flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Period</label>
          <select className="input max-w-[160px]" value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="30">This month (30d)</option>
            <option value="90">Last 90 days</option>
            <option value="365">This year</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        {range === 'custom' && (
          <>
            <div><label className="label">From</label><input className="input max-w-[150px]" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></div>
            <div><label className="label">To</label><input className="input max-w-[150px]" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
          </>
        )}
      </div>

      {loading || !data ? <Loader /> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            <StatCard label="Attendance %" value={`${pct}%`} accent={pct >= 90 ? 'green' : pct >= 75 ? 'amber' : 'red'} />
            <StatCard label="Present" value={data.presentDays || 0} accent="green" />
            <StatCard label="Absent" value={data.absentDays || 0} accent="red" />
            <StatCard label="Half Days" value={halfDays} accent="amber" />
            <StatCard label="Paid Leave" value={data.paidLeaves || 0} accent="blue" />
            <StatCard label="Unpaid Leave" value={data.unpaidLeaves || 0} accent="red" />
            <StatCard label="Late Submissions" value={data.lateSubmissions || 0} accent="amber" />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="card card-body">
              <h3 className="text-sm font-semibold text-slate-800 mb-2">Attendance Distribution</h3>
              <div style={{ width: '100%', height: 240 }}>
                <ResponsiveContainer>
                  <BarChart data={distribution}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {distribution.map((d) => <Cell key={d.name} fill={STATUS_COLORS[d.name] || '#6366f1'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card card-body">
              <h3 className="text-sm font-semibold text-slate-800 mb-2">Weekly Attendance Trend</h3>
              <div style={{ width: '100%', height: 240 }}>
                <ResponsiveContainer>
                  <AreaChart data={trend}>
                    <defs>
                      <linearGradient id="attTrend" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#22c55e" stopOpacity={0.5} />
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="week" tick={{ fontSize: 9 }} />
                    <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                    <Tooltip formatter={(v) => `${v}%`} />
                    <Area type="monotone" dataKey="rate" stroke="#16a34a" fill="url(#attTrend)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
