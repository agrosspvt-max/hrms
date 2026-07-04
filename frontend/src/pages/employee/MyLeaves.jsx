import { Fragment, useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { fmtDate, errMsg, authUrl } from '../../utils/helpers';
import { useAuth } from '../../context/AuthContext.jsx';
import { subscribe } from '../../realtime';

// Phase 54 -- supporting document constraints, mirrored from the
// backend's leaveAttachmentController.  10 MB per file per the spec.
const ALLOWED_ATT_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];
const ALLOWED_ATT_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
]);
const ATT_MAX_BYTES = 10 * 1024 * 1024;
const fmtSize = (n) => {
  if (!Number.isFinite(n)) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024)        return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

export default function MyLeaves() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  // Which leave row is currently expanded (to show Supporting Documents).
  const [openId, setOpenId] = useState(null);
  const toast = useToast();
  const { user } = useAuth();

  const load = async () => {
    setLoading(true);
    const { data } = await api.get('/leaves/mine');
    setItems(data);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);
  // Phase 47 -- HR approves / rejects -> my leave list refreshes.
  useEffect(() => subscribe('leave:decision', load), []);

  /**
   * Phase 54 -- two-phase apply:
   *   1. Upload any pending files -> receive attachment ids.
   *   2. POST /leaves with attachmentIds[] so the backend links them.
   * Files are only uploaded once (on submit), so an employee can add /
   * remove / replace freely in the modal without leaving orphan rows.
   */
  const apply = async (form) => {
    try {
      let attachmentIds = [];
      const files = form._pendingFiles || [];
      if (files.length > 0) {
        const fd = new FormData();
        for (const f of files) fd.append('files', f);
        const { data } = await api.post('/leaves/attachments', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        attachmentIds = (data || []).map((a) => a._id);
      }
      const { _pendingFiles, ...body } = form;
      await api.post('/leaves', { ...body, attachmentIds });
      toast.success(files.length > 0
        ? `Leave applied with ${files.length} document${files.length === 1 ? '' : 's'}.`
        : 'Leave applied');
      setModal(null);
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const remaining = (user?.leaveBalance?.yearlyAllowance || 0) - (user?.leaveBalance?.used || 0);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">My Leaves</h1>
          <p className="text-sm text-slate-500">Balance: <b>{remaining}</b> of {user?.leaveBalance?.yearlyAllowance || 0} remaining</p>
        </div>
        <button className="btn-primary" onClick={() => setModal({
          fromDate: new Date().toISOString().substring(0, 10),
          toDate: new Date().toISOString().substring(0, 10),
          leaveType: 'casual', reason: '', dayType: 'full',
          _pendingFiles: [],
        })}>+ Apply Leave</button>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          items.length === 0 ? <EmptyState title="No leave history" /> :
          <table className="table">
            <thead><tr>
              <th className="w-10"></th>
              <th>Applied</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>Note</th><th>Docs</th>
            </tr></thead>
            <tbody>
              {items.map((lv) => {
                const attCount = (lv.attachments || []).length;
                const isOpen = openId === lv._id;
                return (
                  <Fragment key={lv._id}>
                    <tr className={isOpen ? 'bg-slate-50' : ''}>
                      <td>
                        {attCount > 0 && (
                          <button
                            className="p-1 hover:bg-slate-100 rounded"
                            onClick={() => setOpenId(isOpen ? null : lv._id)}
                            aria-label="Show attachments"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}>
                              <path d="M9 18l6-6-6-6" />
                            </svg>
                          </button>
                        )}
                      </td>
                      <td>{fmtDate(lv.createdAt)}</td>
                      <td className="capitalize">{lv.leaveType}</td>
                      <td>{fmtDate(lv.fromDate)}</td>
                      <td>{fmtDate(lv.toDate)}</td>
                      <td>
                        {lv.days}
                        {lv.dayType === 'half' && <span className="ml-1 badge-amber">Half Day</span>}
                      </td>
                      <td>
                        {lv.status === 'pending' && <span className="badge-amber">Pending</span>}
                        {lv.status === 'approved' && <span className={lv.paid ? 'badge-green' : 'badge-amber'}>{lv.paid ? 'Approved' : 'Approved (Unpaid)'}</span>}
                        {lv.status === 'rejected' && <span className="badge-red">Rejected</span>}
                      </td>
                      <td className="text-slate-500">{lv.hrNote || lv.reason}</td>
                      <td>
                        {attCount > 0
                          ? <span className="badge bg-blue-50 text-blue-700 cursor-pointer" onClick={() => setOpenId(isOpen ? null : lv._id)}>
                              📎 {attCount}
                            </span>
                          : <span className="text-slate-300 text-xs">—</span>}
                      </td>
                    </tr>
                    {isOpen && attCount > 0 && (
                      <tr>
                        <td colSpan="9" className="bg-slate-50 p-4">
                          <AttachmentList attachments={lv.attachments} />
                          <div className="text-[11px] text-slate-500 mt-2 italic">
                            Attachments are locked once the leave is submitted; you can only view or download.
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>}
      </div>

      {modal && (
        <Modal open onClose={() => setModal(null)} title="Apply for Leave"
          footer={<>
            <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => apply(modal)}>Submit</button>
          </>}>
          <div className="space-y-3">
            <div><label className="label">Leave Type</label>
              <select className="input" value={modal.leaveType} onChange={(e) => setModal({ ...modal, leaveType: e.target.value })}>
                <option value="casual">Casual</option><option value="sick">Sick</option>
                <option value="paid">Paid</option><option value="unpaid">Unpaid</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">From</label><input className="input" type="date" value={modal.fromDate} onChange={(e) => {
                const fromDate = e.target.value;
                // Half-day is only valid for a single-day request.
                const dayType = fromDate === modal.toDate ? modal.dayType : 'full';
                setModal({ ...modal, fromDate, dayType });
              }} /></div>
              <div><label className="label">To</label><input className="input" type="date" value={modal.toDate} onChange={(e) => {
                const toDate = e.target.value;
                const dayType = modal.fromDate === toDate ? modal.dayType : 'full';
                setModal({ ...modal, toDate, dayType });
              }} /></div>
            </div>

            {/* Full / Half day option appears ONLY for single-day requests. */}
            {modal.fromDate && modal.fromDate === modal.toDate && (
              <div>
                <label className="label">Duration</label>
                <select className="input" value={modal.dayType} onChange={(e) => setModal({ ...modal, dayType: e.target.value })}>
                  <option value="full">Full Day Leave</option>
                  <option value="half">Half Day Leave (0.5 day)</option>
                </select>
                {modal.dayType === 'half' && (
                  <p className="text-xs text-slate-500 mt-1">
                    You'll still receive daily tasks and are expected to work the other half of the day.
                  </p>
                )}
              </div>
            )}

            <div><label className="label">Reason</label>
              <textarea className="input" rows={3} value={modal.reason} onChange={(e) => setModal({ ...modal, reason: e.target.value })} />
            </div>

            {/* Phase 54 -- Supporting Documents.  Optional.  Files are
                held client-side until Submit, then uploaded in a
                single multipart POST before the leave is created. */}
            <SupportingDocuments
              files={modal._pendingFiles || []}
              setFiles={(next) => setModal({ ...modal, _pendingFiles: next })}
              onError={(msg) => toast.error(msg)}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Phase 54 -- Supporting Documents picker + list                      */
/* ------------------------------------------------------------------ */
function SupportingDocuments({ files, setFiles, onError }) {
  const inputId = 'leave-att-input';
  const validate = (f) => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_ATT_EXT.includes(ext) || (f.type && !ALLOWED_ATT_MIME.has(f.type))) {
      return `"${f.name}" is not a supported format.  Allowed: PDF, JPG, JPEG, PNG, WEBP.`;
    }
    if (f.size > ATT_MAX_BYTES) {
      return `"${f.name}" exceeds the 10 MB limit.`;
    }
    return null;
  };
  const onPick = (list) => {
    const next = [...files];
    for (const f of Array.from(list || [])) {
      const err = validate(f);
      if (err) { onError(err); continue; }
      // Simple dedup: same name + same size.
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    setFiles(next);
  };
  const removeAt = (i) => setFiles(files.filter((_, idx) => idx !== i));
  const replaceAt = (i, list) => {
    const [f] = Array.from(list || []);
    if (!f) return;
    const err = validate(f);
    if (err) { onError(err); return; }
    setFiles(files.map((x, idx) => (idx === i ? f : x)));
  };

  return (
    <div className="border border-slate-200 rounded-md p-3 bg-slate-50/40">
      <div className="text-sm font-semibold text-slate-800 mb-1">
        Supporting Documents <span className="text-slate-400 font-normal">(optional)</span>
      </div>
      <div className="text-[11px] text-slate-500 mb-2">
        Attach any proof for this leave: medical certificate, prescription, hospital discharge, wedding invitation, travel ticket, government document, etc.
      </div>
      <input
        id={inputId}
        type="file"
        multiple
        accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*"
        className="hidden"
        onChange={(e) => { onPick(e.target.files); e.target.value = ''; }}
      />
      <label htmlFor={inputId} className="btn-secondary !py-1 !text-xs cursor-pointer inline-block">
        + Add File{files.length > 0 ? 's' : ''}
      </label>
      <div className="text-[10px] text-slate-500 mt-1">
        Supported formats: PDF, JPG, JPEG, PNG, WEBP · Max 10 MB per file
      </div>

      {files.length > 0 && (
        <ul className="mt-3 space-y-1">
          {files.map((f, i) => {
            const replaceId = `leave-att-replace-${i}`;
            return (
              <li key={i} className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded px-2 py-1.5 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-800 truncate">{f.name}</div>
                  <div className="text-[10px] text-slate-500">{fmtSize(f.size)}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <input
                    id={replaceId}
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*"
                    className="hidden"
                    onChange={(e) => { replaceAt(i, e.target.files); e.target.value = ''; }}
                  />
                  <label htmlFor={replaceId} className="btn-ghost !py-0.5 !text-[10px] cursor-pointer">Replace</label>
                  <button type="button" className="btn-ghost !py-0.5 !text-[10px] text-red-600" onClick={() => removeAt(i)}>Remove</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Phase 54 -- read-only attachment list for submitted leaves          */
/* ------------------------------------------------------------------ */
function AttachmentList({ attachments = [] }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase font-semibold text-slate-500">
        Supporting Documents ({attachments.length})
      </div>
      <ul className="space-y-1">
        {attachments.map((a) => (
          <li key={a._id} className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded px-3 py-2 text-xs">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-800 truncate">{a.filename}</div>
              <div className="text-[10px] text-slate-500">
                {a.mimeType} · {fmtSize(a.size)} · Uploaded {new Date(a.createdAt).toLocaleString()}
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
    </div>
  );
}
