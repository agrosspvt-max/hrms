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
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkReasonModal, setBulkReasonModal] = useState(null); // null | { action: 'deactivate'|'delete' }
  const [bulkResult, setBulkResult] = useState(null); // null | server response
  const [bulkBusy, setBulkBusy] = useState(false);
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

  /* ----------------- Selection helpers ----------------- */
  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const visibleIds = users.map((u) => u._id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSelected = visibleIds.some((id) => selected.has(id)) && !allSelected;
  const toggleAll = () => setSelected((prev) => {
    if (allSelected) {
      // Deselect only the currently visible rows; preserve any others (none today)
      const next = new Set(prev);
      visibleIds.forEach((id) => next.delete(id));
      return next;
    }
    return new Set([...prev, ...visibleIds]);
  });
  const clearSelection = () => setSelected(new Set());

  /* ----------------- Bulk actions ----------------- */
  const runBulkAction = async (reason) => {
    if (!bulkReasonModal) return;
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      const { data } = await api.post('/employees/bulk-action', {
        action: bulkReasonModal.action,
        ids,
        reason,
      });
      setBulkResult(data);
      setBulkReasonModal(null);
      clearSelection();
      load();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBulkBusy(false);
    }
  };

  /* ----------------- Client-side CSV export of selected rows ----------------- */
  const exportSelectedCsv = () => {
    const rows = users.filter((u) => selected.has(u._id));
    if (!rows.length) { toast.error('No rows selected'); return; }
    const headers = ['Employee ID', 'Name', 'Email', 'Phone', 'Role', 'Department', 'Designation', 'Monthly Gross', 'Joining Date', 'Status'];
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    rows.forEach((u) => {
      lines.push([
        u.employeeId, u.name, u.email, u.phone || '', u.role,
        u.department?.name || '', u.designation?.title || '',
        monthlyGrossOf(u),
        u.joiningDate ? new Date(u.joiningDate).toISOString().substring(0, 10) : '',
        u.status,
      ].map(esc).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `employees_selected_${new Date().toISOString().substring(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} row(s)`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-900">Employees</h1>
        <div className="flex gap-2">
          <a className="btn-secondary" href={authUrl('/api/employees/export.csv')}>Export CSV</a>
          <button className="btn-secondary" onClick={() => setImportOpen(true)}>Import from Excel</button>
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

      {/* Sticky bulk action bar -- only shown when 1+ rows are selected */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-10 rounded-lg bg-brand-50 border border-brand-200 px-4 py-2 flex items-center justify-between flex-wrap gap-2 shadow-sm">
          <div className="text-sm text-brand-900">
            <b>{selected.size}</b> selected
          </div>
          <div className="flex gap-2 flex-wrap">
            <button className="btn-secondary !py-1" onClick={exportSelectedCsv}>Export Selected CSV</button>
            <button className="btn-secondary !py-1" onClick={() => setBulkReasonModal({ action: 'deactivate' })}>Deactivate</button>
            <button className="btn-secondary !py-1 !text-red-700 !border-red-200 hover:!bg-red-50" onClick={() => setBulkReasonModal({ action: 'delete' })}>Delete</button>
            <button className="btn-ghost !py-1 text-slate-600" onClick={clearSelection}>Clear</button>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          users.length === 0 ? <EmptyState title="No employees" /> :
          <table className="table">
            <thead>
              <tr>
                <th className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all visible employees"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleAll}
                  />
                </th>
                <th>ID</th><th>Name</th><th>Department</th><th>Designation</th><th>Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = String(u._id) === String(currentUser?._id);
                const isPicked = selected.has(u._id);
                return (
                  <tr
                    key={u._id}
                    className={`cursor-pointer hover:bg-slate-50 transition ${isPicked ? 'bg-brand-50/40' : ''}`}
                    onClick={() => navigate(`/employees/${u._id}`)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${u.name}`}
                        checked={isPicked}
                        onChange={() => toggleOne(u._id)}
                      />
                    </td>
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

      {importOpen && (
        <ImportEmployeesModal
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); load(); }}
        />
      )}

      {bulkReasonModal && (
        <BulkReasonModal
          action={bulkReasonModal.action}
          count={selected.size}
          busy={bulkBusy}
          onCancel={() => setBulkReasonModal(null)}
          onSubmit={runBulkAction}
        />
      )}

      {bulkResult && (
        <BulkResultModal result={bulkResult} onClose={() => setBulkResult(null)} />
      )}
    </div>
  );
}

/**
 * Asks HR for a single shared reason (audit-logged per row).  Defends
 * against accidental destructive batches by requiring 5+ characters and
 * showing a clear count of how many rows the operation will touch.
 */
function BulkReasonModal({ action, count, busy, onCancel, onSubmit }) {
  const [reason, setReason] = useState('');
  const isDelete = action === 'delete';
  const title = isDelete ? `Delete ${count} account(s)` : `Deactivate ${count} account(s)`;
  const canSubmit = reason.trim().length >= 5 && !busy;
  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      footer={<>
        <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          className={isDelete ? 'btn-primary !bg-red-600 hover:!bg-red-700' : 'btn-primary'}
          disabled={!canSubmit}
          onClick={() => onSubmit(reason.trim())}
        >
          {busy ? 'Working...' : isDelete ? 'Delete' : 'Deactivate'}
        </button>
      </>}
    >
      <div className="space-y-3">
        <div className={`rounded-lg p-3 text-sm ${isDelete ? 'bg-red-50 border border-red-200 text-red-800' : 'bg-amber-50 border border-amber-200 text-amber-800'}`}>
          {isDelete
            ? 'This permanently deletes the selected employee records. The action is audit-logged but cannot be undone.'
            : 'The selected accounts will be marked Inactive. They will not be able to log in. You can reactivate them later from the employee detail page.'}
        </div>
        <div>
          <label className="label">Reason (required, shared by all {count} rows)</label>
          <textarea
            className="input min-h-[80px]"
            placeholder="e.g. Annual offboarding, contract ended, department restructure"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
          <div className="text-[11px] text-slate-500 mt-1">
            Minimum 5 characters. The same reason is recorded against every successful row
            in the audit log.
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Per-row summary of a bulk action.  Always shows both lists -- HR needs
 * to know which rows succeeded and which were skipped (and why), since
 * skip-and-continue means a bad row in the middle won't halt the batch.
 */
function BulkResultModal({ result, onClose }) {
  const ok = result.succeeded || [];
  const bad = result.failed || [];
  const actionLabel = result.action === 'delete' ? 'Deleted' : 'Deactivated';
  return (
    <Modal
      open
      onClose={onClose}
      title={`Bulk ${actionLabel.toLowerCase()} complete`}
      footer={<button className="btn-primary" onClick={onClose}>Close</button>}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
            <div className="text-[11px] text-slate-500 uppercase">Requested</div>
            <div className="text-2xl font-bold text-slate-900">{result.requested}</div>
          </div>
          <div className="rounded-lg bg-green-50 border border-green-200 p-3">
            <div className="text-[11px] text-green-700 uppercase">{actionLabel}</div>
            <div className="text-2xl font-bold text-green-700">{ok.length}</div>
          </div>
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
            <div className="text-[11px] text-amber-700 uppercase">Skipped</div>
            <div className="text-2xl font-bold text-amber-700">{bad.length}</div>
          </div>
        </div>

        {ok.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-green-800 mb-1">{actionLabel}</div>
            <div className="max-h-40 overflow-y-auto border border-green-100 rounded-lg bg-green-50/40">
              <ul className="divide-y divide-green-100">
                {ok.map((r) => (
                  <li key={r.id} className="px-3 py-1.5 text-sm text-slate-700">{r.name}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {bad.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-amber-800 mb-1">Skipped (per-row reason)</div>
            <div className="max-h-48 overflow-y-auto border border-amber-100 rounded-lg bg-amber-50/40">
              <ul className="divide-y divide-amber-100">
                {bad.map((r) => (
                  <li key={r.id} className="px-3 py-1.5 text-sm flex justify-between gap-3">
                    <span className="text-slate-700">{r.name}</span>
                    <span className="text-[12px] text-amber-700 text-right">{r.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Bulk import from Excel.  Two-step modal:
 *   1. Download the pre-filled template (server-generated, with a
 *      Reference sheet listing every existing Department + Designation).
 *   2. Upload the filled file.  The server validates EVERY row before
 *      creating anything -- on any validation failure we render the row-
 *      by-row error list and no employees are created.
 */
function ImportEmployeesModal({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { mode: 'success'|'error', ... }
  const toast = useToast();

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/employees/import', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult({ mode: 'success', ...data });
      toast.success(data.message || 'Import succeeded');
    } catch (err) {
      const body = err?.response?.data;
      if (body?.errors?.length) {
        setResult({ mode: 'error', ...body });
      } else {
        toast.error(errMsg(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Import Employees from Excel"
      size="lg"
      footer={result?.mode === 'success' ? (
        <button className="btn-primary" onClick={onImported}>Done</button>
      ) : (
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn-primary"
            onClick={upload}
            disabled={!file || busy}
          >
            {busy ? 'Importing...' : 'Upload & Import'}
          </button>
        </>
      )}
    >
      <div className="space-y-4">
        {!result && (
          <>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700 space-y-2">
              <div className="font-semibold text-slate-900">Step 1 — Download the template</div>
              <p className="text-[13px]">
                The template includes a sample row and a <b>Reference</b> sheet listing every
                Department and Designation that currently exists. If you type a Department or
                Designation that doesn't exist yet, it will be <b>created automatically</b>, and
                new Designations are mapped to the Department from the same row. Required
                columns are marked with <code>*</code>.
              </p>
              <a
                className="btn-secondary inline-block"
                href={authUrl('/api/employees/import-template')}
              >
                Download Excel Template
              </a>
            </div>

            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700 space-y-2">
              <div className="font-semibold text-slate-900">Step 2 — Upload the filled file</div>
              <p className="text-[13px]">
                Every row is validated <b>before</b> any employees are created. If any row has
                an error (missing field, duplicate email, unknown department, etc.) the entire
                import is aborted and you'll see a row-by-row error list below — no partial
                state.
              </p>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:font-semibold hover:file:bg-brand-100"
              />
              {file && (
                <div className="text-[12px] text-slate-500">
                  Selected: <b>{file.name}</b> ({Math.round(file.size / 1024)} KB)
                </div>
              )}
            </div>

            <div className="text-[11px] text-slate-500">
              Welcome emails are sent automatically to each imported employee (same as
              single-employee creation). Default initial password is <code>changeme123</code> if
              the column is left blank.
            </div>
          </>
        )}

        {result?.mode === 'error' && (
          <div className="space-y-3">
            <div className="rounded-lg bg-red-50 border border-red-200 p-3">
              <div className="text-sm font-semibold text-red-800">Import aborted</div>
              <div className="text-[12px] text-red-700 mt-1">
                {result.errors.length} of {result.totalRows} row(s) failed validation.
                No employees were created. Fix the rows below and re-upload.
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-slate-700 w-16">Row</th>
                    <th className="text-left px-3 py-2 font-semibold text-slate-700">Name</th>
                    <th className="text-left px-3 py-2 font-semibold text-slate-700">Problems</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.map((e) => (
                    <tr key={e.row} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">{e.row}</td>
                      <td className="px-3 py-2 text-slate-700">{e.name}</td>
                      <td className="px-3 py-2 text-red-700">
                        <ul className="list-disc pl-4 space-y-0.5">
                          {e.errors.map((msg, i) => <li key={i}>{msg}</li>)}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end">
              <button className="btn-secondary" onClick={() => { setResult(null); setFile(null); }}>
                Try Again
              </button>
            </div>
          </div>
        )}

        {result?.mode === 'success' && (
          <div className="space-y-3">
            <div className="rounded-lg bg-green-50 border border-green-200 p-3">
              <div className="text-sm font-semibold text-green-800">
                Imported {result.created?.length || 0} employee(s) successfully
              </div>
              <div className="text-[12px] text-green-700 mt-1">
                Welcome emails are being sent in the background. Initial password defaults to
                <code> changeme123</code> unless you specified one per row.
              </div>
            </div>

            {(result.createdDepartments?.length > 0 || result.createdDesignations?.length > 0) && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-2">
                <div className="text-sm font-semibold text-amber-900">
                  Auto-provisioned during this import
                </div>
                {result.createdDepartments?.length > 0 && (
                  <div className="text-[12px] text-amber-800">
                    <span className="font-semibold">New Departments ({result.createdDepartments.length}):</span>{' '}
                    {result.createdDepartments.map((d) => d.name).join(', ')}
                  </div>
                )}
                {result.createdDesignations?.length > 0 && (
                  <div className="text-[12px] text-amber-800">
                    <span className="font-semibold">New Designations ({result.createdDesignations.length}):</span>{' '}
                    {result.createdDesignations.map((d) => `${d.title}${d.department ? ` → ${d.department}` : ''}`).join(', ')}
                  </div>
                )}
                <div className="text-[11px] text-amber-700">
                  Visit Organization → Departments / Designations to add descriptions or assign a Head of Department.
                </div>
              </div>
            )}

            {result.created?.length > 0 && (
              <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold text-slate-700">Employee ID</th>
                      <th className="text-left px-3 py-2 font-semibold text-slate-700">Name</th>
                      <th className="text-left px-3 py-2 font-semibold text-slate-700">Email</th>
                      <th className="text-left px-3 py-2 font-semibold text-slate-700">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.created.map((u) => (
                      <tr key={u._id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-mono text-xs text-slate-500">{u.employeeId}</td>
                        <td className="px-3 py-2 text-slate-800">{u.name}</td>
                        <td className="px-3 py-2 text-slate-600">{u.email}</td>
                        <td className="px-3 py-2 text-slate-600 capitalize">{u.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
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
        {field('Bonus', 'specialAllowance')}
        {field('Other Allowances', 'otherAllowance')}
        {field('Special Allowance', 'bonus')}
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
          {[['Basic', s.basicSalary], ['HRA', s.hra], ['Conveyance', s.conveyance], ['Medical', s.medicalAllowance], ['Bonus', s.specialAllowance], ['Other', s.otherAllowance], ['Special Allowance', s.bonus]]
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
