import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/axios';
import { fmtDate } from '../utils/helpers';

const TYPE = {
  birthday: { icon: '🎂', cls: 'bg-pink-50 text-pink-700' },
  festival: { icon: '🎉', cls: 'bg-amber-50 text-amber-700' },
  company_event: { icon: '🏢', cls: 'bg-indigo-50 text-indigo-700' },
  custom: { icon: '📌', cls: 'bg-slate-100 text-slate-700' },
  holiday: { icon: '🏖', cls: 'bg-emerald-50 text-emerald-700' },
};

const ymd = (d) => {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};

/**
 * Compact dashboard widget — Today's Birthdays plus the next handful of
 * events / holidays / festivals.  Fires a no-op pass on /events/process-due
 * so the dashboard visit double-acts as the trigger for any due birthday
 * or event notifications.
 */
export default function UpcomingEventsWidget({ limit = 6, days = 30 }) {
  const [events, setEvents] = useState([]);
  const [today, setToday] = useState([]);

  useEffect(() => {
    // Phase 73 -- /events/process-due removed; the widget just reads
    // the shared resolver endpoints below.
    api.get('/events/upcoming', { params: { days } }).then((r) => setEvents(r.data || [])).catch(() => setEvents([]));
    api.get('/events/birthdays/today').then((r) => setToday(r.data || [])).catch(() => setToday([]));
  }, [days]);

  const t = ymd(new Date());
  const upcoming = events.filter((ev) => !(ev.type === 'birthday' && ymd(ev.occStart) === t)).slice(0, limit);

  return (
    <div className="card card-body">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-slate-800">Upcoming Events</h2>
        <Link to="/events" className="text-[11px] text-brand-600 hover:underline">Open calendar →</Link>
      </div>

      {today.length > 0 && (
        <div className="rounded-lg bg-pink-50 border border-pink-100 p-2 mb-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-pink-700">🎂 Today's birthdays</div>
          <div className="text-sm text-slate-800 mt-0.5">
            {today.map((b) => b.linkedEmployeeName || b.title.replace("'s Birthday", '')).join(', ')}
          </div>
        </div>
      )}

      {upcoming.length === 0 ? (
        <div className="text-xs text-slate-400 italic">No upcoming events in the next {days} days.</div>
      ) : (
        <div className="space-y-1.5">
          {upcoming.map((ev) => {
            const m = TYPE[ev.type] || TYPE.custom;
            return (
              <Link key={`${ev._id}-w`} to="/events" className="flex items-center gap-2 rounded-lg border border-slate-100 hover:border-brand-300 px-2 py-1.5">
                <span className="text-base shrink-0">{m.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-800 truncate">{ev.title}</div>
                  <div className="text-[10px] text-slate-500">{fmtDate(ev.occStart)}</div>
                </div>
                {ev.isHoliday && <span className="badge-green">Holiday</span>}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
