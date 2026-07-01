import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader } from '../../components/Loader.jsx';
import StatCard from '../../components/StatCard.jsx';
import { monthKey } from '../../utils/helpers';
import { subscribe } from '../../realtime';
import MonthPicker from '../../components/MonthPicker.jsx';
// Phase 50 — click a calendar day to open its notes.  The modal is
// shared with the HR/SA "Notes" tab so a single source of truth handles
// permissions, lock state, and priority styling.
import AttendanceNotesModal from '../../components/AttendanceNotesModal.jsx';

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
  // Phase 16: today, no submission yet -- work in progress.
  ongoing: 'bg-amber-400',
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
  ongoing: 'Ongoing',
};

export default function MyAttendance() {
  const [m, setM] = useState(monthKey(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // Phase 50 — per-day note counts for the visible month.  { 'YYYY-MM-DD': {count, importantCount, pendingCount, firstTitle} }
  const [noteMap, setNoteMap] = useState({});
  const [noteModalDate, setNoteModalDate] = useState(null);

  // Phase 47 -- extracted so the realtime subscription can reuse it.
  const load = () => {
    setLoading(true);
    const [y, mo] = m.split('-').map(Number);
    api.get('/attendance/mine', { params: { year: y, month: mo } })
      .then(({ data }) => { setData(data); setLoading(false); });
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [m]);
  // HR edits or clears an attendance row -> the visible month refreshes.
  useEffect(() => subscribe('attendance:changed', load), [m]);

  // Phase 50 -- refresh the note-count map whenever the visible month
  // changes.  The backend endpoint is cheap (indexed, tiny projection),
  // so we call it on mount + after every modal close.
  const loadNotes = () => {
    if (!data?.perDay?.length) return;
    const from = data.perDay[0]?.date;
    const to   = data.perDay[data.perDay.length - 1]?.date;
    if (!from || !to) return;
    api.get('/attendance-notes/day-summary', {
      params: {
        from: new Date(from).toISOString().slice(0, 10),
        to:   new Date(to).toISOString().slice(0, 10),
      },
    })
      .then(({ data: rows }) => {
        const map = {};
        for (const r of rows || []) map[r.date] = r;
        setNoteMap(map);
      })
      .catch(() => setNoteMap({}));
  };
  useEffect(() => { loadNotes(); /* eslint-disable-next-line */ }, [data]);

  if (loading || !data) return <Loader />;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h1 className="text-2xl font-bold">My Attendance</h1>
        <MonthPicker value={m} onChange={setM} />
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
        <h2 className="text-sm font-semibold mb-3 flex items-center justify-between">
          <span>Daily Status</span>
          <span className="text-[11px] font-normal text-slate-500">
            Click any date to view / add notes
          </span>
        </h2>
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
            const dayKey = new Date(d.date).toISOString().slice(0, 10);
            const noteInfo = noteMap[dayKey];
            // Phase 50 -- tooltip merges attendance label + note info.
            const noteTitle = noteInfo
              ? `\n${noteInfo.count} note${noteInfo.count === 1 ? '' : 's'}${noteInfo.firstTitle ? ` — ${noteInfo.firstTitle}` : ''}`
              : '';
            return (
              <button
                type="button"
                key={d.date}
                onClick={() => setNoteModalDate(dayKey)}
                className={`aspect-square rounded-lg flex flex-col items-center justify-center text-[11px] relative transition ${
                  isFuture ? 'border border-dashed border-slate-200 bg-slate-50/40' : 'border border-slate-100'
                } hover:ring-2 hover:ring-brand-200 cursor-pointer`}
                title={`${d.holidayName || STATUS_LABEL[d.status] || d.status}${noteTitle}`}
              >
                {/* Phase 50 -- small pin overlays the attendance dot;
                    attendance color is untouched.  Amber for
                    important-pending, brand for normal-pending, grey
                    for all-completed. */}
                {noteInfo && (
                  <span
                    className={`absolute top-1 right-1 inline-flex items-center justify-center min-w-[14px] h-[14px] rounded-full px-1 text-[9px] font-bold text-white ${
                      noteInfo.importantCount > 0 && noteInfo.pendingCount > 0
                        ? 'bg-amber-500'
                        : noteInfo.pendingCount > 0
                          ? 'bg-brand-500'
                          : 'bg-slate-400'
                    }`}
                    aria-label={`${noteInfo.count} notes`}
                  >
                    {noteInfo.count}
                  </span>
                )}
                <div className={`w-3 h-3 rounded-full mb-1 ${STATUS_STYLE[d.status] || 'bg-slate-200'}`} />
                <div className={`font-semibold ${isFuture ? 'text-slate-400' : ''}`}>{new Date(d.date).getUTCDate()}</div>
                <div className={`text-[10px] truncate w-full text-center px-1 ${isFuture ? 'text-slate-300' : 'text-slate-500'}`}>
                  {d.status === 'holiday' ? (d.holidayName || 'Holiday') : (STATUS_LABEL[d.status] || '')}
                </div>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-3 mt-4 text-xs text-slate-600">
          {Object.entries(STATUS_STYLE).map(([k, c]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className={`w-2.5 h-2.5 rounded-full ${c}`} /> {STATUS_LABEL[k]}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-brand-500" /> Has notes
          </span>
        </div>
      </div>

      <AttendanceNotesModal
        open={!!noteModalDate}
        date={noteModalDate}
        onClose={() => setNoteModalDate(null)}
        onChanged={loadNotes}
      />
    </div>
  );
}
