import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { errMsg } from '../../utils/helpers';
import EmployeeDashboard from '../employee/EmployeeDashboard.jsx';

const TYPE_LABEL = { task: 'Task', excel: 'Excel', sheet: 'Spreadsheet' };
const DEP_CLS = { open: 'badge-red', in_progress: 'badge-amber', resolved: 'badge-green' };
const PRIORITY_CLS = { high: 'badge-red', normal: 'badge-gray', low: 'badge-blue' };

/**
 * My Tasks - a personalized work inbox for HR / Super Admin.
 *  - Dependency work assigned to me (collaborative hand-offs / resolution
 *    requests) with rich badges + resolve.
 *  - Direct task assignments (read-only) the account itself has today.
 * Reuses existing endpoints only - no new work/submission flow.
 */
export default function MyTasks() {
  const toast = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  const [deps, setDeps] = useState([]);
  const [filter, setFilter] = useState('open'); // open | all | resolved
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.get('/dependencies/mine', { params: { status: 'all' } })
        .then((r) => r.data).catch(() => []);
      setDeps(d || []);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const resolveDep = async (id) => {
    try { await api.post(`/dependencies/${id}/resolve`, {}); toast.success('Resolved'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  if (loading) return <Loader />;

  const shown = deps.filter((d) => filter === 'all' ? true : filter === 'resolved' ? d.currentStatus === 'resolved' : d.currentStatus !== 'resolved');
  const openCount = deps.filter((d) => d.currentStatus !== 'resolved').length;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">My Tasks</h1>
          <p className="text-sm text-slate-500">Your personal work inbox — dependency hand-offs{!isSuperAdmin && ' and direct assignments'} awaiting you.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="badge-amber">{openCount} open</span>
          <select className="input max-w-[150px]" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>

      {/* Dependency work */}
      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Dependency Work</div>
        {shown.length === 0 ? (
          <EmptyState title="No dependency work" subtitle="Hand-offs assigned to you will appear here." />
        ) : (
          <div className="space-y-2">
            {shown.map((d) => {
              const days = Math.max(0, Math.floor((Date.now() - new Date(d.waitingSince || d.createdAt)) / 86400000));
              return (
                <div key={d._id} className="card card-body">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-[220px]">
                      <div className="text-sm font-semibold text-slate-800">{d.originalTaskName || 'Dependency task'}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        From <b>{d.assignedBy?.name || d.assignedByName || 'Someone'}</b>
                        {d.departmentName ? ` · ${d.departmentName}` : ''}
                        {d.templateTitle ? ` · ${d.templateTitle}` : ''}
                        {d.sourceKind ? ` · ${TYPE_LABEL[d.sourceKind] || d.sourceKind}` : ''}
                      </div>
                      {d.remark && <div className="text-xs text-slate-600 mt-1">Remark: {d.remark}</div>}
                      {d.chainId && <div className="text-[10px] text-slate-400 mt-0.5 font-mono">chain {d.chainId}</div>}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <div className="flex items-center gap-2">
                        <span className={PRIORITY_CLS[d.priority] || 'badge-gray'}>{(d.priority || 'normal').toUpperCase()}</span>
                        <span className={DEP_CLS[d.currentStatus] || 'badge-gray'}>{d.currentStatus.replace('_', ' ')}</span>
                      </div>
                      <span className="badge-gray">Waiting {days}d</span>
                      {d.currentStatus !== 'resolved' && (
                        <button className="btn-secondary !py-1" onClick={() => resolveDep(d._id)}>Resolve</button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Direct workflow — for HR / Super Admin only, this is where assigned
          Task / Excel / Spreadsheet templates open as real submissions with
          the same submit / pending / dependency hand-off controls employees
          have on their dashboard. */}
      <div>
        <div className="text-sm font-semibold text-slate-800 mb-2">Direct Assignments</div>
        <EmployeeDashboard embedded />
      </div>
    </div>
  );
}
