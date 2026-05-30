import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { fmtDate, errMsg } from '../../utils/helpers';

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

  const decide = async (id, decision) => {
    try {
      await api.patch(`/leaves/${id}/decision`, { decision });
      toast.success(`Leave ${decision}`);
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
          </select>
        </div>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          items.length === 0 ? <EmptyState title="No leave requests" /> :
          <table className="table">
            <thead><tr>
              <th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Reason</th><th>Status</th><th></th>
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
                  <td className="capitalize">{lv.leaveType}</td>
                  <td>{fmtDate(lv.fromDate)}</td>
                  <td>{fmtDate(lv.toDate)}</td>
                  <td>{lv.days}</td>
                  <td className="text-slate-500 max-w-xs truncate">{lv.reason}</td>
                  <td>
                    {lv.status === 'pending' && <span className="badge-amber">Pending</span>}
                    {lv.status === 'approved' && <span className={lv.paid ? 'badge-green' : 'badge-amber'}>{lv.paid ? 'Approved' : 'Approved (Unpaid)'}</span>}
                    {lv.status === 'rejected' && <span className="badge-red">Rejected</span>}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {lv.status === 'pending' && <>
                      <button className="btn-ghost text-green-700" onClick={() => decide(lv._id, 'approved')}>Approve</button>
                      <button className="btn-ghost text-red-600" onClick={() => decide(lv._id, 'rejected')}>Reject</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>
    </div>
  );
}
