import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { errMsg, fmtDate, fmtMoney } from '../../utils/helpers';

/**
 * HR Management - dedicated Super Admin page for CRUD on HR accounts.
 * Wraps the standard /api/employees endpoints but filtered to role=hr
 * and adds an HR-creation modal that defaults role to "hr".
 */
const blank = {
  name: '', employeeId: '', email: '', phone: '', password: '',
  role: 'hr', department: '', designation: '',
  monthlySalary: 0, joiningDate: new Date().toISOString().substring(0, 10),
  status: 'active', weeklyOff: [0],
};

export default function HRManagement() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null);
  const [resetModal, setResetModal] = useState(null);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const [e, d, ds] = await Promise.all([
        api.get('/employees', { params: { role: 'hr', q } }),
        api.get('/departments'),
        api.get('/designations'),
      ]);
      setItems(e.data);
      setDepartments(d.data);
      setDesignations(ds.data);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q]);

  const save = async (form) => {
    try {
      if (modal.mode === 'create') {
        await api.post('/employees', { ...form, role: 'hr' });
        toast.success('HR account created');
      } else {
        await api.put(`/employees/${modal.data._id}`, form);
        toast.success('HR account updated');
      }
      setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const toggle = async (id) => {
    try { await api.patch(`/employees/${id}/status`); toast.success('Status updated'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const del = async (it) => {
    if (!confirm(`Permanently delete HR account "${it.name}"?`)) return;
    try { await api.delete(`/employees/${it._id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  const resetPwd = async () => {
    if (!resetModal.password || resetModal.password.length < 6) {
      toast.error('Password must be at least 6 characters'); return;
    }
    try {
      await api.post(`/employees/${resetModal.user._id}/reset-password`, { newPassword: resetModal.password });
      toast.success('Password reset');
      setResetModal(null);
    } catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-end flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">HR Management</h1>
          <p className="text-sm text-slate-500">
            Manage HR accounts. Only Super Admin can create / edit / delete HR users.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setModal({ mode: 'create', data: { ...blank } })}>+ Add HR</button>
      </div>

      <div className="card card-body">
        <input className="input max-w-md" placeholder="Search name / email / ID..." value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          items.length === 0 ? <EmptyState title="No HR accounts yet" subtitle="Click + Add HR to create one." /> :
          <table className="table">
            <thead>
              <tr>
                <th>ID</th><th>Name</th><th>Email</th><th>Department</th><th>Designation</th>
                <th>Salary</th><th>Joining</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u._id}>
                  <td className="font-mono text-xs">{u.employeeId}</td>
                  <td className="font-medium text-slate-900">
                    {u.name}
                    {String(u._id) === String(user._id) && <span className="ml-1 badge-blue">You</span>}
                    <div className="text-[11px] text-slate-500 capitalize">{u.role.replace('_', ' ')}</div>
                  </td>
                  <td>{u.email}</td>
                  <td>{u.department?.name || '-'}</td>
                  <td>{u.designation?.title || '-'}</td>
                  <td>{fmtMoney(u.monthlySalary)}</td>
                  <td>{fmtDate(u.joiningDate)}</td>
                  <td>{u.status === 'active' ? <span className="badge-green">Active</span> : <span className="badge-red">Inactive</span>}</td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost text-xs" onClick={() => setModal({ mode: 'edit', data: { ...u, department: u.department?._id || '', designation: u.designation?._id || '' } })}>Edit</button>
                    <button className="btn-ghost text-xs" disabled={String(u._id) === String(user._id)} onClick={() => toggle(u._id)}>
                      {u.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                    <button className="btn-ghost text-xs" onClick={() => setResetModal({ user: u, password: '' })}>Reset PW</button>
                    <button className="btn-ghost text-xs text-red-600" disabled={String(u._id) === String(user._id)} onClick={() => del(u)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>

      {modal && <HRForm modal={modal} setModal={setModal} departments={departments} designations={designations} onSave={save} />}

      {resetModal && (
        <Modal
          open
          onClose={() => setResetModal(null)}
          title={`Reset password - ${resetModal.user.name}`}
          footer={<>
            <button className="btn-secondary" onClick={() => setResetModal(null)}>Cancel</button>
            <button className="btn-primary" onClick={resetPwd}>Reset</button>
          </>}
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Set a new password for this HR user immediately (no email approval flow).
              The user must change it after first login.
            </p>
            <div>
              <label className="label">New password (min 6)</label>
              <input
                className="input"
                type="password"
                minLength={6}
                value={resetModal.password}
                onChange={(e) => setResetModal({ ...resetModal, password: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function HRForm({ modal, setModal, departments, designations, onSave }) {
  const f = modal.data;
  const set = (k, v) => setModal({ ...modal, data: { ...f, [k]: v } });
  return (
    <Modal
      open size="lg" onClose={() => setModal(null)}
      title={modal.mode === 'create' ? 'Add HR Account' : `Edit HR - ${f.name}`}
      footer={<>
        <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn-primary" onClick={() => onSave(f)}>Save</button>
      </>}
    >
      <div className="grid md:grid-cols-2 gap-3">
        <div><label className="label">Full Name</label><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div><label className="label">Employee ID</label><input className="input" value={f.employeeId} onChange={(e) => set('employeeId', e.target.value)} disabled={modal.mode === 'edit'} placeholder="e.g. HR-002" /></div>
        <div><label className="label">Email</label><input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
        <div><label className="label">Phone</label><input className="input" value={f.phone || ''} onChange={(e) => set('phone', e.target.value)} /></div>
        {modal.mode === 'create' && (
          <div className="md:col-span-2">
            <label className="label">Initial password</label>
            <input className="input" placeholder='Leave blank for "changeme123"' value={f.password} onChange={(e) => set('password', e.target.value)} />
          </div>
        )}
        <div><label className="label">Department</label>
          <select className="input" value={f.department || ''} onChange={(e) => set('department', e.target.value)}>
            <option value="">-</option>
            {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </select>
        </div>
        <div><label className="label">Designation</label>
          <select className="input" value={f.designation || ''} onChange={(e) => set('designation', e.target.value)}>
            <option value="">-</option>
            {designations.map((d) => <option key={d._id} value={d._id}>{d.title}</option>)}
          </select>
        </div>
        <div><label className="label">Monthly Salary (in-hand)</label>
          <input className="input" type="number" placeholder="0" value={f.monthlySalary || ''} onChange={(e) => set('monthlySalary', Number(e.target.value))} />
        </div>
        <div><label className="label">Joining Date</label>
          <input className="input" type="date" value={(f.joiningDate || '').substring(0, 10)} onChange={(e) => set('joiningDate', e.target.value)} />
        </div>
        <div><label className="label">Status</label>
          <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="active">Active</option><option value="inactive">Inactive</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}
