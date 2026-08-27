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

  // Phase 77 -- pending-row edit state.  `pendingEdits[leaveId]`
  // holds the tentative { leaveType, fromDate, toDate } HR is
  // shaping in-table before Approve.  When the row is approved,
  // any modified fields are forwarded to /decision so the backend
  // snapshots the original request + stamps modifiedOnApproval.
  const [pendingEdits, setPendingEdits] = useState({});
  const [confirming, setConfirming] = useState(null);   // { lv, changes[] }

  const patchEdit = (leaveId, patch) => setPendingEdits((cur) => ({
    ...cur, [leaveId]: { ...(cur[leaveId] || {}), ...patch },
  }));
  const clearEdits = (leaveId) => setPendingEdits((cur) => {
    const c = { ...cur }; delete c[leaveId]; return c;
  });

  // Phase 78 -- live-derive the effective Days value from the
  // (possibly edited) range so HR sees the FINAL day count before
  // approval.  Mirrors the backend `effectiveLeaveDays` helper --
  // excludes the employee's weeklyOff days (config comes with the
  // /leaves response; falls back to Sunday-only).  Company holidays
  // are still authoritative on the server: the confirm modal shows
  // the naive delta; the DB stores the server-computed final value.
  const _iso = (d) => (d ? String(d).slice(0, 10) : '');
  const _daysBetween = (fromIso, toIso, weeklyOff = [0], dayType = 'full') => {
    if (!fromIso || !toIso) return 0;
    const f = new Date(fromIso + 'T00:00:00Z');
    const t = new Date(toIso   + 'T00:00:00Z');
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t < f) return 0;
    const offs = Array.isArray(weeklyOff) && weeklyOff.length ? weeklyOff : [0];
    if (dayType === 'half') {
      return f.getTime() === t.getTime() && !offs.includes(f.getUTCDay()) ? 0.5 : 0;
    }
    let count = 0;
    for (let d = new Date(f.getTime()); d.getTime() <= t.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
      if (!offs.includes(d.getUTCDay())) count += 1;
    }
    return count;
  };

  const editedRangeFor = (lv) => {
    const edits = pendingEdits[lv._id] || {};
    const fromIso = _iso(edits.fromDate || lv.fromDate);
    const toIso   = _iso(edits.toDate   || lv.toDate);
    // If HR widens the range past a single day AND the leave was
    // half-day, dayType auto-flips to 'full' (mirrors backend).
    const isSingle = fromIso === toIso;
    const dayType  = (lv.dayType === 'half' && isSingle) ? 'half' : 'full';
    const weeklyOff = lv.employee?.weeklyOff || [0];
    return { fromIso, toIso, dayType, weeklyOff };
  };

  const derivedDays = (lv) => {
    const { fromIso, toIso, dayType, weeklyOff } = editedRangeFor(lv);
    return _daysBetween(fromIso, toIso, weeklyOff, dayType);
  };

  const diffFor = (lv) => {
    const edits = pendingEdits[lv._id] || {};
    const out = [];
    if (edits.leaveType && edits.leaveType !== lv.leaveType) {
      out.push({ field: 'Leave Type', from: lv.leaveType, to: edits.leaveType });
    }
    if (edits.fromDate && _iso(edits.fromDate) !== _iso(lv.fromDate)) {
      out.push({ field: 'Start Date', from: _iso(lv.fromDate), to: _iso(edits.fromDate) });
    }
    if (edits.toDate && _iso(edits.toDate) !== _iso(lv.toDate)) {
      out.push({ field: 'End Date',   from: _iso(lv.toDate),   to: _iso(edits.toDate) });
    }
    // Days is a derived field: only surface the delta when it
    // actually differs.  Uses the same effective-days math so
    // weekly-offs never inflate the delta.
    const dLive = derivedDays(lv);
    if ((edits.fromDate || edits.toDate) && dLive !== lv.days) {
      out.push({ field: 'Days', from: lv.days, to: dLive });
    }
    return out;
  };

  const decide = async (lv, decision) => {
    const changes = decision === 'approved' ? diffFor(lv) : [];
    if (decision === 'approved' && changes.length > 0) {
      // Show the pre-approval summary + require confirmation.
      setConfirming({ lv, changes });
      return;
    }
    try {
      await api.patch(`/leaves/${lv._id}/decision`, { decision });
      toast.success(`Leave ${decision}`);
      clearEdits(lv._id);
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const confirmModifiedApproval = async (note) => {
    if (!confirming) return;
    const { lv } = confirming;
    const edits = pendingEdits[lv._id] || {};
    try {
      await api.patch(`/leaves/${lv._id}/decision`, {
        decision: 'approved',
        leaveType: edits.leaveType || undefined,
        fromDate:  edits.fromDate  || undefined,
        toDate:    edits.toDate    || undefined,
        modificationNote: note || '',
      });
      toast.success('Leave approved with modifications.');
      setConfirming(null);
      clearEdits(lv._id);
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

      {/* Phase 62 -- Leave Configuration.  Only HR / Super Admin see
          this card; changes take effect immediately via a shared
          server cache invalidation. */}
      <LeaveConfigCard />

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
                  {/* Phase 77 -- inline-editable Type / From / To for
                      pending rows.  A modified field is highlighted
                      until Approve so HR can see at a glance what
                      differs from the employee's original request. */}
                  <td className="capitalize">
                    {lv.status === 'pending' ? (
                      <select
                        className={`input !py-0.5 !text-xs ${(pendingEdits[lv._id]?.leaveType && pendingEdits[lv._id].leaveType !== lv.leaveType) ? 'ring-1 ring-amber-400 bg-amber-50' : ''}`}
                        value={pendingEdits[lv._id]?.leaveType || lv.leaveType || 'casual'}
                        onChange={(e) => patchEdit(lv._id, { leaveType: e.target.value })}
                      >
                        <option value="casual">Casual</option>
                        <option value="sick">Sick</option>
                        <option value="paid">Paid</option>
                        <option value="unpaid">Unpaid</option>
                        <option value="other">Other</option>
                      </select>
                    ) : (
                      lv.leaveType
                    )}
                  </td>
                  <td>
                    {lv.status === 'pending' ? (
                      <input type="date"
                        className={`input !py-0.5 !text-xs ${(pendingEdits[lv._id]?.fromDate && String(pendingEdits[lv._id].fromDate).slice(0,10) !== String(lv.fromDate).slice(0,10)) ? 'ring-1 ring-amber-400 bg-amber-50' : ''}`}
                        value={(pendingEdits[lv._id]?.fromDate || lv.fromDate || '').slice(0, 10)}
                        onChange={(e) => patchEdit(lv._id, { fromDate: e.target.value })}
                      />
                    ) : fmtDate(lv.fromDate)}
                  </td>
                  <td>
                    {lv.status === 'pending' ? (
                      <input type="date"
                        className={`input !py-0.5 !text-xs ${(pendingEdits[lv._id]?.toDate && String(pendingEdits[lv._id].toDate).slice(0,10) !== String(lv.toDate).slice(0,10)) ? 'ring-1 ring-amber-400 bg-amber-50' : ''}`}
                        value={(pendingEdits[lv._id]?.toDate || lv.toDate || '').slice(0, 10)}
                        onChange={(e) => patchEdit(lv._id, { toDate: e.target.value })}
                      />
                    ) : fmtDate(lv.toDate)}
                  </td>
                  <td>
                    {(() => {
                      // Phase 78 -- live derived Days.  Pending rows
                      // recompute against the (possibly edited) range
                      // so HR sees the final day count BEFORE approval.
                      // Non-pending rows display the stored value.
                      if (lv.status !== 'pending') return lv.days;
                      const d = derivedDays(lv);
                      const changed = d !== lv.days;
                      return (
                        <span className={changed ? 'font-medium text-amber-700' : ''}
                          title={changed ? `Original: ${lv.days} day(s) — recalculated after HR edits.` : ''}>
                          {d}
                          {changed && <span className="text-[10px] text-slate-500 ml-1">(was {lv.days})</span>}
                        </span>
                      );
                    })()}
                  </td>
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
                    {/* Phase 77 -- yellow badge when the approval
                        differed from what the employee requested. */}
                    {lv.status === 'approved' && lv.modifiedOnApproval && (
                      <span className="badge-amber" title="HR modified this request before approval.">Approved (Modified)</span>
                    )}
                    {lv.status === 'approved' && !lv.modifiedOnApproval && (
                      <span className={lv.paid ? 'badge-green' : 'badge-amber'}>{lv.paid ? 'Approved' : 'Approved (Unpaid)'}</span>
                    )}
                    {lv.status === 'rejected' && <span className="badge-red">Rejected</span>}
                    {lv.status === 'revoked'  && <span className="badge-gray">Revoked</span>}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost" onClick={() => setViewing(lv)} title="View full leave details">View</button>
                    {lv.status === 'pending' && <>
                      <button className="btn-ghost text-green-700" onClick={() => decide(lv, 'approved')}>Approve</button>
                      <button className="btn-ghost text-red-600" onClick={() => decide(lv, 'rejected')}>Reject</button>
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

      {/* Phase 77 -- pre-approval summary + mandatory HR ack. */}
      {confirming && (
        <ModifiedApprovalConfirmModal
          lv={confirming.lv}
          changes={confirming.changes}
          onCancel={() => setConfirming(null)}
          onConfirm={confirmModifiedApproval}
        />
      )}
    </div>
  );
}

/**
 * Phase 77 -- Pre-approval summary modal.  Shown ONLY when HR made
 * at least one change to the pending request.  Requires HR to
 * confirm before the /decision call fires.  A modification note is
 * optional; when provided it's persisted alongside the audit entry.
 */
function ModifiedApprovalConfirmModal({ lv, changes, onCancel, onConfirm }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await onConfirm(note); } finally { setBusy(false); }
  };
  return (
    <Modal open size="md" onClose={onCancel} title="Approve leave with modifications"
      footer={<>
        <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Approving…' : 'Confirm Approve'}
        </button>
      </>}>
      <div className="space-y-3 text-sm">
        <div className="text-slate-700">
          You are about to approve <strong>{lv.employee?.name || 'this leave'}</strong>&apos;s
          request with the following changes:
        </div>
        <div className="rounded border border-amber-200 bg-amber-50 p-3">
          <div className="text-[11px] uppercase text-amber-800 font-semibold mb-1">Changes made before approval</div>
          <ul className="space-y-1">
            {changes.map((c, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="text-slate-500 min-w-[90px]">{c.field}</span>
                <span className="text-slate-800">{c.from || '—'}</span>
                <span className="text-slate-400">→</span>
                <span className="text-slate-900 font-medium">{c.to || '—'}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <label className="text-[11px] uppercase text-slate-500 mb-1 block">Reason (optional)</label>
          <textarea
            className="input min-h-[70px] w-full"
            placeholder="Why did you modify this request? (visible in audit log; helps the employee understand)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="text-[11px] text-slate-500">
          The employee will receive a notification listing every change. The original request
          is preserved in the audit trail and remains visible on the leave.
        </div>
      </div>
    </Modal>
  );
}

/**
 * Phase 62 -- Leave Configuration card.
 * Currently exposes ONLY the "Restricted During Probation" checklist
 * (spec item 6).  Never touches leave records, balances, approvals
 * or attendance.  HR selects any subset of leave types; on Save the
 * new list is persisted to LeaveConfig and used by the apply-time
 * gate immediately.
 */
function LeaveConfigCard() {
  const toast = useToast();
  const [restricted, setRestricted] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    api.get('/leave-config')
      .then((r) => { setRestricted(r.data?.restrictedDuringProbation || []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);
  const toggle = (t) => setRestricted((cur) =>
    cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  const save = async () => {
    setSaving(true);
    try {
      await api.put('/leave-config', { restrictedDuringProbation: restricted });
      toast.success('Saved');
    } catch (err) { toast.error(errMsg(err)); }
    setSaving(false);
  };
  const TYPES = [
    ['paid',   'Paid Leave'],
    ['casual', 'Casual Leave'],
    ['sick',   'Sick Leave'],
    ['unpaid', 'Unpaid Leave'],
    ['other',  'Other Leave'],
  ];
  return (
    <div className="card card-body">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Leave Configuration</h2>
          <div className="text-[11px] text-slate-500">Which leave types are blocked while an employee is on probation.</div>
        </div>
        <button className="btn-primary" onClick={save} disabled={saving || !loaded}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        {TYPES.map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm border rounded px-3 py-1.5 bg-white">
            <input type="checkbox" checked={restricted.includes(key)} onChange={() => toggle(key)} />
            {label}
          </label>
        ))}
      </div>
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

        {/* Phase 77 -- Modified-by-HR panel.  Shown only when the
            approval differed from the original request.  Always
            renders `originalRequest` verbatim so the employee's
            true submission is never obscured. */}
        {lv.modifiedOnApproval && lv.originalRequest && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-amber-700 mb-1">Modified by HR</div>
            <div className="grid grid-cols-2 gap-3 bg-amber-50 border border-amber-100 rounded-lg p-3 text-xs">
              <div>
                <div className="text-[10px] uppercase text-slate-500">Original request</div>
                <div className="text-slate-800 capitalize">{lv.originalRequest.leaveType || '—'}</div>
                <div className="text-slate-800">
                  {lv.originalRequest.fromDate ? fmtDate(lv.originalRequest.fromDate) : '—'}
                  {' – '}
                  {lv.originalRequest.toDate ? fmtDate(lv.originalRequest.toDate) : '—'}
                </div>
                {lv.originalRequest.days != null && (
                  <div className="text-[11px] text-slate-600">{lv.originalRequest.days} day(s)</div>
                )}
              </div>
              <div>
                <div className="text-[10px] uppercase text-slate-500">Approved values</div>
                <div className="text-slate-900 capitalize font-medium">{lv.leaveType}</div>
                <div className="text-slate-900 font-medium">{fmtDate(lv.fromDate)} – {fmtDate(lv.toDate)}</div>
                <div className="text-[11px] text-slate-700 font-medium">{lv.days} day(s)</div>
              </div>
            </div>
            {lv.modificationNote && (
              <div className="text-[11px] text-slate-600 mt-1"><strong>HR note:</strong> {lv.modificationNote}</div>
            )}
          </div>
        )}

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
                      href={authUrl(`/api/leaves/attachments/${a._id}/inline`)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >View</a>
                    <a
                      className="btn-ghost !py-0.5 !text-[10px]"
                      href={authUrl(`/api/leaves/attachments/${a._id}/download`)}
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
