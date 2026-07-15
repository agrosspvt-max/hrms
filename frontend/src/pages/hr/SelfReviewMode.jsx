import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  AreaChart, Area, LineChart, Line, Cell,
} from 'recharts';
import api from '../../api/axios';
import StatCard from '../../components/StatCard.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtDate } from '../../utils/helpers';

/**
 * Phase 69 -- Daily Self Review analytics tab.
 *
 * Reads only from DailyReflection (via /api/self-review/*).  Reuses
 * the same StatCard + Recharts vocabulary as the Pendency / Completion
 * tabs so the layout style stays consistent with the rest of the
 * Performance Analytics page.
 *
 * Props (mirror the shape used by PendencyMode / CompletionMode):
 *   filters   -- { from, to, department, employee, range } already
 *                normalised by the parent
 *   canExport -- boolean; parent decides based on the user's role
 */

const RATING_COLORS = ['#ef4444', '#ef4444', '#f97316', '#f97316', '#f59e0b',
  '#f59e0b', '#84cc16', '#84cc16', '#22c55e', '#22c55e', '#16a34a'];
const BAR = '#6366f1';
const AREA = '#3b82f6';

const ChartCard = ({ title, subtitle, children, height = 260 }) => (
  <div className="card card-body">
    <div className="flex items-start justify-between">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {subtitle && <div className="text-[11px] text-slate-400">{subtitle}</div>}
      </div>
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
  const [openEmployee, setOpenEmployee] = useState(null); // full detail
  const [tab, setTab] = useState('overview'); // overview | ideas | notes
  const toast = useToast();

  const params = useMemo(() => {
    const p = {};
    if (filters.from && filters.to) { p.from = filters.from; p.to = filters.to; }
    else if (filters.range) p.range = filters.range;
    if (filters.department) p.department = filters.department;
    if (filters.employee)   p.employee   = filters.employee;
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
    // api.defaults.baseURL is /api; open in a new tab so the browser
    // handles the download.  Auth cookie / bearer is on the same origin.
    const base = (api.defaults.baseURL || '').replace(/\/$/, '');
    const token = localStorage.getItem('token') || '';
    // Use a fetch + blob approach so the Authorization header travels.
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

  if (loading || !data) return <Loader />;
  const c = data.cards; const ch = data.charts; const t = data.trend;

  return (
    <div className="space-y-5">
      {/* Sub-tabs: Overview / Ideas / Notes */}
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
        />
      )}
      {tab === 'ideas' && <IdeasLibrary params={params} />}
      {tab === 'notes' && <NotesLibrary params={params} />}

      {openEmployee && (
        <EmployeeDetailModal
          employeeId={openEmployee}
          params={params}
          onClose={() => setOpenEmployee(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                             */
/* ------------------------------------------------------------------ */
function OverviewTab({ data, c, ch, trend, onOpenEmployee }) {
  const empShort = (e) => e ? `${e.employee.name} (${e.avg})` : '—';
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard label="Average Rating"     value={c.avgRating}       accent={ratingAccent(c.avgRating)}    sub={`${c.totalReflections} reflections`} />
        <StatCard label="Highest Rating"     value={c.highestRating}   accent="green" />
        <StatCard label="Lowest Rating"      value={c.lowestRating}    accent="red" />
        <StatCard label="Median Rating"      value={c.medianRating}    accent="blue" />
        <StatCard label="Employees Submitted" value={c.employeesSubmitted} accent="green" />
        <StatCard label="Employees Missing"  value={c.employeesMissing}    accent={c.employeesMissing > 0 ? 'amber' : 'slate'} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Most Consistent" value={c.mostConsistent?.employee?.name || '—'} accent="blue"  sub={c.mostConsistent ? `${c.mostConsistent.consistency}% coverage` : ''} />
        <StatCard label="Most Positive"   value={empShort(c.mostPositive)}   accent="green" sub={c.mostPositive ? `${c.mostPositive.count} reflections` : ''} />
        <StatCard label="Most Critical"   value={empShort(c.mostCritical)}   accent="red"   sub={c.mostCritical ? `${c.mostCritical.count} reflections` : ''} />
        <StatCard label="Most Improved"   value={c.mostImproved?.employee?.name || '—'} accent="amber" sub={c.mostImproved ? `${c.mostImproved.improvement > 0 ? '+' : ''}${c.mostImproved.improvement} vs early period` : ''} />
      </div>

      {/* Trend vs previous period */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Current Period Avg"  value={trend.currentAvg}  accent={ratingAccent(trend.currentAvg)} />
        <StatCard label="Previous Period Avg" value={trend.previousAvg} accent="slate" />
        <StatCard label="Delta"               value={`${trend.delta > 0 ? '+' : ''}${trend.delta}`} accent={trend.delta > 0 ? 'green' : trend.delta < 0 ? 'red' : 'slate'} />
        <StatCard label="Delta %"             value={`${trend.deltaPct > 0 ? '+' : ''}${trend.deltaPct}%`} accent={trend.deltaPct > 0 ? 'green' : trend.deltaPct < 0 ? 'red' : 'slate'} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Daily Average Rating" subtitle={`${data.range.from} → ${data.range.to}`}>
          <AreaChart data={ch.daily}>
            <defs><linearGradient id="dailyG" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={AREA} stopOpacity={0.5} />
              <stop offset="95%" stopColor={AREA} stopOpacity={0.05} />
            </linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Area type="monotone" dataKey="avg" stroke={AREA} fill="url(#dailyG)" strokeWidth={2} />
          </AreaChart>
        </ChartCard>
        <ChartCard title="Rating Distribution" subtitle="0-10 histogram">
          <BarChart data={ch.distribution}>
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
        <ChartCard title="Weekly Average Rating">
          <LineChart data={ch.weekly}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Line type="monotone" dataKey="avg" stroke={BAR} strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ChartCard>
        <ChartCard title="Monthly Average Rating">
          <BarChart data={ch.monthly}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="avg" fill={BAR} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartCard>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <ChartCard title="Department Comparison" subtitle="Average rating per department">
          <BarChart data={ch.deptAvg} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis type="number" domain={[0, 10]} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
            <Tooltip />
            <Bar dataKey="avg" fill={AREA} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Weekday Heatmap" subtitle="Average rating by weekday">
          <BarChart data={ch.heatmap}>
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

      {/* Employee ranking tables */}
      <div className="grid md:grid-cols-2 gap-4">
        <RankingTable
          title="Top 10 - Highest Average"
          rows={ch.topRanking}
          onOpen={onOpenEmployee}
          rankColor="text-green-700"
        />
        <RankingTable
          title="Bottom 10 - Lowest Average"
          rows={ch.bottomRanking}
          onOpen={onOpenEmployee}
          rankColor="text-red-700"
        />
      </div>
    </>
  );
}

function RankingTable({ title, rows, onOpen, rankColor }) {
  if (!rows || rows.length === 0) return (
    <div className="card card-body">
      <h2 className="text-sm font-semibold text-slate-800 mb-2">{title}</h2>
      <EmptyState title="No employees with 3+ reflections in this range" />
    </div>
  );
  return (
    <div className="card card-body">
      <h2 className="text-sm font-semibold text-slate-800 mb-3">{title}</h2>
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
/* Ideas / Notes libraries                                              */
/* ------------------------------------------------------------------ */
function IdeasLibrary({ params }) {
  return <LibraryBrowser params={params} kind="ideas" field="idea" placeholder="Search idea text" />;
}
function NotesLibrary({ params }) {
  return <LibraryBrowser params={params} kind="notes" field="selfNote" placeholder="Search note text" />;
}

function LibraryBrowser({ params, kind, field, placeholder }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [rating, setRating] = useState('');
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const q = { ...params };
    if (keyword.trim()) q.keyword = keyword.trim();
    if (kind === 'ideas' && rating !== '') q.rating = rating;
    api.get(`/self-review/${kind}`, { params: q })
      .then(({ data }) => { if (!cancelled) { setRows(data || []); setLoading(false); } })
      .catch((err) => { if (!cancelled) { toast.error(errMsg(err)); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(params), keyword, rating]);

  return (
    <div className="space-y-3">
      <div className="card card-body flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[220px]">
          <label className="label">Keyword</label>
          <input className="input" type="search" placeholder={placeholder}
            value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        {kind === 'ideas' && (
          <div>
            <label className="label">Rating</label>
            <select className="input max-w-[140px]" value={rating} onChange={(e) => setRating(e.target.value)}>
              <option value="">Any</option>
              {Array.from({ length: 11 }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {loading ? <Loader /> : rows.length === 0 ? (
        <EmptyState title={`No ${kind} match the current filters`} />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r._id} className="card card-body">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-sm font-semibold text-slate-800">
                    {r.employee?.name || '(unknown)'}{' '}
                    <span className="text-slate-400 font-normal">
                      ({r.employee?.employeeId || '—'})
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {r.employee?.department || '—'} · {fmtDate(r.date)}
                  </div>
                </div>
                <span className="badge bg-slate-100 text-slate-700 border border-slate-200 text-[11px]">
                  Rating: <b className="ml-1">{r.selfRating}</b>
                </span>
              </div>
              <div className="text-sm text-slate-700 whitespace-pre-wrap mt-2">
                {r[field]}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Employee detail modal (drill-down)                                    */
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
                        <span className="badge bg-slate-100 text-slate-700 border border-slate-200 text-[11px]">
                          Rating: <b className="ml-1">{row.selfRating}</b>
                        </span>
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
