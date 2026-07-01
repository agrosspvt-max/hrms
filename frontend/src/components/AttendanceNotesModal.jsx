import { useEffect, useState } from 'react';
import api from '../api/axios';
import Modal from './Modal.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { errMsg, fmtDate } from '../utils/helpers';

/**
 * AttendanceNotesModal — Phase 50.
 *
 * Shared component used from:
 *   - MyAttendance (employee clicks a calendar day)
 *   - HR EmployeeAttendance Notes tab (HR/SA clicks a day inside the
 *     expanded employee card)
 *
 * Props:
 *   open           bool
 *   onClose        () => void
 *   date           'YYYY-MM-DD' (day the user clicked)
 *   employeeId     the calendar's owner.  Employees pass their own id
 *                  (or nothing — the backend clamps).  HR/SA must pass
 *                  the target employee id.
 *   employeeName   optional label shown in the modal title.
 *   onChanged      () => void  parent refresh hook (called after any
 *                  successful create / patch / delete).
 *
 * Preserves the existing UI theme (input / btn-primary / badge-*).
 * Never fires notifications — notes are silent, per spec.
 */
export default function AttendanceNotesModal({
  open, onClose, date, employeeId, employeeName, onChanged,
}) {
  const { user } = useAuth();
  const toast = useToast();
  const isAdmin = user?.role === 'hr' || user?.role === 'super_admin';

  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState(null);
  // Phase 51 -- the compose form now carries its own `date` so users
  // can plan notes for ANY day (past / present / future) regardless of
  // whether an attendance record exists for that day.  The modal opens
  // "on" the incoming `date` prop but the picker is fully editable.
  const emptyForm = {
    title: '', description: '', priority: 'normal', reminderTime: '',
    date: date || new Date().toISOString().slice(0, 10),
    locked: false,
  };
  const [form, setForm] = useState(emptyForm);
  // If the parent opens the modal on a different day, or opens it
  // freshly, reset the compose form's date to match.  We only reset
  // the DATE (not the other in-progress fields) so a half-typed title
  // survives a parent re-render.
  useEffect(() => {
    setForm((f) => ({
      ...f,
      date: date || new Date().toISOString().slice(0, 10),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const load = async () => {
    // Phase 51 -- Notes are planning data.  The list is scoped to the
    // day the modal was opened on; if `date` is missing (e.g. the
    // dashboard "New Note" quick action), we skip the list read but
    // still let the user compose and submit for any date.
    if (!open) return;
    if (!date) { setNotes([]); return; }
    setLoading(true);
    try {
      const params = { date };
      // Include archived items so history stays visible; the list is
      // small (one day) so we don't paginate.
      params.archived = 'false';
      if (isAdmin && employeeId) params.employee = employeeId;
      const { data } = await api.get('/attendance-notes', { params });
      setNotes(data || []);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [open, date, employeeId]);

  const startNew = () => {
    setEditingId(null);
    setForm({
      ...emptyForm,
      date: date || new Date().toISOString().slice(0, 10),
    });
  };

  const startEdit = (n) => {
    setEditingId(n._id);
    setForm({
      title: n.title || '',
      description: n.description || '',
      priority: n.priority || 'normal',
      reminderTime: n.reminderTime || '',
      // Phase 51 -- edit preserves the note's own date and lets the
      // user reschedule to a different day (past or future).
      date: n.date
        ? new Date(n.date).toISOString().slice(0, 10)
        : (date || new Date().toISOString().slice(0, 10)),
      locked: !!n.locked,
    });
  };

  const submit = async () => {
    if (!form.title.trim()) { toast.error('Title is required'); return; }
    // Phase 51 -- date is always chosen in the compose form so any
    // day (past / present / future) is valid; there is no attendance
    // dependency on the selected date.
    const targetDate = form.date || date || new Date().toISOString().slice(0, 10);
    try {
      if (editingId) {
        const body = {
          title: form.title,
          description: form.description,
          priority: form.priority,
          reminderTime: form.reminderTime,
          date: targetDate,
        };
        if (isAdmin) body.locked = form.locked;
        await api.patch(`/attendance-notes/${editingId}`, body);
        toast.success('Note updated');
      } else {
        const body = {
          date: targetDate,
          title: form.title,
          description: form.description,
          priority: form.priority,
          reminderTime: form.reminderTime,
        };
        if (isAdmin && employeeId) body.employee = employeeId;
        await api.post('/attendance-notes', body);
        // If HR/SA chose to lock at creation time, patch immediately.
        if (isAdmin && form.locked) {
          // We need the new note's id; refetch on the target date and
          // lock the most recent matching row.  Simpler than parsing
          // the create response twice, still correct because we just
          // inserted it.
          const { data } = await api.get('/attendance-notes', {
            params: { date: targetDate, employee: employeeId },
          });
          const latest = (data || []).find((n) => n.title === form.title.trim());
          if (latest) await api.patch(`/attendance-notes/${latest._id}`, { locked: true });
        }
        toast.success('Note added');
      }
      setForm({
        ...emptyForm,
        date: date || new Date().toISOString().slice(0, 10),
      });
      setEditingId(null);
      await load();
      onChanged?.();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const setStatus = async (n, patch) => {
    try {
      await api.patch(`/attendance-notes/${n._id}`, patch);
      await load();
      onChanged?.();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const remove = async (n) => {
    if (!confirm(`Delete "${n.title}"?`)) return;
    try {
      await api.delete(`/attendance-notes/${n._id}`);
      await load();
      onChanged?.();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const canEditNote = (n) => {
    if (isAdmin) return true;
    if (n.locked) return false;
    return String(n.createdBy?._id || n.createdBy) === String(user?._id);
  };
  const canDeleteNote = canEditNote;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <>
          Notes
          {date && <> · <span className="text-slate-500 font-normal">{fmtDate(date)}</span></>}
          {employeeName && <span className="text-slate-400 font-normal"> · {employeeName}</span>}
        </>
      }
      footer={<button className="btn-secondary" onClick={onClose}>Close</button>}
    >
      <div className="space-y-4">
        {/* ---------- Existing notes ---------- */}
        <div>
          <div className="text-[11px] uppercase text-slate-500 font-semibold mb-2">
            {date
              ? (loading ? 'Loading…' : `${notes.length} note${notes.length === 1 ? '' : 's'} on this day`)
              : 'New note'}
          </div>
          {!date ? (
            <div className="text-xs text-slate-500 italic bg-slate-50 dark:bg-slate-800/40 rounded p-3">
              Pick a date below to schedule this note. Any date is allowed — past, present, or future.
            </div>
          ) : notes.length === 0 ? (
            <div className="text-xs text-slate-500 italic bg-slate-50 dark:bg-slate-800/40 rounded p-3">
              No notes on this day yet. Add one below.
            </div>
          ) : (
            <div className="space-y-2">
              {notes.map((n) => (
                <div key={n._id}
                  className={`rounded-lg border p-3 ${
                    n.completed
                      ? 'bg-green-50/40 border-green-200 dark:bg-green-500/10 dark:border-green-500/30'
                      : n.priority === 'important'
                        ? 'bg-amber-50/40 border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30'
                        : 'bg-white border-slate-200 dark:bg-slate-800/60 dark:border-slate-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {n.priority === 'important'
                          ? <span className="badge-amber">Important</span>
                          : <span className="badge-gray">Normal</span>}
                        {n.completed && <span className="badge-green text-[10px]">DONE</span>}
                        {n.locked   && <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-200 text-[10px]">🔒 Locked</span>}
                        <span className={`text-sm font-semibold ${n.completed ? 'line-through text-slate-500' : 'text-slate-800 dark:text-slate-100'}`}>
                          {n.title}
                        </span>
                      </div>
                      {n.description && (
                        <div className="text-xs text-slate-600 dark:text-slate-300 mt-1 whitespace-pre-wrap">{n.description}</div>
                      )}
                      <div className="text-[11px] text-slate-500 mt-1.5 flex flex-wrap items-center gap-2">
                        {n.reminderTime && <span>⏰ {n.reminderTime}</span>}
                        <span>Created by {n.createdBy?.name || n.createdByName || 'Someone'}
                          {n.createdByRole && ` (${n.createdByRole === 'super_admin' ? 'Super Admin' : n.createdByRole.toUpperCase()})`}
                        </span>
                        <span>· {new Date(n.createdAt).toLocaleString()}</span>
                        {n.updatedAt && n.updatedAt !== n.createdAt && (
                          <span>· updated {new Date(n.updatedAt).toLocaleString()}</span>
                        )}
                        {n.completedAt && (
                          <span>· completed {new Date(n.completedAt).toLocaleString()}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!n.completed
                        ? <button className="btn-secondary !py-1 !text-xs" onClick={() => setStatus(n, { completed: true })}>Complete</button>
                        : <button className="btn-ghost !py-1 !text-xs" onClick={() => setStatus(n, { completed: false })}>Undo</button>}
                      <button className="btn-ghost !py-1 !text-xs" onClick={() => setStatus(n, { archived: true })}>Archive</button>
                      {canEditNote(n) && (
                        <button className="btn-ghost !py-1 !text-xs" onClick={() => startEdit(n)}>Edit</button>
                      )}
                      {canDeleteNote(n) && (
                        <button className="btn-ghost !py-1 !text-xs text-red-600" onClick={() => remove(n)}>Delete</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ---------- Compose / edit ---------- */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 bg-slate-50/60 dark:bg-slate-800/40 space-y-2">
          <div className="text-[11px] uppercase text-slate-500 font-semibold flex items-center justify-between">
            <span>{editingId ? 'Edit note' : 'Add a new note'}</span>
            {editingId && (
              <button className="text-[11px] text-slate-500 hover:underline" onClick={startNew}>New instead</button>
            )}
          </div>
          <input
            className="input"
            placeholder="Title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <textarea
            className="input"
            rows={2}
            placeholder="Description (optional)"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <div className="grid grid-cols-3 gap-2">
            {/* Phase 51 -- date is fully editable so notes can be
                planned for any day (past / present / future).  Notes
                are pure planning data; no attendance record is
                required on the selected day. */}
            <div>
              <label className="label text-[10px] uppercase">Date</label>
              <input
                type="date"
                className="input"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </div>
            <div>
              <label className="label text-[10px] uppercase">Priority</label>
              <select className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                <option value="normal">Normal</option>
                <option value="important">Important</option>
              </select>
            </div>
            <div>
              <label className="label text-[10px] uppercase">Reminder Time (optional)</label>
              <input
                type="time"
                className="input"
                value={form.reminderTime}
                onChange={(e) => setForm({ ...form, reminderTime: e.target.value })}
              />
            </div>
          </div>
          {/* Phase 51 -- inline hint when the user is planning a
              future note or moving one to a different day. */}
          {form.date && date && form.date !== date && (
            <div className="text-[11px] text-brand-700 bg-brand-50 border border-brand-100 rounded-md px-2 py-1">
              {editingId
                ? <>This note will be moved to {fmtDate(form.date)}.</>
                : <>Note will be scheduled for {fmtDate(form.date)} (not the calendar day you opened).</>}
            </div>
          )}
          {isAdmin && (
            <label className="text-[11px] text-slate-600 dark:text-slate-300 flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.locked}
                onChange={(e) => setForm({ ...form, locked: e.target.checked })}
              />
              Lock note (employee cannot edit or delete)
            </label>
          )}
          <div className="flex justify-end">
            <button className="btn-primary !py-1 !text-xs" onClick={submit}>
              {editingId ? 'Save changes' : 'Add note'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
