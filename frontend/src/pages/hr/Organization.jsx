import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import StatCard from '../../components/StatCard.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';

const Chevron = ({ open }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${open ? 'rotate-90' : ''}`}><path d="M9 18l6-6-6-6" /></svg>
);

/**
 * Organization - unified Departments + Designations control center.
 * Analytics + an expandable org tree (department → designation → employees,
 * + HOD), with full CRUD, employee moves, and reporting-manager assignment.
 */
export default function Organization() {
  const toast = useToast();
  const navigate = useNavigate();
  const [org, setOrg] = useState(null);
  const [pendByDept, setPendByDept] = useState({});
  const [loading, setLoading] = useState(true);
  const [openDepts, setOpenDepts] = useState(() => new Set());
  const [openDesigs, setOpenDesigs] = useState(() => new Set());
  const [modal, setModal] = useState(null); // { kind, ... }

  const load = async () => {
    setLoading(true);
    try {
      const [o, p] = await Promise.all([
        api.get('/departments/org-structure').then((r) => r.data),
        api.get('/dashboard/hr/pendency', { params: { range: '30' } }).then((r) => r.data).catch(() => null),
      ]);
      setOrg(o);
      const map = {};
      (p?.charts?.byDepartment || []).forEach((d) => { map[d.name] = d.pendencyRate; });
      setPendByDept(map);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const toggle = (set, setter, id) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setter(n); };

  // Flat lists for the move / manager pickers.
  const allEmployees = useMemo(() => {
    if (!org) return [];
    const out = [];
    org.departments.forEach((d) => { d.designations.forEach((dg) => out.push(...dg.employees)); out.push(...d.unassignedEmployees); });
    out.push(...org.noDepartmentEmployees);
    const seen = new Set();
    return out.filter((e) => (seen.has(String(e._id)) ? false : seen.add(String(e._id))));
  }, [org]);

  const avgPendency = useMemo(() => {
    const vals = Object.values(pendByDept);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;
  }, [pendByDept]);

  if (loading || !org) return <Loader />;
  const s = org.stats;

  // ---- CRUD helpers ----
  const saveDept = async (form, id) => {
    try { id ? await api.put(`/departments/${id}`, form) : await api.post('/departments', form); toast.success('Saved'); setModal(null); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const saveDesig = async (form, id) => {
    try { id ? await api.put(`/designations/${id}`, form) : await api.post('/designations', form); toast.success('Saved'); setModal(null); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const doDelete = async (kind, id, reassignTo) => {
    try {
      const base = kind === 'dept' ? 'departments' : 'designations';
      await api.delete(`/${base}/${id}${reassignTo ? `?reassignTo=${reassignTo}` : ''}`);
      toast.success('Deleted'); setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const moveEmployee = async (empId, patch) => {
    try { await api.put(`/employees/${empId}`, patch); toast.success('Updated'); setModal(null); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  const EmpRow = ({ e }) => (
    <div className="flex items-center justify-between gap-2 py-1.5 px-2 rounded hover:bg-slate-50">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-6 h-6 rounded-full bg-slate-100 text-[10px] grid place-items-center font-semibold text-slate-600 shrink-0">{(e.name || '?').slice(0, 2).toUpperCase()}</span>
        <button className="text-sm text-slate-700 hover:text-brand-700 truncate" onClick={() => navigate(`/employees/${e._id}`)}>{e.name}</button>
        {e.isHOD && <span className="badge-green">HOD</span>}
        {e.reportingManager && <span className="text-[11px] text-slate-400 truncate">→ {e.reportingManager}</span>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button className="btn-ghost !py-0.5 text-xs" onClick={() => setModal({ kind: 'move', emp: e })}>Move</button>
        <button className="btn-ghost !py-0.5 text-xs" onClick={() => setModal({ kind: 'manager', emp: e })}>Manager</button>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Organization</h1>
          <p className="text-sm text-slate-500">Departments, designations &amp; reporting structure — your org control center.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => setModal({ kind: 'desig', data: { title: '', description: '', department: '' } })}>+ Designation</button>
          <button className="btn-primary" onClick={() => setModal({ kind: 'dept', data: { name: '', description: '' } })}>+ Department</button>
        </div>
      </div>

      {/* Analytics cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard label="Departments" value={s.totalDepartments} accent="brand" />
        <StatCard label="Designations" value={s.totalDesignations} accent="blue" />
        <StatCard label="Total Employees" value={s.totalEmployees} accent="green" />
        <StatCard label="No Department" value={s.employeesWithoutDepartment} accent={s.employeesWithoutDepartment > 0 ? 'amber' : 'green'} />
        <StatCard label="Standalone Designations" value={s.standaloneDesignations} accent="blue" />
        <StatCard label="Avg Pendency / Dept" value={`${avgPendency}%`} accent={avgPendency >= 50 ? 'red' : avgPendency >= 25 ? 'amber' : 'green'} />
      </div>

      {/* Department tree */}
      <div className="space-y-3">
        {org.departments.length === 0 && <EmptyState title="No departments yet" subtitle="Create a department to start building your org structure." />}
        {org.departments.map((dep) => {
          const open = openDepts.has(String(dep._id));
          const pend = pendByDept[dep.name];
          return (
            <div key={dep._id} className="card">
              <div className="card-body flex items-center justify-between gap-3">
                <button className="flex items-center gap-3 min-w-0 text-left" onClick={() => toggle(openDepts, setOpenDepts, String(dep._id))}>
                  <Chevron open={open} />
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 flex items-center gap-2">{dep.name}
                      <span className="badge-gray">{dep.employeeCount} emp</span>
                      <span className="badge-blue">{dep.designations.length} desig</span>
                      {pend != null && <span className={pend >= 50 ? 'badge-red' : pend >= 25 ? 'badge-amber' : 'badge-green'}>{pend}% pendency</span>}
                    </div>
                    <div className="text-[11px] text-slate-500">{dep.hod ? `HOD: ${dep.hod.name}` : 'No HOD'}{dep.description ? ` · ${dep.description}` : ''}</div>
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <button className="btn-ghost !py-1 text-xs" onClick={() => setModal({ kind: 'dept', id: dep._id, data: { name: dep.name, description: dep.description } })}>Edit</button>
                  <button className="btn-ghost !py-1 text-xs text-red-600" onClick={() => setModal({ kind: 'delete', target: 'dept', id: dep._id, name: dep.name, count: dep.employeeCount, options: org.departments.filter((x) => x._id !== dep._id) })}>Delete</button>
                </div>
              </div>
              {open && (
                <div className="border-t border-slate-100 px-4 py-3 space-y-2">
                  {dep.designations.length === 0 && dep.unassignedEmployees.length === 0 && <div className="text-xs text-slate-400 italic">No designations or employees in this department.</div>}
                  {dep.designations.map((dg) => {
                    const dgOpen = openDesigs.has(String(dg._id));
                    return (
                      <div key={dg._id} className="rounded-lg border border-slate-200">
                        <div className="flex items-center justify-between gap-2 px-3 py-2">
                          <button className="flex items-center gap-2 text-left" onClick={() => toggle(openDesigs, setOpenDesigs, String(dg._id))}>
                            <Chevron open={dgOpen} />
                            <span className="text-sm font-medium text-slate-800">{dg.title}</span>
                            <span className="badge-gray">{dg.employeeCount}</span>
                          </button>
                          <div className="flex gap-1">
                            <button className="btn-ghost !py-0.5 text-xs" onClick={() => setModal({ kind: 'desig', id: dg._id, data: { title: dg.title, description: dg.description, department: dep._id } })}>Edit</button>
                            <button className="btn-ghost !py-0.5 text-xs text-red-600" onClick={() => setModal({ kind: 'delete', target: 'desig', id: dg._id, name: dg.title, count: dg.employeeCount, options: allDesigs(org).filter((x) => x._id !== dg._id) })}>Delete</button>
                          </div>
                        </div>
                        {dgOpen && (
                          <div className="px-2 pb-2">
                            {dg.employees.length === 0 ? <div className="text-xs text-slate-400 italic px-2 py-1">No employees.</div> : dg.employees.map((e) => <EmpRow key={e._id} e={e} />)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {dep.unassignedEmployees.length > 0 && (
                    <div className="rounded-lg border border-dashed border-slate-200 px-2 py-2">
                      <div className="text-[11px] font-semibold text-slate-500 px-2 mb-1">No designation ({dep.unassignedEmployees.length})</div>
                      {dep.unassignedEmployees.map((e) => <EmpRow key={e._id} e={e} />)}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Standalone designations */}
      {org.standaloneDesignations.length > 0 && (
        <div className="card">
          <div className="card-body"><div className="font-semibold text-slate-900">Standalone Designations <span className="badge-blue ml-1">{org.standaloneDesignations.length}</span></div><div className="text-[11px] text-slate-500">Global designations not tied to any department.</div></div>
          <div className="border-t border-slate-100 px-4 py-3 space-y-2">
            {org.standaloneDesignations.map((dg) => {
              const dgOpen = openDesigs.has(String(dg._id));
              return (
                <div key={dg._id} className="rounded-lg border border-slate-200">
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <button className="flex items-center gap-2" onClick={() => toggle(openDesigs, setOpenDesigs, String(dg._id))}><Chevron open={dgOpen} /><span className="text-sm font-medium text-slate-800">{dg.title}</span><span className="badge-gray">{dg.employeeCount}</span></button>
                    <div className="flex gap-1">
                      <button className="btn-ghost !py-0.5 text-xs" onClick={() => setModal({ kind: 'desig', id: dg._id, data: { title: dg.title, description: dg.description, department: '' } })}>Edit</button>
                      <button className="btn-ghost !py-0.5 text-xs text-red-600" onClick={() => setModal({ kind: 'delete', target: 'desig', id: dg._id, name: dg.title, count: dg.employeeCount, options: allDesigs(org).filter((x) => x._id !== dg._id) })}>Delete</button>
                    </div>
                  </div>
                  {dgOpen && <div className="px-2 pb-2">{dg.employees.length === 0 ? <div className="text-xs text-slate-400 italic px-2 py-1">No employees.</div> : dg.employees.map((e) => <EmpRow key={e._id} e={e} />)}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Employees with no department */}
      {org.noDepartmentEmployees.length > 0 && (
        <div className="card">
          <div className="card-body"><div className="font-semibold text-amber-700">Employees Without a Department <span className="badge-amber ml-1">{org.noDepartmentEmployees.length}</span></div></div>
          <div className="border-t border-slate-100 px-4 py-2">{org.noDepartmentEmployees.map((e) => <EmpRow key={e._id} e={e} />)}</div>
        </div>
      )}

      {/* Modals */}
      {modal?.kind === 'dept' && <DeptModal initial={modal.data} id={modal.id} onClose={() => setModal(null)} onSave={saveDept} />}
      {modal?.kind === 'desig' && <DesigModal initial={modal.data} id={modal.id} departments={org.departments} onClose={() => setModal(null)} onSave={saveDesig} />}
      {modal?.kind === 'delete' && <ReassignDeleteModal modal={modal} onClose={() => setModal(null)} onConfirm={doDelete} />}
      {modal?.kind === 'move' && <MoveModal emp={modal.emp} org={org} onClose={() => setModal(null)} onSave={moveEmployee} />}
      {modal?.kind === 'manager' && <ManagerModal emp={modal.emp} employees={allEmployees} onClose={() => setModal(null)} onSave={moveEmployee} />}
    </div>
  );
}

const allDesigs = (org) => {
  const out = [];
  org.departments.forEach((d) => d.designations.forEach((dg) => out.push({ _id: dg._id, title: dg.title })));
  org.standaloneDesignations.forEach((dg) => out.push({ _id: dg._id, title: dg.title }));
  return out;
};

function DeptModal({ initial, id, onClose, onSave }) {
  const [f, setF] = useState({ analyticsType: 'standard', ...initial });
  return (
    <Modal open onClose={onClose} title={id ? 'Edit Department' : 'Add Department'}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.name} onClick={() => onSave(f, id)}>Save</button></>}>
      <div className="space-y-3">
        <div><label className="label">Name</label><input className="input" value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="label">Description</label><input className="input" value={f.description || ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div>
          <label className="label">Analytics Type</label>
          <select
            className="input"
            value={f.analyticsType || 'standard'}
            onChange={(e) => setF({ ...f, analyticsType: e.target.value })}
          >
            <option value="standard">Standard — Pendency Review + Completion Review</option>
            <option value="calling">Calling — adds Calling Analytics + Product &amp; Farmer Analytics</option>
          </select>
          <div className="text-[11px] text-slate-500 mt-1">
            Controls which Performance tabs the department's HOD sees. Switch to "Calling"
            for teams that file the Daily Calling Report. Renaming the department later does
            not change this setting.
          </div>
        </div>
      </div>
    </Modal>
  );
}

function DesigModal({ initial, id, departments, onClose, onSave }) {
  const [f, setF] = useState(initial);
  return (
    <Modal open onClose={onClose} title={id ? 'Edit Designation' : 'Add Designation'}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.title} onClick={() => onSave(f, id)}>Save</button></>}>
      <div className="space-y-3">
        <div><label className="label">Title</label><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div><label className="label">Description</label><input className="input" value={f.description || ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div>
          <label className="label">Department (leave blank for standalone/global)</label>
          <SearchableSelect
            value={f.department || ''}
            onChange={(v) => setF({ ...f, department: v })}
            options={departments}
            getValue={(d) => d._id}
            getLabel={(d) => d.name}
            placeholder="— Standalone (global) —"
          />
        </div>
      </div>
    </Modal>
  );
}

function ReassignDeleteModal({ modal, onClose, onConfirm }) {
  const [reassignTo, setReassignTo] = useState('');
  const label = modal.target === 'dept' ? 'department' : 'designation';
  return (
    <Modal open onClose={onClose} title={`Delete ${label}`}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary !bg-red-600" onClick={() => onConfirm(modal.target, modal.id, reassignTo)}>Delete</button></>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">Delete <b>{modal.name}</b>?{modal.count > 0 && <> {modal.count} employee(s) currently use it.</>}</p>
        {modal.count > 0 && (
          <div>
            <label className="label">Reassign those employees to (optional)</label>
            <select className="input" value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
              <option value="">— Clear (no {label}) —</option>
              {modal.options.map((o) => <option key={o._id} value={o._id}>{o.name || o.title}</option>)}
            </select>
            <div className="text-[11px] text-slate-500 mt-1">Employees are never broken — they’re moved to your choice or left without a {label}.</div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function MoveModal({ emp, org, onClose, onSave }) {
  const [dept, setDept] = useState('');
  const [desig, setDesig] = useState('');
  // Designations available: those in the chosen dept + standalone ones.
  const desigOptions = useMemo(() => {
    const out = [];
    if (dept) { const d = org.departments.find((x) => String(x._id) === String(dept)); (d?.designations || []).forEach((dg) => out.push({ _id: dg._id, title: dg.title })); }
    org.standaloneDesignations.forEach((dg) => out.push({ _id: dg._id, title: `${dg.title} (global)` }));
    return out;
  }, [dept, org]);
  return (
    <Modal open onClose={onClose} title={`Move ${emp.name}`}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={() => onSave(emp._id, { department: dept || '', designation: desig || '' })}>Save</button></>}>
      <div className="space-y-3">
        <div><label className="label">Department</label>
          <select className="input" value={dept} onChange={(e) => { setDept(e.target.value); setDesig(''); }}>
            <option value="">— No department —</option>
            {org.departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </select>
        </div>
        <div><label className="label">Designation</label>
          <select className="input" value={desig} onChange={(e) => setDesig(e.target.value)}>
            <option value="">— No designation —</option>
            {desigOptions.map((d) => <option key={d._id} value={d._id}>{d.title}</option>)}
          </select>
        </div>
        <div className="text-[11px] text-slate-500">Updates the employee's department &amp; designation. Salary, attendance and assignments are unaffected.</div>
      </div>
    </Modal>
  );
}

function ManagerModal({ emp, employees, onClose, onSave }) {
  const [mgr, setMgr] = useState(emp.reportingManager || '');
  return (
    <Modal open onClose={onClose} title={`Reporting Manager — ${emp.name}`}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={() => onSave(emp._id, { reportingManager: mgr })}>Save</button></>}>
      <div className="space-y-3">
        <div><label className="label">Reporting manager</label>
          <select className="input" value={mgr} onChange={(e) => setMgr(e.target.value)}>
            <option value="">— None —</option>
            {employees.filter((e) => String(e._id) !== String(emp._id)).map((e) => <option key={e._id} value={e.name}>{e.name}</option>)}
          </select>
        </div>
        <div className="text-[11px] text-slate-500">Sets the employee's reporting manager. Choose “None” to remove.</div>
      </div>
    </Modal>
  );
}
