import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import api from '../../api/axios';
import StatCard from '../../components/StatCard.jsx';
import { Loader } from '../../components/Loader.jsx';
import { fmtDate, errMsg } from '../../utils/helpers';
import { useToast } from '../../context/ToastContext.jsx';

const STATUS_CLS = { approved: 'badge-green', pending: 'badge-amber', rejected: 'badge-red' };
const TYPE_COLORS = { casual: '#6366f1', sick: '#ef4444', paid: '#22c55e', unpaid: '#f97316', other: '#94a3b8' };

export default function EmployeeLeaves({ employee }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get(`/employees/${employee._id}/leaves`)
      .then(({ data }) => setData(data)).catch((e) => toast.error(errMsg(e)))
      .finally(() => setLoading(false));
    /* eslint-disable-next-line */
  }, [employee._id]);

  if (loading || !data) return <Loader />;

  const leaves = data.leaves || [];
  const bal = data.balance || {};
  const remaining = Math.max(0, (bal.yearlyAllowance || 0) - (bal.used || 0));
  const counts = { approved: 0, pending: 0, rejected: 0 };
  const byType = {};
  for (const l of leaves) {
    counts[l.status] = (counts[l.status] || 0) + 1;
    byType[l.leaveType] = (byType[l.leaveType] || 0) + (l.days || 0);
  }
  const typeData = Object.entries(byType).map(([name, value]) => ({ name, value }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Yearly Allowance" value={bal.yearlyAllowance || 0} accent="blue" />
        <StatCard label="Used" value={bal.used || 0} accent="amber" />
        <StatCard label="Remaining" value={remaining} accent="green" />
        <StatCard label="Approved" value={counts.approved} accent="green" />
        <StatCard label="Pending / Rejected" value={`${counts.pending} / ${counts.rejected}`} accent="red" />
      </div>

      {typeData.length > 0 && (
        <div className="card card-body">
          <h3 className="text-sm font-semibold text-slate-800 mb-2">Leave Days by Type</h3>
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={typeData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {typeData.map((d) => <Cell key={d.name} fill={TYPE_COLORS[d.name] || '#6366f1'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto">
        <div className="px-4 pt-3 text-sm font-semibold text-slate-800">Leave History ({leaves.length})</div>
        {leaves.length === 0 ? (
          <div className="text-sm text-slate-400 italic p-4">No leave records.</div>
        ) : (
          <table className="table mt-2">
            <thead><tr><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Day Type</th><th>Status</th><th>Decided By</th><th>Note</th></tr></thead>
            <tbody>
              {leaves.map((l) => (
                <tr key={l._id}>
                  <td className="capitalize font-medium">{l.leaveType}</td>
                  <td className="text-xs">{fmtDate(l.fromDate)}</td>
                  <td className="text-xs">{fmtDate(l.toDate)}</td>
                  <td>{l.days}{!l.paid && <span className="ml-1 badge-red">unpaid</span>}</td>
                  <td className="capitalize">{l.dayType}</td>
                  <td><span className={STATUS_CLS[l.status] || 'badge-gray'}>{l.status}</span></td>
                  <td className="text-xs">{l.decidedBy?.name || '—'}</td>
                  <td className="text-xs text-slate-500">{l.hrNote || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
