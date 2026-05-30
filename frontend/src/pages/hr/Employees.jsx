import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { fmtMoney, errMsg, authUrl } from '../../utils/helpers';

/** Role badge shown in the directory. */
function RoleBadge({ user }) {
  if (user.role === 'super_admin') return <span className="badge bg-purple-50 text-purple-700">Super Admin</span>;
  if (user.role === 'hr') return <span className="badge-blue">HR</span>;
  if (user.isHOD) return <span className="badge-green">HOD</span>;
  return <span className="badge-gray">Employee</span>;
}

const blankStructure = {
  annualCTC: 0, monthlyGross: 0,
  basicSalary: 0, hra: 0, conveyance: 0, medicalAllowance: 0, specialAllowance: 0, otherAllowance: 0,
  pfEnabled: false, pfPercentage: 12, pfAmount: 0,
  esicEnabled: false, esicPercentage: 0.75, esicAmount: 0,
  ptEnabled: false, ptAmount: 200,
  tdsEnabled: false, tdsType: 'percentage', tdsValue: 0, tdsAmount: 0,
};

const blank = {
  name: '', employeeId: '', email: '', phone: '', password: '',
  role: 'employee', department: '', designation: '',
  monthlySalary: 0,
  salaryStructure: { ...blankStructure },
  bankName: '', bankAccount: '', uanNumber: '', panNumber: '',
  joiningDate: new Date().toISOString().substring(0, 10),
  status: 'active', weeklyOff: [0],
  reviewFlow: 'direct_hr',
  isHOD: false, hodDepartment: '',
  hodPermissions: { canReview: false, canRemark: false, canMarks: false, canRecommend: false },
};

/**
 * Monthly salary shown in the employee list.  Prefers the sum of the
 * structured earning components (the real gross), falling back to the
 * stored monthlyGross / legacy in-hand so older records still display.
 */
export function monthlyGrossOf(u) {
  const s = u.salaryStructure || {};
  const components = (Number(s.basicSalary) || 0) + (Number(s.hra) || 0) + (Number(s.conveyance) || 0) +
    (Number(s.medicalAllowance) || 0) + (Number(s.specialAllowance) || 0) + (Number(s.otherAllowance) || 0) +
    (Number(s.bonus) || 0);
  return components > 0
    ? components
    : (Number(s.monthlyGross) || Number(s.grossSalary) || Number(u.monthlySalary) || 0);
}

export default function Employees() {
  const [users, setUsers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [q, setQ] = useState('');
  const [filterDept, setFilterDept] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | { mode, data }
  const toast = useToast();
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const isHR = currentUser?.role === 'hr';

  const load = async () => {
    setLoading(true);
    const [u, d, ds] = await Promise.all([
      api.get('/employees', { params: { q, department: filterDept, status: filterStatus } }),
      api.get('/departments'),
      api.get('/designations'),
    ]);
    setUsers(u.data); setDepartments(d.data); setDesignations(ds.data);
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q, filterDept, filterStatus]);

  const save = async (form) => {
    try {
      if (modal.mode === 'create') await api.post('/employees', form);
      else await api.put(`/employees/${modal.data._id}`, form);
      toast.success('Saved');
      setModal(null);
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-900">Employees</h1>
        <div className="flex gap-2">
          <a className="btn-secondary" href={authUrl('/api/employees/export.csv')}>Export CSV</a>
          <button className="btn-primary" onClick={() => setModal({ mode: 'create', data: blank })}>+ Add Employee</button>
        </div>
      </div>

      <div className="card card-body grid md:grid-cols-4 gap-3">
        <input className="input" placeholder="Search name, email, ID..." value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={filterDept} onChange={(e) => setFilterDept(e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
        </select>
        <select className="input" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          users.length === 0 ? <EmptyState title="No employees" /> :
          <table className="table">
            <thead>
              <tr>
                <th>ID</th><th>Name</th><th>Department</th><th>Designation</th><th>Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = String(u._id) === String(currentUser?._id);
                return (
                  <tr
                    key={u._id}
                    className="cursor-pointer hover:bg-slate-50 transition"
                    onClick={() => navigate(`/employees/${u._id}`)}
                  >
                    <td className="font-mono text-xs">{u.employeeId}</td>
                    <td className="font-medium text-slate-900">
                      {u.name}
                      {isSelf && <span className="ml-1 badge-blue">You</span>}
                      {u.status === 'inactive' && <span className="ml-1 badge-red">Inactive</span>}
                    </td>
                    <td>{u.department?.name || '-'}</td>
                    <td>{u.designation?.title || '-'}</td>
                    <td><RoleBadge user={u} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>}
      </div>

      {modal && (
        <EmployeeForm
          mode={modal.mode}
          initial={modal.data}
          departments={departments}
          designations={designations}
          onCancel={() => setModal(null)}
          onSave={save}
          isHR={isHR}
        />
      )}
    </div>
  );
}

export function EmployeeForm({ mode, initial, departments, designations, onCancel, onSave, isHR }) {
  const [form, setForm] = useState(initial);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleOff = (n) => {
    const cur = form.weeklyOff || [];
    set('weeklyOff', cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort());
  };
  return (
    <Modal
      open
      onClose={onCancel}
      title={mode === 'create' ? 'Add Employee' : `Edit ${form.name}`}
      size="lg"
      footer={<>
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={() => onSave(form)}>Save</button>
      </>}
    >
      <div className="grid md:grid-cols-2 gap-3">
        <div><label className="label">Full Name</label><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div><label className="label">Employee ID</label><input className="input" value={form.employeeId} onChange={(e) => set('employeeId', e.target.value)} disabled={mode === 'edit'} /></div>
        <div><label className="label">Email</label><input className="input" value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
        <div><label className="label">Phone</label><input className="input" value={form.phone || ''} onChange={(e) => set('phone', e.target.value)} /></div>
        {mode === 'create' && (
          <div><label className="label">Initial password (default "changeme123")</label><input className="input" value={form.password} onChange={(e) => set('password', e.target.value)} /></div>
        )}
        <div><label className="label">Role</label>
          <select className="input" value={form.role} onChange={(e) => set('role', e.target.value)} disabled={isHR}>
            <option value="employee">Employee</option>
            {!isHR && <option value="hr">HR / Admin</option>}
            {!isHR && <option value="super_admin">Super Admin</option>}
          </select>
          {isHR && <div className="text-[11px] text-slate-500 mt-1">HR can only create Employee accounts.</div>}
        </div>
        <div><label className="label">Department</label>
          <select className="input" value={form.department || ''} onChange={(e) => set('department', e.target.value)}>
            <option value="">-</option>
            {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </select>
        </div>
        <div><label className="label">Designation</label>
          <select className="input" value={form.designation || ''} onChange={(e) => set('designation', e.target.value)}>
            <option value="">-</option>
            {designations.map((d) => <option key={d._id} value={d._id}>{d.title}</option>)}
          </select>
        </div>
        <div className="md:col-span-2">
          <SalaryStructureEditor form={form} set={set} />
        </div>
        <div><label className="label">Joining Date</label><input className="input" type="date" value={(form.joiningDate || '').substring(0, 10)} onChange={(e) => set('joiningDate', e.target.value)} /></div>
        <div><label className="label">Status</label>
          <select className="input" value={form.status} onChange={(e) => set('status', e.target.value)}>
            <option value="active">Active</option><option value="inactive">Inactive</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="label">Weekly Off Days</label>
          <div className="flex flex-wrap gap-2">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
              <button key={i} type="button" onClick={() => toggleOff(i)}
                className={`px-3 py-1.5 rounded-lg text-xs border ${form.weeklyOff?.includes(i) ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-600 border-slate-200'}`}>
                {d}
              </button>
            ))}
          </div>
        </div>
        {/* Review routing + HOD supervision */}
        <div className="md:col-span-2 bg-indigo-50/60 border border-indigo-100 rounded-lg p-3 space-y-3">
          <div className="text-xs font-semibold text-slate-700">Review &amp; Supervision</div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="label">Review Flow</label>
              <select className="input" value={form.reviewFlow || 'direct_hr'} onChange={(e) => set('reviewFlow', e.target.value)}>
                <option value="direct_hr">Direct HR Review</option>
                <option value="hod_first">HOD → HR Review</option>
              </select>
              <div className="text-[11px] text-slate-500 mt-1">
                {form.reviewFlow === 'hod_first'
                  ? 'Submissions go to the department HOD first, then HR finalises.'
                  : 'Submissions go straight to HR (current default).'}
              </div>
            </div>
            <div>
              <label className="label">Head of Department</label>
              <label className="flex items-center gap-2 text-sm text-slate-700 mt-1.5">
                <input type="checkbox" checked={!!form.isHOD} onChange={(e) => set('isHOD', e.target.checked)} />
                Make this employee a HOD
              </label>
              <div className="text-[11px] text-slate-500 mt-1">A HOD is still an employee, managed by HR.</div>
            </div>
          </div>

          {form.isHOD && (
            <div className="grid md:grid-cols-2 gap-3 bg-white rounded-lg p-3 border border-indigo-100">
              <div>
                <label className="label">Heads which department?</label>
                <select className="input" value={form.hodDepartment || ''} onChange={(e) => set('hodDepartment', e.target.value)}>
                  <option value="">- select department -</option>
                  {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">HOD Permissions</label>
                <div className="grid grid-cols-2 gap-1 mt-1">
                  {[
                    ['canReview', 'Can review submissions'],
                    ['canRemark', 'Can add remarks'],
                    ['canMarks', 'Can give marks'],
                    ['canRecommend', 'Can recommend approval'],
                  ].map(([key, label]) => (
                    <label key={key} className="flex items-center gap-1.5 text-[12px] text-slate-700">
                      <input
                        type="checkbox"
                        checked={!!(form.hodPermissions || {})[key]}
                        onChange={(e) => set('hodPermissions', { ...(form.hodPermissions || {}), [key]: e.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="md:col-span-2 bg-slate-50 rounded-lg p-3">
          <div className="text-xs font-semibold text-slate-700 mb-2">Leave Balance</div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="label">Yearly Allowance</label><input className="input" type="number" placeholder="12" value={form.leaveBalance?.yearlyAllowance || ''} onChange={(e) => set('leaveBalance', { ...(form.leaveBalance || {}), yearlyAllowance: Number(e.target.value) })} /></div>
            <div><label className="label">Monthly Allowance</label><input className="input" type="number" placeholder="2" value={form.leaveBalance?.monthlyAllowance || ''} onChange={(e) => set('leaveBalance', { ...(form.leaveBalance || {}), monthlyAllowance: Number(e.target.value) })} /></div>
            <div><label className="label">Used</label><input className="input" type="number" placeholder="0" value={form.leaveBalance?.used || ''} onChange={(e) => set('leaveBalance', { ...(form.leaveBalance || {}), used: Number(e.target.value) })} /></div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Advanced salary-structure editor: earning components + statutory
 * deductions (PF / ESIC / PT / TDS) with a live, attendance-agnostic
 * preview of gross, total statutory deductions and net.  Actual payslips
 * additionally apply attendance (LOP / half-day) deductions at generation.
 */
function SalaryStructureEditor({ form, set }) {
  const s = form.salaryStructure || {};
  const setS = (k, v) => set('salaryStructure', { ...(form.salaryStructure || {}), [k]: v });
  const num = (v) => Number(v) || 0;

  // Gross = sum of all earning components (legacy fallback to monthlyGross /
  // in-hand so existing employees still preview sensibly).
  const components = num(s.basicSalary) + num(s.hra) + num(s.conveyance) +
    num(s.medicalAllowance) + num(s.specialAllowance) + num(s.otherAllowance) + num(s.bonus);
  const gross = components > 0 ? components : (num(s.monthlyGross) || num(form.monthlySalary));

  // Employer contributions (CTC items - never reduce net).  Employer PF is
  // % of Basic; Employer ESIC is % of Gross.
  const employerPf = s.pfEnabled ? Math.round(num(s.basicSalary) * num(s.employerPfPercentage ?? 13) / 100) : 0;
  const employerEsic = s.esicEnabled ? Math.round(gross * num(s.employerEsicPercentage ?? 3.25) / 100) : 0;
  const employerTotal = employerPf + employerEsic;
  const ctcMonthly = gross + employerTotal;

  // Employee deductions: all percentage-based deductions are on TOTAL CTC
  // (monthly).  PT is fixed; explicit amount overrides still win.
  const pf = s.pfEnabled ? (num(s.pfAmount) > 0 ? num(s.pfAmount) : Math.round(ctcMonthly * num(s.pfPercentage) / 100)) : 0;
  const esic = s.esicEnabled ? (num(s.esicAmount) > 0 ? num(s.esicAmount) : Math.round(ctcMonthly * num(s.esicPercentage) / 100)) : 0;
  const pt = s.ptEnabled ? num(s.ptAmount) : 0;
  const tds = s.tdsEnabled ? (s.tdsType === 'fixed' ? num(s.tdsValue) : Math.round(ctcMonthly * num(s.tdsValue) / 100)) : 0;
  const employeeDeductions = pf + esic + pt + tds;

  // Net In-hand = Total CTC (monthly) - Employee Deductions.
  const net = Math.max(0, ctcMonthly - employeeDeductions);

  // Helpers that render the STABLE module-level components, wiring each
  // field to its structure key.  These are plain function calls (not new
  // component types), so inputs are never remounted on re-render.
  const field = (label, k, step) => (
    <NumField label={label} value={s[k]} step={step} onChange={(v) => setS(k, v)} />
  );
  const toggle = (label, k) => (
    <ToggleField label={label} checked={!!s[k]} onChange={(v) => setS(k, v)} />
  );

  return (
    <div className="bg-slate-50 rounded-lg p-3 space-y-4">
      <div className="text-xs font-semibold text-slate-700">Gross Earnings (monthly components)</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {field('Basic Salary', 'basicSalary')}
        {field('HRA', 'hra')}
        {field('Conveyance', 'conveyance')}
        {field('Medical Allowance', 'medicalAllowance')}
        {field('Special Allowance', 'specialAllowance')}
        {field('Other Allowances', 'otherAllowance')}
        {field('Bonus (fixed monthly)', 'bonus')}
      </div>
      <div className="text-[11px] text-slate-500">
        Monthly Gross is the sum of these components. All employee deductions (PF / ESIC / TDS %) are calculated on
        <b> Total CTC (monthly)</b>; PT is a fixed amount. Employer PF is % of Basic and Employer ESIC is % of Gross.
      </div>

      <div className="text-xs font-semibold text-slate-700">Statutory Deductions</div>
      <div className="grid md:grid-cols-2 gap-4">
        {/* PF */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
          {toggle('Provident Fund (PF / EPF)', 'pfEnabled')}
          {s.pfEnabled && (
            <div className="grid grid-cols-2 gap-2">
              {field('Employee PF % of CTC', 'pfPercentage', '0.01')}
              {field('PF Amount (override)', 'pfAmount')}
              {field('Employer PF % of Basic', 'employerPfPercentage', '0.01')}
            </div>
          )}
        </div>
        {/* ESIC */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
          {toggle('ESIC', 'esicEnabled')}
          {s.esicEnabled && (
            <div className="grid grid-cols-2 gap-2">
              {field('Employee ESIC % of CTC', 'esicPercentage', '0.01')}
              {field('ESIC Amount (override)', 'esicAmount')}
              {field('Employer ESIC % of Gross', 'employerEsicPercentage', '0.01')}
            </div>
          )}
        </div>
        {/* PT */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
          {toggle('Professional Tax (PT)', 'ptEnabled')}
          {s.ptEnabled && field('PT Amount (fixed)', 'ptAmount')}
        </div>
        {/* TDS */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
          {toggle('Income Tax (TDS)', 'tdsEnabled')}
          {s.tdsEnabled && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">TDS Type</label>
                <select className="input" value={s.tdsType || 'percentage'} onChange={(e) => setS('tdsType', e.target.value)}>
                  <option value="percentage">Percentage</option>
                  <option value="fixed">Fixed</option>
                </select>
              </div>
              {field(s.tdsType === 'fixed' ? 'TDS Amount' : 'TDS % of Gross', 'tdsValue', '0.01')}
            </div>
          )}
        </div>
      </div>

      <div className="text-xs font-semibold text-slate-700">Payout Details (shown on payslip)</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div><label className="label">Bank Name</label><input className="input" value={form.bankName || ''} onChange={(e) => set('bankName', e.target.value)} /></div>
        <div><label className="label">Account Number</label><input className="input" value={form.bankAccount || ''} onChange={(e) => set('bankAccount', e.target.value)} /></div>
        <div><label className="label">UAN / PF Number</label><input className="input" value={form.uanNumber || ''} onChange={(e) => set('uanNumber', e.target.value)} /></div>
        <div><label className="label">PAN</label><input className="input" value={form.panNumber || ''} onChange={(e) => set('panNumber', e.target.value)} /></div>
      </div>

      {/* Live CTC preview */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg border border-slate-200 p-3 text-sm">
          <div className="text-[10px] font-semibold text-green-700 uppercase tracking-wide mb-2">Gross Earnings</div>
          {[['Basic', s.basicSalary], ['HRA', s.hra], ['Conveyance', s.conveyance], ['Medical', s.medicalAllowance], ['Special', s.specialAllowance], ['Other', s.otherAllowance], ['Bonus', s.bonus]]
            .filter((r) => num(r[1]))
            .map(([l, v]) => <div key={l} className="flex justify-between text-slate-600"><span>{l}</span><span>{fmtMoney(num(v))}</span></div>)}
          <div className="border-t border-slate-200 mt-1.5 pt-1.5 flex justify-between font-semibold text-green-700"><span>Monthly Gross</span><span>{fmtMoney(gross)}</span></div>

          <div className="text-[10px] font-semibold text-indigo-700 uppercase tracking-wide mt-3 mb-1">Employer Contributions</div>
          <div className="flex justify-between text-slate-600"><span>Employer PF</span><span>{fmtMoney(employerPf)}</span></div>
          <div className="flex justify-between text-slate-600"><span>Employer ESIC</span><span>{fmtMoney(employerEsic)}</span></div>
          <div className="border-t border-slate-200 mt-1.5 pt-1.5 flex justify-between font-semibold text-indigo-700"><span>Total CTC (monthly)</span><span>{fmtMoney(ctcMonthly)}</span></div>
          <div className="flex justify-between text-[11px] text-slate-400"><span>Annual CTC</span><span>{fmtMoney(ctcMonthly * 12)}</span></div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-3 text-sm">
          <div className="text-[10px] font-semibold text-red-700 uppercase tracking-wide mb-2">Employee Deductions</div>
          <div className="flex justify-between text-red-700"><span>Employee PF (on CTC)</span><span>- {fmtMoney(pf)}</span></div>
          <div className="flex justify-between text-red-700"><span>ESIC (on CTC)</span><span>- {fmtMoney(esic)}</span></div>
          <div className="flex justify-between text-red-700"><span>Professional Tax</span><span>- {fmtMoney(pt)}</span></div>
          <div className="flex justify-between text-red-700"><span>TDS</span><span>- {fmtMoney(tds)}</span></div>
          <div className="border-t border-slate-200 mt-1.5 pt-1.5 flex justify-between font-semibold text-red-700"><span>Total Deductions</span><span>- {fmtMoney(employeeDeductions)}</span></div>

          <div className="mt-3 rounded-lg px-3 py-2 text-white flex justify-between items-center" style={{ background: 'linear-gradient(135deg, #1a365d 0%, #2a4365 100%)' }}>
            <span className="text-xs">Net In-hand (Total CTC − Deductions)</span>
            <span className="text-lg font-bold">{fmtMoney(net)}</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            Employer contributions raise CTC but never reduce net pay. Payslips additionally apply attendance-based LOP / half-day deductions for the month.
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Stable, module-level numeric field.  Defined OUTSIDE any render body so
 * its component identity never changes between renders - this is what keeps
 * the input mounted (and focused) while typing.
 *
 * UX: an UNSET value (0 / null / undefined) renders VISUALLY EMPTY with a
 * placeholder, so HR can type directly without first deleting a "0".  The
 * displayed text is held in local string state so intermediate entries like
 * "" or "0." don't get clobbered by the parent, while the parent always
 * receives a clean number (empty -> 0).
 */
function NumField({ label, value, onChange, step, placeholder }) {
  const toRaw = (v) => (v === 0 || v === null || v === undefined || v === '' ? '' : String(v));
  const [raw, setRaw] = useState(toRaw(value));

  // Re-sync the displayed text when the value changes from OUTSIDE (form
  // reset, loading an employee to edit, or an auto-calculation), but never
  // while the user is mid-edit (when the parsed local text already matches).
  useEffect(() => {
    const parsedLocal = raw === '' ? 0 : Number(raw);
    if (parsedLocal !== (Number(value) || 0)) setRaw(toRaw(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div>
      <label className="label">{label}</label>
      <input
        className="input"
        type="number"
        min="0"
        step={step || 1}
        placeholder={placeholder || 'Enter amount'}
        value={raw}
        onChange={(e) => {
          const v = e.target.value;
          setRaw(v);
          onChange(v === '' ? 0 : Number(v));
        }}
      />
    </div>
  );
}

function ToggleField({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
