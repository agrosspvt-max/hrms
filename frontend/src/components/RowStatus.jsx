/**
 * RowStatus - shared row-level status + dependency visualisation for the
 * HR / HOD submission review screens.  Display-only: it never affects
 * marks entry or the review pipeline.
 */

const STATUS_META = {
  done: { text: 'Done', cls: 'badge-green' },
  pending: { text: 'Pending', cls: 'badge-red' },
  work_not_available: { text: 'Work N/A', cls: 'badge-gray' },
};

/** Base row status badge (Done / Pending / Work N/A). */
export function RowStatusBadge({ status }) {
  const m = STATUS_META[status];
  if (!m) return <span className="text-slate-300">—</span>;
  return <span className={m.cls}>{m.text}</span>;
}

/** Dependency badge: Forwarded (open / in-progress) or Resolved. */
export function DependencyBadge({ dep }) {
  if (!dep) return null;
  const resolved = dep.status === 'resolved';
  return (
    <span className={`badge ${resolved ? 'bg-teal-50 text-teal-700' : 'bg-amber-50 text-amber-700'}`}>
      {resolved ? 'Dependency Resolved' : 'Dependency Forwarded'}
    </span>
  );
}

const fmtDateTime = (d) => (d ? new Date(d).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/**
 * Inline dependency details: forwarded-to + assigned-by chain, remark,
 * created/resolved timestamps and turnaround duration.
 */
export function DependencyLine({ dep }) {
  if (!dep) return null;
  return (
    <div className="mt-1 text-[11px] text-slate-500 leading-relaxed">
      <div>
        Forwarded to <b className="text-slate-700">{dep.assignedToName || '—'}</b>
        {dep.assignedByName && <> · by <b className="text-slate-700">{dep.assignedByName}</b></>}
      </div>
      {dep.remark && <div>Remark: <span className="text-slate-600">{dep.remark}</span></div>}
      <div>
        Sent {fmtDateTime(dep.createdAt)}
        {dep.resolvedAt
          ? <> · Resolved {fmtDateTime(dep.resolvedAt)} · <b className="text-teal-700">{dep.resolutionHours}h turnaround</b></>
          : <> · <span className="text-amber-700">awaiting resolution</span></>}
      </div>
    </div>
  );
}

/** Build a Map keyed by String(sourceTaskId) from the dependencies array. */
export function depMap(dependencies = []) {
  const m = new Map();
  for (const d of dependencies) m.set(String(d.sourceTaskId), d);
  return m;
}

export const ROW_FILTERS = [
  ['all', 'All rows'],
  ['done', 'Done'],
  ['pending', 'Pending'],
  ['dependency', 'Dependency'],
  ['work_not_available', 'Work N/A'],
];

/** Does a row (status + optional dependency) match the active filter? */
export function matchRowFilter(status, dep, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'dependency') return !!dep;
  return status === filter;
}

/** Small status filter select. */
export function RowStatusFilter({ value, onChange, className = '' }) {
  return (
    <select className={`input max-w-[160px] ${className}`} value={value} onChange={(e) => onChange(e.target.value)}>
      {ROW_FILTERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );
}

/**
 * Unified task-status table (shared by HR + HOD reviews): every task on one
 * row with an inline status badge, dependency badge + details, pending
 * reason and points.  Includes a status filter.  Display-only.
 */
export function TaskStatusTable({ tasks = [], deps, rowFilter, setRowFilter, showPoints = true }) {
  const rows = tasks.filter((t) => ['done', 'pending', 'work_not_available'].includes(t.status));
  const visible = rows.filter((t) => matchRowFilter(t.status, deps.get(String(t._id)), rowFilter));
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Task Status ({rows.length})</div>
        <RowStatusFilter value={rowFilter} onChange={setRowFilter} />
      </div>
      {visible.length === 0 ? <div className="text-xs text-slate-400 italic">No rows match this filter.</div> : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Task</th><th>Status</th><th>Reason / Dependency</th>{showPoints && <th className="text-right">Points</th>}</tr></thead>
            <tbody>
              {visible.map((t) => {
                const dep = deps.get(String(t._id));
                return (
                  <tr key={t._id}>
                    <td className="font-medium text-slate-800">{t.title}</td>
                    <td>
                      <RowStatusBadge status={t.status} />
                      <div className="mt-1"><DependencyBadge dep={dep} /></div>
                    </td>
                    <td className="align-top">
                      {t.status === 'pending' && t.pendingReason && <div className="text-[12px] text-slate-600">Reason: {t.pendingReason}</div>}
                      {dep && <DependencyLine dep={dep} />}
                      {!dep && !(t.status === 'pending' && t.pendingReason) && <span className="text-slate-300">—</span>}
                    </td>
                    {showPoints && <td className="text-right font-medium text-slate-700">{t.status === 'done' ? `+${t.points}` : `${t.points}`}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Below the sheet grid: full dependency details for any tracked rows. */
export function SheetDependencyDetails({ sheet, deps }) {
  const rows = ((sheet && sheet.scores) || []).filter((sc) => deps.get(sc.key));
  if (rows.length === 0) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3">
      <div className="text-xs font-semibold text-slate-700 mb-2">Row Dependencies</div>
      <div className="space-y-2">
        {rows.map((sc) => (
          <div key={sc.key} className="border-b border-slate-100 last:border-0 pb-2 last:pb-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-800">{sc.label || sc.key}</span>
              <RowStatusBadge status={sc.rowStatus} />
              <DependencyBadge dep={deps.get(sc.key)} />
            </div>
            <DependencyLine dep={deps.get(sc.key)} />
          </div>
        ))}
      </div>
    </div>
  );
}
