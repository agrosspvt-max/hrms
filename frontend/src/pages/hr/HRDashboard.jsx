import { useEffect, useState } from 'react';
import api from '../../api/axios';
import StatCard from '../../components/StatCard.jsx';
import Collapsible from '../../components/Collapsible.jsx';
import ScheduleTag from '../../components/ScheduleTag.jsx';
import UpcomingEventsWidget from '../../components/UpcomingEventsWidget.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { delayBadgeClass, delayLabel, fmtDate } from '../../utils/helpers';
import { subscribe } from '../../realtime';

export default function HRDashboard() {
  const [summary, setSummary] = useState(null);
  const [today, setToday] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [s, t] = await Promise.all([
      api.get('/dashboard/hr/summary'),
      api.get('/dashboard/hr/today'),
    ]);
    setSummary(s.data);
    setToday(t.data);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);
  // Phase 47 -- HR dashboard counters reflect cross-user activity, so
  // any meaningful event re-fetches the summary + today snapshot.
  useEffect(() => {
    const subs = [
      subscribe('leave:applied',          load),
      subscribe('leave:decision',         load),
      subscribe('submission:submitted',   load),
      subscribe('attendance:changed',     load),
      subscribe('salary:slip:generated',  load),
    ];
    return () => subs.forEach((u) => u());
  }, []);

  if (loading) return <Loader />;

  // Group by department
  const byDept = {};
  today.items.forEach((it) => {
    const k = it.employee.department?.name || 'Unassigned';
    if (!byDept[k]) byDept[k] = [];
    byDept[k].push(it);
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">HR Dashboard</h1>
        <p className="text-sm text-slate-500">Today is {fmtDate(today.date)}. Track workflow, pendency, and performance.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Employees"        value={summary.totalEmployees}                                  accent="brand" to="/employees" />
        <StatCard label="Submitted Today"  value={`${summary.submittedToday}/${summary.totalEmployees}`}    accent="green" to="/reviews" />
        <StatCard label="Pending Leaves"   value={summary.pendingLeaves}                                    accent="amber" to="/leaves" />
        <StatCard label="Pendency Tasks"   value={summary.backlogCount}                                     accent="red"   to="/backlog" />
        <StatCard label="Departments"      value={summary.totalDepartments}                                 accent="blue"  to="/departments" />
      </div>

      <UpcomingEventsWidget />

      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900">Today's Work</h2>
        {Object.keys(byDept).length === 0 && <EmptyState title="No employees yet" />}
        {Object.entries(byDept).map(([dept, items]) => {
          const dept_pct = items.length
            ? items.reduce((s, x) => s + x.completionPercentage, 0) / items.length
            : 0;
          return (
            <Collapsible
              key={dept}
              title={dept}
              subtitle={`${items.length} employee(s) • avg completion ${dept_pct.toFixed(1)}%`}
              defaultOpen
              right={<span className="badge-blue">{items.filter((x) => x.submitted).length}/{items.length} submitted</span>}
            >
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                {items.map((it) => (
                  <EmployeeCard key={it.employee._id} item={it} />
                ))}
              </div>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}

function EmployeeCard({ item }) {
  const pct = item.completionPercentage;
  const color = pct >= 80 ? 'bg-green-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500';
  // Distinct recurrence types among today's submissions for this employee.
  const freqs = [...new Set((item.submissions || []).map((s) => s.frequency || 'daily'))];
  return (
    <div className="border border-slate-200 rounded-xl p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">{item.employee.name}</div>
          <div className="text-xs text-slate-500">{item.employee.designation?.title || 'No designation'}</div>
        </div>
        {item.submitted
          ? <span className="badge-green">Submitted</span>
          : item.hasSubmission ? <span className="badge-amber">Pending</span> : <span className="badge-gray">No data</span>}
      </div>
      {freqs.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {freqs.map((fr) => <ScheduleTag key={fr} frequency={fr} showLabel={false} />)}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 mt-3 text-center">
        <Stat label="Done" value={item.doneCount} color="text-green-700" />
        <Stat label="Pending" value={item.pendingCount} color="text-red-700" />
        <Stat label="N/A" value={item.workNotAvailableCount} color="text-slate-500" />
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
          <span>Completion</span><span>{pct.toFixed(1)}%</span>
        </div>
        <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      </div>
      {item.selfRating !== null && (
        <div className="mt-2 text-xs text-slate-500">
          Self-rating: <span className="font-semibold text-slate-700">{item.selfRating.toFixed(1)}/10</span>
        </div>
      )}
    </div>
  );
}

const Stat = ({ label, value, color }) => (
  <div className="bg-slate-50 rounded-lg py-2">
    <div className={`text-base font-semibold ${color}`}>{value}</div>
    <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
  </div>
);
