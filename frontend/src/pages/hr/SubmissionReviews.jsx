import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtDate } from '../../utils/helpers';

/**
 * HR Submission Reviews -- Phase 5 grouped layout.
 *
 *   - Feed: GET /api/daily-review/grouped?date=YYYY-MM-DD&status=
 *   - Each card = one (employee, date).  Inside the card we render
 *     every submission for that day with custom-template-aware
 *     widgets (calling KPI strip, product sales table, farmer
 *     records list with dealer details).
 *   - Daily Reflection panel shows what the employee wrote ONCE for
 *     the whole day (selfRating + selfNote + idea).
 *   - Daily Review panel (footer of each card) collects Discipline
 *     + Innovation marks ONCE per (employee, date).
 *     Finalising the day:
 *       - writes the marks to DailyReview
 *       - distributes them onto the primary (first chronological)
 *         submission so legacy analytics that sum earnedPoints keep
 *         working without any controller changes
 *       - flips every same-day submission to reviewStatus='reviewed'
 *
 *   Excel / spreadsheet templates that need per-row work scoring
 *   still surface a "Edit work scoring" link that opens the
 *   Submission Control page for that submission, where HR has the
 *   full freeze-mode editor.
 */
export default function SubmissionReviews() {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate]     = useState(today);
  const [status, setStatus] = useState('');         // '' | pending | reviewed
  const [cards, setCards]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/daily-review/grouped', { params: { date, status } });
      setCards(data);
    } catch (err) {
      toast.error(errMsg(err));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date, status]);

  const pending  = cards.filter((c) => !c.review || c.review.reviewStatus !== 'reviewed').length;
  const reviewed = cards.filter((c) =>  c.review && c.review.reviewStatus === 'reviewed').length;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Submission Reviews</h1>
          <p className="text-sm text-slate-500">
            One card per employee per day. Daily reflection + discipline + innovation are reviewed once,
            even when the employee filed multiple reports.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="badge bg-amber-50 text-amber-700">{pending} pending</span>
          <span className="badge-green">{reviewed} reviewed</span>
        </div>
      </div>

      <div className="card card-body flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Date</label>
          <input className="input max-w-[170px]" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input max-w-[160px]" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="reviewed">Reviewed</option>
          </select>
        </div>
      </div>

      {loading ? <Loader /> : cards.length === 0 ? (
        <EmptyState title="No submissions to review on this day" />
      ) : (
        <div className="space-y-3">
          {cards.map((c) => (
            <EmployeeDayCard
              key={String(c.employee._id) + String(c.date)}
              card={c}
              open={openId === String(c.employee._id)}
              onToggle={() => setOpenId((cur) => cur === String(c.employee._id) ? null : String(c.employee._id))}
              onReload={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ===================================================================== */
/* Per-employee-per-day card                                              */
/* ===================================================================== */
function EmployeeDayCard({ card, open, onToggle, onReload }) {
  const { employee, date, submissions, reflection, review } = card;
  const reviewed = review && review.reviewStatus === 'reviewed';
  const types = submissions.map((s) => (s.template?.customKind || s.templateType));
  // Phase 16: roll-up HOD state for the day.  Awaiting beats Returned
  // beats Approved so HR's attention is drawn to anything still waiting
  // on the HOD layer.
  const hodRollup = (() => {
    const states = submissions.map((s) => hodReviewState(s)).filter(Boolean);
    if (states.length === 0) return null;
    if (states.some((x) => x.label === 'Awaiting HOD Review')) {
      return { label: 'Awaiting HOD', dot: '🟡', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
    }
    if (states.some((x) => x.label === 'HOD Returned for Changes')) {
      return { label: 'HOD Returned', dot: '🔵', cls: 'bg-blue-50 text-blue-700 border-blue-200' };
    }
    return { label: 'HOD Approved', dot: '🟢', cls: 'bg-green-50 text-green-700 border-green-200' };
  })();

  return (
    <div className={`card overflow-hidden ${reviewed ? '' : 'ring-1 ring-amber-200'}`}>
      <button className="w-full flex items-center justify-between px-5 py-3 bg-slate-50 hover:bg-slate-100" onClick={onToggle}>
        <div className="text-left">
          <div className="font-semibold text-slate-800">
            {employee.name} <span className="text-slate-400 font-normal">({employee.employeeId})</span>
          </div>
          <div className="text-[12px] text-slate-500">
            {employee.department || '—'} · {fmtDate(date)} · {submissions.length} submission(s)
            {types.length > 0 && <> · <span className="text-slate-600">{types.join(' · ')}</span></>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hodRollup && (
            <span className={`badge text-[11px] border ${hodRollup.cls}`} title={`Day-level HOD status: ${hodRollup.label}`}>
              <span className="mr-1">{hodRollup.dot}</span>{hodRollup.label}
            </span>
          )}
          {reviewed
            ? <span className="badge-green">HR Reviewed</span>
            : <span className="badge-amber">HR Pending</span>}
          <span className="text-slate-400">{open ? '▾' : '▸'}</span>
        </div>
      </button>

      {open && (
        <div className="p-5 space-y-4">
          {/* Daily Reflection */}
          <DailyReflectionPanel reflection={reflection} />

          {/* Per-submission render -- one per assignment, with custom widgets */}
          <div className="space-y-3">
            {submissions.map((s) => (
              <SubmissionPanel key={s._id} sub={s} onReload={onReload} />
            ))}
          </div>

          {/* Daily Discipline + Innovation entry */}
          <DailyReviewPanel
            employeeId={employee._id}
            date={date}
            review={review}
            onSaved={onReload}
          />
        </div>
      )}
    </div>
  );
}

/* ===================================================================== */
/* Daily Reflection (employee-written, read-only here)                    */
/* ===================================================================== */
function DailyReflectionPanel({ reflection }) {
  if (!reflection) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 p-3 text-sm text-slate-500">
        Employee has not filed a daily reflection for this day.
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 space-y-2">
      <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Daily Reflection</div>
      <div className="grid md:grid-cols-3 gap-3 text-sm">
        <KV k="Self Rating" v={reflection.selfRating != null ? `${reflection.selfRating} / 10` : '—'} />
        <KV k="Note" v={reflection.selfNote || '—'} multiline />
        <KV k="Idea" v={reflection.idea || '—'} multiline />
      </div>
    </div>
  );
}

/* ===================================================================== */
/* Per-submission panel -- branches on templateType + customKind         */
/* ===================================================================== */
function SubmissionPanel({ sub, onReload }) {
  const kind = sub.template?.customKind || '';
  const isCalling = kind === 'calling';
  const isProductFarmer = kind === 'product_farmer'
    || (Array.isArray(sub.productSales) && sub.productSales.length > 0)
    || (Array.isArray(sub.farmerRecords) && sub.farmerRecords.length > 0);

  return (
    <div className="rounded-lg border border-slate-200">
      <div className="px-4 py-2 border-b border-slate-100 flex items-center justify-between bg-white gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="font-medium text-slate-800">
            {sub.template?.title || '(template gone)'}
          </div>
          <div className="text-[11px] text-slate-500">
            {sub.templateType}{kind ? ` / ${kind}` : ''} · submitted {sub.submittedAt ? new Date(sub.submittedAt).toLocaleString() : ''}
            {sub.totalPoints > 0 && <> · work score <b>{sub.earnedPoints}/{sub.totalPoints}</b></>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <HodReviewBadge sub={sub} />
          <Link className="text-xs text-brand-600 hover:underline" to={`/submission-control?focus=${sub._id}`}>
            Open in Submission Control →
          </Link>
        </div>
      </div>
      {/* Phase 16: HOD review details (reviewer + time + remarks) when present. */}
      <HodReviewDetails sub={sub} />
      <div className="p-4 space-y-3">
        {isCalling && <CallingReportPanel sub={sub} />}
        {isProductFarmer && <ProductFarmerPanel sub={sub} />}
        {!isCalling && !isProductFarmer && sub.templateType === 'custom' && (
          <CustomResponsesPanel responses={sub.customResponses || []} fields={sub.template?.customFields || []} />
        )}
        {sub.templateType === 'task' && (
          <TaskListPanel sub={sub} onReload={onReload} />
        )}
        {(sub.templateType === 'excel' || sub.templateType === 'sheet') && (
          <div className="text-xs text-slate-500 italic">
            {sub.templateType === 'excel' ? 'Excel report' : 'Spreadsheet report'} — open in Submission Control to score per-row work.
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------- Calling KPI strip ----------------- */
function CallingReportPanel({ sub }) {
  // Pull every customResponses field by key into one map.
  const m = Object.fromEntries((sub.customResponses || []).map((r) => [r.key, r.value]));
  const n = (k) => Number(m[k]) || 0;
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  const dialed = n('dialedCalls') || n('totalCallsCompleted');
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Calling Report</div>
      {/* Headline grid */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <KPI label="Assigned"        value={n('assignedCalls')} />
        <KPI label="Dialed"          value={n('dialedCalls')} />
        <KPI label="Calls Completed" value={n('totalCallsCompleted')} accent="green" />
        <KPI label="Attended"        value={n('attendedCalls')} accent="blue" />
        <KPI label="Unattended"      value={n('unattendedCalls') || (dialed - n('attendedCalls'))} accent="amber" />
        <KPI label="Old Conversions"   value={n('oldCustomerConversions')} />
        <KPI label="New Conversions"   value={n('newCustomerConversions')} accent="green" />
        <KPI label="Total Conversions" value={n('totalConversions')} accent="green" />
        <KPI label="Total Pending"     value={n('totalPending')}     accent="red" />
        <KPI label="Yesterday Pending" value={n('yesterdayPending')} />
      </div>
      {/* Rate strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <KPI label="Connection Rate"        value={`${n('connectionRate')        || pct(n('attendedCalls'), dialed)}%`} accent="blue" />
        <KPI label="Conversion Rate"        value={`${n('conversionRate')        || pct(n('totalConversions'), n('attendedCalls'))}%`} accent="green" />
        <KPI label="Pending Rate"           value={`${n('pendingRate')           || pct(n('totalPending'), n('assignedCalls'))}%`}   accent="red" />
        <KPI label="Call Completion Rate"   value={`${n('callCompletionRate')    || pct(n('totalCallsCompleted'), n('assignedCalls'))}%`} accent="green" />
      </div>
    </div>
  );
}

/* ----------------- Product Sales + Farmer Records panel ----------------- */
function ProductFarmerPanel({ sub }) {
  const sales   = sub.productSales   || [];
  const farmers = sub.farmerRecords  || [];
  const totQty   = sales.reduce((s, r) => s + (Number(r.quantity ?? r.quantityValue) || 0), 0);
  const totSales = sales.reduce((s, r) => s + (Number(r.salesValue) || 0), 0);
  const totNbv   = sales.reduce((s, r) => s + (Number(r.nbvValue)   || 0), 0);

  return (
    <div className="space-y-3">
      {sales.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
            Product Sales ({sales.length})
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-3 py-2">Product</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-right px-3 py-2">Sales (₹)</th>
                  <th className="text-right px-3 py-2">NBV (₹)</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-1.5">{r.productName || '—'} <span className="text-[11px] text-slate-400">({r.productUnit || ''})</span></td>
                    <td className="px-3 py-1.5 text-right">{Number(r.quantity ?? r.quantityValue) || 0}</td>
                    <td className="px-3 py-1.5 text-right text-green-700 font-semibold">{Math.round((Number(r.salesValue) || 0) * 100) / 100}</td>
                    <td className="px-3 py-1.5 text-right">{Math.round((Number(r.nbvValue) || 0) * 100) / 100}</td>
                  </tr>
                ))}
                <tr className="bg-slate-50 border-t-2 border-slate-200 font-semibold">
                  <td className="px-3 py-1.5 text-right">Total</td>
                  <td className="px-3 py-1.5 text-right">{Math.round(totQty * 100) / 100}</td>
                  <td className="px-3 py-1.5 text-right text-green-700">{Math.round(totSales * 100) / 100}</td>
                  <td className="px-3 py-1.5 text-right">{Math.round(totNbv * 100) / 100}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {farmers.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
            Farmer Records ({farmers.length})
          </div>
          <div className="space-y-2">
            {farmers.map((f, i) => (
              <div key={i} className="rounded-lg border border-emerald-100 bg-emerald-50/40 p-2 text-sm">
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <div className="font-medium text-slate-800">
                    {f.name || '—'} <span className="text-slate-400 font-normal">{f.mobile ? `· ${f.mobile}` : ''}</span>
                  </div>
                  <div className="text-[12px] text-slate-600">
                    {f.dealerFirmSnapshot || f.dealerNameSnapshot || f.dealerLocation || '—'}
                    {f.dealerPlaceSnapshot ? <> · {f.dealerPlaceSnapshot}</> : ''}
                    {f.village ? <> · Village: {f.village}</> : ''}
                  </div>
                </div>
                {Array.isArray(f.products) && f.products.length > 0 && (
                  <div className="mt-1 pl-3 text-[12px] text-slate-700">
                    {f.products.map((p, j) => (
                      <div key={j}>• {p.productName || '—'} <span className="text-slate-400">({p.productUnit || ''})</span> · qty {Number(p.quantity) || 0}</div>
                    ))}
                  </div>
                )}
                {/* Legacy single-product mirror */}
                {(!f.products || f.products.length === 0) && f.productName && (
                  <div className="mt-1 pl-3 text-[12px] text-slate-700">• {f.productName} {f.quantityLabel ? `(${f.quantityLabel})` : ''}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {sales.length === 0 && farmers.length === 0 && (
        <div className="text-xs text-slate-500 italic">No product sales or farmer records on this submission.</div>
      )}
    </div>
  );
}

/* ----------------- Generic custom-template panel ----------------- */
function CustomResponsesPanel({ responses, fields }) {
  if (responses.length === 0) return <div className="text-xs text-slate-500 italic">No responses.</div>;
  // Phase 14: surface { value, status, remark } per row, with a
  // status badge + remark below the value.  Legacy { key, value }
  // rows render only the value (status/remark default to '').
  const byKey = Object.fromEntries(responses.map((r) => [r.key, r]));
  const ordered = (fields || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const STATUS_META = {
    done:               { label: 'Done',     cls: 'bg-green-50 text-green-700' },
    ongoing:            { label: 'Ongoing',  cls: 'bg-blue-50 text-blue-700' },
    pending:            { label: 'Pending',  cls: 'bg-amber-50 text-amber-700' },
    work_not_available: { label: 'Work N/A', cls: 'bg-slate-100 text-slate-600' },
  };
  return (
    <div className="grid md:grid-cols-2 gap-2">
      {ordered.map((f) => {
        const row = byKey[f.key] || {};
        const meta = STATUS_META[row.status];
        return (
          <div key={f.key} className="rounded border border-slate-200 px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{f.label || f.key}</div>
                <div className="text-sm font-medium text-slate-800 break-all">
                  {row.value === '' || row.value == null
                    ? <span className="text-slate-400">—</span>
                    : String(row.value)}
                </div>
              </div>
              {meta && <span className={`badge ${meta.cls} text-[10px] whitespace-nowrap`}>{meta.label}</span>}
            </div>
            {row.remark && (
              <div className="text-[11px] text-slate-600 mt-1">
                <span className="font-semibold">Remark:</span> {row.remark}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ----------------- Task list with per-row inline status editor ----------------- */
function TaskListPanel({ sub, onReload }) {
  const tasks = sub.tasks || [];
  const done    = tasks.filter((t) => t.status === 'done').length;
  const ongoing = tasks.filter((t) => t.status === 'ongoing').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const wna     = tasks.filter((t) => t.status === 'work_not_available').length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2">
        <KPI label="Done"     value={done}    accent="green" />
        <KPI label="Ongoing"  value={ongoing} accent="blue" />
        <KPI label="Pending"  value={pending} accent="red" />
        <KPI label="Work N/A" value={wna}     accent="amber" />
      </div>
      <div className="space-y-1.5">
        {tasks.map((t) => (
          <TaskRowEditor key={t._id} submissionId={sub._id} task={t} onReload={onReload} />
        ))}
      </div>
    </div>
  );
}

const STATUS_META = {
  done:               { label: 'Done',     symbol: '✓', cls: 'text-green-700 bg-green-50 border-green-200' },
  ongoing:            { label: 'Ongoing',  symbol: '◐', cls: 'text-blue-700  bg-blue-50  border-blue-200' },
  pending:            { label: 'Pending',  symbol: '⚠', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  work_not_available: { label: 'Work N/A', symbol: '✖', cls: 'text-slate-700 bg-slate-50 border-slate-200' },
  pending_submit:     { label: 'Not filled', symbol: '·', cls: 'text-slate-500 bg-slate-50 border-slate-200' },
};

function TaskRowEditor({ submissionId, task, onReload }) {
  const [status, setStatus] = useState(task.status);
  const [reason, setReason] = useState(task.pendingReason || '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const meta = STATUS_META[task.status] || STATUS_META.pending_submit;
  const dirty = status !== task.status || (status === 'pending' && reason !== (task.pendingReason || ''));

  const save = async () => {
    if (status === 'pending' && !reason.trim()) {
      toast.error('A pending reason is required when status is Pending.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/daily-review/task-status', {
        submissionId,
        taskId: task._id,
        status,
        pendingReason: status === 'pending' ? reason.trim() : '',
      });
      toast.success('Task updated');
      setEditing(false);
      onReload?.();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  const cancel = () => {
    setStatus(task.status);
    setReason(task.pendingReason || '');
    setEditing(false);
  };

  return (
    <div className={`rounded border ${meta.cls} px-3 py-1.5`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">{meta.symbol}</span>
          <div className="min-w-0">
            <div className="font-medium text-slate-800 truncate">{task.title}</div>
            {task.points > 0 && (
              <div className="text-[11px] text-slate-500">{task.points} pts{task.addedByEmployee ? ' · employee-added' : ''}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!editing ? (
            <>
              <span className="text-[11px] font-medium uppercase tracking-wide opacity-80">{meta.label}</span>
              <button className="btn-ghost !py-0.5 !text-xs" onClick={() => setEditing(true)}>Edit</button>
            </>
          ) : (
            <>
              <select
                className="input !py-1 !text-xs max-w-[140px]"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="done">Done</option>
                <option value="ongoing">Ongoing</option>
                <option value="pending">Pending</option>
                <option value="work_not_available">Work N/A</option>
              </select>
              <button className="btn-primary !py-0.5 !text-xs" disabled={busy || !dirty} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button className="btn-ghost !py-0.5 !text-xs" onClick={cancel}>Cancel</button>
            </>
          )}
        </div>
      </div>
      {/* Pending reason -- shown when employee or reviewer set status=pending */}
      {(editing && status === 'pending') ? (
        <div className="mt-1.5">
          <input
            className="input !py-1 !text-xs"
            placeholder="Pending reason (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      ) : (!editing && task.status === 'pending' && task.pendingReason) ? (
        <div className="mt-1 text-[12px] text-slate-700">
          <b>Reason:</b> {task.pendingReason}
        </div>
      ) : null}
    </div>
  );
}

/* ===================================================================== */
/* Daily Discipline + Innovation entry                                    */
/* ===================================================================== */
function DailyReviewPanel({ employeeId, date, review, onSaved }) {
  const reviewed = review && review.reviewStatus === 'reviewed';
  const [d, setD]     = useState(String(review?.disciplineMarks ?? ''));
  const [maxD, setMaxD] = useState(String(review?.maxDisciplineMarks ?? '3'));
  const [i, setI]     = useState(String(review?.ideaMarks ?? ''));
  const [maxI, setMaxI] = useState(String(review?.maxIdeaMarks ?? '2'));
  const [dn, setDn]   = useState(review?.disciplineNote || '');
  const [iFb, setIFb] = useState(review?.ideaFeedback || '');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/daily-review/finalize', {
        employeeId,
        date,
        disciplineMarks: Number(d) || 0,
        maxDisciplineMarks: Number(maxD) || 3,
        ideaMarks: Number(i) || 0,
        maxIdeaMarks: Number(maxI) || 2,
        disciplineNote: dn,
        ideaFeedback: iFb,
      });
      toast.success(reviewed ? 'Daily review updated' : 'Daily review finalised');
      onSaved?.();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

    /* Phase 22 (Issue: dark-mode visibility): the brand palette is a
       custom Tailwind colour defined in tailwind.config.js, so the
       index.css dark safety net (which targets Tailwind's stock
       palettes) doesn't catch `bg-brand-50` / `border-brand-200` /
       `text-brand-700` / `text-brand-800`.  In dark mode those classes
       rendered as a bright off-white panel with dark indigo text --
       barely legible.  Added explicit dark: variants below so the
       panel reads as a quiet brand-tinted surface against the dark
       review card, matching the rest of the page. */
  return (
    <div className="rounded-lg bg-brand-50 border border-brand-200 p-3 space-y-3 dark:bg-brand-500/15 dark:border-brand-500/30">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-brand-800 uppercase tracking-wide dark:text-brand-300">Daily Discipline &amp; Innovation</div>
        {reviewed && (
          <div className="text-[11px] text-brand-700 dark:text-brand-300">
            Reviewed by {review.reviewedBy?.name || '—'} on {review.reviewedAt ? new Date(review.reviewedAt).toLocaleString() : ''}
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div>
          <label className="label">Discipline</label>
          <div className="flex items-center gap-2">
            <input className="input" type="number" min="0" value={d}    onChange={(e) => setD(e.target.value)} />
            <span className="text-slate-400">/</span>
            <input className="input max-w-[70px]" type="number" min="0" value={maxD} onChange={(e) => setMaxD(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">Innovation</label>
          <div className="flex items-center gap-2">
            <input className="input" type="number" min="0" value={i}    onChange={(e) => setI(e.target.value)} />
            <span className="text-slate-400">/</span>
            <input className="input max-w-[70px]" type="number" min="0" value={maxI} onChange={(e) => setMaxI(e.target.value)} />
          </div>
        </div>
        <div className="md:col-span-2">
          <label className="label">Discipline Note</label>
          <input className="input" value={dn} onChange={(e) => setDn(e.target.value)} />
        </div>
        <div className="md:col-span-4">
          <label className="label">Idea Feedback</label>
          <textarea className="input" rows={2} value={iFb} onChange={(e) => setIFb(e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : (reviewed ? 'Update Daily Review' : 'Finalise Day')}
        </button>
      </div>
    </div>
  );
}

/* ===================================================================== */
/* HOD review status (Phase 16)                                           */
/* ===================================================================== */
/**
 * Derive the HOD-stage status from currentReviewStage + hodReview.
 *
 *   currentReviewStage      hodReview.recommend     → label / colour
 *   ----------------------  ---------------------   --------------------------
 *   under_hod               (any)                   🟡 Awaiting HOD Review
 *   submitted               (any) -- HOD route      🟡 Awaiting HOD Review
 *   hod_reviewed            'approve'               🟢 HOD Approved
 *   hod_reviewed            'needs_changes'         🔵 HOD Returned for Changes
 *   under_hr / finalized    'approve'               🟢 HOD Approved
 *   under_hr / finalized    'needs_changes'         🔵 HOD Returned for Changes
 *   direct_hr (no HOD)      —                       (nothing rendered)
 *
 * Returns { label, dot, cls } for the badge, or null when the
 * submission bypasses HOD entirely (employee's reviewFlow=direct_hr).
 */
const hodReviewState = (sub) => {
  const reviewedByHod = !!sub.hodReview?.reviewedAt;
  const recommend = sub.hodReview?.recommend || '';
  const stage = sub.currentReviewStage || '';
  // Bypass: never routed through HOD AND nobody reviewed at HOD layer.
  if (!reviewedByHod && stage !== 'under_hod' && stage !== 'hod_reviewed') return null;
  if (reviewedByHod) {
    if (recommend === 'approve') {
      return { label: 'HOD Approved', dot: '🟢', cls: 'bg-green-50 text-green-700 border-green-200' };
    }
    if (recommend === 'needs_changes') {
      return { label: 'HOD Returned for Changes', dot: '🔵', cls: 'bg-blue-50 text-blue-700 border-blue-200' };
    }
    // Reviewed but no explicit recommend value.
    return { label: 'HOD Reviewed', dot: '🟢', cls: 'bg-green-50 text-green-700 border-green-200' };
  }
  return { label: 'Awaiting HOD Review', dot: '🟡', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
};

function HodReviewBadge({ sub }) {
  const s = hodReviewState(sub);
  if (!s) return null;
  return (
    <span className={`badge text-[11px] whitespace-nowrap border ${s.cls}`} title={s.label}>
      <span className="mr-1">{s.dot}</span>{s.label}
    </span>
  );
}

function HodReviewDetails({ sub }) {
  const s = hodReviewState(sub);
  if (!s) return null;
  const h = sub.hodReview || {};
  // Awaiting state has no reviewer / timestamp yet -- skip the detail row.
  if (!h.reviewedAt) return null;
  return (
    <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 text-[12px] text-slate-700">
      <span className="font-semibold">{s.label}</span>
      <span className="text-slate-500"> · </span>
      Reviewed by <b>{h.reviewedBy?.name || '—'}</b>
      <span className="text-slate-500"> · {new Date(h.reviewedAt).toLocaleString()}</span>
      {h.remarks && (
        <div className="mt-1 text-[12px] text-slate-700">
          <span className="font-semibold">HOD remarks:</span> {h.remarks}
        </div>
      )}
    </div>
  );
}

/* ===================================================================== */
/* Tiny presentational helpers                                            */
/* ===================================================================== */
const KPI = ({ label, value, accent = 'slate' }) => {
  const cls = {
    slate: 'bg-slate-50 text-slate-800 border-slate-200',
    blue:  'bg-blue-50  text-blue-800  border-blue-200',
    green: 'bg-green-50 text-green-800 border-green-200',
    amber: 'bg-amber-50 text-amber-800 border-amber-200',
    red:   'bg-red-50   text-red-800   border-red-200',
  }[accent] || 'bg-slate-50 text-slate-800 border-slate-200';
  return (
    <div className={`rounded-lg border ${cls} px-3 py-2`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-base font-semibold mt-0.5">{value}</div>
    </div>
  );
};

const KV = ({ k, v, multiline = false }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wide text-slate-500">{k}</div>
    <div className={`text-sm text-slate-800 ${multiline ? 'whitespace-pre-wrap' : 'truncate'} font-medium`}>{v || <span className="text-slate-400">—</span>}</div>
  </div>
);
