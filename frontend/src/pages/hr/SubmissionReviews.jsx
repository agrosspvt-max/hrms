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
          {reviewed
            ? <span className="badge-green">Reviewed</span>
            : <span className="badge-amber">Pending</span>}
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
      <div className="px-4 py-2 border-b border-slate-100 flex items-center justify-between bg-white">
        <div>
          <div className="font-medium text-slate-800">
            {sub.template?.title || '(template gone)'}
          </div>
          <div className="text-[11px] text-slate-500">
            {sub.templateType}{kind ? ` / ${kind}` : ''} · submitted {sub.submittedAt ? new Date(sub.submittedAt).toLocaleString() : ''}
            {sub.totalPoints > 0 && <> · work score <b>{sub.earnedPoints}/{sub.totalPoints}</b></>}
          </div>
        </div>
        <Link className="text-xs text-brand-600 hover:underline" to={`/submission-control?focus=${sub._id}`}>
          Open in Submission Control →
        </Link>
      </div>
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
  const byKey = Object.fromEntries(responses.map((r) => [r.key, r.value]));
  const ordered = (fields || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  return (
    <div className="grid md:grid-cols-3 gap-2">
      {ordered.map((f) => (
        <KV key={f.key} k={f.label || f.key} v={String(byKey[f.key] ?? '')} />
      ))}
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

  return (
    <div className="rounded-lg bg-brand-50 border border-brand-200 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-brand-800 uppercase tracking-wide">Daily Discipline &amp; Innovation</div>
        {reviewed && (
          <div className="text-[11px] text-brand-700">
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
