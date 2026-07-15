import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  AreaChart, Area, LineChart, Line, Cell,
} from 'recharts';
import api from '../../api/axios';
import StatCard from '../../components/StatCard.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { ClickableCard, DrillDownModal } from '../../components/AnalyticsDrillDown.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtDate } from '../../utils/helpers';

/**
 * Phase 69 + Phase 70 -- Daily Self Review analytics tab.
 *
 * Every card + every chart cell is clickable and opens DrillDownModal
 * (same modal Pendency / Completion use) with a sortable, searchable,
 * paginated, CSV-exportable BreakdownTable.
 *
 * All data comes from /api/self-review/* which reads only from the
 * existing DailyReflection collection.  No new data model, no side
 * effects on Salary / Compliance / Attendance / Submission.
 */

const RATING_COLORS = ['#ef4444', '#ef4444', '#f97316', '#f97316', '#f59e0b',
  '#f59e0b', '#84cc16', '#84cc16', '#22c55e', '#22c55e', '#16a34a'];
const BAR = '#6366f1';
const AREA = '#3b82f6';

const ChartCard = ({ title, subtitle, onClick, children, height = 260 }) => (
  <div className="card card-body">
    <div className="flex items-start justify-between">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {subtitle && <div className="text-[11px] text-slate-400">{subtitle}</div>}
      </div>
      {onClick && <button className="text-[11px] text-brand-600 hover:underline" onClick={onClick}>Details →</button>}
    </div>
    <div style={{ width: '100%', height }} className="mt-3">
      <ResponsiveContainer>{children}</ResponsiveContainer>
    </div>
  </div>
);

const ratingAccent = (r) => (r >= 8 ? 'green' : r >= 6 ? 'amber' : r > 0 ? 'red' : 'slate');

export default function SelfReviewMode({ filters, canExport }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openEmployee, setOpenEmployee] = useState(null);
  const [drill, setDrill] = useState(null); // { metricId, title, sub }
  const [tab, setTab] = useState('overview');
  const toast = useToast();

  const params = useMemo(() => {
    const p = {};
    if (filters.from && filters.to) { p.from = filters.from; p.to = filters.to; }
    else if (filters.range) p.range = filters.range;
    if (filters.department)  p.department  = filters.department;
    if (filters.designation) p.designation = filters.designation;
    if (filters.employee)    p.employee    = filters.employee;
    return p;
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get('/self-review/overview', { params })
      .then(({ data: d }) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err) => { if (!cancelled) { toast.error(errMsg(err)); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(params)]);

  const exportCsv = () => {
    const qs = new URLSearchParams(params).toString();
    api.get(`/self-review/export.csv?${qs}`, { responseType: 'blob' })
      .then((r) => {
        const blob = new Blob([r.data], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `daily-self-review_${params.from || ''}_${params.to || ''}.csv`.replace(/__/g, '_');
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      })
      .catch((err) => toast.error(errMsg(err)));
  };

  const openDrill = (metricId, title, sub = {}) => setDrill({ metricId, title, sub });

  if (loading || !data) return <Loader />;
  const c = data.cards; const ch = data.charts; const t = data.trend;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 text-sm">
          {[['overview', 'Overview'], ['ideas', 'Idea Library'], ['notes', 'Notes Library']].map(([k, label]) => (
            <button key={k}
              className={`px-4 py-1.5 rounded-md transition ${tab === k ? 'bg-white shadow text-brand-700' : 'text-slate-500 hover:text-slate-700'}`}
              onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        {canExport && tab === 'overview' && (
          <button className="btn-secondary !py-1 !text-xs" onClick={exportCsv}>Export CSV</button>
        )}
      </div>

      {tab === 'overview' && (
        <OverviewTab
          data={data} c={c} ch={ch} trend={t}
          onOpenEmployee={setOpenEmployee}
          onOpenDrill={openDrill}
        />
      )}
      {tab === 'ideas' && <LibraryBrowser params={params} kind="ideas" field="idea" placeholder="Search idea text" onOpenEmployee={setOpenEmployee} />}
      {tab === 'notes' && <LibraryBrowser params={params} kind="notes" field="selfNote" placeholder="Search note text" onOpenEmployee={setOpenEmployee} />}

      {openEmployee && (
        <EmployeeDetailModal
          employeeId={openEmployee}
          params={params}
          onClose={() => setOpenEmployee(null)}
        />
      )}

      {drill && (
        <DrillDownModal metricId={drill.metricId} title={drill.title} onClose={() => setDrill(null)}>
          <BreakdownTable
            metricId={drill.metricId}
            sub={drill.sub}
            baseParams={params}
            onOpenEmployee={(id) => { setDrill(null); setOpenEmployee(id); }}
            onOpenSubmission={(id) => { window.open(`/submissions/${id}`, '_blank'); }}
          />
        </DrillDownModal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview -- every tile + every chart is clickable                    */
/* ------------------------------------------------------------------ */
function OverviewTab({ data, c, ch, trend, onOpenEmployee, onOpenDrill }) {
  const empShort = (e) => e ? `${e.employee.name} (${e.avg})` : '—';

  const barClick = (metricId, keyField) => (payload) => {
    if (!payload || !payload.activePayload || !payload.activePayload[0]) return;
    const row = payload.activePayload[0].payload;
    const sub = {};
    if (keyField === 'label') sub.day = row.label;         // Daily
    if (keyField === 'week')  sub.week = row.label;
    if (keyField === 'month') sub.month = row.label;
    if (keyField === 'weekday') {
      const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(row.weekday);
      if (idx >= 0) sub.weekday = idx;
    }
    if (keyField === 'rating')     sub.rating = row.rating;
    if (keyField === 'department') sub.deptName = row.name;
    onOpenDrill(metricId, undefined, sub);
  };

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <ClickableCard onClick={() => onOpenDrill('srAvgRating')}>
          <StatCard label="Average Rating" value={c.avgRating} accent={ratingAccent(c.avgRating)} sub={`${c.totalReflections} reflections`} />
        </ClickableCard>
        <ClickableCard onClick={() => onOpenDrill('srHighestRating')}>
          <StatCard label="Highest Rating" value={c.highestRating} accent="green" />
        </ClickableCard>
        <ClickableCard onClick={() => onOpenDrill('srLowestRating')}>
          <StatCard label="Lowest Rating" value={c.lowestRating} accent="red" />
        </ClickableCard>
        <ClickableCard onClick={() => onOpenDrill('srMedianRating')}>
          <StatCard label="Median Rating" value={c.medianRating} accent="blue" />
        </ClickableCard>
        <ClickableCard onClick={() => onOpenDrill('srEmployeesSubmitted')}>
          <StatCard label="Employees Submitted" value={c.employeesSubmitted} accent="green" />
        </ClickableCard>
        <ClickableCard onClick={() => onOpenDrill('srEmployeesMissing')}>
          <StatCard label="Employees Missing" value={c.employeesMissing} accent={c.employeesMissing > 0 ? 'amber' : 'slate'} />
        </ClickableCard>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <ClickableCard onClick={() => c.mostConsistent && onOpenEmployee(c.mostConsistent.employee._id)}>
          <StatCard label="Most Consistent" value={c.mostConsistent?.employee?.name || '—'} accent="blue" sub={c.mostConsistent ? `${c.mostConsistent.consistency}% coverage` : ''} />
        </ClickableCard>
        <ClickableCard onClick={() => c.mostPositive && onOpenEmployee(c.mostPositive.employee._id)}>
          <StatCard label="Most Positive" value={empShort(c.mostPositive)} accent="green" sub={c.mostPositive ? `${c.mostPositive.count} reflections` : ''} />
        </ClickableCard>
        <ClickableCard onClick={() => c.mostCritical && onOpenEmployee(c.mostCritical.employee._id)}>
          <StatCard label="Most Critical" value={empShort(c.mostCritical)} accent="red" sub={c.mostCritical ? `${c.mostCritical.count} reflections` : ''} />
        </ClickableCard>
        <ClickableCard onClick={() => c.mostImproved && onOpenEmployee(c.mostImproved.employee._id)}>
          <StatCard label="Most Improved" value={c.mostImproved?.employee?.name || '—'} accent="amber" sub={c.mostImproved ? `${c.mostImproved.improvement > 0 ? '+' : ''}${c.mostImproved.improvement} vs early period` : ''} />
        </ClickableCard>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <ClickableCard onClick={() => onOpenDrill('srTrendCurrent')}>
          <StatCard label="Current Period Avg" value={trend.currentAvg} accent={ratingAccent(trend.currentAvg)} />
        </ClickableCard>
        <ClickableCard onClick={() => onOpenDrill('srTrendPrevious')}>
          <StatCard label="Previous Period Avg" value={trend.previousAvg} accent="slate" />
        </ClickableCard>
        <ClickableCard onClick={() => onOpenDrill('srTrendDelta')}>
          <StatCard label="Delta" value={`${trend.delta > 0 ? '+' : ''}${trend.delta}`} accent={trend.delta > 0 ? 'green' : trend.delta < 0 ? 'red' : 'slate'} />
        </ClickableCard>
        <ClickableCard onClick={() => onOpenDrill('srTrendDelta')}>
          <StatCard label="Delta %" value={`${trend.deltaPct > 0 ? '+' : ''}${trend.deltaPct}%`} accent={trend.deltaPct > 0 ? 'green' : trend.deltaPct < 0 ? 'red' : 'slate'} />
        </ClickableCard>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Daily Average Rating" subtitle={`${data.range.from} → ${data.range.to} · click a bar to drill`}
          onClick={() => onOpenDrill('srDaily')}>
          <BarChart data={ch.daily} onClick={barClick('srDaily', 'label')}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="avg" fill={AREA} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Rating Distribution" subtitle="0-10 histogram · click a bar to drill"
          onClick={() => onOpenDrill('srDistribution')}>
          <BarChart data={ch.distribution} onClick={barClick('srDistribution', 'rating')}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="rating" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
              {ch.distribution.map((d, i) => <Cell key={i} fill={RATING_COLORS[d.rating] || BAR} />)}
            </Bar>
          </BarChart>
        </ChartCard>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Weekly Average Rating" subtitle="Click a bar to drill"
          onClick={() => onOpenDrill('srWeekly')}>
          <BarChart data={ch.weekly} onClick={barClick('srWeekly', 'week')}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="avg" fill={BAR} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Monthly Average Rating" subtitle="Click a bar to drill"
          onClick={() => onOpenDrill('srMonthly')}>
          <BarChart data={ch.monthly} onClick={barClick('srMonthly', 'month')}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="avg" fill={BAR} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartCard>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Department Comparison" subtitle="Click a bar to drill into that department"
          onClick={() => onOpenDrill('srDeptCompare')}>
          <BarChart data={ch.deptAvg} layout="vertical" onClick={barClick('srDaily', 'department')}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis type="number" domain={[0, 10]} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
            <Tooltip />
            <Bar dataKey="avg" fill={AREA} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Weekday Heatmap" subtitle="Click a weekday to drill"
          onClick={() => onOpenDrill('srHeatmap')}>
          <BarChart data={ch.heatmap} onClick={barClick('srHeatmap', 'weekday')}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="weekday" tick={{ fontSize: 11 }} />
            <YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
              {ch.heatmap.map((d, i) => <Cell key={i} fill={RATING_COLORS[Math.round(d.avg)] || BAR} />)}
            </Bar>
          </BarChart>
        </ChartCard>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <RankingTable title="Top 10 - Highest Average" rows={ch.topRanking} onOpen={onOpenEmployee} rankColor="text-green-700" onSeeAll={() => onOpenDrill('srRanking')} />
        <RankingTable title="Bottom 10 - Lowest Average" rows={ch.bottomRanking} onOpen={onOpenEmployee} rankColor="text-red-700" onSeeAll={() => onOpenDrill('srRanking')} />
      </div>
    </>
  );
}

function RankingTable({ title, rows, onOpen, rankColor, onSeeAll }) {
  if (!rows || rows.length === 0) return (
    <div className="card card-body">
      <h2 className="text-sm font-semibold text-slate-800 mb-2">{title}</h2>
      <EmptyState title="No employees with 3+ reflections in this range" />
    </div>
  );
  return (
    <div className="card card-body">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {onSeeAll && <button className="text-[11px] text-brand-600 hover:underline" onClick={onSeeAll}>See full ranking →</button>}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-100">
              <th className="text-left py-1.5 w-8">#</th>
              <th className="text-left py-1.5">Employee</th>
              <th className="text-left py-1.5">Department</th>
              <th className="text-right py-1.5">Avg</th>
              <th className="text-right py-1.5">Count</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.employee._id} className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer" onClick={() => onOpen(r.employee._id)}>
                <td className={`py-1.5 font-semibold ${rankColor}`}>{i + 1}</td>
                <td className="py-1.5 text-slate-800">{r.employee.name}<div className="text-[10px] text-slate-400">{r.employee.employeeId}</div></td>
                <td className="py-1.5 text-slate-500">{r.employee.department || '—'}</td>
                <td className="py-1.5 text-right font-semibold text-slate-800">{r.avg}</td>
                <td className="py-1.5 text-right text-slate-500">{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reusable Breakdown table: sort + search + pagination + CSV export    */
/* ------------------------------------------------------------------ */
function BreakdownTable({ metricId, sub, baseParams, onOpenEmployee, onOpenSubmission }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: '', dir: 'desc' });
  const [page, setPage] = useState(1);
  const perPage = 25;
  const toast = useToast();

  useEffect(() => {
    setLoading(true);
    api.get('/self-review/breakdown', { params: { ...baseParams, metricId, ...sub } })
      .then(({ data: d }) => { setData(d); setLoading(false); })
      .catch((err) => { toast.error(errMsg(err)); setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricId, JSON.stringify(sub), JSON.stringify(baseParams)]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    let rows = q ? data.rows.filter((r) =>
      Object.values(r).some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(q))
    ) : data.rows.slice();
    if (sort.key) {
      const dir = sort.dir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        const av = a[sort.key]; const bv = b[sort.key];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }
    return rows;
  }, [data, search, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * perPage, currentPage * perPage);

  const exportCsv = () => {
    if (!data || filtered.length === 0) return;
    const cols = data.columns;
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = cols.map((c) => c.label).join(',');
    const lines = [header].concat(filtered.map((r) => cols.map((c) => esc(
      c.type === 'date' && r[c.key] ? new Date(r[c.key]).toISOString().slice(0, 10) : r[c.key]
    )).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${metricId}_${data.range.from}_${data.range.to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
  const exportXls = () => {
    // "Excel" export via CSV with .xls extension + tab separator so
    // Excel opens it natively without requiring xlsx bundling on the
    // client.  Same rows and columns as CSV.
    if (!data || filtered.length === 0) return;
    const cols = data.columns;
    const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' '));
    const header = cols.map((c) => c.label).join('\t');
    const lines = [header].concat(filtered.map((r) => cols.map((c) => esc(
      c.type === 'date' && r[c.key] ? new Date(r[c.key]).toISOString().slice(0, 10) : r[c.key]
    )).join('\t')));
    const blob = new Blob([lines.join('\n')], { type: 'application/vnd.ms-excel' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${metricId}_${data.range.from}_${data.range.to}.xls`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  if (loading || !data) return <Loader />;
  const cols = data.columns;

  const toggleSort = (key) => setSort((cur) => cur.key === key
    ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'desc' });

  const cellRender = (r, c) => {
    if (c.type === 'date' && r[c.key]) return fmtDate(r[c.key]);
    if (c.key === 'employeeName' && r.employeeId) {
      return (
        <button className="text-brand-600 hover:underline text-left" onClick={() => onOpenEmployee(r.employeeId)}>
          {r.employeeName || '—'}
        </button>
      );
    }
    if (c.key === 'submissionStatus' && r.submissionId) {
      return (
        <button className="text-brand-600 hover:underline" onClick={() => onOpenSubmission(r.submissionId)}>
          {r.submissionStatus} →
        </button>
      );
    }
    if (c.type === 'number') return typeof r[c.key] === 'number' ? r[c.key] : (r[c.key] || 0);
    return r[c.key] || '—';
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-slate-500">
          {data.title} · {filtered.length} row{filtered.length !== 1 ? 's' : ''} ·{' '}
          {data.range.from} → {data.range.to}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input className="input !py-1 !text-xs max-w-[220px]" type="search"
            placeholder="Search rows" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <button className="btn-secondary !py-1 !text-xs" disabled={filtered.length === 0} onClick={exportCsv}>Export CSV</button>
          <button className="btn-secondary !py-1 !text-xs" disabled={filtered.length === 0} onClick={exportXls}>Export Excel</button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No rows to show for this metric" />
      ) : (
        <>
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  {cols.map((c) => (
                    <th key={c.key}
                      className="text-left py-2 px-3 text-[11px] uppercase tracking-wide text-slate-500 cursor-pointer select-none"
                      onClick={() => toggleSort(c.key)}>
                      {c.label}
                      {sort.key === c.key && <span className="ml-1">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => (
                  <tr key={r._id || r.employeeId || i} className="border-t border-slate-100">
                    {cols.map((c) => (
                      <td key={c.key} className={`py-1.5 px-3 ${c.type === 'number' ? 'text-right' : ''} text-slate-700`}>
                        {cellRender(r, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-slate-500">
              <div>Page {currentPage} of {totalPages}</div>
              <div className="flex items-center gap-1">
                <button className="btn-ghost !py-1 !text-xs" disabled={currentPage === 1} onClick={() => setPage(1)}>« First</button>
                <button className="btn-ghost !py-1 !text-xs" disabled={currentPage === 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
                <button className="btn-ghost !py-1 !text-xs" disabled={currentPage === totalPages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
                <button className="btn-ghost !py-1 !text-xs" disabled={currentPage === totalPages} onClick={() => setPage(totalPages)}>Last »</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Library browser -- expanded filters, rows link to the submission     */
/* ------------------------------------------------------------------ */
function LibraryBrowser({ params, kind, field, placeholder, onOpenEmployee }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [rating, setRating] = useState('');
  const [attendance, setAttendance] = useState('');
  const [submissionStatus, setSubmissionStatus] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 20;
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const q = { ...params };
    if (keyword.trim()) q.keyword = keyword.trim();
    if (rating !== '') q.rating = rating;
    if (attendance) q.attendance = attendance;
    if (submissionStatus) q.submissionStatus = submissionStatus;
    api.get(`/self-review/${kind}`, { params: q })
      .then(({ data }) => { if (!cancelled) { setRows(data || []); setLoading(false); setPage(1); } })
      .catch((err) => { if (!cancelled) { toast.error(errMsg(err)); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(params), keyword, rating, attendance, submissionStatus]);

  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * perPage, currentPage * perPage);

  const exportCsv = () => {
    if (rows.length === 0) return;
    const header = 'Date,Employee,Emp ID,Department,Rating,Attendance,Submission,Text';
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header].concat(rows.map((r) => [
      new Date(r.date).toISOString().slice(0, 10),
      r.employee?.name || '', r.employee?.employeeId || '', r.employee?.department || '',
      r.selfRating, r.attendance || '', r.submissionStatus || '',
      (r[field] || '').replace(/\r?\n/g, ' '),
    ].map(esc).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${kind}-library.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="card card-body flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[220px]">
          <label className="label">Keyword</label>
          <input className="input" type="search" placeholder={placeholder}
            value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <div>
          <label className="label">Rating</label>
          <select className="input max-w-[140px]" value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="">Any</option>
            {Array.from({ length: 11 }, (_, i) => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Attendance</label>
          <select className="input max-w-[170px]" value={attendance} onChange={(e) => setAttendance(e.target.value)}>
            <option value="">Any</option>
            <option value="present">Present</option>
            <option value="absent">Absent</option>
            <option value="half_paid">Half Paid</option>
            <option value="half_unpaid">Half Unpaid</option>
            <option value="full_paid">Paid Leave</option>
            <option value="full_unpaid">Unpaid Leave</option>
            <option value="weekly_off">Weekly Off</option>
          </select>
        </div>
        <div>
          <label className="label">Submission</label>
          <select className="input max-w-[150px]" value={submissionStatus} onChange={(e) => setSubmissionStatus(e.target.value)}>
            <option value="">Any</option>
            <option value="none">None</option>
            <option value="draft">Draft</option>
            <option value="pending">Pending Review</option>
            <option value="reviewed">Reviewed</option>
          </select>
        </div>
        <button className="btn-secondary !py-1 !text-xs" disabled={rows.length === 0} onClick={exportCsv}>Export CSV</button>
      </div>

      {loading ? <Loader /> : rows.length === 0 ? (
        <EmptyState title={`No ${kind} match the current filters`} />
      ) : (
        <>
          <div className="space-y-2">
            {pageRows.map((r) => (
              <div key={r._id} className="card card-body">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <button className="text-sm font-semibold text-slate-800 hover:underline"
                      onClick={() => onOpenEmployee?.(r.employee?._id)}>
                      {r.employee?.name || '(unknown)'}{' '}
                      <span className="text-slate-400 font-normal">
                        ({r.employee?.employeeId || '—'})
                      </span>
                    </button>
                    <div className="text-[11px] text-slate-500">
                      {r.employee?.department || '—'} · {fmtDate(r.date)}
                      {' · '}Attendance: {r.attendance || '—'} · Submission: {r.submissionStatus || 'none'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="badge bg-slate-100 text-slate-700 border border-slate-200 text-[11px]">
                      Rating: <b className="ml-1">{r.selfRating}</b>
                    </span>
                    {r.submissionId && (
                      <button
                        className="btn-secondary !py-1 !text-xs"
                        onClick={() => window.open(`/submissions/${r.submissionId}`, '_blank')}>
                        Open Submission →
                      </button>
                    )}
                  </div>
                </div>
                <div className="text-sm text-slate-700 whitespace-pre-wrap mt-2">
                  {r[field]}
                </div>
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-slate-500">
              <div>Page {currentPage} of {totalPages} · {rows.length} rows</div>
              <div className="flex items-center gap-1">
                <button className="btn-ghost !py-1 !text-xs" disabled={currentPage === 1} onClick={() => setPage(1)}>« First</button>
                <button className="btn-ghost !py-1 !text-xs" disabled={currentPage === 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
                <button className="btn-ghost !py-1 !text-xs" disabled={currentPage === totalPages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
                <button className="btn-ghost !py-1 !text-xs" disabled={currentPage === totalPages} onClick={() => setPage(totalPages)}>Last »</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Employee detail modal                                                */
/* ------------------------------------------------------------------ */
function EmployeeDetailModal({ employeeId, params, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    setLoading(true);
    api.get(`/self-review/employee/${employeeId}`, { params })
      .then(({ data }) => { setDetail(data); setLoading(false); })
      .catch((err) => { toast.error(errMsg(err)); setLoading(false); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg w-full max-w-4xl max-h-[90vh] overflow-y-auto p-4 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {detail?.employee?.name || 'Employee'}{' '}
              {detail?.employee?.employeeId && <span className="text-slate-400 text-sm">({detail.employee.employeeId})</span>}
            </h2>
            {detail?.employee?.department && (
              <div className="text-xs text-slate-500">{detail.employee.department}</div>
            )}
          </div>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>
        {loading || !detail ? <Loader /> : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatCard label="Average" value={detail.stats.avg} accent={ratingAccent(detail.stats.avg)} />
              <StatCard label="Highest" value={detail.stats.high} accent="green" />
              <StatCard label="Lowest"  value={detail.stats.low}  accent="red" />
              <StatCard label="Median"  value={detail.stats.median} accent="blue" />
              <StatCard label="Total Reflections" value={detail.stats.count} accent="slate" />
            </div>

            <ChartCard title="Rating Trend" subtitle={`${detail.range.from} → ${detail.range.to}`}>
              <LineChart data={[...detail.timeline].reverse().map((t) => ({
                date: new Date(t.date).toISOString().slice(5, 10),
                rating: t.selfRating,
              }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="rating" stroke={BAR} strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ChartCard>

            <div>
              <h3 className="text-sm font-semibold text-slate-800 mb-2">Daily Timeline</h3>
              {detail.timeline.length === 0 ? (
                <EmptyState title="No reflections filed in this range" />
              ) : (
                <div className="space-y-2">
                  {detail.timeline.map((row) => (
                    <div key={String(row.date)} className="card card-body">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                          <div className="text-sm font-semibold text-slate-800">{fmtDate(row.date)}</div>
                          <div className="text-[11px] text-slate-500">
                            Attendance: {row.attendance || '—'} · Submission: {row.submissionStatus}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="badge bg-slate-100 text-slate-700 border border-slate-200 text-[11px]">
                            Rating: <b className="ml-1">{row.selfRating}</b>
                          </span>
                          {row.submissionId && (
                            <button className="btn-secondary !py-1 !text-xs"
                              onClick={() => window.open(`/submissions/${row.submissionId}`, '_blank')}>
                              Open Submission →
                            </button>
                          )}
                        </div>
                      </div>
                      {row.selfNote && (
                        <div className="mt-2 text-sm text-slate-700 whitespace-pre-wrap">
                          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Note</div>
                          {row.selfNote}
                        </div>
                      )}
                      {row.idea && (
                        <div className="mt-2 text-sm text-slate-700 whitespace-pre-wrap">
                          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Business Idea</div>
                          {row.idea}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
