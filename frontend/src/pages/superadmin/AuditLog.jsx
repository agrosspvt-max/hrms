import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
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
        <h1 className="text-2xl font-bold text-slate-900">Audit Log</h1>
        <p className="text-sm text-slate-500">Sensitive actions traced with actor, target, and timestamp.</p>
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
                <tr key={a._id}>
                  <td className="text-xs whitespace-nowrap">{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="font-medium">{a.actor?.name || '-'}<div className="text-[11px] text-slate-500">{a.actor?.email}</div></td>
                  <td className="text-xs uppercase">{a.actorRole}</td>
                  <td><span className={ACTION_BADGE[a.action] || 'badge-gray'}>{a.action}</span></td>
                  <td className="text-sm text-slate-700">{a.targetLabel || a.targetType}</td>
                  <td className="text-xs text-slate-500 max-w-md truncate">{a.meta && Object.keys(a.meta).length ? JSON.stringify(a.meta) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>
    </div>
  );
}
