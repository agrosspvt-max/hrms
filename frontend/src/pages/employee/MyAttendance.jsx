import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader } from '../../components/Loader.jsx';
import StatCard from '../../components/StatCard.jsx';
import { monthKey } from '../../utils/helpers';

const STATUS_STYLE = {
  present: 'bg-green-500',
  half_paid: 'bg-blue-500',
  half_unpaid: 'bg-orange-500',
  full_paid: 'bg-purple-500',
  full_unpaid: 'bg-red-500',
  absent: 'bg-red-800',
  weekly_off: 'bg-slate-300',
  holiday: 'bg-indigo-400',
  future: 'bg-slate-100 border border-slate-200',
};

const STATUS_LABEL = {
  present: 'Present',
  half_paid: 'Half Day (Paid)',
  half_unpaid: 'Half Day (Unpaid)',
  full_paid: 'Full Day Leave (Paid)',
  full_unpaid: 'Full Day Leave (Unpaid)',
  absent: 'Absent',
  weekly_off: 'Weekly Off',
  holiday: 'Holiday',
  future: 'Upcoming',
};

export default function MyAttendance() {
  const [m, setM] = useState(monthKey(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const [y, mo] = m.split('-').map(Number);
    api.get('/attendance/mine', { params: { year: y, month: mo } })
      .then(({ data }) => { setData(data); setLoading(false); });
  }, [m]);

  if (loading || !data) return <Loader />;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h1 className="text-2xl font-bold">My Attendance</h1>
        <input className="input max-w-[180px]" type="month" value={m} onChange={(e) => setM(e.target.value)} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Working Days" value={data.workingDays} accent="brand" />
        <StatCard label="Present" value={data.presentDays} accent="green" />
        <StatCard label="Half Day (Paid)" value={data.halfPaidDays || 0} accent="blue" />
        <StatCard label="Half Day (Unpaid)" value={data.halfUnpaidDays || 0} accent="amber" />
        <StatCard label="Full Leave (Paid)" value={data.paidLeaves} accent="brand" />
        <StatCard label="Full Leave (Unpaid)" value={data.unpaidLeaves} accent="red" />
        <StatCard label="Absent" value={data.absentDays} accent="red" />
        <StatCard label="Holidays" value={data.holidayDays || 0} accent="brand" />
      </div>

      <div className="card card-body">
        <h2 className="text-sm font-semibold mb-3">Daily Status</h2>
        <div className="grid grid-cols-7 gap-2 text-xs text-slate-500 mb-2">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="text-center font-medium">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-2">
          {(() => {
            const first = new Date(data.perDay[0]?.date);
            const startGap = first.getUTCDay();
            return Array.from({ length: startGap }).map((_, i) => <div key={`g-${i}`} />);
          })()}
          {data.perDay.map((d) => {
            const isFuture = d.status === 'future';
            return (
              <div
                key={d.date}
                className={`aspect-square rounded-lg flex flex-col items-center justify-center text-[11px] ${
                  isFuture ? 'border border-dashed border-slate-200 bg-slate-50/40' : 'border border-slate-100'
                }`}
                title={d.holidayName || STATUS_LABEL[d.status] || d.status}
              >
                <div className={`w-3 h-3 rounded-full mb-1 ${STATUS_STYLE[d.status] || 'bg-slate-200'}`} />
                <div className={`font-semibold ${isFuture ? 'text-slate-400' : ''}`}>{new Date(d.date).getUTCDate()}</div>
                <div className={`text-[10px] truncate w-full text-center px-1 ${isFuture ? 'text-slate-300' : 'text-slate-500'}`}>
                  {d.status === 'holiday' ? (d.holidayName || 'Holiday') : (STATUS_LABEL[d.status] || '')}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-3 mt-4 text-xs text-slate-600">
          {Object.entries(STATUS_STYLE).map(([k, c]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className={`w-2.5 h-2.5 rounded-full ${c}`} /> {STATUS_LABEL[k]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
