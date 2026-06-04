import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import ScheduleTag from '../../components/ScheduleTag.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { fmtDate, errMsg } from '../../utils/helpers';

const TYPE_LABEL = { task: 'Task', excel: 'Excel', sheet: 'Spreadsheet', custom: 'Custom' };
const PRIORITY_CLS = { high: 'badge-red', normal: 'badge-gray', low: 'badge-blue' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Per-employee template management.  Lists the employee's direct + inherited
 * assignments; HR can assign, pause/reactivate, edit (recurrence + priority),
 * or remove DIRECT assignments.  Inherited (department / designation) ones
 * are read-only here and managed on the Assignments page.
 */
export default function EmployeeTemplates({ employee }) {
  const toast = useToast();
  const [assignments, setAssignments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // { mode:'assign'|'edit', data }

  const load = async () => {
    setLoading(true);
    try {
      const [a, t] = await Promise.all([
        api.get('/assignments', { params: { employee: employee._id } }),
        api.get('/templates'),
      ]);
      setAssignments(a.data); setTemplates(t.data);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [employee._id]);

  const isDirect = (a) => a.targetType === 'employee';

  const save = async (form) => {
    try {
      if (modal.mode === 'assign') {
        await api.post('/assignments', {
          template: form.template,
          targetType: 'employee',
          targetRef: employee._id,
          frequency: form.frequency,
          weeklyDay: form.weeklyDay,
          monthlyDate: form.monthlyDate,
          startDate: form.startDate,
          priority: form.priority,
          holidayOverride: form.holidayOverride,
          overrideScope: form.overrideScope,
          overrideReason: form.overrideReason,
        });
      } else {
        await api.put(`/assignments/${modal.data._id}`, {
          frequency: form.frequency,
          weeklyDay: form.weeklyDay,
          monthlyDate: form.monthlyDate,
          startDate: form.startDate,
          endDate: form.endDate,
          priority: form.priority,
          holidayOverride: form.holidayOverride,
          overrideScope: form.overrideScope,
          overrideReason: form.overrideReason,
        });
      }
      toast.success('Saved'); setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const toggleActive = async (a) => {
    try { await api.put(`/assignments/${a._id}`, { active: !a.active }); toast.success(a.active ? 'Paused' : 'Reactivated'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const remove = async (a) => {
    if (!confirm(`Remove "${a.template?.title}" from this employee?`)) return;
    try { await api.delete(`/assignments/${a._id}`); toast.success('Removed'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  if (loading) return <Loader />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">Assigned Templates</h2>
        <button className="btn-primary" onClick={() => setModal({ mode: 'assign', data: { frequency: 'daily', priority: 'normal', startDate: new Date().toISOString().substring(0, 10), template: '' } })}>
          + Assign Template
        </button>
      </div>

      {assignments.length === 0 ? (
        <EmptyState title="No templates assigned" subtitle="Click 'Assign Template' to give this employee work." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr>
              <th>Template</th><th>Type</th><th>Recurrence</th><th>Assigned</th><th>Scope</th><th>Priority</th><th>Status</th><th></th>
            </tr></thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a._id}>
                  <td className="font-medium text-slate-900">{a.template?.title || '—'}</td>
                  <td><span className="badge-gray">{TYPE_LABEL[a.template?.templateType] || a.template?.templateType || '—'}</span></td>
                  <td><ScheduleTag frequency={a.frequency} label={a.scheduleLabel} /></td>
                  <td className="text-xs text-slate-500">{fmtDate(a.createdAt)}</td>
                  <td>
                    {isDirect(a)
                      ? <span className="badge-blue">Direct</span>
                      : <span className="badge-amber" title="Managed on the Assignments page">Inherited · {a.targetType}</span>}
                  </td>
                  <td><span className={PRIORITY_CLS[a.priority] || 'badge-gray'}>{(a.priority || 'normal').toUpperCase()}</span></td>
                  <td>{a.active ? <span className="badge-green">Active</span> : <span className="badge-gray">Paused</span>}</td>
                  <td className="text-right whitespace-nowrap">
                    {isDirect(a) ? <>
                      <button className="btn-ghost" onClick={() => toggleActive(a)}>{a.active ? 'Pause' : 'Reactivate'}</button>
                      <button className="btn-ghost" onClick={() => setModal({ mode: 'edit', data: { ...a, startDate: (a.startDate || '').substring(0, 10), endDate: (a.endDate || '').substring(0, 10) } })}>Edit</button>
                      <button className="btn-ghost text-red-600" onClick={() => remove(a)}>Remove</button>
                    </> : <span className="text-[11px] text-slate-400 italic pr-2">Manage on Assignments page</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <AssignmentModal
          mode={modal.mode}
          initial={modal.data}
          templates={templates}
          onCancel={() => setModal(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function AssignmentModal({ mode, initial, templates, onCancel, onSave }) {
  const [f, setF] = useState({
    template: initial.template?._id || initial.template || '',
    frequency: initial.frequency || 'daily',
    weeklyDay: initial.weeklyDay ?? 1,
    monthlyDate: initial.monthlyDate ?? 1,
    startDate: initial.startDate || new Date().toISOString().substring(0, 10),
    endDate: initial.endDate || '',
    priority: initial.priority || 'normal',
    holidayOverride: !!initial.holidayOverride,
    overrideScope: initial.overrideScope || 'once',
    overrideReason: initial.overrideReason || '',
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const [search, setSearch] = useState('');
  const filtered = templates.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()));

  const valid = mode === 'edit' || !!f.template;

  return (
    <Modal open onClose={onCancel} size="lg"
      title={mode === 'assign' ? 'Assign Template' : 'Edit Assignment'}
      footer={<><button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" disabled={!valid} onClick={() => onSave(f)}>{mode === 'assign' ? 'Assign' : 'Save'}</button></>}>
      <div className="space-y-3">
        {mode === 'assign' && (
          <div>
            <label className="label">Template</label>
            <input className="input mb-2" placeholder="Search templates…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="input" value={f.template} onChange={(e) => set('template', e.target.value)}>
              <option value="">Select a template…</option>
              {filtered.map((t) => (
                <option key={t._id} value={t._id}>{t.title} · {TYPE_LABEL[t.templateType] || t.templateType || '—'}</option>
              ))}
            </select>
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="label">Recurrence</label>
            <select className="input" value={f.frequency} onChange={(e) => set('frequency', e.target.value)}>
              <option value="one-time">One Time</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div>
            <label className="label">Priority</label>
            <select className="input" value={f.priority} onChange={(e) => set('priority', e.target.value)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </div>

          {f.frequency === 'weekly' && (
            <div>
              <label className="label">Day of week</label>
              <select className="input" value={f.weeklyDay} onChange={(e) => set('weeklyDay', Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
          )}
          {f.frequency === 'monthly' && (
            <div>
              <label className="label">Day of month (1–31)</label>
              <input className="input" type="number" min="1" max="31" value={f.monthlyDate} onChange={(e) => set('monthlyDate', Number(e.target.value))} />
              <div className="text-[11px] text-slate-500 mt-1">Clamps to the last day for shorter months.</div>
            </div>
          )}

          <div>
            <label className="label">Start date</label>
            <input className="input" type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </div>
          {mode === 'edit' && (
            <div>
              <label className="label">End date (optional)</label>
              <input className="input" type="date" value={f.endDate || ''} onChange={(e) => set('endDate', e.target.value)} />
            </div>
          )}
        </div>

        {/* Manual override for non-working days (weekly off / holiday / event-holiday). */}
        <div className="bg-amber-50/60 border border-amber-100 rounded-lg p-3 space-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" checked={!!f.holidayOverride} onChange={(e) => set('holidayOverride', e.target.checked)} />
            Assign Work on Non-Working Day
          </label>
          <div className="text-[11px] text-slate-500">
            Generates this assignment for this employee even on their weekly off, configured holidays, or work-stop events. Approved full-day leaves are never overridden.
          </div>
          {f.holidayOverride && (
            <div className="space-y-2">
              <div>
                <label className="label">Override scope</label>
                <div className="flex flex-wrap gap-3 text-sm text-slate-700">
                  <label className="flex items-center gap-1">
                    <input type="radio" name="empOverrideScope" checked={(f.overrideScope || 'once') === 'once'}
                      onChange={() => set('overrideScope', 'once')} />
                    This occurrence only
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="radio" name="empOverrideScope" checked={f.overrideScope === 'all'}
                      onChange={() => set('overrideScope', 'all')} />
                    All future occurrences
                  </label>
                </div>
                <div className="text-[11px] text-slate-500 mt-1">
                  <b>This occurrence only</b> (default) fires the override on the start date only — recurring templates won't bleed onto every future non-working day.
                </div>
              </div>
              <div>
                <label className="label">Override reason (kept for audit)</label>
                <input className="input" value={f.overrideReason || ''} onChange={(e) => set('overrideReason', e.target.value)} placeholder="e.g. Festival production support" />
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
