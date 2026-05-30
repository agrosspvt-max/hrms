import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtDate, monthKey } from '../../utils/helpers';

/**
 * HR Holiday Calendar
 *
 * Two panels side by side: a clickable month calendar on the left and a
 * year-wide holiday list on the right.  Clicking any day in the grid
 * either opens an "Add holiday" composer pre-filled with that date, or
 * (if the day already has a holiday) opens the edit/delete modal.
 */

const TYPE_BADGE = {
  national: 'badge-blue',
  company: 'badge-green',
  optional: 'badge-amber',
};

export default function Holidays() {
  const [month, setMonth] = useState(monthKey(new Date()));
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // { mode: 'create'|'edit', data }
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/holidays', { params: { year } });
      setItems(data);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year]);

  // Index holidays by YYYY-MM-DD for the calendar lookup
  const byDay = useMemo(() => {
    const out = {};
    for (const h of items) {
      const key = new Date(h.date).toISOString().substring(0, 10);
      out[key] = h;
    }
    return out;
  }, [items]);

  // Holidays in the selected month
  const inMonth = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    return items.filter((h) => {
      const d = new Date(h.date);
      return d.getUTCFullYear() === y && (d.getUTCMonth() + 1) === m;
    });
  }, [items, month]);

  const save = async (form) => {
    try {
      if (modal.mode === 'create') {
        await api.post('/holidays', form);
        toast.success('Holiday added');
      } else {
        await api.put(`/holidays/${modal.data._id}`, form);
        toast.success('Holiday updated');
      }
      setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const remove = async (id) => {
    if (!confirm('Delete this holiday?')) return;
    try {
      await api.delete(`/holidays/${id}`);
      toast.success('Deleted'); setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const onDayClick = (dateStr) => {
    const existing = byDay[dateStr];
    if (existing) setModal({ mode: 'edit', data: { ...existing, date: dateStr } });
    else setModal({ mode: 'create', data: { date: dateStr, name: '', description: '', type: 'company' } });
  };

  // Build calendar grid for the selected month
  const grid = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const startGap = first.getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { y, m, startGap, daysInMonth };
  }, [month]);

  if (loading) return <Loader />;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Holidays Calendar</h1>
          <p className="text-sm text-slate-500">
            Days listed here are non-working for every employee. No submission, no absent penalty.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <input
            className="input max-w-[180px]"
            type="month"
            value={month}
            onChange={(e) => { setMonth(e.target.value); setYear(Number(e.target.value.split('-')[0])); }}
          />
          <button className="btn-primary" onClick={() => setModal({
            mode: 'create',
            data: { date: new Date().toISOString().substring(0, 10), name: '', description: '', type: 'company' },
          })}>+ Add Holiday</button>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Calendar grid */}
        <div className="card lg:col-span-2">
          <div className="card-head">
            <div>
              <div className="text-sm font-semibold text-slate-900">
                {new Date(Date.UTC(grid.y, grid.m - 1, 1)).toLocaleString('default', { month: 'long', year: 'numeric' })}
              </div>
              <div className="text-xs text-slate-500">Click any day to add or edit its holiday.</div>
            </div>
            <span className="badge-blue">{inMonth.length} this month</span>
          </div>
          <div className="card-body">
            <div className="grid grid-cols-7 gap-2 text-xs text-slate-500 mb-2">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="text-center font-medium">{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-2">
              {Array.from({ length: grid.startGap }).map((_, i) => <div key={`g-${i}`} />)}
              {Array.from({ length: grid.daysInMonth }).map((_, i) => {
                const day = i + 1;
                const dateStr = `${grid.y}-${String(grid.m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const holiday = byDay[dateStr];
                return (
                  <button
                    key={day}
                    onClick={() => onDayClick(dateStr)}
                    className={`aspect-square rounded-lg border text-left p-2 transition ${
                      holiday
                        ? 'bg-purple-50 border-purple-200 hover:bg-purple-100'
                        : 'border-slate-100 hover:bg-slate-50'
                    }`}
                  >
                    <div className={`text-xs font-semibold ${holiday ? 'text-purple-700' : 'text-slate-700'}`}>{day}</div>
                    {holiday && (
                      <div className="mt-1 text-[10px] text-purple-700 leading-tight line-clamp-2">{holiday.name}</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Year list */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="text-sm font-semibold text-slate-900">Holidays in {year}</div>
              <div className="text-xs text-slate-500">{items.length} total</div>
            </div>
          </div>
          <div className="card-body p-0">
            {items.length === 0
              ? <EmptyState title="No holidays yet" subtitle="Click a day on the calendar to add one." />
              : <ul className="divide-y divide-slate-100">
                  {items.map((h) => (
                    <li key={h._id} className="flex items-center justify-between gap-3 p-3 hover:bg-slate-50">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-slate-900">{h.name}</span>
                          <span className={TYPE_BADGE[h.type] || 'badge-gray'}>{h.type}</span>
                        </div>
                        <div className="text-[11px] text-slate-500">{fmtDate(h.date)}</div>
                        {h.description && <div className="text-xs text-slate-600 mt-0.5 truncate">{h.description}</div>}
                      </div>
                      <div className="flex gap-1">
                        <button className="btn-ghost text-xs" onClick={() => setModal({
                          mode: 'edit',
                          data: { ...h, date: new Date(h.date).toISOString().substring(0, 10) },
                        })}>Edit</button>
                        <button className="btn-ghost text-xs text-red-600" onClick={() => remove(h._id)}>Delete</button>
                      </div>
                    </li>
                  ))}
                </ul>}
          </div>
        </div>
      </div>

      {modal && (
        <Modal
          open
          onClose={() => setModal(null)}
          title={modal.mode === 'create' ? 'Add Holiday' : 'Edit Holiday'}
          footer={<>
            {modal.mode === 'edit' && (
              <button className="btn-danger mr-auto" onClick={() => remove(modal.data._id)}>Delete</button>
            )}
            <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => save({
              date: modal.data.date,
              name: modal.data.name,
              description: modal.data.description,
              type: modal.data.type,
            })}>Save</button>
          </>}
        >
          <div className="space-y-3">
            <div>
              <label className="label">Date</label>
              <input
                className="input"
                type="date"
                value={modal.data.date}
                onChange={(e) => setModal({ ...modal, data: { ...modal.data, date: e.target.value } })}
              />
            </div>
            <div>
              <label className="label">Name</label>
              <input
                className="input"
                placeholder="e.g. Diwali, Independence Day"
                value={modal.data.name}
                onChange={(e) => setModal({ ...modal, data: { ...modal.data, name: e.target.value } })}
              />
            </div>
            <div>
              <label className="label">Type</label>
              <select className="input" value={modal.data.type} onChange={(e) => setModal({ ...modal, data: { ...modal.data, type: e.target.value } })}>
                <option value="company">Company holiday</option>
                <option value="national">National holiday</option>
                <option value="optional">Optional / restricted</option>
              </select>
            </div>
            <div>
              <label className="label">Description (optional)</label>
              <textarea
                className="input"
                rows={2}
                value={modal.data.description || ''}
                onChange={(e) => setModal({ ...modal, data: { ...modal.data, description: e.target.value } })}
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
