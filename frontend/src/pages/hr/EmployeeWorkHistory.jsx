import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader } from '../../components/Loader.jsx';
import ScheduleTag from '../../components/ScheduleTag.jsx';
import { fmtDate, errMsg } from '../../utils/helpers';
import { useToast } from '../../context/ToastContext.jsx';

const TYPE_LABEL = { task: 'Task', excel: 'Excel', sheet: 'Spreadsheet' };
const DEP_CLS = { open: 'badge-red', in_progress: 'badge-amber', resolved: 'badge-green' };

/**
 * Per-employee Work History: completed vs pending work + dependency chains
 * given / received, with assigned-by / forwarded-to, pending reasons,
 * timestamps and resolution time.  Filters: template type, recurrence, dates.
 */
export default function EmployeeWorkHistory({ employee }) {
  const toast = useToast();
  const [range, setRange] = useState('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [templateType, setTemplateType] = useState('');
  const [recurrence, setRecurrence] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = {};
    if (range === 'custom') { if (!from || !to) return; params.from = from; params.to = to; }
    else params.range = range;
    if (templateType) params.templateType = templateType;
    if (recurrence) params.recurrence = recurrence;
    setLoading(true);
    api.get(`/employees/${employee._id}/work-history`, { params })
      .then(({ data }) => setData(data)).catch((e) => toast.error(errMsg(e)))
      .finally(() => setLoading(false));
    /* eslint-disable-next-line */
  }, [employee._id, range, from, to, templateType, recurrence]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="card card-body flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Period</label>
          <select className="input max-w-[150px]" value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 1 year</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        {range === 'custom' && (
          <>
            <div><label className="label">From</label><input className="input max-w-[150px]" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></div>
            <div><label className="label">To</label><input className="input max-w-[150px]" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
          </>
        )}
        <div>
          <label className="label">Template type</label>
          <select className="input max-w-[150px]" value={templateType} onChange={(e) => setTemplateType(e.target.value)}>
            <option value="">All types</option>
            <option value="task">Task</option>
            <option value="excel">Excel</option>
            <option value="sheet">Spreadsheet</option>
          </select>
        </div>
        <div>
          <label className="label">Recurrence</label>
          <select className="input max-w-[150px]" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
            <option value="">All recurrences</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="one-time">One-time</option>
          </select>
        </div>
      </div>

      {loading || !data ? <Loader /> : (
        <>
          {/* Submissions */}
          <div className="card overflow-x-auto">
            <div className="px-4 pt-3 text-sm font-semibold text-slate-800">Recent Submissions ({data.submissions.length})</div>
            {data.submissions.length === 0 ? (
              <div className="text-sm text-slate-400 italic p-4">No submissions in this period.</div>
            ) : (
              <table className="table mt-2">
                <thead><tr><th>Date</th><th>Template</th><th>Type</th><th>Recurrence</th><th>Done</th><th>Pending</th><th>Review</th></tr></thead>
                <tbody>
                  {data.submissions.map((s) => (
                    <tr key={s._id}>
                      <td className="text-xs">{fmtDate(s.date)}</td>
                      <td className="font-medium">{s.template || '—'}</td>
                      <td><span className="badge-gray">{TYPE_LABEL[s.type] || 'Task'}</span></td>
                      <td><ScheduleTag frequency={s.frequency} showLabel={false} /></td>
                      <td className="text-green-700 font-medium">{s.done}</td>
                      <td className={s.pending > 0 ? 'text-red-600 font-semibold' : ''}>{s.pending}</td>
                      <td>{s.reviewStatus === 'reviewed' ? <span className="badge-green">Reviewed</span> : <span className="badge-amber">Pending</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pending work */}
          <div className="card card-body">
            <div className="text-sm font-semibold text-slate-800 mb-2">Pending Work ({data.pendingItems.length})</div>
            {data.pendingItems.length === 0 ? (
              <div className="text-sm text-slate-400 italic">No pending work in this period. 🎉</div>
            ) : (
              <div className="space-y-2">
                {data.pendingItems.map((p, i) => (
                  <div key={i} className="rounded-lg border border-amber-100 bg-amber-50/50 p-2 flex flex-wrap justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-slate-800">{p.title}</div>
                      <div className="text-[11px] text-slate-500">{p.template} · {TYPE_LABEL[p.type] || 'Task'} · since {fmtDate(p.since)}</div>
                      {p.reason && <div className="text-xs text-slate-600 mt-0.5">Reason: {p.reason}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Dependency chains */}
          <div className="grid md:grid-cols-2 gap-4">
            <DepTable title="Dependencies Forwarded (given)" rows={data.dependencyGiven} who="assignedTo" whoLabel="Forwarded to" />
            <DepTable title="Dependencies Received" rows={data.dependencyReceived} who="assignedBy" whoLabel="Assigned by" />
          </div>
        </>
      )}
    </div>
  );
}

function DepTable({ title, rows, who, whoLabel }) {
  return (
    <div className="card card-body">
      <div className="text-sm font-semibold text-slate-800 mb-2">{title} ({rows.length})</div>
      {rows.length === 0 ? (
        <div className="text-sm text-slate-400 italic">None.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((d) => (
            <div key={d._id} className="rounded-lg border border-slate-200 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-slate-800">{d.originalTaskName || 'Dependency'}</div>
                <span className={DEP_CLS[d.status] || 'badge-gray'}>{d.status.replace('_', ' ')}</span>
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {whoLabel}: <b>{d[who]?.name || '—'}</b> · {fmtDate(d.createdAt)}
                {d.resolvedAt && <> · resolved in {d.resolutionHours}h</>}
              </div>
              {d.remark && <div className="text-xs text-slate-600 mt-0.5">{d.remark}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
