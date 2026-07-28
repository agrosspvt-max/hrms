import { useEffect, useState, useCallback } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import StatCard from '../../components/StatCard.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { fmtDate, errMsg } from '../../utils/helpers';

/**
 * EmployeePendingManagement.jsx
 *
 * HR / Super-Admin investigation + recovery tab on the Employee
 * Profile.  Displays every currently-pending item for the employee
 * (Submission tasks + DependencyTasks) and lets HR resolve one row
 * at a time with a mandatory reason.  A diagnostic banner reports
 * pending counts from every consumer's perspective so any silent
 * divergence between Dashboard / Performance / Global Pendency /
 * Compliance is caught in-page.
 *
 * All reads + writes go through /api/pending-management/*, which is
 * itself a thin wrapper over PendingStateService -- the same
 * canonical predicate every other surface uses.
 */
export default function EmployeePendingManagement({ employee }) {
  const auth = useAuth() || {};
  const currentUser = auth.user || null;
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [pickedRow, setPickedRow] = useState(null);
  const canView = !!currentUser && (currentUser.role === 'super_admin' || currentUser.role === 'hr');

  const load = useCallback(async () => {
    if (!employee || !employee._id || !canView) { setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const { data: d } = await api.get(`/pending-management/${employee._id}`);
      setData(d || null);
    } catch (e) {
      const msg = errMsg(e) || 'Failed to load pending management data.';
      setLoadError(msg);
      // Never crash the outer page; only toast so HR sees the failure.
      try { toast.error(msg); } catch (_) { /* silent */ }
    } finally { setLoading(false); }
  }, [employee, canView, toast]);

  useEffect(() => { load(); }, [load]);

  if (!canView) {
    return (
      <div className="card card-body">
        <EmptyState title="HR only" subtitle="This page is visible to Super Admin and HR." />
      </div>
    );
  }
  if (loading) return <Loader />;
  if (loadError) {
    return (
      <div className="card card-body">
        <div className="text-sm font-semibold text-red-700 mb-1">Pending Management failed to load</div>
        <div className="text-xs text-slate-600 mb-2">The rest of the employee profile is unaffected.</div>
        <div className="text-[11px] font-mono text-red-800 bg-red-50 border border-red-100 rounded p-2 whitespace-pre-wrap break-words">{loadError}</div>
        <div className="mt-3">
          <button className="btn-secondary !py-1 !text-xs" onClick={load}>Retry</button>
        </div>
      </div>
    );
  }
  if (!data) return <div className="card card-body"><EmptyState title="No data" /></div>;

  const d = (data && data.diagnostics) || {};
  const rows = Array.isArray(data && data.pending) ? data.pending : [];

  return (
    <div className="space-y-4">
      {/* Diagnostic banner */}
      <div className="card">
        <div className="px-4 py-2 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-800">Pending Diagnostics</div>
            <div className="text-[11px] text-slate-500">Same predicate consulted by every surface. Divergence indicates stale state elsewhere.</div>
          </div>
          <button className="btn-secondary !py-1 !text-xs" onClick={load}>Refresh</button>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="Dashboard Pending" value={d.dashboard ?? 0} sub="via getBacklog" accent="brand" />
            <StatCard label="Performance Pending" value={d.performance ?? 0} sub="overdueByFreq" accent="brand" />
            <StatCard label="Global Pendency" value={d.globalPendency ?? 0} sub="7-day window" accent={d.globalPendency !== d.dashboard ? 'amber' : 'brand'} />
            <StatCard label="Compliance Eligible" value={d.complianceEligible ?? 0} sub="resolveBy < today" accent="brand" />
            <StatCard label="Open Dependencies" value={d.openDependencies ?? 0} sub="assigned to employee" accent="brand" />
          </div>
          {d.inconsistency && (
            <div className="mt-3 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-amber-800 text-sm">
              <strong>&#9888; Pending state inconsistency detected.</strong>{' '}
              At least one consumer disagrees with the canonical count. Resolve or investigate the rows below.
            </div>
          )}
          {!d.inconsistency && (d.dashboard || 0) > 0 && (
            <div className="mt-3 px-3 py-2 rounded bg-slate-50 border border-slate-200 text-slate-700 text-sm">
              Every consumer agrees on {d.dashboard} pending item{d.dashboard === 1 ? '' : 's'}. State is consistent.
            </div>
          )}
          {!d.inconsistency && (d.dashboard || 0) === 0 && (d.openDependencies || 0) === 0 && (
            <div className="mt-3 px-3 py-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm">
              No pending items for this employee. All consumers agree.
            </div>
          )}
        </div>
      </div>

      {/* Pending rows */}
      <div className="card">
        <div className="px-4 py-2 border-b border-slate-100 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">Pending Items</div>
          <div className="text-[11px] text-slate-500">Submission tasks + open dependencies pointing at this employee.</div>
        </div>
        {rows.length === 0 ? (
          <div className="p-6"><EmptyState title="Nothing pending" subtitle="This employee has no open pending items." /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="text-[10px] uppercase text-slate-500">
                <tr>
                  <th className="text-left py-2 px-3">Template</th>
                  <th className="text-left px-3">Task</th>
                  <th className="text-left px-3">Source</th>
                  <th className="text-left px-3">Submission Date</th>
                  <th className="text-left px-3">Pending Since</th>
                  <th className="text-left px-3">Resolve By</th>
                  <th className="text-right px-3">Days</th>
                  <th className="text-left px-3">Status</th>
                  <th className="text-left px-3">Extra</th>
                  <th className="text-right px-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  if (!r) return null;
                  const tpl = r.template || {};
                  const key = `${r.kind || 'row'}-${r.submissionId || r.dependencyId || idx}-${r.taskId || idx}`;
                  return (
                    <tr key={key}
                        className={`border-t border-slate-100 hover:bg-slate-50 ${r.overdue ? 'bg-red-50/40' : ''}`}>
                      <td className="py-2 px-3">
                        <div className="font-medium text-slate-800">{tpl.title || '—'}</div>
                        {tpl.customKind && <div className="text-[10px] text-slate-500">{tpl.customKind}</div>}
                      </td>
                      <td className="px-3">
                        <span>{r.taskName || '—'}</span>
                        {r.isCritical && <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-red-100 text-red-700">CRITICAL</span>}
                      </td>
                      <td className="px-3">
                        <span className="text-[10px] px-1 py-0.5 rounded bg-slate-100 text-slate-700">{r.source || '—'}</span>
                      </td>
                      <td className="px-3 text-slate-600">{r.submissionDate ? fmtDate(r.submissionDate) : '—'}</td>
                      <td className="px-3 text-slate-600">{r.pendingSince ? fmtDate(r.pendingSince) : '—'}</td>
                      <td className="px-3 text-slate-600">{r.resolveBy ? fmtDate(r.resolveBy) : '—'}</td>
                      <td className="px-3 text-right font-medium" style={{ color: r.overdue ? '#b91c1c' : '#334155' }}>{Number.isFinite(r.daysPending) ? r.daysPending : 0}</td>
                      <td className="px-3 text-slate-600">{r.status || 'pending'}</td>
                      <td className="px-3 text-[11px] text-slate-500">
                        {r.kind === 'dependency' && r.sourceEmployee && (
                          <div>
                            <div>Blocked By: <span className="text-slate-700">{r.blockedBy || '—'}</span></div>
                            <div>Waiting For: <span className="text-slate-700">{r.waitingFor || '—'}</span></div>
                          </div>
                        )}
                        {r.kind === 'submission' && r.submissionId && (
                          <div title={String(r.submissionId)} className="truncate max-w-[160px]">Sub: {String(r.submissionId).slice(-6)}</div>
                        )}
                      </td>
                      <td className="px-3 text-right">
                        <button className="btn-secondary !py-1 !text-xs" onClick={() => setPickedRow(r)}>Resolve</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pickedRow && (
        <ResolveModal
          row={pickedRow}
          employee={data.employee}
          onClose={() => setPickedRow(null)}
          onDone={() => { setPickedRow(null); load(); }}
        />
      )}
    </div>
  );
}

function ResolveModal({ row, employee, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const validReason = reason.trim().length >= 5;

  // Null-safe: if the caller opened the modal with a malformed row,
  // don't render anything (a return null keeps the parent stable and
  // avoids throwing during render).
  if (!row || !employee || !employee._id) return null;

  const submit = async () => {
    if (!validReason) return;
    setBusy(true);
    try {
      const body = { reason };
      if (row.kind === 'submission') {
        body.source = 'submission';
        body.submissionId = row.submissionId;
        body.taskId = row.taskId;
      } else if (row.kind === 'dependency') {
        body.source = 'dependency';
        body.dependencyId = row.dependencyId;
      }
      const { data } = await api.post(`/pending-management/${employee._id}/resolve`, body);
      const changed = data && data.outcome && data.outcome.changed;
      if (changed === false) {
        try { toast.info((data && data.outcome && data.outcome.message) || 'Already resolved.'); } catch (_) { /* silent */ }
      } else {
        try { toast.success('Pending item resolved.'); } catch (_) { /* silent */ }
      }
      onDone && onDone();
    } catch (e) {
      try { toast.error(errMsg(e) || 'Failed to resolve.'); } catch (_) { /* silent */ }
    } finally { setBusy(false); }
  };

  const isDep = row.kind === 'dependency';
  const title = isDep ? 'Resolve Pending Dependency' : 'Resolve Pending Task';
  const tpl = row.template || {};

  return (
    <Modal
      open size="lg" onClose={onClose} title={title}
      footer={<>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={busy || !validReason}>
          {busy ? 'Resolving…' : 'Confirm Resolve'}
        </button>
      </>}
    >
      <div className="space-y-3 text-sm">
        <div className="rounded border border-slate-200 p-3 bg-slate-50">
          <div className="text-[11px] uppercase text-slate-500 mb-1">Target</div>
          <div><strong>Template:</strong> {tpl.title || '—'}</div>
          <div><strong>Task:</strong> {row.taskName || '—'}</div>
          {row.pendingSince && <div><strong>Pending Since:</strong> {fmtDate(row.pendingSince)}</div>}
          <div><strong>Source:</strong> {row.source || '—'}</div>
          {isDep && row.sourceEmployee && <div><strong>From:</strong> {row.blockedBy || '—'}</div>}
        </div>
        <div className="rounded border border-emerald-100 p-3 bg-emerald-50 text-emerald-900">
          <div className="font-semibold mb-1">Resolving this pending will:</div>
          <ul className="list-none space-y-0.5">
            <li>&#10003; Mark {isDep ? 'the dependency task' : 'the submission task'} as resolved (writes business data)</li>
            <li>&#10003; Remove employee from Global Pendency for this row</li>
            <li>&#10003; Remove from Performance pending count</li>
            <li>&#10003; Prevent future Performance Lock incidents for this row</li>
            <li>&#10003; Prevent future Dependency Pending incidents (if applicable)</li>
            <li>&#10003; Existing compliance incidents WILL NOT be deleted automatically</li>
            <li>&#10003; Existing penalties remain unless manually waived / recovered / cancelled</li>
          </ul>
        </div>
        <div>
          <label className="text-[11px] uppercase text-slate-500 mb-1 block">
            Reason <span className="text-red-600">*</span>
          </label>
          <textarea
            className="input min-h-[70px] w-full"
            placeholder="Why is this being resolved manually? (min 5 characters)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {!validReason && reason.length > 0 && (
            <div className="text-[11px] text-red-600 mt-1">Reason must be at least 5 characters.</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
