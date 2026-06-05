import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { errMsg, fmtDate } from '../../utils/helpers';
import { EmptyState } from '../../components/Loader.jsx';
import ScheduleTag from '../../components/ScheduleTag.jsx';

const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

const blank = {
  template: '', targetType: 'department', targetRef: '', frequency: 'daily',
  weeklyDay: 1, monthlyDate: 1,
  startDate: new Date().toISOString().substring(0, 10),
  priority: 'normal',
  holidayOverride: false, overrideScope: 'once', overrideReason: '',
};

export default function Assignments({ embedded = false } = {}) {
  const [items, setItems] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [modal, setModal] = useState(null);
  // Filters + search + detail drawer
  const [fEmployee, setFEmployee] = useState('');
  const [fDepartment, setFDepartment] = useState('');
  const [fDesignation, setFDesignation] = useState('');
  const [fType, setFType] = useState('');
  const [fRecurrence, setFRecurrence] = useState('');
  const [fActive, setFActive] = useState('');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState(null); // { id, data, stats, recent }
  const toast = useToast();
  const { user: currentUser } = useAuth();
  const isHR = currentUser?.role === 'hr';

  // Employees selectable as a direct-target for HR: only role=employee,
  // not the HR themselves.  Super Admin sees the full list.
  const targetableEmployees = useMemo(() => {
    if (!isHR) return employees;
    return employees.filter((e) =>
      e.role === 'employee' && String(e._id) !== String(currentUser?._id)
    );
  }, [employees, isHR, currentUser]);

  // Decide whether the current user can edit/delete a given assignment.
  // HR cannot touch rows that target HR, super_admin, or themselves.
  const canModify = (a) => {
    if (!isHR) return true;
    if (a.targetType !== 'employee') return true;
    const targetUser = employees.find((u) => String(u._id) === String(a.targetRef));
    if (!targetUser) return true; // unknown user - let backend decide
    if (targetUser.role === 'hr' || targetUser.role === 'super_admin') return false;
    if (String(targetUser._id) === String(currentUser?._id)) return false;
    return true;
  };

  const load = async () => {
    const [a, t, e, d, ds] = await Promise.all([
      api.get('/assignments'),
      api.get('/templates'),
      api.get('/employees'),
      api.get('/departments'),
      api.get('/designations'),
    ]);
    setItems(a.data); setTemplates(t.data); setEmployees(e.data);
    setDepartments(d.data); setDesignations(ds.data);
  };
  useEffect(() => { load(); }, []);

  const save = async (form) => {
    try {
      if (modal.mode === 'create') await api.post('/assignments', form);
      else await api.put(`/assignments/${modal.data._id}`, form);
      toast.success('Saved'); setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const del = async (id) => {
    if (!confirm('Delete assignment?')) return;
    try { await api.delete(`/assignments/${id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  /**
   * Soft revoke an assignment.  Different from Delete: revoke keeps the
   * row in the database (for audit), stops daily generation, removes any
   * un-submitted submissions from the employee dashboard, and preserves
   * submitted history.
   */
  const revoke = async (a) => {
    const ok = window.confirm(
      `Are you sure you want to revoke this assignment?\n` +
      `Template: ${a.template?.title || ''}\n` +
      `Target: ${a.targetType} — ${resolveTarget(a) || ''}\n\n` +
      `This stops daily generation immediately and removes any un-submitted submissions from the employee dashboard. Already-submitted reports stay intact.`,
    );
    if (!ok) return;
    const reason = window.prompt('Reason for revoking this assignment (optional):', '') || '';
    try {
      const { data } = await api.post(`/assignments/${a._id}/revoke`, { reason: reason.trim() });
      toast.success(`Assignment revoked. ${data.unsubmittedDeleted || 0} un-submitted submission(s) removed.`);
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const resolveTarget = (a) => {
    if (a.targetType === 'employee') return employees.find((x) => x._id === a.targetRef)?.name || a.targetRef;
    if (a.targetType === 'department') return departments.find((x) => x._id === a.targetRef)?.name || a.targetRef;
    return designations.find((x) => x._id === a.targetRef)?.title || a.targetRef;
  };

  // Apply filters + search to the assignment list.
  const filtered = useMemo(() => items.filter((a) => {
    if (fEmployee && (a.targetType !== 'employee' || String(a.targetRef) !== fEmployee)) return false;
    if (fDepartment && (a.targetType !== 'department' || String(a.targetRef) !== fDepartment)) return false;
    if (fDesignation && (a.targetType !== 'designation' || String(a.targetRef) !== fDesignation)) return false;
    if (fType && a.template?.templateType !== fType) return false;
    if (fRecurrence && a.frequency !== fRecurrence) return false;
    if (fActive === 'active' && !a.active) return false;
    if (fActive === 'paused' && a.active) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${a.template?.title || ''} ${resolveTarget(a) || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [items, fEmployee, fDepartment, fDesignation, fType, fRecurrence, fActive, search, employees, departments, designations]);

  const openDetail = async (a) => {
    setDetail({ id: a._id, loading: true });
    try {
      const { data } = await api.get(`/assignments/${a._id}/stats`);
      setDetail({ id: a._id, data: data.assignment, stats: data.stats, recent: data.recent, loading: false });
    } catch (err) { setDetail({ id: a._id, error: errMsg(err), loading: false }); }
  };

  return (
    <div className="space-y-4">
      <div className={`flex ${embedded ? 'justify-end' : 'justify-between'} items-center`}>
        {!embedded && <h1 className="text-2xl font-bold">Assignments</h1>}
        <button className="btn-primary" onClick={() => setModal({ mode: 'create', data: { ...blank } })}>+ Assign Template</button>
      </div>

      {/* Filters + search */}
      <div className="card card-body grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
        <input className="input" placeholder="Search template or target…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" value={fEmployee} onChange={(e) => setFEmployee(e.target.value)}>
          <option value="">All employees</option>
          {targetableEmployees.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}
        </select>
        <select className="input" value={fDepartment} onChange={(e) => setFDepartment(e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
        </select>
        <select className="input" value={fDesignation} onChange={(e) => setFDesignation(e.target.value)}>
          <option value="">All designations</option>
          {designations.map((d) => <option key={d._id} value={d._id}>{d.title}</option>)}
        </select>
        <select className="input" value={fType} onChange={(e) => setFType(e.target.value)}>
          <option value="">All types</option><option value="task">Task</option><option value="excel">Excel</option><option value="sheet">Spreadsheet</option><option value="custom">Custom</option>
        </select>
        <select className="input" value={fRecurrence} onChange={(e) => setFRecurrence(e.target.value)}>
          <option value="">All recurrences</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="one-time">One-time</option>
        </select>
        <select className="input" value={fActive} onChange={(e) => setFActive(e.target.value)}>
          <option value="">Active &amp; paused</option><option value="active">Active</option><option value="paused">Paused</option>
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr>
            <th>Template</th><th>Target Type</th><th>Target</th><th>Schedule</th><th>Start</th><th>Active</th><th></th>
          </tr></thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan="7"><EmptyState title="No matching assignments" /></td></tr>}
            {filtered.map((a) => (
              <tr key={a._id} className="cursor-pointer hover:bg-slate-50" onClick={() => openDetail(a)} title="Click for details">
                <td className="font-medium">{a.template?.title}</td>
                <td className="capitalize">{a.targetType}</td>
                <td>{resolveTarget(a)}</td>
                <td><ScheduleTag frequency={a.frequency} label={a.scheduleLabel} /></td>
                <td>{fmtDate(a.startDate)}</td>
                <td>{a.active ? <span className="badge-green">Yes</span> : <span className="badge-gray">No</span>}</td>
                <td className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  {canModify(a) ? (<>
                    <button className="btn-ghost" onClick={() => setModal({ mode: 'edit', data: { ...a, template: a.template?._id } })}>Edit</button>
                    {a.active && !a.revokedAt && (
                      <button
                        className="btn-ghost text-red-600"
                        title="Stop generating new submissions and remove un-submitted ones from the employee dashboard"
                        onClick={() => revoke(a)}
                      >
                        Revoke
                      </button>
                    )}
                    {a.revokedAt && (
                      <span className="badge-gray ml-1" title={`Revoked ${new Date(a.revokedAt).toLocaleString()}`}>Revoked</span>
                    )}
                    <button className="btn-ghost text-red-600" onClick={() => del(a._id)}>Delete</button>
                  </>) : (
                    <span className="text-[11px] text-slate-400 italic pr-2">Managed by Super Admin</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && <AssignmentDetailDrawer detail={detail} onClose={() => setDetail(null)} resolveTarget={resolveTarget} />}

      {modal && (() => {
        const f = modal.data;
        const set = (k, v) => setModal({ ...modal, data: { ...f, [k]: v } });
        const options = f.targetType === 'employee'
          ? targetableEmployees.map((x) => ({ id: x._id, label: `${x.name} (${x.employeeId})` }))
          : f.targetType === 'department'
          ? departments.map((x) => ({ id: x._id, label: x.name }))
          : designations.map((x) => ({ id: x._id, label: x.title }));
        return (
          <Modal open onClose={() => setModal(null)} title={modal.mode === 'create' ? 'New Assignment' : 'Edit Assignment'}
            footer={<>
              <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => save(f)}>Save</button>
            </>}>
            <div className="space-y-3">
              <div><label className="label">Template</label>
                <select className="input" value={f.template} onChange={(e) => set('template', e.target.value)}>
                  <option value="">Select template</option>
                  {templates.map((t) => <option key={t._id} value={t._id}>{t.title}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Target Type</label>
                  <select
                    className="input"
                    value={f.targetType}
                    onChange={(e) => setModal({
                      ...modal,
                      data: { ...f, targetType: e.target.value, targetRef: '' },
                    })}
                  >
                    <option value="employee">Employee</option>
                    <option value="department">Department</option>
                    <option value="designation">Designation</option>
                  </select>
                </div>
                <div><label className="label">Target</label>
                  <select className="input" value={f.targetRef} onChange={(e) => set('targetRef', e.target.value)}>
                    <option value="">Select</option>
                    {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Frequency</label>
                  <select className="input" value={f.frequency} onChange={(e) => set('frequency', e.target.value)}>
                    <option value="daily">Daily (recurring)</option>
                    <option value="weekly">Weekly (recurring)</option>
                    <option value="monthly">Monthly (recurring)</option>
                    <option value="one-time">One-time</option>
                  </select>
                </div>
                <div><label className="label">Start Date</label>
                  <input className="input" type="date" value={(f.startDate || '').substring(0, 10)} onChange={(e) => set('startDate', e.target.value)} />
                </div>
              </div>

              {/* Weekly: weekday selector */}
              {f.frequency === 'weekly' && (
                <div>
                  <label className="label">Repeat on</label>
                  <select className="input" value={f.weeklyDay ?? 1} onChange={(e) => set('weeklyDay', Number(e.target.value))}>
                    {WEEKDAYS.map((d) => <option key={d.value} value={d.value}>Every {d.label}</option>)}
                  </select>
                </div>
              )}

              {/* Monthly: day-of-month selector */}
              {f.frequency === 'monthly' && (
                <div>
                  <label className="label">Day of month</label>
                  <select className="input" value={f.monthlyDate ?? 1} onChange={(e) => set('monthlyDate', Number(e.target.value))}>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-500 mt-1">
                    If a month is shorter (e.g. the 31st in February), it runs on that month's last day.
                  </p>
                </div>
              )}
              {modal.mode === 'edit' && (
                <div className="flex items-center gap-2">
                  <input id="active" type="checkbox" checked={!!f.active} onChange={(e) => set('active', e.target.checked)} />
                  <label htmlFor="active" className="text-sm text-slate-700">Active</label>
                </div>
              )}

              {/* Manual "work on a non-working day" override.  Normal
                  automatic generation still skips Sundays, weekly offs,
                  holidays and event-holidays for everyone else. */}
              <div className="bg-amber-50/60 border border-amber-100 rounded-lg p-3 space-y-2">
                <label className="flex items-center gap-2 text-sm text-slate-800">
                  <input type="checkbox" checked={!!f.holidayOverride} onChange={(e) => set('holidayOverride', e.target.checked)} />
                  Assign Work on Non-Working Day
                </label>
                <div className="text-[11px] text-slate-500">
                  When ticked, this assignment is generated even on the target's weekly off, configured holidays, or "work stops" events — for these targets only.
                  Approved full-day leaves are never overridden.
                </div>
                {f.holidayOverride && (
                  <div className="space-y-2">
                    <div>
                      <label className="label">Override scope</label>
                      <div className="flex flex-wrap gap-3 text-sm text-slate-700">
                        <label className="flex items-center gap-1">
                          <input type="radio" name="overrideScope" checked={(f.overrideScope || 'once') === 'once'}
                            onChange={() => set('overrideScope', 'once')} />
                          This occurrence only
                        </label>
                        <label className="flex items-center gap-1">
                          <input type="radio" name="overrideScope" checked={f.overrideScope === 'all'}
                            onChange={() => set('overrideScope', 'all')} />
                          All future occurrences
                        </label>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1">
                        <b>This occurrence only</b> (default) fires the override on the assignment's start date only — recurring templates won't bleed onto every future non-working day.
                      </div>
                    </div>
                    <div>
                      <label className="label">Override reason (kept for audit)</label>
                      <input className="input" value={f.overrideReason || ''}
                        onChange={(e) => set('overrideReason', e.target.value)}
                        placeholder="e.g. Diwali production support, weekend audit, festival promotion shift" />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

/** Detail drawer for one assignment: metadata + template + stats + recent. */
function AssignmentDetailDrawer({ detail, onClose, resolveTarget }) {
  const a = detail.data;
  const s = detail.stats;
  return (
    <Modal open onClose={onClose} size="lg" title={a ? `Assignment — ${a.template?.title || ''}` : 'Assignment'}
      footer={<button className="btn-secondary" onClick={onClose}>Close</button>}>
      {detail.loading && <div className="text-sm text-slate-500">Loading…</div>}
      {detail.error && <div className="text-sm text-red-600">{detail.error}</div>}
      {a && (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-slate-400">Template:</span> <b>{a.template?.title}</b>{' '}
              {(() => {
                const tt = a.template?.templateType || 'task';
                const cls = tt === 'excel' ? 'badge-blue'
                  : tt === 'sheet' ? 'badge-green'
                  : tt === 'custom' ? 'badge bg-indigo-50 text-indigo-700'
                  : 'badge-gray';
                const label = tt === 'custom' ? 'Custom' : tt.charAt(0).toUpperCase() + tt.slice(1);
                return <span className={`${cls} ml-1`}>{label}</span>;
              })()}
            </div>
            <div><span className="text-slate-400">Target:</span> <span className="capitalize">{a.targetType}</span> — <b>{resolveTarget ? resolveTarget(a) : ''}</b></div>
            <div><span className="text-slate-400">Schedule:</span> <ScheduleTag frequency={a.frequency} label={a.scheduleLabel} /></div>
            <div><span className="text-slate-400">Active:</span> {a.active ? <span className="badge-green">Yes</span> : <span className="badge-gray">No</span>}</div>
            <div><span className="text-slate-400">Start date:</span> {fmtDate(a.startDate)}</div>
            <div><span className="text-slate-400">Assigned date:</span> {fmtDate(a.createdAt)}</div>
            <div className="sm:col-span-2"><span className="text-slate-400">Assigned by:</span> {a.createdBy?.name || '—'}{a.createdBy?.role ? ` · ${a.createdBy.role.toUpperCase()}` : ''}</div>
          </div>

          {s && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Stat label="Submissions" value={s.submissions} />
              <Stat label="Done units" value={s.doneUnits} cls="text-green-700" />
              <Stat label="Pending units" value={s.pendingUnits} cls="text-red-600" />
              <Stat label="Reviewed" value={s.reviewedCount} />
              <Stat label="Dependencies" value={s.dependencyCount} cls="text-amber-700" />
            </div>
          )}

          {detail.recent && detail.recent.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-700 mb-1">Recent Submissions</div>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Date</th><th>Employee</th><th>Review</th></tr></thead>
                  <tbody>
                    {detail.recent.map((r) => (
                      <tr key={r._id}>
                        <td className="text-xs">{fmtDate(r.date)}</td>
                        <td>{r.employee || '—'}</td>
                        <td>{r.reviewStatus === 'reviewed' ? <span className="badge-green">Reviewed</span> : <span className="badge-amber">Pending</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const Stat = ({ label, value, cls }) => (
  <div className="bg-slate-50 rounded-lg p-2 text-center">
    <div className={`text-lg font-bold ${cls || 'text-slate-900'}`}>{value}</div>
    <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
  </div>
);
