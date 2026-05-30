import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import StatCard from '../../components/StatCard.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { fmtDate, errMsg } from '../../utils/helpers';

/**
 * Manage Access (Super Admin only)
 *
 * Self-service administration of HR + Super Admin accounts.  Powered by
 * the existing employee CRUD endpoints (create, status-toggle, role
 * update, reset-password, delete) plus a dedicated GET /admin-accounts
 * read for this dashboard.  The "last Super Admin" guard is enforced
 * server-side so it cannot be bypassed even via direct API calls.
 *
 * Adding a new role (Finance Manager, Operations, etc.) only requires
 * extending the ROLES list below and the enum on the User model — the
 * page is otherwise role-agnostic.
 */

const ROLES = [
  { value: 'super_admin', label: 'Super Admin', cls: 'badge bg-purple-50 text-purple-700' },
  { value: 'hr',          label: 'HR',          cls: 'badge-blue' },
  // Future roles plug in here without page changes:
  // { value: 'finance', label: 'Finance Manager', cls: 'badge-green' },
];
const roleMeta = (r) => ROLES.find((x) => x.value === r) || { value: r, label: r, cls: 'badge-gray' };

const FORM_BLANK = {
  name: '', email: '', phone: '', password: 'changeme123',
  role: 'hr', department: '', designation: '',
  employeeId: '',
};

export default function ManageAccess() {
  const toast = useToast();
  const { user: me } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [summary, setSummary] = useState({ totalSuperAdmins: 0, totalHR: 0, active: 0, inactive: 0 });
  const [depts, setDepts] = useState([]);
  const [desigs, setDesigs] = useState([]);
  const [q, setQ] = useState('');
  const [filterRole, setFilterRole] = useState('all');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | { kind, target?, data? }

  const load = async () => {
    setLoading(true);
    try {
      const [a, d, ds] = await Promise.all([
        api.get('/admin-accounts').then((r) => r.data),
        api.get('/departments').then((r) => r.data).catch(() => []),
        api.get('/designations').then((r) => r.data).catch(() => []),
      ]);
      setAccounts(a.accounts || []); setSummary(a.summary || {}); setDepts(d || []); setDesigs(ds || []);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const ql = q.toLowerCase();
    return accounts.filter((u) => (filterRole === 'all' || u.role === filterRole)
      && (!q || u.name?.toLowerCase().includes(ql) || u.email?.toLowerCase().includes(ql)));
  }, [accounts, q, filterRole]);

  const isMe = (u) => String(u._id) === String(me?._id);
  const onlyOneSA = summary.totalSuperAdmins <= 1;

  /* ---------- mutations (delegating to existing employee endpoints) ---------- */
  const create = async (form) => {
    try {
      await api.post('/employees', form);
      toast.success('Account created'); setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const edit = async (id, patch) => {
    try { await api.put(`/employees/${id}`, patch); toast.success('Saved'); setModal(null); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const toggleStatus = async (u, reason) => {
    try { await api.patch(`/employees/${u._id}/status`, { reason }); toast.success('Status updated'); setModal(null); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const changeRole = async (u, role) => {
    try { await api.put(`/employees/${u._id}`, { role }); toast.success(role === 'super_admin' ? 'Promoted to Super Admin' : 'Demoted to HR'); setModal(null); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const resetPassword = async (u, newPassword) => {
    try { await api.post(`/employees/${u._id}/reset-password`, { newPassword }); toast.success('Password reset'); setModal(null); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const remove = async (u, reason) => {
    try { await api.delete(`/employees/${u._id}`, { data: { reason } }); toast.success('Account deleted'); setModal(null); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Manage Access</h1>
          <p className="text-sm text-slate-500">Self-service administration for Super Admin &amp; HR accounts — no seed files, no DB scripts.</p>
        </div>
        <button className="btn-primary" onClick={() => setModal({ kind: 'create', data: { ...FORM_BLANK } })}>+ Create Admin Account</button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Super Admins" value={summary.totalSuperAdmins} accent="brand" />
        <StatCard label="HR Accounts" value={summary.totalHR} accent="blue" />
        <StatCard label="Active" value={summary.active} accent="green" />
        <StatCard label="Inactive" value={summary.inactive} accent={summary.inactive > 0 ? 'red' : 'gray'} />
      </div>

      {/* Filters */}
      <div className="card card-body flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[220px]">
          <label className="label">Search</label>
          <input className="input" placeholder="Name or email…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div>
          <label className="label">Role</label>
          <select className="input max-w-[200px]" value={filterRole} onChange={(e) => setFilterRole(e.target.value)}>
            <option value="all">All admin roles</option>
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
      </div>

      {/* Account list */}
      {loading ? <Loader /> : shown.length === 0 ? <EmptyState title="No admin accounts" /> : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr>
              <th>Name</th><th>Email</th><th>Role</th><th>Created By</th><th>Created</th><th>Last Login</th><th>Status</th><th className="text-right">Actions</th>
            </tr></thead>
            <tbody>
              {shown.map((u) => {
                const meta = roleMeta(u.role);
                return (
                  <tr key={u._id}>
                    <td>
                      <div className="font-medium text-slate-900">{u.name}{isMe(u) && <span className="ml-2 badge-blue">You</span>}</div>
                      <div className="text-[11px] text-slate-500">{u.employeeId} {u.phone ? `· ${u.phone}` : ''}</div>
                    </td>
                    <td className="text-sm text-slate-700">{u.email}</td>
                    <td><span className={meta.cls}>{meta.label}</span></td>
                    <td className="text-xs text-slate-500">{u.createdByUser?.name || <span className="italic">system</span>}</td>
                    <td className="text-xs text-slate-500">{u.createdAt ? fmtDate(u.createdAt) : '—'}</td>
                    <td className="text-xs text-slate-500">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : <span className="italic">never</span>}</td>
                    <td>{u.status === 'active' ? <span className="badge-green">Active</span> : <span className="badge-red">Inactive</span>}</td>
                    <td className="text-right whitespace-nowrap">
                      <button className="btn-ghost !py-0.5 text-xs" onClick={() => setModal({ kind: 'view', target: u })}>View</button>
                      <button className="btn-ghost !py-0.5 text-xs" onClick={() => setModal({ kind: 'edit', target: u, data: { ...u, department: u.department?._id || '', designation: u.designation?._id || '' } })}>Edit</button>
                      <button className="btn-ghost !py-0.5 text-xs" disabled={isMe(u) || (u.role === 'super_admin' && onlyOneSA && u.status === 'active')} onClick={() => setModal({ kind: 'status', target: u })}>{u.status === 'active' ? 'Deactivate' : 'Activate'}</button>
                      <button className="btn-ghost !py-0.5 text-xs" onClick={() => setModal({ kind: 'role', target: u })} disabled={isMe(u) && u.role === 'super_admin' && onlyOneSA}>{u.role === 'hr' ? 'Promote' : 'Demote'}</button>
                      <button className="btn-ghost !py-0.5 text-xs" onClick={() => setModal({ kind: 'password', target: u })}>Reset Password</button>
                      <button className="btn-ghost !py-0.5 text-xs text-red-600" disabled={isMe(u) || (u.role === 'super_admin' && onlyOneSA)} onClick={() => setModal({ kind: 'delete', target: u })}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal?.kind === 'create' && <CreateModal data={modal.data} departments={depts} designations={desigs} onClose={() => setModal(null)} onSave={create} />}
      {modal?.kind === 'edit' && <EditModal data={modal.data} departments={depts} designations={desigs} onClose={() => setModal(null)} onSave={(patch) => edit(modal.target._id, patch)} />}
      {modal?.kind === 'view' && <ViewModal u={modal.target} onClose={() => setModal(null)} />}
      {modal?.kind === 'status' && <ReasonModal title={modal.target.status === 'active' ? 'Deactivate Account' : 'Reactivate Account'} requireReason={modal.target.status === 'active'} u={modal.target} onClose={() => setModal(null)} onConfirm={(reason) => toggleStatus(modal.target, reason)} />}
      {modal?.kind === 'role' && <RoleModal u={modal.target} onClose={() => setModal(null)} onConfirm={(role) => changeRole(modal.target, role)} />}
      {modal?.kind === 'password' && <PasswordModal u={modal.target} onClose={() => setModal(null)} onConfirm={(pw) => resetPassword(modal.target, pw)} />}
      {modal?.kind === 'delete' && <ReasonModal title="Delete Account" requireReason confirmCls="!bg-red-600" u={modal.target} body={<>This permanently deletes <b>{modal.target.name}</b>. This cannot be undone.</>} onClose={() => setModal(null)} onConfirm={(reason) => remove(modal.target, reason)} />}
    </div>
  );
}

/* ------------------------------ Modals ------------------------------ */

function CreateModal({ data, departments, designations, onClose, onSave }) {
  const [f, setF] = useState(data);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const valid = f.name && f.email && f.employeeId && (f.password || '').length >= 6;
  return (
    <Modal open onClose={onClose} size="lg" title="Create Admin Account"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!valid} onClick={() => onSave(f)}>Create</button></>}>
      <div className="grid md:grid-cols-2 gap-3">
        <div><label className="label">Role</label>
          <select className="input" value={f.role} onChange={(e) => set('role', e.target.value)}>
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div><label className="label">Employee ID</label>
          <input className="input" value={f.employeeId} onChange={(e) => set('employeeId', e.target.value)} placeholder="e.g. AMI0099" />
        </div>
        <div><label className="label">Full Name</label>
          <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div><label className="label">Email</label>
          <input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
        </div>
        <div><label className="label">Phone</label>
          <input className="input" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
        </div>
        <div><label className="label">Initial password (min 6)</label>
          <input className="input" value={f.password} onChange={(e) => set('password', e.target.value)} />
        </div>
        <div><label className="label">Department (optional)</label>
          <select className="input" value={f.department} onChange={(e) => set('department', e.target.value)}>
            <option value="">—</option>
            {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </select>
        </div>
        <div><label className="label">Designation (optional)</label>
          <select className="input" value={f.designation} onChange={(e) => set('designation', e.target.value)}>
            <option value="">—</option>
            {designations.map((d) => <option key={d._id} value={d._id}>{d.title}</option>)}
          </select>
        </div>
      </div>
      <div className="text-[11px] text-slate-500 mt-3">
        A welcome email will be sent when the email system is configured. The account is created with standard permissions for the chosen role.
      </div>
    </Modal>
  );
}

function EditModal({ data, departments, designations, onClose, onSave }) {
  const [f, setF] = useState({
    name: data.name || '', email: data.email || '', phone: data.phone || '',
    department: data.department || '', designation: data.designation || '',
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Modal open onClose={onClose} size="lg" title={`Edit ${data.name}`}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => onSave(f)}>Save</button></>}>
      <div className="grid md:grid-cols-2 gap-3">
        <div><label className="label">Full Name</label><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div><label className="label">Email</label><input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
        <div><label className="label">Phone</label><input className="input" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        <div /> {/* spacer */}
        <div><label className="label">Department</label>
          <select className="input" value={f.department} onChange={(e) => set('department', e.target.value)}>
            <option value="">—</option>
            {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </select>
        </div>
        <div><label className="label">Designation</label>
          <select className="input" value={f.designation} onChange={(e) => set('designation', e.target.value)}>
            <option value="">—</option>
            {designations.map((d) => <option key={d._id} value={d._id}>{d.title}</option>)}
          </select>
        </div>
      </div>
    </Modal>
  );
}

function ViewModal({ u, onClose }) {
  const meta = roleMeta(u.role);
  const Field = ({ label, value }) => (
    <div className="bg-slate-50 rounded-lg p-2"><div className="text-[10px] uppercase text-slate-500">{label}</div><div className="text-sm text-slate-800">{value || <span className="text-slate-400 italic">—</span>}</div></div>
  );
  return (
    <Modal open onClose={onClose} size="lg" title="Account Details"
      footer={<button className="btn-secondary" onClick={onClose}>Close</button>}>
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-lg font-bold">{u.name}</div>
          <span className={meta.cls}>{meta.label}</span>
          {u.status === 'active' ? <span className="badge-green">Active</span> : <span className="badge-red">Inactive</span>}
        </div>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <Field label="Employee ID" value={u.employeeId} />
          <Field label="Email" value={u.email} />
          <Field label="Phone" value={u.phone} />
          <Field label="Department" value={u.department?.name} />
          <Field label="Designation" value={u.designation?.title} />
          <Field label="Created By" value={u.createdByUser?.name} />
          <Field label="Created" value={u.createdAt ? fmtDate(u.createdAt) : ''} />
          <Field label="Last Login" value={u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'Never'} />
        </div>
      </div>
    </Modal>
  );
}

function RoleModal({ u, onClose, onConfirm }) {
  const next = u.role === 'hr' ? 'super_admin' : 'hr';
  const meta = roleMeta(next);
  return (
    <Modal open onClose={onClose} title={u.role === 'hr' ? 'Promote to Super Admin' : 'Demote to HR'}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => onConfirm(next)}>{u.role === 'hr' ? 'Promote' : 'Demote'}</button></>}>
      <p className="text-sm text-slate-700">
        {u.role === 'hr'
          ? <>Grant <b>{u.name}</b> full Super Admin authority. They'll be able to manage HR accounts, audit logs, and review HR work.</>
          : <>Reduce <b>{u.name}</b>'s access to standard HR permissions. They'll lose Super Admin-only modules and review power over HR submissions.</>}
        <br />New role: <span className={meta.cls + ' ml-1'}>{meta.label}</span>
      </p>
    </Modal>
  );
}

function PasswordModal({ u, onClose, onConfirm }) {
  const [pw, setPw] = useState('');
  const gen = () => setPw(Math.random().toString(36).slice(-10));
  return (
    <Modal open onClose={onClose} title={`Reset password — ${u.name}`}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={pw.length < 6} onClick={() => onConfirm(pw)}>Reset</button></>}>
      <div className="space-y-3">
        <div>
          <label className="label">New password (min 6 characters)</label>
          <input className="input" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Type or generate a temporary password" />
        </div>
        <button className="btn-ghost text-xs" onClick={gen}>Generate temporary password</button>
        <div className="text-[11px] text-slate-500">When the email system is configured, the user will receive a reset link. For now the password is set immediately.</div>
      </div>
    </Modal>
  );
}

function ReasonModal({ title, body, u, requireReason, confirmCls = '', onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  return (
    <Modal open onClose={onClose} title={title}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className={`btn-primary ${confirmCls}`} disabled={requireReason && !reason.trim()} onClick={() => onConfirm(reason)}>{title}</button></>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-700">{body || <>This action will be logged with your name and a timestamp.</>}</p>
        {requireReason && (
          <div>
            <label className="label">Reason (required)</label>
            <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you performing this action?" />
          </div>
        )}
      </div>
    </Modal>
  );
}
