import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import StatCard from '../../components/StatCard.jsx';
import { Loader } from '../../components/Loader.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtDate } from '../../utils/helpers';

const TYPE_META = {
  birthday: { label: 'Birthday', icon: '🎂', cls: 'bg-pink-50 text-pink-700', dot: '#ec4899' },
  festival: { label: 'Festival', icon: '🎉', cls: 'bg-amber-50 text-amber-700', dot: '#f59e0b' },
  company_event: { label: 'Company Event', icon: '🏢', cls: 'bg-indigo-50 text-indigo-700', dot: '#6366f1' },
  custom: { label: 'Custom', icon: '📌', cls: 'bg-slate-100 text-slate-700', dot: '#94a3b8' },
  holiday: { label: 'Holiday', icon: '🏖', cls: 'bg-emerald-50 text-emerald-700', dot: '#10b981' },
};

const ymd = (d) => {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};
const monthLabel = (d) => d.toLocaleString('en-US', { month: 'long', year: 'numeric' });

/**
 * Events & Holidays - unified calendar page.  Shows the existing Holiday
 * model entries AND new Event occurrences (incl. yearly recurrence) and
 * auto-derived birthdays, color-coded by type.  HR/SA manage events here
 * via a modal; legacy /holidays page is still available for raw holiday
 * CRUD if needed.
 */
export default function EventsCalendar() {
  const toast = useToast();
  const { user } = useAuth();
  const canManage = user?.role === 'hr' || user?.role === 'super_admin';

  const today = new Date();
  const [cursor, setCursor] = useState(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
  const [items, setItems] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState(null);
  const [modal, setModal] = useState(null);

  const monthStart = cursor;
  const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));

  const load = async () => {
    setLoading(true);
    try {
      // Phase 73 -- /events is now the SHARED occurrence resolver:
      // it already returns Holiday-collection entries + Event
      // occurrences + auto-birthdays.  The separate /holidays fetch
      // is only kept so raw Holiday CRUD (edit / delete via the
      // legacy Holidays page) has a source of truth; the calendar
      // itself no longer needs to merge it — the resolver did.
      const [evs, hs, emp, deps, designs, an] = await Promise.all([
        api.get('/events', { params: { from: ymd(monthStart), to: ymd(new Date(monthEnd - 86400000)) } }).then((r) => r.data),
        api.get('/holidays').then((r) => r.data).catch(() => []),
        canManage ? api.get('/employees', { params: { status: 'active' } }).then((r) => r.data).catch(() => []) : Promise.resolve([]),
        canManage ? api.get('/departments').then((r) => r.data).catch(() => []) : Promise.resolve([]),
        canManage ? api.get('/designations').then((r) => r.data).catch(() => []) : Promise.resolve([]),
        canManage ? api.get('/events/analytics').then((r) => r.data).catch(() => null) : Promise.resolve(null),
      ]);
      setItems(evs); setHolidays(hs); setEmployees(emp); setDepartments(deps); setDesignations(designs); setAnalytics(an);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [cursor]);

  // Phase 73 -- /events/process-due was a no-op notification path; the
  // route has been removed.  Nothing else to do on mount.

  // Combine occurrences into a single day-keyed map for the grid.
  // `items` already contains Holiday-collection rows (type='holiday')
  // via the shared resolver, so no second merge is needed.
  const byDay = useMemo(() => {
    const m = new Map();
    const stamp = (date, item) => {
      const k = ymd(date);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(item);
    };
    items.forEach((ev) => {
      const start = new Date(ev.occStart);
      const end = ev.occEnd ? new Date(ev.occEnd) : start;
      for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) stamp(d, ev);
    });
    return m;
  }, [items]);

  // Calendar grid cells (always show 6 rows × 7 cols).
  const days = useMemo(() => {
    const firstDow = monthStart.getUTCDay(); // 0=Sun
    const cells = [];
    const gridStart = new Date(monthStart);
    gridStart.setUTCDate(gridStart.getUTCDate() - firstDow);
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(gridStart);
      d.setUTCDate(gridStart.getUTCDate() + i);
      cells.push(d);
    }
    return cells;
  }, [monthStart]);

  const isCurrentMonth = (d) => d.getUTCMonth() === monthStart.getUTCMonth();
  const isToday = (d) => ymd(d) === ymd(today);

  const upcoming = useMemo(() => {
    const t = new Date(today); t.setUTCHours(0, 0, 0, 0);
    return items
      .filter((ev) => new Date(ev.occEnd || ev.occStart) >= t)
      .sort((a, b) => new Date(a.occStart) - new Date(b.occStart))
      .slice(0, 8);
  }, [items, today]);

  const saveEvent = async (form) => {
    try {
      if (modal.mode === 'create') await api.post('/events', form);
      else await api.put(`/events/${modal.data._id}`, form);
      toast.success('Saved'); setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const delEvent = async (id) => {
    if (!confirm('Delete this event?')) return;
    try { await api.delete(`/events/${id}`); toast.success('Deleted'); setDrawer(null); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  /**
   * Phase 23.9 — Delete a birthday entry.
   *
   * Birthdays are auto-derived from User.dateOfBirth (no Event document
   * exists for them), so "delete" means PATCH the linked user to clear
   * their dateOfBirth.  Once cleared, eventController.birthdaysForRange
   * stops emitting occurrences and the entry disappears from the
   * calendar + upcoming widget on the next load.  The backend's
   * updateEmployee handler also wipes any same-day birthday
   * notifications already in the recipient inboxes so reminders stop
   * triggering immediately (Phase 23.9 backend addition).
   *
   * Confirmation matches the brief.  HR / SA only by way of the gating
   * on the Delete button itself (canManage check inside EventDrawer).
   */
  const delBirthday = async (ev) => {
    if (!ev?.linkedEmployee) {
      toast.error('This birthday is not linked to an employee account.');
      return;
    }
    if (!confirm('Are you sure you want to delete this birthday entry?')) return;
    try {
      await api.put(`/employees/${ev.linkedEmployee}`, { dateOfBirth: null });
      toast.success('Birthday deleted');
      setDrawer(null);
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Events &amp; Holidays</h1>
          <p className="text-sm text-slate-500">Birthdays, festivals, company events, custom events &amp; holidays — one calendar.</p>
        </div>
        {canManage && (
          <button className="btn-primary" onClick={() => setModal({ mode: 'create', data: { type: 'custom', title: '', startDate: ymd(new Date()), repeatYearly: false, isHoliday: false, audience: 'everyone', notifyOffsets: [0], notify: true } })}>+ New Event</button>
        )}
      </div>

      {canManage && analytics && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <StatCard label="Total Holidays" value={analytics.totals.holidays} accent="green" />
          <StatCard label="Total Festivals" value={analytics.totals.festivals} accent="amber" />
          <StatCard label="Company Events" value={analytics.totals.companyEvents} accent="blue" />
          <StatCard label="Custom Events" value={analytics.totals.custom} accent="brand" />
          <StatCard label="Birthdays on File" value={analytics.totals.birthdays} accent="red" />
          <StatCard label="Upcoming (90d)" value={analytics.upcoming.total} accent="brand" sub={`${analytics.upcoming.birthdays} birthdays · ${analytics.upcoming.holidays} holidays · ${analytics.upcoming.events} events`} />
        </div>
      )}

      {/* Month nav */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button className="btn-secondary !py-1" onClick={() => setCursor(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1)))}>‹</button>
          <div className="text-lg font-semibold text-slate-800">{monthLabel(cursor)}</div>
          <button className="btn-secondary !py-1" onClick={() => setCursor(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)))}>›</button>
          <button className="btn-ghost !py-1 text-xs" onClick={() => setCursor(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)))}>Today</button>
        </div>
        <div className="hidden md:flex items-center gap-3 text-[11px] text-slate-500">
          {Object.entries(TYPE_META).map(([k, m]) => (
            <span key={k} className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: m.dot }} />{m.icon} {m.label}</span>
          ))}
        </div>
      </div>

      {loading ? <Loader /> : (
        <div className="grid lg:grid-cols-3 gap-4">
          {/* Month grid */}
          <div className="lg:col-span-2 card">
            <div className="grid grid-cols-7 text-[10px] uppercase tracking-wide text-slate-500 px-2 pt-2">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="px-1 py-1">{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-px bg-slate-100 p-px rounded-b-2xl">
              {days.map((d) => {
                const k = ymd(d);
                const inMonth = isCurrentMonth(d);
                const list = byDay.get(k) || [];
                return (
                  <div key={k} className={`min-h-[88px] bg-white p-1.5 ${inMonth ? '' : 'opacity-40'} ${isToday(d) ? 'ring-2 ring-brand-400 ring-inset' : ''}`}>
                    <div className="text-[11px] text-slate-500">{d.getUTCDate()}</div>
                    <div className="mt-1 space-y-0.5">
                      {list.slice(0, 3).map((ev) => {
                        const m = TYPE_META[ev.type] || TYPE_META.custom;
                        return (
                          <button key={`${ev._id}-${k}`} onClick={() => setDrawer(ev)}
                            className={`block w-full truncate text-[10px] px-1.5 py-0.5 rounded text-left ${m.cls}`}>
                            <span className="mr-1">{m.icon}</span>{ev.title}
                          </button>
                        );
                      })}
                      {list.length > 3 && <div className="text-[10px] text-slate-400">+{list.length - 3} more</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Upcoming list */}
          <div className="card card-body">
            <div className="text-sm font-semibold text-slate-800 mb-2">Upcoming</div>
            {upcoming.length === 0 ? <div className="text-xs text-slate-400 italic">No upcoming events.</div> : (
              <div className="space-y-2">
                {upcoming.map((ev) => {
                  const m = TYPE_META[ev.type] || TYPE_META.custom;
                  return (
                    <button key={`${ev._id}-up`} onClick={() => setDrawer(ev)}
                      className="w-full text-left rounded-lg border border-slate-200 hover:border-brand-300 p-2 flex items-start gap-2">
                      <span className="text-lg leading-none">{m.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-800 truncate">{ev.title}</div>
                        <div className="text-[11px] text-slate-500">{fmtDate(ev.occStart)}{ev.occEnd && ev.occEnd !== ev.occStart ? ` → ${fmtDate(ev.occEnd)}` : ''}</div>
                      </div>
                      <span className={`badge ${m.cls}`}>{m.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {drawer && (
        <EventDrawer ev={drawer} onClose={() => setDrawer(null)} canManage={canManage}
          onEdit={() => {
            // Phase 23.1: birthdays are auto-derived from User.dateOfBirth
            // so "edit" routes to a dedicated BirthdayEditModal that
            // patches the linked user, NOT the Event collection.  Holidays
            // remain managed by the legacy /holidays page (kept silent).
            if (String(drawer._id).startsWith('holiday:')) return;
            if (String(drawer._id).startsWith('birthday:')) {
              setModal({ mode: 'edit-birthday', data: { ...drawer } });
              setDrawer(null);
              return;
            }
            setModal({ mode: 'edit', data: { ...drawer, startDate: ymd(drawer.occStart), endDate: drawer.occEnd ? ymd(drawer.occEnd) : '' } });
            setDrawer(null);
          }}
          // Phase 23.9: birthdays route to delBirthday (clears the linked
          // user's dateOfBirth); all other events use the Event delete API.
          onDelete={() => String(drawer._id).startsWith('birthday:')
            ? delBirthday(drawer)
            : delEvent(drawer._id)} />
      )}
      {modal && modal.mode === 'edit-birthday' && (
        <BirthdayEditModal modal={modal} onCancel={() => setModal(null)}
          onSave={async (form) => {
            try {
              await api.put(`/employees/${form.linkedEmployee}`, { dateOfBirth: form.dateOfBirth || null });
              toast.success('Birthday updated'); setModal(null); load();
            } catch (err) { toast.error(errMsg(err)); }
          }} />
      )}
      {modal && modal.mode !== 'edit-birthday' && (
        <EventModal modal={modal} employees={employees} departments={departments} designations={designations}
          onCancel={() => setModal(null)} onSave={saveEvent} />
      )}
    </div>
  );
}

function EventDrawer({ ev, onClose, canManage, onEdit, onDelete }) {
  const m = TYPE_META[ev.type] || TYPE_META.custom;
  const isBirthday = ev.type === 'birthday';
  const isHoliday = ev.type === 'holiday';
  return (
    <Modal open onClose={onClose} size="lg" title={ev.title}
      footer={<div className="flex justify-end gap-2 w-full">
        {/* Phase 23.1 + 23.9: HR / SA can edit AND delete birthdays the
            same way as other events.  Delete on a birthday clears the
            linked user's dateOfBirth (handled by onDelete routing in the
            parent).  Holiday occurrences keep their existing behaviour
            (managed by the legacy Holiday module). */}
        {canManage && !isHoliday && <>
          <button className="btn-ghost text-red-600" onClick={onDelete}>Delete</button>
          <button className="btn-secondary" onClick={onEdit}>Edit</button>
        </>}
        <button className="btn-primary" onClick={onClose}>Close</button>
      </div>}>
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{m.icon}</span>
          <span className={`badge ${m.cls}`}>{m.label}</span>
          {ev.isHoliday && <span className="badge-green">Company Holiday — work stops</span>}
          {ev.repeatYearly && <span className="badge-blue">Repeats yearly</span>}
        </div>
        {ev.description && <div className="text-slate-700 whitespace-pre-wrap">{ev.description}</div>}
        <div className="grid sm:grid-cols-2 gap-3">
          <div><span className="text-slate-400">When:</span> {fmtDate(ev.occStart)}{ev.occEnd && ev.occEnd !== ev.occStart ? ` → ${fmtDate(ev.occEnd)}` : ''}</div>
          {ev.audience && <div><span className="text-slate-400">Audience:</span> <span className="capitalize">{ev.audience}</span></div>}
          {ev.notifyOffsets && ev.notifyOffsets.length > 0 && (
            <div><span className="text-slate-400">Reminders:</span> {ev.notifyOffsets.map((n) => n === 0 ? 'On day' : `${n}d before`).join(' · ')}</div>
          )}
        </div>
        {isBirthday && <div className="text-[11px] text-slate-500 italic">Birthdays never stop work generation.</div>}
        {isHoliday && <div className="text-[11px] text-slate-500 italic">Managed in the legacy Holiday module.</div>}
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------------------
 * Phase 23.1 — Birthday edit modal
 *
 * Birthdays are auto-derived from User.dateOfBirth (see eventController
 * .birthdaysForRange).  Editing a birthday from the Events & Holidays
 * page therefore means PATCHing the linked user's dateOfBirth via
 * PUT /api/employees/:id.  No Event document exists for these rows.
 *
 * The drawer payload carries linkedEmployee (User._id), linkedEmployeeName
 * and occStart (the occurrence date for the year being viewed).  We seed
 * the date-of-birth input from occStart so HR doesn't see a year-1900
 * placeholder if dateOfBirth wasn't on the drawer.
 * -------------------------------------------------------------------- */
function BirthdayEditModal({ modal, onCancel, onSave }) {
  const ev = modal.data || {};
  const [dob, setDob] = useState(() => ev.occStart ? ymd(ev.occStart) : '');
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onCancel} size="md" title={`Edit Birthday — ${ev.linkedEmployeeName || ev.title || ''}`}
      footer={<>
        <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-primary" disabled={!dob || busy}
          onClick={async () => { setBusy(true); await onSave({ linkedEmployee: ev.linkedEmployee, dateOfBirth: dob }); setBusy(false); }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </>}>
      <div className="space-y-3 text-sm">
        <div className="text-slate-600">
          Update the employee's date of birth.  The change reflects everywhere
          birthdays are displayed (calendar, upcoming widget, notifications).
        </div>
        <div>
          <label className="label">Date of birth</label>
          <input className="input" type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
          <div className="text-[11px] text-slate-500 mt-1">
            Only the month and day matter for recurring birthday display.  The year is stored on the employee profile.
          </div>
        </div>
        {!ev.linkedEmployee && (
          <div className="text-[11px] text-red-600">
            Cannot edit — this birthday entry is missing its employee link.  Update the date-of-birth directly on the Employee profile instead.
          </div>
        )}
      </div>
    </Modal>
  );
}

function EventModal({ modal, employees, departments, designations, onCancel, onSave }) {
  const [f, setF] = useState(() => ({
    type: modal.data.type || 'custom',
    title: modal.data.title || '',
    description: modal.data.description || '',
    startDate: modal.data.startDate || '',
    endDate: modal.data.endDate || '',
    repeatYearly: !!modal.data.repeatYearly,
    isHoliday: !!modal.data.isHoliday,
    audience: modal.data.audience || 'everyone',
    audienceDepartment: modal.data.audienceDepartment || '',
    audienceDesignation: modal.data.audienceDesignation || '',
    audienceEmployees: modal.data.audienceEmployees || [],
    notify: modal.data.notify !== false,
    notifyOffsets: modal.data.notifyOffsets || [0],
    linkedEmployee: modal.data.linkedEmployee || '',
  }));
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const isBirthday = f.type === 'birthday';
  // Birthdays never set isHoliday.
  useEffect(() => { if (isBirthday && f.isHoliday) set('isHoliday', false); /* eslint-disable-next-line */ }, [isBirthday]);

  const holidayLabel = f.type === 'company_event' ? 'Work stops on this event' : 'Company holiday — work stops';

  const toggleOffset = (n) => set('notifyOffsets', f.notifyOffsets.includes(n) ? f.notifyOffsets.filter((x) => x !== n) : [...f.notifyOffsets, n].sort());

  return (
    <Modal open onClose={onCancel} size="lg" title={modal.mode === 'create' ? 'New Event' : 'Edit Event'}
      footer={<><button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" disabled={!f.title || !f.startDate} onClick={() => onSave(f)}>Save</button></>}>
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="label">Type</label>
            <select className="input" value={f.type} onChange={(e) => set('type', e.target.value)}>
              <option value="custom">📌 Custom Event</option>
              <option value="festival">🎉 Festival</option>
              <option value="company_event">🏢 Company Event</option>
              <option value="birthday">🎂 Birthday</option>
            </select>
          </div>
          <div>
            <label className="label">Title</label>
            <input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} />
          </div>
          <div>
            <label className="label">Start date</label>
            <input className="input" type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </div>
          <div>
            <label className="label">End date (optional)</label>
            <input className="input" type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} />
          </div>
          {isBirthday && (
            <div className="md:col-span-2">
              <label className="label">Employee</label>
              <select className="input" value={f.linkedEmployee} onChange={(e) => set('linkedEmployee', e.target.value)}>
                <option value="">— Select —</option>
                {employees.map((u) => <option key={u._id} value={u._id}>{u.name} · {u.employeeId}</option>)}
              </select>
              <div className="text-[11px] text-slate-500 mt-1">Employees with a date-of-birth on their profile already appear automatically — this is only for overrides.</div>
            </div>
          )}
          <div className="md:col-span-2">
            <label className="label">Description</label>
            <textarea className="input" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
          </div>
        </div>

        <div className="flex items-center gap-6 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={f.repeatYearly} onChange={(e) => set('repeatYearly', e.target.checked)} />
            Repeat every year
          </label>
          {!isBirthday && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={f.isHoliday} onChange={(e) => set('isHoliday', e.target.checked)} />
              {holidayLabel}
            </label>
          )}
          {isBirthday && <div className="text-[11px] text-slate-500 italic">Birthdays never stop work generation.</div>}
        </div>

        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="label">Audience</label>
            <select className="input" value={f.audience} onChange={(e) => set('audience', e.target.value)}>
              <option value="everyone">Everyone</option>
              <option value="department">Department</option>
              <option value="designation">Designation</option>
              <option value="employees">Selected employees</option>
            </select>
          </div>
          <div>
            <label className="label">Reminders</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {[0, 1, 3, 7].map((n) => (
                <button key={n} type="button" onClick={() => toggleOffset(n)}
                  className={`px-3 py-1 rounded-full text-xs border ${f.notifyOffsets.includes(n) ? 'bg-brand-600 text-white border-brand-600' : 'bg-white border-slate-200 text-slate-600'}`}>
                  {n === 0 ? 'On day' : `${n}d before`}
                </button>
              ))}
            </div>
          </div>
          {f.audience === 'department' && (
            <div>
              <label className="label">Department</label>
              <select className="input" value={f.audienceDepartment} onChange={(e) => set('audienceDepartment', e.target.value)}>
                <option value="">—</option>
                {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
              </select>
            </div>
          )}
          {f.audience === 'designation' && (
            <div>
              <label className="label">Designation</label>
              <select className="input" value={f.audienceDesignation} onChange={(e) => set('audienceDesignation', e.target.value)}>
                <option value="">—</option>
                {designations.map((d) => <option key={d._id} value={d._id}>{d.title}</option>)}
              </select>
            </div>
          )}
          {f.audience === 'employees' && (
            <div className="md:col-span-2">
              <label className="label">Recipients</label>
              <select multiple className="input h-32" value={f.audienceEmployees} onChange={(e) => set('audienceEmployees', [...e.target.selectedOptions].map((o) => o.value))}>
                {employees.map((u) => <option key={u._id} value={u._id}>{u.name} · {u.employeeId}</option>)}
              </select>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
