import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import StatCard from '../../components/StatCard.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';

/**
 * HOD - Manage Team
 *
 * Read-only department supervisor view: the employees under this HOD's
 * department with today's submission status and backlog.  A HOD can view
 * but never edit salaries, delete employees, change roles or manage
 * departments - those remain HR-only.
 */
export default function HODEmployees() {
  const [data, setData] = useState({ department: null, members: [] });
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/employees/team');
        setData(data);
      } catch (err) {
        toast.error(errMsg(err));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line
  }, []);

  if (loading) return <Loader />;

  const members = data.members || [];
  const submittedToday = members.filter((m) => m.submittedToday).length;
  const pendingReview = members.filter((m) => m.pendingHodReview).length;
  const withBacklog = members.filter((m) => (m.backlogCount || 0) > 0).length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Manage Team</h1>
        <p className="text-sm text-slate-500">
          {data.department?.name ? `${data.department.name} department` : 'Your department'} • {members.length} member(s)
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Team Size" value={members.length} accent="brand" />
        <StatCard label="Submitted Today" value={submittedToday} accent="green" />
        <StatCard label="Awaiting My Review" value={pendingReview} accent={pendingReview ? 'amber' : 'brand'} to="/team-reviews" />
        <StatCard label="With Backlog" value={withBacklog} accent={withBacklog ? 'red' : 'brand'} />
      </div>

      <div className="card overflow-x-auto">
        {members.length === 0 ? (
          <EmptyState title="No team members" subtitle="No employees are assigned to your department yet." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th><th>Name</th><th>Designation</th><th>Review Flow</th>
                <th>Today</th><th>Backlog</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m._id}>
                  <td className="font-mono text-xs">{m.employeeId}</td>
                  <td className="font-medium text-slate-900">{m.name}</td>
                  <td>{m.designation?.title || '-'}</td>
                  <td>
                    {m.reviewFlow === 'hod_first'
                      ? <span className="badge-amber">HOD → HR</span>
                      : <span className="badge-gray">Direct HR</span>}
                  </td>
                  <td>
                    {m.submittedToday
                      ? <span className="badge-green">Submitted</span>
                      : m.pendingHodReview
                      ? <span className="badge-amber">Awaiting review</span>
                      : <span className="badge-gray">Pending</span>}
                  </td>
                  <td>
                    {m.backlogCount > 0
                      ? <span className="badge-red">{m.backlogCount}</span>
                      : <span className="badge-green">0</span>}
                  </td>
                  <td>{m.status === 'active' ? <span className="badge-green">Active</span> : <span className="badge-red">Inactive</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
