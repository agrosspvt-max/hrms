import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import StatCard from '../../components/StatCard.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { fmtDate, fmtMoney, errMsg } from '../../utils/helpers';
import { EmployeeForm } from './Employees.jsx';
import EmployeeTemplates from './EmployeeTemplates.jsx';
import EmployeePendency from './EmployeePendency.jsx';
import EmployeeWorkHistory from './EmployeeWorkHistory.jsx';
import EmployeeAttendanceTab from './EmployeeAttendanceTab.jsx';
import EmployeeLeaves from './EmployeeLeaves.jsx';

const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

/** CTC salary breakdown from a salary structure (mirrors the editor preview). */
function salaryBreakdown(u) {
  const s = u.salaryStructure || {};
  const n = (v) => Number(v) || 0;
  const components = n(s.basicSalary) + n(s.hra) + n(s.conveyance) + n(s.medicalAllowance) + n(s.specialAllowance) + n(s.otherAllowance) + n(s.bonus);
  const gross = components > 0 ? components : (n(s.monthlyGross) || n(s.grossSalary) || n(u.monthlySalary));
  const employerPf = s.pfEnabled ? Math.round(n(s.basicSalary) * n(s.employerPfPercentage ?? 13) / 100) : 0;
  const employerEsic = s.esicEnabled ? Math.round(gross * n(s.employerEsicPercentage ?? 3.25) / 100) : 0;
  const ctc = gross + employerPf + employerEsic;
  const pf = s.pfEnabled ? (n(s.pfAmount) > 0 ? n(s.pfAmount) : Math.round(ctc * n(s.pfPercentage) / 100)) : 0;
  const esic = s.esicEnabled ? (n(s.esicAmount) > 0 ? n(s.esicAmount) : Math.round(ctc * n(s.esicPercentage) / 100)) : 0;
  const pt = s.ptEnabled ? n(s.ptAmount) : 0;
  const tds = s.tdsEnabled ? (s.tdsType === 'fixed' ? n(s.tdsValue) : Math.round(ctc * n(s.tdsValue) / 100)) : 0;
  const ded = pf + esic + pt + tds;
  return { gross, employerPf, employerEsic, ctc, pf, esic, pt, tds, ded, net: Math.max(0, ctc - ded) };
}

function RoleChip({ user }) {
  if (user.role === 'super_admin') return <span className="badge bg-purple-50 text-purple-700">Super Admin</span>;
  if (user.role === 'hr') return <span className="badge-blue">HR</span>;
  if (user.isHOD) return <span className="badge-green">HOD</span>;
  return <span className="badge-gray">Employee</span>;
}

export default function EmployeeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user: currentUser } = useAuth();
  const isHR = currentUser?.role === 'hr';

  const [emp, setEmp] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [pendency, setPendency] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [jdOpen, setJdOpen] = useState(false);
  const [danger, setDanger] = useState(null); // { type:'deactivate'|'activate'|'delete' }
  const [tab, setTab] = useState('overview');

  // Phase 62 -- Probation Status card.
  const [probation, setProbation] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [e, d, ds] = await Promise.all([
        api.get(`/employees/${id}`),
        api.get('/departments'),
        api.get('/designations'),
      ]);
      setEmp(e.data); setDepartments(d.data); setDesignations(ds.data);
      api.get('/dashboard/hr/pendency', { params: { range: '30', employee: id } })
        .then((r) => setPendency(r.data)).catch(() => setPendency(null));
      // Phase 62 -- probation window (non-blocking).
      api.get(`/probation/employee/${id}`)
        .then((r) => setProbation(r.data)).catch(() => setProbation(null));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  if (loading) return <Loader />;
  if (!emp) return <EmptyState title="Employee not found" />;

  const isSelf = String(emp._id) === String(currentUser?._id);
  const locked = isHR && (emp.role === 'hr' || emp.role === 'super_admin' || isSelf);
  const sb = salaryBreakdown(emp);

  const saveProfile = async (form) => {
    try {
      // Phase 62 -- normalize the Probation sub-doc the same way
      // Employees.jsx does, so empty date inputs become null and the
      // backend derives defaults from joiningDate.
      const payload = { ...form };
      if (payload.probation) {
        const p = payload.probation;
        payload.probation = {
          enabled: p.enabled !== false,
          startDate: p.startDate ? p.startDate : null,
          endDate:   p.endDate   ? p.endDate   : null,
        };
      }
      await api.put(`/employees/${id}`, payload);
      toast.success('Saved'); setEditOpen(false); load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const editInitial = {
    ...emp,
    department: emp.department?._id || '',
    designation: emp.designation?._id || '',
    hodDepartment: emp.hodDepartment?._id || '',
  };

  return (
    <div className="space-y-5">
      <button className="btn-ghost !px-0 text-slate-500" onClick={() => navigate('/employees')}>← Back to Employees</button>

      {/* Identity header */}
      <div className="card card-body">
        <div className="flex flex-wrap items-start gap-4">
          <div className="w-16 h-16 rounded-2xl grid place-items-center text-xl font-bold text-white shrink-0"
            style={{ background: 'linear-gradient(135deg, #1a365d 0%, #3182ce 100%)' }}>
            {initials(emp.name)}
          </div>
          <div className="flex-1 min-w-[220px]">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{emp.name}</h1>
              <RoleChip user={emp} />
              {emp.status === 'active'
                ? <span className="badge-green">Active</span>
                : <span className="badge-red">Inactive</span>}
              {emp.reviewFlow === 'hod_first' && <span className="badge-amber">HOD-first review</span>}
            </div>
            <div className="text-sm text-slate-500 mt-1">
              <span className="font-mono">{emp.employeeId}</span>
              {' · '}{emp.department?.name || 'No department'}
              {' · '}{emp.designation?.title || 'No designation'}
            </div>
            <div className="grid sm:grid-cols-3 gap-x-6 gap-y-1 mt-3 text-sm">
              <div><span className="text-slate-400">Email:</span> {emp.email || '—'}</div>
              <div><span className="text-slate-400">Phone:</span> {emp.phone || '—'}</div>
              <div><span className="text-slate-400">Joined:</span> {fmtDate(emp.joiningDate)}</div>
              <div><span className="text-slate-400">Reporting to:</span> {emp.reportingManager || '—'}</div>
              <div><span className="text-slate-400">Weekly off:</span> {(emp.weeklyOff || []).map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ') || '—'}</div>
              <div><span className="text-slate-400">Leave balance:</span> {Math.max(0, (emp.leaveBalance?.yearlyAllowance || 0) - (emp.leaveBalance?.used || 0))} left</div>
            </div>
          </div>

          {/* Quick actions */}
          {!locked && (
            <div className="flex flex-col gap-2 w-full sm:w-auto">
              <button className="btn-primary" onClick={() => setEditOpen(true)}>Edit Profile</button>
              <button className="btn-secondary" onClick={() => setEditOpen(true)}>Edit Salary</button>
              <button className="btn-secondary" onClick={() => setJdOpen(true)}>Edit JD / Scope</button>
              <button className="btn-secondary" onClick={() => setResetOpen(true)}>Reset Password</button>
            </div>
          )}
          {locked && <div className="text-[11px] text-slate-400 italic self-center">Managed by Super Admin</div>}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {[['overview', 'Overview'], ['templates', 'Templates'], ['analytics', 'Pendency Analytics'], ['work', 'Work History'], ['attendance', 'Attendance'], ['leaves', 'Leaves']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 transition ${tab === key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'templates' && <EmployeeTemplates employee={emp} />}
      {tab === 'analytics' && <EmployeePendency employee={emp} />}
      {tab === 'work' && <EmployeeWorkHistory employee={emp} />}
      {tab === 'attendance' && <EmployeeAttendanceTab employee={emp} />}
      {tab === 'leaves' && <EmployeeLeaves employee={emp} />}

      {tab === 'overview' && <>
      {/* Phase 62 -- Probation Status card for HR / Super Admin. */}
      {probation && (
        <div className="card card-body">
          <h2 className="text-sm font-semibold text-slate-800 mb-3">Probation Status</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
            <div>
              <div className="text-[11px] uppercase text-slate-500">Status</div>
              <div className="mt-0.5">
                {probation.status === 'active'    && <span className="badge bg-blue-50 text-blue-700">Active</span>}
                {probation.status === 'completed' && <span className="badge bg-slate-100 text-slate-700">Completed</span>}
                {probation.status === 'scheduled' && <span className="badge bg-amber-50 text-amber-800">Scheduled</span>}
                {probation.status === 'disabled'  && <span className="badge bg-slate-100 text-slate-500">Disabled</span>}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-slate-500">Start Date</div>
              <div>{probation.startDate ? fmtDate(probation.startDate) : '—'}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-slate-500">End Date</div>
              <div>{probation.endDate ? fmtDate(probation.endDate) : '—'}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-slate-500">Days Remaining</div>
              <div>{probation.daysRemaining ?? 0}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-slate-500">Restricted Leave Types</div>
              <div className="text-xs">
                {(probation.restrictedLeaveTypes || []).length === 0
                  ? '—'
                  : probation.restrictedLeaveTypes.map((t) => {
                      const label = { paid: 'Paid', casual: 'Casual', sick: 'Sick', unpaid: 'Unpaid', other: 'Other' }[t] || t;
                      return <span key={t} className="badge bg-slate-100 text-slate-700 mr-1">{label}</span>;
                    })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Pendency snapshot */}
      {pendency && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Pendency Rate (30d)" value={`${pendency.cards.avgPendencyRate}%`}
            accent={pendency.cards.avgPendencyRate >= 50 ? 'red' : pendency.cards.avgPendencyRate >= 25 ? 'amber' : 'green'} />
          <StatCard label="Pending Tasks (30d)" value={pendency.cards.totalPendingTasks} accent="red" />
          <StatCard label="Dependency Blocked" value={pendency.cards.dependencyBlockedTasks} accent="amber" />
          <StatCard label="Completed (30d)" value={pendency.cards.totalCompletedTasks} accent="green" />
        </div>
      )}

      {/* Salary information */}
      <div className="card card-body">
        <h2 className="text-sm font-semibold text-slate-800 mb-3">Salary Information</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <SalaryStat label="Monthly Gross" value={sb.gross} accent="text-slate-900" />
          <SalaryStat label="Net In-hand" value={sb.net} accent="text-green-700" />
          <SalaryStat label="Monthly CTC" value={sb.ctc} accent="text-indigo-700" />
          <SalaryStat label="Annual CTC" value={sb.ctc * 12} accent="text-indigo-700" />
          <SalaryStat label="Employee PF" value={sb.pf} accent="text-red-700" />
          <SalaryStat label="ESIC" value={sb.esic} accent="text-red-700" />
          <SalaryStat label="Professional Tax" value={sb.pt} accent="text-red-700" />
          <SalaryStat label="TDS" value={sb.tds} accent="text-red-700" />
        </div>
        <div className="text-xs text-slate-500 mt-3">
          Last increment: {emp.lastIncrementDate ? fmtDate(emp.lastIncrementDate) : '—'}
        </div>
        {!locked && <IncrementHistory emp={emp} onChange={load} currentGross={sb.gross} />}
      </div>

      {/* JD / Scope of work */}
      <div className="card card-body">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-800">Job Description &amp; Scope</h2>
          {!locked && <button className="btn-ghost text-brand-700" onClick={() => setJdOpen(true)}>Edit</button>}
        </div>
        <div className="grid md:grid-cols-2 gap-4 text-sm">
          <JdBlock title="Job Description" value={emp.jobDescription} />
          <JdBlock title="Scope of Work" value={emp.scopeOfWork} />
          <JdBlock title="Responsibilities" value={emp.responsibilities} />
          <JdBlock title="KPI Notes" value={emp.kpiNotes} />
        </div>
      </div>

      {/* Danger zone */}
      {!locked && (
        <div className="card card-body border border-red-200">
          <h2 className="text-sm font-semibold text-red-700 mb-1">Danger Zone</h2>
          <p className="text-xs text-slate-500 mb-3">These actions are logged with your name, a timestamp, and the reason you provide.</p>
          <div className="flex flex-wrap gap-2">
            {emp.status === 'active'
              ? <button className="btn-secondary text-amber-700" onClick={() => setDanger({ type: 'deactivate' })}>Deactivate Employee</button>
              : <button className="btn-secondary text-green-700" onClick={() => setDanger({ type: 'activate' })}>Reactivate Employee</button>}
            <button className="btn-secondary text-red-600" onClick={() => setDanger({ type: 'delete' })}>Delete Employee</button>
          </div>
        </div>
      )}
      </>}

      {editOpen && (
        <EmployeeForm
          mode="edit"
          initial={editInitial}
          departments={departments}
          designations={designations}
          onCancel={() => setEditOpen(false)}
          onSave={saveProfile}
          isHR={isHR}
        />
      )}
      {resetOpen && <ResetModal id={id} onClose={() => setResetOpen(false)} />}
      {jdOpen && <JdModal emp={emp} onClose={() => setJdOpen(false)} onSaved={() => { setJdOpen(false); load(); }} />}
      {danger && <DangerModal emp={emp} action={danger.type} onClose={() => setDanger(null)} onDone={(deleted) => { setDanger(null); deleted ? navigate('/employees') : load(); }} />}
    </div>
  );
}

const SalaryStat = ({ label, value, accent }) => (
  <div className="bg-slate-50 rounded-lg p-3">
    <div className="text-[11px] text-slate-500 uppercase tracking-wide">{label}</div>
    <div className={`text-lg font-bold mt-0.5 ${accent}`}>{fmtMoney(value)}</div>
  </div>
);

const JdBlock = ({ title, value }) => (
  <div>
    <div className="text-xs font-semibold text-slate-600 mb-1">{title}</div>
    <div className="text-sm text-slate-700 whitespace-pre-wrap">{value || <span className="text-slate-400 italic">Not set</span>}</div>
  </div>
);

function ResetModal({ id, onClose }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  const save = async () => {
    try { await api.post(`/employees/${id}/reset-password`, { newPassword: pw }); toast.success('Password reset'); onClose(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  return (
    <Modal open onClose={onClose} title="Reset Password"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={pw.length < 6} onClick={save}>Reset</button></>}>
      <label className="label">New password (min 6 characters)</label>
      <input className="input" type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Enter a new password" />
    </Modal>
  );
}

function JdModal({ emp, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({
    jobDescription: emp.jobDescription || '', scopeOfWork: emp.scopeOfWork || '',
    responsibilities: emp.responsibilities || '', reportingManager: emp.reportingManager || '',
    kpiNotes: emp.kpiNotes || '',
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    try { await api.put(`/employees/${emp._id}`, f); toast.success('Saved'); onSaved(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title="Edit Job Description & Scope"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={save}>Save</button></>}>
      <div className="space-y-3">
        <div><label className="label">Reporting Manager</label>
          <input className="input" value={f.reportingManager} onChange={(e) => set('reportingManager', e.target.value)} /></div>
        <div><label className="label">Job Description</label>
          <textarea className="input" rows={3} value={f.jobDescription} onChange={(e) => set('jobDescription', e.target.value)} /></div>
        <div><label className="label">Scope of Work</label>
          <textarea className="input" rows={3} value={f.scopeOfWork} onChange={(e) => set('scopeOfWork', e.target.value)} /></div>
        <div><label className="label">Responsibilities</label>
          <textarea className="input" rows={3} value={f.responsibilities} onChange={(e) => set('responsibilities', e.target.value)} /></div>
        <div><label className="label">KPI Notes</label>
          <textarea className="input" rows={2} value={f.kpiNotes} onChange={(e) => set('kpiNotes', e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function IncrementHistory({ emp, onChange, currentGross }) {
  const toast = useToast();
  const records = [...(emp.salaryIncrements || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
  const [modal, setModal] = useState(null); // null | { mode, data }

  const pct = (prev, next) => (Number(prev) > 0 ? Math.round(((Number(next) - Number(prev)) / Number(prev)) * 1000) / 10 : 0);

  const save = async (form) => {
    try {
      if (modal.mode === 'add') await api.post(`/employees/${emp._id}/increments`, form);
      else await api.put(`/employees/${emp._id}/increments/${modal.data._id}`, form);
      toast.success('Saved'); setModal(null); onChange();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const del = async (rec) => {
    if (!confirm('Delete this increment record?')) return;
    try { await api.delete(`/employees/${emp._id}/increments/${rec._id}`); toast.success('Deleted'); onChange(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-slate-700">Salary Increment History</div>
        <button className="btn-secondary !py-1 text-xs" onClick={() => setModal({ mode: 'add', data: { date: new Date().toISOString().substring(0, 10), previousGross: currentGross || 0, newGross: '', note: '' } })}>+ Add Increment</button>
      </div>
      {records.length === 0 ? (
        <div className="text-xs text-slate-400 italic">No increment history recorded yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table text-sm">
            <thead><tr><th>Effective</th><th>Previous</th><th>Revised</th><th>Increment</th><th>Remarks</th><th></th></tr></thead>
            <tbody>
              {records.map((r) => (
                <tr key={r._id}>
                  <td className="text-xs">{fmtDate(r.date)}</td>
                  <td>{fmtMoney(r.previousGross)}</td>
                  <td className="font-medium">{fmtMoney(r.newGross)}</td>
                  <td className={pct(r.previousGross, r.newGross) >= 0 ? 'text-green-700' : 'text-red-700'}>
                    {pct(r.previousGross, r.newGross) >= 0 ? '+' : ''}{pct(r.previousGross, r.newGross)}%
                  </td>
                  <td className="text-xs text-slate-500">{r.note || '—'}</td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost !py-0.5" onClick={() => setModal({ mode: 'edit', data: { ...r, date: (r.date || '').substring(0, 10) } })}>Edit</button>
                    <button className="btn-ghost !py-0.5 text-red-600" onClick={() => del(r)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal && <IncrementModal mode={modal.mode} initial={modal.data} onCancel={() => setModal(null)} onSave={save} pct={pct} />}
    </div>
  );
}

function IncrementModal({ mode, initial, onCancel, onSave, pct }) {
  const [f, setF] = useState({
    date: initial.date || new Date().toISOString().substring(0, 10),
    previousGross: initial.previousGross ?? 0,
    newGross: initial.newGross ?? '',
    note: initial.note || '',
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const change = pct(f.previousGross, f.newGross);
  return (
    <Modal open onClose={onCancel} title={mode === 'add' ? 'Add Salary Increment' : 'Edit Increment'}
      footer={<><button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" disabled={!f.newGross} onClick={() => onSave(f)}>Save</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">Effective date</label><input className="input" type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></div>
        <div><label className="label">Increment %</label><input className="input bg-slate-50" value={`${change >= 0 ? '+' : ''}${change}%`} readOnly /></div>
        <div><label className="label">Previous salary (gross)</label><input className="input" type="number" min="0" value={f.previousGross} onChange={(e) => set('previousGross', Number(e.target.value))} /></div>
        <div><label className="label">Revised salary (gross)</label><input className="input" type="number" min="0" value={f.newGross} onChange={(e) => set('newGross', e.target.value === '' ? '' : Number(e.target.value))} placeholder="Enter revised gross" /></div>
        <div className="col-span-2"><label className="label">Remarks</label><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="e.g. Annual appraisal" /></div>
      </div>
      <div className="text-[11px] text-slate-500 mt-2">
        Increment % is auto-calculated. This records the change history; payslips continue to use the live salary structure (Edit Salary).
      </div>
    </Modal>
  );
}

function DangerModal({ emp, action, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const isDelete = action === 'delete';
  const isActivate = action === 'activate';
  const needsReason = !isActivate;

  const go = async () => {
    try {
      if (isDelete) {
        await api.delete(`/employees/${emp._id}`, { data: { reason } });
        toast.success('Employee deleted');
        onDone(true);
      } else {
        await api.patch(`/employees/${emp._id}/status`, { reason });
        toast.success(isActivate ? 'Reactivated' : 'Deactivated');
        onDone(false);
      }
    } catch (err) { toast.error(errMsg(err)); }
  };

  const title = isDelete ? 'Delete Employee' : isActivate ? 'Reactivate Employee' : 'Deactivate Employee';
  return (
    <Modal open onClose={onClose} title={title}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className={isDelete ? 'btn-primary !bg-red-600' : 'btn-primary'} disabled={needsReason && !reason.trim()} onClick={go}>
          {isDelete ? 'Delete permanently' : title}
        </button></>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {isDelete
            ? <>This permanently deletes <b>{emp.name}</b> ({emp.employeeId}). This cannot be undone.</>
            : isActivate
              ? <>Reactivate <b>{emp.name}</b> so they can log in and submit work again.</>
              : <>Deactivate <b>{emp.name}</b>. They will no longer be able to log in.</>}
        </p>
        {needsReason && (
          <div>
            <label className="label">Reason (required)</label>
            <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you performing this action?" />
          </div>
        )}
      </div>
    </Modal>
  );
}
