import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { fmtDate, errMsg, authUrl } from '../../utils/helpers';
import { subscribe } from '../../realtime';

// Phase 54 -- reused inside LeaveDetailsModal to display supporting docs.
const fmtSize = (n) => {
  if (!Number.isFinite(n)) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024)        return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

export default function HRLeaves() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('pending');
  // Super Admin sees three tabs: All / Employees / HR.  Default to "all"
  // so legacy leaves (whose employee role couldn't be populated for some
  // reason) are never accidentally hidden.
  const [audience, setAudience] = useState('all');
  const [loading, setLoading] = useState(true);
  // Leave whose full details are being viewed (employee reason +
  // HR note + revoke reason are all rendered in full here so long
  // remarks aren't lost behind a CSS truncate).
  const [viewing, setViewing] = useState(null);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    const params = {};
    if (filter) params.status = filter;
    // Only forward audience if it's not 'all' so the backend returns everything.
    if (isSuperAdmin && audience && audience !== 'all') params.audience = audience;
    const { data } = await api.get('/leaves', { params });
    setItems(data);
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter, audience]);
  // Phase 47 -- new leave application or a decision made on another
  // tab refreshes the list immediately.
  useEffect(() => {
    const u1 = subscribe('leave:applied',  load);
    const u2 = subscribe('leave:decision', load);
    return () => { u1(); u2(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, audience]);

  const decide = async (id, decision) => {
    try {
      await api.patch(`/leaves/${id}/decision`, { decision });
      toast.success(`Leave ${decision}`);
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  /**
   * Revoke an approved leave.  Two-step confirm (yes/no + optional
   * reason) so HR doesn't undo an approval by accident.  Backend
   * restores the exact balance and audit-logs the revocation.
   */
  const revoke = async (lv) => {
    const ok = window.confirm(
      `Are you sure you want to revoke this approved leave for ${lv.employee?.name || 'this employee'}?\n` +
      `This will restore the employee's leave balance by ${lv.days} day(s).`,
    );
    if (!ok) return;
    const reason = window.prompt('Reason for revoking this leave (optional):', '') || '';
    try {
      await api.post(`/leaves/${lv._id}/revoke`, { reason: reason.trim() });
      toast.success(`Leave revoked.${lv.paid ? ` ${lv.days} day(s) restored.` : ''}`);
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h1 className="text-2xl font-bold">Leave Requests</h1>
        <div className="flex gap-2 items-center">
          {isSuperAdmin && (
            <div className="flex bg-slate-100 rounded-lg p-0.5 text-xs">
              <button
                onClick={() => setAudience('all')}
                className={`px-3 py-1.5 rounded-md ${audience === 'all' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-600'}`}
              >All</button>
              <button
                onClick={() => setAudience('employee')}
                className={`px-3 py-1.5 rounded-md ${audience === 'employee' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-600'}`}
              >Employees</button>
              <button
                onClick={() => setAudience('hr')}
                className={`px-3 py-1.5 rounded-md ${audience === 'hr' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-600'}`}
              >HR</button>
            </div>
          )}
          <select className="input max-w-[180px]" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="revoked">Revoked</option>
          </select>
        </div>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          items.length === 0 ? <EmptyState title="No leave requests" /> :
          <table className="table">
            <thead><tr>
              <th>Employee</th><th>Applied</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Reason</th><th>Status</th><th></th>
            </tr></thead>
            <tbody>
              {items.map((lv) => (
                <tr key={lv._id}>
                  <td className="font-medium">
                    {lv.employee?.name}
                    {lv.employee?.role === 'hr' && <span className="ml-1 badge-blue">HR</span>}
                    {lv.employee?.role === 'super_admin' && <span className="ml-1 badge-amber">Super Admin</span>}
                    <div className="text-[11px] text-slate-500">{lv.employee?.employeeId}</div>
                  </td>
                  {/* Phase 40.1 -- exact submission timestamp.  The Leave
                      model has timestamps:true so this is just `createdAt`. */}
                  <td className="text-[12px] whitespace-nowrap">
                    {lv.createdAt ? (
                      <>
                        {fmtDate(lv.createdAt)}
                        <div className="text-[11px] text-slate-500">
                          {new Date(lv.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}
                        </div>
                      </>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="capitalize">{lv.leaveType}</td>
                  <td>{fmtDate(lv.fromDate)}</td>
                  <td>{fmtDate(lv.toDate)}</td>
                  <td>{lv.days}</td>
                  <td className="text-slate-500 max-w-xs">
                    {lv.reason ? (
                      <button
                        type="button"
                        onClick={() => setViewing(lv)}
                        title="Click to view full reason"
                        className="text-left w-full truncate hover:text-brand-700 hover:underline cursor-pointer"
                      >
                        {lv.reason}
                      </button>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                    {/* Phase 54 -- inline paperclip when supporting docs
                        exist so HR can spot leave requests that carry
                        attachments at a glance. */}
                    {Array.isArray(lv.attachments) && lv.attachments.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setViewing(lv)}
                        className="ml-2 badge bg-blue-50 text-blue-700 text-[10px]"
                        title={`${lv.attachments.length} supporting document${lv.attachments.length === 1 ? '' : 's'}`}
                      >
                        📎 {lv.attachments.length}
                      </button>
                    )}
                  </td>
                  <td>
                    {lv.status === 'pending' && <span className="badge-amber">Pending</span>}
                    {lv.status === 'approved' && <span className={lv.paid ? 'badge-green' : 'badge-amber'}>{lv.paid ? 'Approved' : 'Approved (Unpaid)'}</span>}
                    {lv.status === 'rejected' && <span className="badge-red">Rejected</span>}
                    {lv.status === 'revoked'  && <span className="badge-gray">Revoked</span>}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost" onClick={() => setViewing(lv)} title="View full leave details">View</button>
                    {lv.status === 'pending' && <>
                      <button className="btn-ghost text-green-700" onClick={() => decide(lv._id, 'approved')}>Approve</button>
                      <button className="btn-ghost text-red-600" onClick={() => decide(lv._id, 'rejected')}>Reject</button>
                    </>}
                    {lv.status === 'approved' && (
                      <button
                        className="btn-ghost text-red-600"
                        title={`Restore ${lv.days} day(s) to the employee's balance.`}
                        onClick={() => revoke(lv)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>

      {viewing && (
        <LeaveDetailsModal
          lv={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

/**
 * Full leave-details modal.  Surfaces the entire employee reason,
 * the HR note (if any), and the revoke reason (if revoked) so long
 * remarks aren't lost behind the table's truncate.
 */
function LeaveDetailsModal({ lv, onClose }) {
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Leave Details"
      footer={<button className="btn-primary" onClick={onClose}>Close</button>}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Employee</div>
            <div className="text-slate-900 font-medium">{lv.employee?.name || '—'}</div>
            <div className="text-[11px] text-slate-500">{lv.employee?.employeeId}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Type</div>
            <div className="text-slate-900 capitalize">{lv.leaveType}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500">From</div>
            <div className="text-slate-900">{fmtDate(lv.fromDate)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500">To</div>
            <div className="text-slate-900">{fmtDate(lv.toDate)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Days</div>
            <div className="text-slate-900">{lv.days}{lv.dayType === 'half' ? ' (half-day)' : ''}</div>
          </div>
          {/* Phase 40.1 -- exact submission timestamp */}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Applied</div>
            <div className="text-slate-900">
              {lv.createdAt ? (
                <>
                  {fmtDate(lv.createdAt)}
                  <span className="text-slate-500"> · {new Date(lv.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</span>
                </>
              ) : '—'}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Status</div>
            <div>
              {lv.status === 'pending'  && <span className="badge-amber">Pending</span>}
              {lv.status === 'approved' && <span className={lv.paid ? 'badge-green' : 'badge-amber'}>{lv.paid ? 'Approved' : 'Approved (Unpaid)'}</span>}
              {lv.status === 'rejected' && <span className="badge-red">Rejected</span>}
              {lv.status === 'revoked'  && <span className="badge-gray">Revoked</span>}
            </div>
          </div>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Reason from employee</div>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm text-slate-700 whitespace-pre-wrap">
            {lv.reason
              ? lv.reason
              : <span className="text-slate-400 italic">No reason provided.</span>}
          </div>
        </div>

        {lv.hrNote && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">HR note</div>
            <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm text-slate-700 whitespace-pre-wrap">
              {lv.hrNote}
            </div>
          </div>
        )}

        {lv.status === 'revoked' && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Revoke reason</div>
            <div className="bg-amber-50 border border-amber-100 rounded-lg p-3 text-sm text-slate-700 whitespace-pre-wrap">
              {lv.revokeReason || <span className="text-slate-400 italic">No reason recorded.</span>}
            </div>
            {lv.revokedAt && (
              <div className="text-[11px] text-slate-500 mt-1">
                Revoked on {new Date(lv.revokedAt).toLocaleString()}
              </div>
            )}
          </div>
        )}

        {/* Phase 54 -- Supporting Documents.  Available before, during
            and after decision (approve / reject / revoke) so HR
            history stays intact.  Reviewer sees file name, mime type,
            size, uploader + upload time and can View (inline) or
            Download.  PDFs / images render inline in the browser
            because the /inline endpoint sets Content-Disposition:
            inline; the router hands the correct Content-Type header. */}
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
            Supporting Documents {Array.isArray(lv.attachments) && lv.attachments.length > 0 ? `(${lv.attachments.length})` : ''}
          </div>
          {!Array.isArray(lv.attachments) || lv.attachments.length === 0 ? (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-500 italic">
              No supporting documents attached to this request.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {lv.attachments.map((a) => (
                <li key={a._id} className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded px-3 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-slate-800 truncate">{a.filename}</div>
                    <div className="text-[10px] text-slate-500">
                      {a.mimeType} · {fmtSize(a.size)}
                      {' · '}
                      Uploaded by {a.uploadedBy?.name || 'employee'}
                      {a.uploadedBy?.role && ` (${a.uploadedBy.role === 'super_admin' ? 'Super Admin' : a.uploadedBy.role.toUpperCase()})`}
                      {' · '}
                      {new Date(a.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <a
                      className="btn-ghost !py-0.5 !text-[10px]"
                      href={authUrl(`/leaves/attachments/${a._id}/inline`)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >View</a>
                    <a
                      className="btn-ghost !py-0.5 !text-[10px]"
                      href={authUrl(`/leaves/attachments/${a._id}/download`)}
                    >Download</a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {lv.decidedAt && (
          <div className="text-[11px] text-slate-500">
            Decided on {new Date(lv.decidedAt).toLocaleString()}
          </div>
        )}
      </div>
    </Modal>
  );
}
