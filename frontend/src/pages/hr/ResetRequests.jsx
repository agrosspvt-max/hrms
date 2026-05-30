import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import Modal from '../../components/Modal.jsx';
import StatCard from '../../components/StatCard.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtDate } from '../../utils/helpers';

/**
 * HR Reset Requests
 *
 * Audit + actions UI for the password reset workflow.  HR sees every
 * request, can approve (which auto-generates a token and emails the
 * employee), or reject with an optional reason.  Approved requests
 * include a copy-able reset URL for fallback delivery.
 */
export default function ResetRequests() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('PENDING');
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [rejectModal, setRejectModal] = useState(null); // request being rejected
  const [linkModal, setLinkModal] = useState(null);     // shows reset URL after approve
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/password-reset', { params: status ? { status } : {} });
      setItems(data);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [status]);

  const filtered = useMemo(() => {
    if (!q) return items;
    const s = q.toLowerCase();
    return items.filter((r) =>
      r.employeeEmail?.toLowerCase().includes(s) ||
      r.employeeId?.name?.toLowerCase().includes(s) ||
      r.employeeId?.employeeId?.toLowerCase().includes(s)
    );
  }, [items, q]);

  const counts = useMemo(() => ({
    pending: items.filter((i) => i.status === 'PENDING').length,
    approved: items.filter((i) => i.status === 'APPROVED').length,
    rejected: items.filter((i) => i.status === 'REJECTED').length,
    used: items.filter((i) => i.status === 'USED').length,
  }), [items]);

  const approve = async (id) => {
    setBusyId(id);
    try {
      const { data } = await api.post(`/password-reset/${id}/approve`);
      toast.success('Approved. Reset email sent.');
      setLinkModal({ url: data.resetUrl, employee: data.request });
      load();
      window.dispatchEvent(new Event('hrms:reset-requests-changed'));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async () => {
    const id = rejectModal._id;
    setBusyId(id);
    try {
      await api.post(`/password-reset/${id}/reject`, { reason: rejectModal.reason });
      toast.success('Rejected.');
      setRejectModal(null);
      load();
      window.dispatchEvent(new Event('hrms:reset-requests-changed'));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const statusBadge = (s) => ({
    PENDING: 'badge-amber', APPROVED: 'badge-blue', REJECTED: 'badge-red', USED: 'badge-green',
  }[s] || 'badge-gray');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Password Reset Requests</h1>
        <p className="text-sm text-slate-500">
          Approve requests to email the employee a one-time, time-bound reset link.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Pending" value={counts.pending} accent="amber" />
        <StatCard label="Approved" value={counts.approved} accent="blue" />
        <StatCard label="Used" value={counts.used} accent="green" />
        <StatCard label="Rejected" value={counts.rejected} accent="red" />
      </div>

      <div className="card card-body grid md:grid-cols-3 gap-3">
        <input className="input" placeholder="Search name / email / ID..." value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="USED">Used</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <button className="btn-secondary" onClick={load}>Refresh</button>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          filtered.length === 0 ? <EmptyState title="No reset requests" subtitle={status === 'PENDING' ? 'Nothing waiting on you.' : 'Try changing the status filter.'} /> :
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Email</th>
                <th>Requested</th>
                <th>Status</th>
                <th>Decided</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r._id}>
                  <td className="font-medium">
                    {r.employeeId?.name || <em className="text-slate-400">Deleted user</em>}
                    {r.employeeId?.role === 'hr' && <span className="ml-1 badge-blue">HR</span>}
                    {r.employeeId?.role === 'super_admin' && <span className="ml-1 badge-amber">Super Admin</span>}
                    <div className="text-[11px] text-slate-500">{r.employeeId?.employeeId}</div>
                  </td>
                  <td>{r.employeeEmail}</td>
                  <td className="text-xs whitespace-nowrap">
                    {new Date(r.requestedAt).toLocaleDateString()}
                    <div className="text-[10px] text-slate-500">{new Date(r.requestedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                  </td>
                  <td><span className={statusBadge(r.status)}>{r.status}</span></td>
                  <td className="text-xs whitespace-nowrap">
                    {r.approvedAt ? new Date(r.approvedAt).toLocaleString()
                      : r.rejectedAt ? new Date(r.rejectedAt).toLocaleString()
                      : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="text-xs text-slate-500 max-w-xs truncate">
                    {r.status === 'REJECTED' && r.rejectReason}
                    {r.status === 'APPROVED' && r.emailSentAt && `Email sent at ${new Date(r.emailSentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                    {r.status === 'USED' && r.usedAt && `Used at ${new Date(r.usedAt).toLocaleString()}`}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {r.status === 'PENDING' && <>
                      <button
                        className="btn-ghost text-xs text-green-700"
                        disabled={busyId === r._id}
                        onClick={() => approve(r._id)}
                      >{busyId === r._id ? '...' : 'Approve'}</button>
                      <button
                        className="btn-ghost text-xs text-red-600"
                        disabled={busyId === r._id}
                        onClick={() => setRejectModal({ ...r, reason: '' })}
                      >Reject</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>

      {/* Reject reason modal */}
      {rejectModal && (
        <Modal
          open
          onClose={() => setRejectModal(null)}
          title={`Reject reset request - ${rejectModal.employeeEmail}`}
          footer={<>
            <button className="btn-secondary" onClick={() => setRejectModal(null)}>Cancel</button>
            <button className="btn-danger" onClick={reject} disabled={busyId === rejectModal._id}>
              {busyId === rejectModal._id ? 'Rejecting...' : 'Confirm Reject'}
            </button>
          </>}
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              The employee will need to submit a new request after rejection.
              Optionally include a reason that will be stored on the audit log.
            </p>
            <div>
              <label className="label">Reason (optional)</label>
              <textarea
                className="input"
                rows={3}
                placeholder="e.g. Cannot verify identity"
                value={rejectModal.reason}
                onChange={(e) => setRejectModal({ ...rejectModal, reason: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Reset link modal (shown right after approve so HR can copy/share if needed) */}
      {linkModal && (
        <Modal
          open
          onClose={() => setLinkModal(null)}
          title="Reset email sent"
          footer={<button className="btn-primary" onClick={() => setLinkModal(null)}>Close</button>}
        >
          <div className="space-y-3 text-sm">
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-800">
              The employee has been emailed a secure one-time reset link.
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Reset URL (fallback)</div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-2 break-all text-xs font-mono">
                {linkModal.url}
              </div>
              <button
                className="btn-secondary mt-2 text-xs"
                onClick={() => { navigator.clipboard.writeText(linkModal.url); toast.success('Copied to clipboard'); }}
              >Copy link</button>
            </div>
            <p className="text-[11px] text-slate-500">
              Use this fallback only if the employee says they didn't receive the email.
              The link is single-use and expires in the configured window.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
