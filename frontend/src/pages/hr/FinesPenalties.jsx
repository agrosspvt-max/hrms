/**
 * Phase 61 -- Fines & Penalties module for HR / Super Admin / permitted HOD.
 *
 * Three tabs:
 *   Active    -- currently enforced penalties (reduce Final Marks).
 *   Probable  -- warnings the automatic engine has raised.
 *   Resolved  -- historical / expired / cancelled records.
 *
 * Header actions:
 *   + Manual Penalty  (opens a modal to create a marks/completion
 *                      penalty with optional grace period / duration).
 *
 * Every row shows category, target employee, target date, marks,
 * reason and an actions cell (Cancel for HR/SA only).
 */
import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtDate } from '../../utils/helpers';
import { useAuth } from '../../context/AuthContext.jsx';
import { Loader } from '../../components/Loader.jsx';

const CATEGORY_LABEL = {
  // Phase 64 Part 4 -- classification per spec:
  //   Manual Penalties · Missed Submission · Performance Lock ·
  //   Completion Adjustments · Marks Adjustments
  missed_submission:     'Missed Submission',
  absent_submission:     'Missed Submission (legacy)',
  performance_lock:      'Performance Lock',
  dependency_pending:    'Pending Dependency (3+ days)',
  attendance_manual:     'Attendance Correction',
  critical_threshold:    'Critical Task Threshold',
  repeated_missing:      'Repeated Missing Submission',
  manual_marks:          'Manual · Marks (legacy)',
  marks_adjustment:      'Marks Adjustment',
  manual_completion:     'Manual · Completion % (legacy)',
  completion_adjustment: 'Completion Adjustment',
};

// Phase 64 Part 4 -- grouping used by the classification chips at the
// top of each row so HR sees the spec's five buckets clearly.
const CATEGORY_GROUP = {
  missed_submission:     'Missed Submission',
  absent_submission:     'Missed Submission',
  performance_lock:      'Performance Lock',
  dependency_pending:    'Performance Lock',
  attendance_manual:     'Manual Penalties',
  critical_threshold:    'Manual Penalties',
  repeated_missing:      'Missed Submission',
  manual_marks:          'Marks Adjustments',
  marks_adjustment:      'Marks Adjustments',
  manual_completion:     'Completion Adjustments',
  completion_adjustment: 'Completion Adjustments',
};
const GROUP_BADGE = {
  'Manual Penalties':       'bg-red-50 text-red-700',
  'Missed Submission':      'bg-amber-50 text-amber-700',
  'Performance Lock':       'bg-red-50 text-red-700',
  'Completion Adjustments': 'bg-purple-50 text-purple-700',
  'Marks Adjustments':      'bg-purple-50 text-purple-700',
};

const STATUS_BADGE = {
  active:    'bg-red-50 text-red-700',
  pending:   'bg-amber-50 text-amber-700',
  scheduled: 'bg-amber-50 text-amber-700',
  resolved:  'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-slate-100 text-slate-700',
  expired:   'bg-slate-100 text-slate-700',
};

export default function FinesPenalties() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'hr' || user?.role === 'super_admin';
  const toast = useToast();

  const [tab, setTab] = useState('active');
  const [data, setData] = useState({ active: [], probable: [], resolved: [] });
  const [loading, setLoading] = useState(true);
  const [openManual, setOpenManual] = useState(false);
  const [filters, setFilters] = useState({ employee: '', from: '', to: '' });

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.employee) params.employee = filters.employee;
      if (filters.from)     params.from     = filters.from;
      if (filters.to)       params.to       = filters.to;
      const { data } = await api.get('/penalties/dashboard', { params });
      setData(data || { active: [], probable: [], resolved: [] });
    } catch (e) { toast.error(errMsg(e)); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filters.employee, filters.from, filters.to]);

  const rows = data[tab] || [];
  const stats = useMemo(() => ({
    active:   data.active.length,
    probable: data.probable.length,
    resolved: data.resolved.length,
  }), [data]);

  const doCancel = async (id) => {
    const reason = prompt('Cancel reason (optional):', '') || '';
    try {
      await api.post(`/penalties/${id}/cancel`, { reason });
      toast.success('Penalty cancelled');
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">Fines &amp; Penalties</h1>
        {isAdmin && (
          <button className="btn-primary" onClick={() => setOpenManual(true)}>
            + Manual Penalty
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap text-sm bg-white border rounded p-3">
        <label className="flex items-center gap-2">
          <span className="text-slate-500 text-xs">Employee ID</span>
          <input
            className="input h-8 !py-1"
            value={filters.employee}
            onChange={(e) => setFilters((f) => ({ ...f, employee: e.target.value.trim() }))}
            placeholder="ObjectId"
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-slate-500 text-xs">From</span>
          <input type="date" className="input h-8 !py-1" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-slate-500 text-xs">To</span>
          <input type="date" className="input h-8 !py-1" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
        </label>
        {(filters.employee || filters.from || filters.to) && (
          <button className="btn-ghost" onClick={() => setFilters({ employee: '', from: '', to: '' })}>Clear</button>
        )}
      </div>

      <div className="flex items-center gap-2 border-b">
        <TabBtn active={tab === 'active'}   onClick={() => setTab('active')}   count={stats.active}   label="Active Penalties"   />
        <TabBtn active={tab === 'probable'} onClick={() => setTab('probable')} count={stats.probable} label="Probable Penalties" />
        <TabBtn active={tab === 'resolved'} onClick={() => setTab('resolved')} count={stats.resolved} label="Resolved Penalties" />
      </div>

      {loading ? <Loader /> : (
        rows.length === 0
          ? <div className="text-sm text-slate-500 italic p-4">No penalties in this bucket.</div>
          : (
            <div className="overflow-x-auto bg-white border rounded">
              <table className="table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Category</th>
                    <th>Target Date</th>
                    <th>Marks</th>
                    <th>Status</th>
                    <th>Reason</th>
                    <th>Effective</th>
                    <th>Resolved</th>
                    {isAdmin && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p._id}>
                      <td>
                        <div className="font-medium">{p.employee?.name || '—'}</div>
                        <div className="text-[11px] text-slate-500">{p.employee?.employeeId || ''}</div>
                      </td>
                      <td>
                        <div className="flex flex-col gap-0.5">
                          {/* Phase 64 Part 4 -- group chip. */}
                          <span className={`badge text-[10px] ${GROUP_BADGE[CATEGORY_GROUP[p.category]] || 'bg-slate-100 text-slate-600'}`}>
                            {CATEGORY_GROUP[p.category] || 'Other'}
                          </span>
                          <span className={`badge ${p.probable ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-700'}`}>
                            {CATEGORY_LABEL[p.category] || p.category}
                          </span>
                          {/* Phase 64 Part 2 -- surface reopen state on the row. */}
                          {p.reopenRequest?.requested && p.reopenRequest?.decision === 'pending' && (
                            <span className="badge bg-blue-50 text-blue-700 text-[10px]">Reopen requested</span>
                          )}
                        </div>
                      </td>
                      <td>{p.targetDate ? fmtDate(p.targetDate) : '—'}</td>
                      <td className="font-mono">
                        {(p.category === 'manual_completion' || p.category === 'completion_adjustment')
                          ? `${p.completionPercent}%`
                          : (Number(p.penaltyMarks) || 0)}
                      </td>
                      <td><span className={`badge ${STATUS_BADGE[p.status] || 'bg-slate-100 text-slate-700'}`}>{p.status}</span></td>
                      <td className="max-w-md text-xs text-slate-600">
                        {p.reason || '—'}
                        {p.reopenRequest?.requested && (
                          <div className="mt-1 text-[11px] text-blue-700">
                            Employee reason: {p.reopenRequest.reason || '—'}
                          </div>
                        )}
                        {p.evaluationMode && (
                          <div className="mt-1 text-[11px] text-purple-700">
                            Evaluation: {p.evaluationMode}
                          </div>
                        )}
                      </td>
                      <td className="text-xs">{p.effectiveDate ? new Date(p.effectiveDate).toLocaleString() : ''}</td>
                      <td className="text-xs">{p.resolvedAt ? new Date(p.resolvedAt).toLocaleString() : (p.cancelledAt ? new Date(p.cancelledAt).toLocaleString() : '')}</td>
                      {isAdmin && (
                        <td>
                          {/* Phase 64 Part 2 -- Approve / Reject a
                              pending reopen request; can also pick an
                              evaluation mode directly. */}
                          {p.reopenRequest?.requested && p.reopenRequest?.decision === 'pending' && (
                            <ReopenActions penalty={p} onDone={load} />
                          )}
                          {['active', 'pending', 'scheduled'].includes(p.status) && (
                            <button className="btn-ghost text-red-600" onClick={() => doCancel(p._id)}>Cancel</button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {openManual && (
        <ManualPenaltyModal
          onClose={() => setOpenManual(false)}
          onCreated={() => { setOpenManual(false); load(); }}
        />
      )}
    </div>
  );
}

/**
 * Phase 64 Part 2 -- HR-side Approve / Reject controls for a pending
 * Request Reopening.  Approve requires the HR user to pick one of
 * the three shared evaluation modes so the missed-submission /
 * performance-lock recovery workflow is applied consistently.
 */
function ReopenActions({ penalty, onDone }) {
  const toast = useToast();
  const [mode, setMode] = useState('restore');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (decision) => {
    if (decision === 'approved' && !mode) { toast.error('Pick an evaluation mode'); return; }
    setBusy(true);
    try {
      await api.post(`/penalties/${penalty._id}/reopen-decision`, {
        decision,
        evaluationMode: decision === 'approved' ? mode : null,
        note,
      });
      toast.success(`Reopen ${decision}`);
      onDone?.();
    } catch (e) { toast.error(errMsg(e)); }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <select
        className="input h-7 !py-0 !text-[11px]"
        value={mode}
        onChange={(e) => setMode(e.target.value)}
      >
        <option value="restore">Restore Performance</option>
        <option value="information">Information Only</option>
        <option value="neutral">Neutral Day</option>
      </select>
      <input
        className="input h-7 !py-0 !text-[11px]"
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex gap-1">
        <button className="btn-primary !py-0.5 !px-2 !text-[11px]" disabled={busy} onClick={() => submit('approved')}>Approve</button>
        <button className="btn-ghost text-red-600 !py-0.5 !px-2 !text-[11px]" disabled={busy} onClick={() => submit('rejected')}>Reject</button>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, count, label }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-sm border-b-2 ${active ? 'border-indigo-500 text-indigo-700 font-semibold' : 'border-transparent text-slate-600'}`}
    >
      {label} <span className="ml-1 text-[11px] text-slate-500">({count})</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Manual Penalty modal                                                */
/* ------------------------------------------------------------------ */
function ManualPenaltyModal({ onClose, onCreated }) {
  const toast = useToast();
  const [employees, setEmployees] = useState([]);
  const [form, setForm] = useState({
    employee: '', type: 'marks',
    marks: '', completionPercent: '',
    reason: '', employeeMessage: '',
    graceHours: '',
    // Phase 64 Part 5 -- Completion Adjustment uses a past-only date
    // range instead of an auto-expiry duration.
    evaluationStart: '', evaluationEnd: '',
  });
  useEffect(() => {
    api.get('/employees', { params: { activeOnly: 'true' } })
      .then((r) => setEmployees(r.data || [])).catch(() => setEmployees([]));
  }, []);

  const submit = async () => {
    if (!form.employee) { toast.error('Pick an employee'); return; }
    if (form.type === 'marks' && !form.marks) { toast.error('Enter marks'); return; }
    if (form.type === 'completion') {
      if (!form.completionPercent) { toast.error('Enter adjustment %'); return; }
      if (!form.evaluationStart || !form.evaluationEnd) { toast.error('Pick the evaluation period'); return; }
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (new Date(form.evaluationStart) > today || new Date(form.evaluationEnd) > today) {
        toast.error('Evaluation period must be strictly in the past.');
        return;
      }
    }
    try {
      await api.post('/penalties/manual', {
        employee: form.employee,
        type: form.type,
        marks: Number(form.marks) || 0,
        completionPercent: Number(form.completionPercent) || 0,
        reason: form.reason,
        employeeMessage: form.employeeMessage,
        graceHours: Number(form.graceHours) || 0,
        // Phase 64 Part 5 -- past-only evaluation range.
        evaluationStart: form.evaluationStart || undefined,
        evaluationEnd:   form.evaluationEnd   || undefined,
      });
      toast.success(form.type === 'completion' ? 'Completion adjustment created' : 'Marks adjustment created');
      onCreated();
    } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-lg p-4 space-y-3">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold">Create Manual Penalty</h2>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>
        <div>
          <label className="label">Employee <span className="text-red-500">*</span></label>
          <select className="input" value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })}>
            <option value="">— Select —</option>
            {employees.map((e) => <option key={e._id} value={e._id}>{e.name} ({e.employeeId})</option>)}
          </select>
        </div>
        <div>
          <label className="label">Penalty Type <span className="text-red-500">*</span></label>
          <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="marks">Marks Adjustment</option>
            <option value="completion">Completion Score Adjustment</option>
          </select>
        </div>
        {form.type === 'marks' ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Deduct Marks <span className="text-red-500">*</span></label>
              <input type="number" min="0" className="input" value={form.marks} onChange={(e) => setForm({ ...form, marks: e.target.value })} />
            </div>
            <div>
              <label className="label">Grace Period (hours)</label>
              <input type="number" min="0" className="input" value={form.graceHours} onChange={(e) => setForm({ ...form, graceHours: e.target.value })} placeholder="0 = immediate" />
              <div className="text-[11px] text-slate-500 mt-1">Employee has this long to fix the issue.  Cancel before expiry to prevent.</div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">Adjustment % <span className="text-red-500">*</span></label>
              <input
                type="number"
                className="input"
                value={form.completionPercent}
                onChange={(e) => setForm({ ...form, completionPercent: e.target.value })}
                placeholder="e.g. 5 for −5%"
              />
              <div className="text-[11px] text-slate-500 mt-1">Percentage points to subtract from displayed Completion Score inside the evaluation period.  No auto-expiry -- adjustment lives forever unless cancelled.</div>
            </div>
            <div>
              <label className="label">Evaluation Start <span className="text-red-500">*</span></label>
              <input
                type="date"
                className="input"
                max={new Date().toISOString().slice(0, 10)}
                value={form.evaluationStart}
                onChange={(e) => setForm({ ...form, evaluationStart: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Evaluation End <span className="text-red-500">*</span></label>
              <input
                type="date"
                className="input"
                max={new Date().toISOString().slice(0, 10)}
                value={form.evaluationEnd}
                onChange={(e) => setForm({ ...form, evaluationEnd: e.target.value })}
              />
              <div className="text-[11px] text-slate-500 mt-1">Past dates only.  Multiple overlapping adjustments stack.</div>
            </div>
          </div>
        )}
        <div>
          <label className="label">Internal Reason (audit) <span className="text-red-500">*</span></label>
          <input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </div>
        <div>
          <label className="label">Employee Message</label>
          <textarea className="input" rows={2} value={form.employeeMessage} onChange={(e) => setForm({ ...form, employeeMessage: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit}>Create</button>
        </div>
      </div>
    </div>
  );
}
