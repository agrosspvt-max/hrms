import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';

const ACTION_BADGE = {
  'hr.create': 'badge-green',
  'hr.delete': 'badge-red',
  'employee.create': 'badge-green',
  'employee.delete': 'badge-red',
  'leave.decide.hr': 'badge-blue',
  'leave.decide.employee': 'badge-gray',
  'password-reset.approve.hr': 'badge-blue',
  'password-reset.approve.employee': 'badge-gray',
};

export default function AuditLog() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  // Phase 31.1 -- click-to-open detail drawer.
  const [openItem, setOpenItem] = useState(null);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/audit', { params: action ? { action } : {} });
      setItems(data);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [action]);

  const actionOptions = useMemo(() => Object.keys(ACTION_BADGE), []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Audit Log</h1>
        <p className="text-sm text-slate-500">Sensitive actions traced with actor, target, and timestamp. Click any row to inspect.</p>
      </div>

      <div className="card card-body flex flex-wrap gap-2 items-center">
        <select className="input max-w-[260px]" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {actionOptions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <button className="btn-secondary" onClick={load}>Refresh</button>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          items.length === 0 ? <EmptyState title="No audit entries" /> :
          <table className="table">
            <thead><tr>
              <th>Time</th><th>Actor</th><th>Role</th><th>Action</th><th>Target</th><th>Meta</th>
            </tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a._id}
                  className="cursor-pointer hover:bg-brand-50 dark:hover:bg-brand-500/10"
                  title="Click for full details"
                  onClick={() => setOpenItem(a)}>
                  <td className="text-xs whitespace-nowrap">{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="font-medium text-brand-700">{a.actor?.name || '-'}<div className="text-[11px] text-slate-500">{a.actor?.email}</div></td>
                  <td className="text-xs uppercase">{a.actorRole}</td>
                  <td><span className={ACTION_BADGE[a.action] || 'badge-gray'}>{a.action}</span></td>
                  <td className="text-sm text-slate-700 dark:text-slate-200">{a.targetLabel || a.targetType}</td>
                  <td className="text-xs text-slate-500 max-w-md truncate">{a.meta && Object.keys(a.meta).length ? JSON.stringify(a.meta) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>

      {openItem && <AuditDetailModal item={openItem} onClose={() => setOpenItem(null)} />}
    </div>
  );
}

/* =====================================================================
 * Phase 31.1 — Audit Detail modal
 *
 * Surfaces every field the backend stores on an audit entry so admins
 * can audit a single event without leaving the page.  The list endpoint
 * already returns the populated actor + full meta payload, so the modal
 * only needs to render -- no extra API round-trip.
 * ===================================================================== */
function AuditDetailModal({ item, onClose }) {
  if (!item) return null;
  const created = new Date(item.createdAt);
  const meta = item.meta || {};
  // Audit meta entries often carry { from, to } / { previousStatus, newStatus }
  // pairs.  Surface them as a "Previous / New" row so HR doesn't have to
  // dig through raw JSON.
  const prevVal = meta.previousStatus ?? meta.from ?? meta.previousMode ?? '';
  const newVal  = meta.newStatus     ?? meta.to   ?? meta.newMode     ?? '';
  const Row = ({ k, v }) => (
    <div className="grid grid-cols-3 gap-3 py-1.5 border-b border-slate-100 dark:border-slate-700 last:border-b-0">
      <div className="text-xs uppercase tracking-wide text-slate-500">{k}</div>
      <div className="col-span-2 text-sm text-slate-800 dark:text-slate-100 break-words">{v ?? <span className="text-slate-400">—</span>}</div>
    </div>
  );
  return (
    <Modal open onClose={onClose} size="lg" title={`Audit Entry — ${item.action}`}
      footer={<button className="btn-primary" onClick={onClose}>Close</button>}>
      <div className="space-y-2">
        <Row k="Event ID"    v={<code className="text-[11px]">{item._id}</code>} />
        <Row k="Date"        v={created.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} />
        <Row k="Time"        v={created.toLocaleTimeString()} />
        <Row k="Actor"       v={item.actor?.name || '—'} />
        <Row k="Actor Email" v={item.actor?.email || '—'} />
        <Row k="Employee ID" v={item.actor?.employeeId || '—'} />
        <Row k="Role"        v={<span className="uppercase text-xs">{item.actorRole || '—'}</span>} />
        <Row k="Action Type" v={<code className="text-[11px]">{item.action}</code>} />
        <Row k="Module"      v={(item.action || '').split('.')[0] || '—'} />
        <Row k="Target"      v={item.targetLabel || '—'} />
        <Row k="Target Type" v={item.targetType || '—'} />
        <Row k="Target ID"   v={item.targetId ? <code className="text-[11px]">{item.targetId}</code> : null} />
        {(prevVal || newVal) && (
          <>
            <Row k="Previous Value" v={String(prevVal || '—')} />
            <Row k="New Value"      v={String(newVal  || '—')} />
          </>
        )}
        <Row k="IP / Device" v={item.ip || '—'} />
        <div className="mt-3">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Full Payload</div>
          <pre className="text-[11px] bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded p-3 overflow-x-auto max-h-72">
{JSON.stringify({ meta, ...(item.targetId ? { targetId: item.targetId } : {}) }, null, 2)}
          </pre>
        </div>
      </div>
    </Modal>
  );
}
