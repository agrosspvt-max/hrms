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
  // Phase 23.5: HOD review-status filter, client-side because the
  // grouped feed already returns hodReview + currentReviewStage on
  // every submission.  Possible values:
  //   '' (all) | awaiting | reviewed | returned | direct
  const [hodStatus, setHodStatus] = useState('');
  const [cards, setCards]   = useState([]);
  // Phase 28 -- when status === 'not_submitted', the backend returns
  // { cards, summary } with day-level counts (expected / submitted /
  // not_submitted / on_approved_leave) we display at the top.
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  // Phase 23.6 -- multi-select for bulk Discipline + Innovation scoring.
  // selected is a Set of (employeeId|date) keys taken from the filtered
  // card list.  bulkOpen toggles the bulk-action panel.
  const [selected, setSelected] = useState(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/daily-review/grouped', { params: { date, status } });
      // Phase 28: Not Submitted returns { cards, summary }; all other
      // statuses still return a plain array.  Normalise here.
      if (data && Array.isArray(data.cards)) {
        setCards(data.cards);
        setSummary(data.summary || null);
      } else {
        setCards(Array.isArray(data) ? data : []);
        setSummary(null);
      }
    } catch (err) {
      toast.error(errMsg(err));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date, status]);

  // Phase 23.5: derive a card's HOD bucket from its submissions.  A
  // card may hold multiple submissions on the same day -- the rule is:
  //   awaiting beats returned beats reviewed beats direct
  // (so HR's attention is drawn to anything still waiting on the HOD
  // layer).  Bucket values match the filter options below.
  const hodBucket = (c) => {
    const states = (c.submissions || []).map((s) => {
      const stage = s.currentReviewStage || '';
      const recommend = s.hodReview?.recommend || '';
      const reviewedByHod = !!s.hodReview?.reviewedAt;
      if (stage === 'under_hod') return 'awaiting';
      if (reviewedByHod && recommend === 'needs_changes') return 'returned';
      if (reviewedByHod) return 'reviewed';
      // Submission never routed through HOD AND nobody at HOD layer
      // touched it -- HR-direct review.
      if (stage !== 'hod_reviewed' && !reviewedByHod) return 'direct';
      return 'reviewed';
    });
    if (states.includes('awaiting')) return 'awaiting';
    if (states.includes('returned')) return 'returned';
    if (states.includes('reviewed')) return 'reviewed';
    return 'direct';
  };
  const filteredCards = hodStatus
    ? cards.filter((c) => hodBucket(c) === hodStatus)
    : cards;

  const pending  = filteredCards.filter((c) => !c.review || c.review.reviewStatus !== 'reviewed').length;
  const reviewed = filteredCards.filter((c) =>  c.review && c.review.reviewStatus === 'reviewed').length;

  // Phase 23.6 -- selection helpers.  The key is stable: the grouped
  // feed already keys each card by (employeeId, date).
  const cardKey = (c) => `${String(c.employee._id)}|${new Date(c.date).toISOString().slice(0, 10)}`;
  const toggleSelected = (c) => setSelected((cur) => {
    const k = cardKey(c);
    const n = new Set(cur);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const allSelected = filteredCards.length > 0 && filteredCards.every((c) => selected.has(cardKey(c)));
  const someSelected = filteredCards.some((c) => selected.has(cardKey(c)));
  const toggleSelectAll = () => setSelected((cur) => {
    if (allSelected) return new Set();
    const n = new Set(cur);
    filteredCards.forEach((c) => n.add(cardKey(c)));
    return n;
  });
  const clearSelection = () => setSelected(new Set());
  const selectedCards = filteredCards.filter((c) => selected.has(cardKey(c)));

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
          <select className="input max-w-[180px]" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="reviewed">Reviewed</option>
            {/* Phase 28 -- Not Submitted */}
            <option value="not_submitted">Not Submitted</option>
          </select>
        </div>
        {/* Phase 23.5 -- HOD review status filter */}
        <div>
          <label className="label">HOD Review Status</label>
          <select className="input max-w-[200px]" value={hodStatus} onChange={(e) => setHodStatus(e.target.value)}>
            <option value="">All</option>
            <option value="awaiting">Awaiting HOD</option>
            <option value="reviewed">Reviewed by HOD</option>
            <option value="returned">Returned by HOD</option>
            <option value="direct">Direct HR Review</option>
          </select>
        </div>
      </div>

      {/* Phase 23.6 -- bulk-action toolbar.  Only renders when at least
          one card matches the current filters; checkbox state is purely
          client-side and clears on a refresh or successful save. */}
      {!loading && filteredCards.length > 0 && (
        <div className="flex items-center justify-between gap-2 flex-wrap text-xs text-slate-600">
          <label className="flex items-center gap-2 select-none cursor-pointer">
            <input type="checkbox" checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
              onChange={toggleSelectAll} />
            {selected.size > 0
              ? <>{selected.size} selected</>
              : <>Select all on this page</>}
          </label>
          <div className="flex items-center gap-2">
            {selected.size > 0 && (
              <>
                <button className="btn-secondary !py-1 !text-xs" onClick={clearSelection}>Clear</button>
                <button className="btn-primary !py-1 !text-xs" onClick={() => setBulkOpen(true)}>
                  Bulk Assign Scores ({selected.size})
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Phase 28 -- summary strip for the Not Submitted view.  Renders
          only when the backend returned per-day counts (i.e. status ===
          'not_submitted').  Pure presentational; numbers come straight
          from the captured summary payload. */}
      {summary && status === 'not_submitted' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Expected to Submit</div>
            <div className="text-2xl font-bold text-slate-800 dark:text-slate-100">{summary.expectedToSubmit ?? 0}</div>
          </div>
          <div className="rounded-lg border border-green-200 dark:border-green-500/30 bg-green-50/60 dark:bg-green-500/10 px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-green-700 dark:text-green-300">Submitted</div>
            <div className="text-2xl font-bold text-green-700 dark:text-green-300">{summary.submitted ?? 0}</div>
          </div>
          <div className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50/60 dark:bg-red-500/10 px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-red-700 dark:text-red-300">Not Submitted</div>
            <div className="text-2xl font-bold text-red-700 dark:text-red-300">{summary.notSubmitted ?? 0}</div>
          </div>
          <div className="rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/60 dark:bg-blue-500/10 px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-blue-700 dark:text-blue-300">On Approved Leave</div>
            <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">{summary.onApprovedLeave ?? 0}</div>
          </div>
        </div>
      )}

      {loading ? <Loader /> : filteredCards.length === 0 ? (
        <EmptyState title={
          cards.length === 0
            ? (status === 'not_submitted'
                ? 'No employees missed their submissions on this day'
                : 'No submissions to review on this day')
            : 'No submissions match the current filters'
        } />
      ) : (
        <div className="space-y-3">
          {filteredCards.map((c) => (
            c.notSubmitted ? (
              <NotSubmittedCard
                key={String(c.employee._id) + String(c.date)}
                card={c}
              />
            ) : (
              <EmployeeDayCard
                key={String(c.employee._id) + String(c.date)}
                card={c}
                open={openId === String(c.employee._id)}
                onToggle={() => setOpenId((cur) => cur === String(c.employee._id) ? null : String(c.employee._id))}
                onReload={load}
                selected={selected.has(cardKey(c))}
                onSelectToggle={() => toggleSelected(c)}
              />
            )
          ))}
        </div>
      )}

      {/* Phase 29 -- Attendance Reviews section (mode 2 employees).
          Renders below the Submission Reviews list and is always visible
          to HR / Super Admin / HOD because the queue endpoint enforces
          the scope server-side. */}
      <AttendanceReviewsSection date={date} />

      {bulkOpen && (
        <BulkScoreModal
          cards={selectedCards}
          onClose={() => setBulkOpen(false)}
          onDone={() => { setBulkOpen(false); clearSelection(); load(); }}
        />
      )}
    </div>
  );
}

/* =====================================================================
 * Phase 28 — Not Submitted card
 *
 * Compact, non-expandable card for employees who had at least one
 * scheduled assignment for the selected day but did not submit anything
 * and aren't on approved leave.  Shows the assignment list + attendance
 * snapshot so HR can act (chase the employee, mark an attendance
 * override, approve a leave) directly from Attendance afterwards.
 *
 * The card has no Open / Selection / Bulk-score affordances because no
 * Submission / DailyReview document exists yet — the only meaningful HR
 * action here is "follow up", which is contextual to each org.
 * ===================================================================== */
function NotSubmittedCard({ card }) {
  const { employee, date, assignments = [], attendance, leave } = card;
  const ATT_META = {
    present:        { label: 'Present',     cls: 'bg-green-50 text-green-700  border-green-200' },
    half_paid:      { label: 'Half Paid',   cls: 'bg-amber-50 text-amber-700  border-amber-200' },
    half_unpaid:    { label: 'Half Unpaid', cls: 'bg-amber-50 text-amber-700  border-amber-200' },
    paid_leave:     { label: 'Paid Leave',  cls: 'bg-blue-50  text-blue-700   border-blue-200' },
    unpaid_leave:   { label: 'Unpaid Leave',cls: 'bg-blue-50  text-blue-700   border-blue-200' },
    weekly_off:     { label: 'Weekly Off',  cls: 'bg-slate-50 text-slate-700  border-slate-200' },
    holiday:        { label: 'Holiday',     cls: 'bg-slate-50 text-slate-700  border-slate-200' },
    absent:         { label: 'Absent',      cls: 'bg-red-50   text-red-700    border-red-200' },
  };
  const att = ATT_META[attendance] || { label: attendance || '—', cls: 'bg-slate-50 text-slate-700 border-slate-200' };
  return (
    <div className="card overflow-hidden ring-1 ring-red-200">
      <div className="px-5 py-3 bg-red-50/40 dark:bg-red-500/10 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-semibold text-slate-800 dark:text-slate-100">
            {employee.name} <span className="text-slate-400 font-normal">({employee.employeeId})</span>
          </div>
          <div className="text-[12px] text-slate-500">
            {employee.department || '—'} · {fmtDate(date)} · {assignments.length} assignment(s)
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`badge text-[11px] border ${att.cls}`}>Attendance: {att.label}</span>
          <span className="badge text-[11px] border bg-slate-50 text-slate-700 border-slate-200">Leave: {leave ? 'Approved' : 'None'}</span>
          <span className="badge-red">Not Submitted</span>
        </div>
      </div>
      {assignments.length > 0 && (
        <div className="px-5 py-3 text-sm">
          <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mb-1">Expected Assignments</div>
          <ul className="space-y-0.5 text-slate-700 dark:text-slate-200">
            {assignments.map((a) => (
              <li key={String(a._id)} className="flex items-center gap-2">
                <span className="text-slate-400">•</span>
                <span className="font-medium">{a.title}</span>
                {a.customKind ? <span className="text-[11px] text-slate-500">({a.customKind})</span> : null}
                {a.scheduleLabel ? <span className="text-[11px] text-slate-400 ml-1">{a.scheduleLabel}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ===================================================================== */
/* Per-employee-per-day card                                              */
/* ===================================================================== */
function EmployeeDayCard({ card, open, onToggle, onReload, selected = false, onSelectToggle }) {
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
    <div className={`card overflow-hidden ${reviewed ? '' : 'ring-1 ring-amber-200'} ${selected ? 'ring-2 ring-brand-400' : ''}`}>
      <div className="w-full flex items-center justify-between px-5 py-3 bg-slate-50 hover:bg-slate-100 gap-3">
        {/* Phase 23.6 -- selection checkbox.  Click is isolated so it
            doesn't also toggle the card's open state.  We render it as a
            non-button label so the parent expand/collapse still works
            when the user clicks anywhere else on the header. */}
        {onSelectToggle && (
          <label
            className="flex items-center cursor-pointer select-none"
            onClick={(e) => e.stopPropagation()}
            title={selected ? 'Deselect this card' : 'Select for bulk scoring'}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={onSelectToggle}
              onClick={(e) => e.stopPropagation()}
            />
          </label>
        )}
        <button className="flex-1 text-left flex items-center justify-between gap-2" onClick={onToggle}>
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
      </div>

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
        {/* Phase 23.3: dependency hand-offs for non-task submissions
            (task templates render them inline beside the task row above). */}
        {sub.templateType !== 'task' && Array.isArray(sub.dependencies) && sub.dependencies.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">
              Dependent Tasks ({sub.dependencies.length})
            </div>
            {sub.dependencies.map((d) => <DependencyTransferCard key={d._id} dep={d} />)}
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
  // Phase 40.3 -- helper used for every percentage display in this
  // panel.  Calculation is unchanged; this is a pure display formatter.
  // Rule: at most 2 decimals, never more (e.g. 84.123456 → 84.12,
  // 92 → 92.00, 13.1 → 13.10).
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 100 : 0);
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
      {/* Rate strip -- every rate now goes through fmtPct2 so a long
          stored decimal like 84.123456789 renders as 84.12%. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <KPI label="Connection Rate"        value={`${fmtPct2(n('connectionRate')        || pct(n('attendedCalls'), dialed))}%`} accent="blue" />
        <KPI label="Conversion Rate"        value={`${fmtPct2(n('conversionRate')        || pct(n('totalConversions'), n('attendedCalls')))}%`} accent="green" />
        <KPI label="Pending Rate"           value={`${fmtPct2(n('pendingRate')           || pct(n('totalPending'), n('assignedCalls')))}%`}   accent="red" />
        <KPI label="Call Completion Rate"   value={`${fmtPct2(n('callCompletionRate')    || pct(n('totalCallsCompleted'), n('assignedCalls')))}%`} accent="green" />
      </div>
    </div>
  );
}

/* =====================================================================
 * Phase 40.3 — Display-only decimal formatter
 *
 * Caps any numeric value to at most 2 decimal places when rendered.
 * Whole numbers render as integers (with two trailing zeros to keep
 * column alignment consistent with the spec example "13.1 → 13.10").
 * This is pure formatting -- nothing about how the value was
 * calculated or stored changes.
 *
 *   84.123456789  → "84.12"
 *   91.999999     → "92.00"
 *   13.1          → "13.10"
 *   13            → "13.00"
 *   null / NaN    → "0.00"
 * ===================================================================== */
function fmtPct2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
                {/* Phase 40.3 -- 2-decimal display formatting on all
                    computed values (quantity / sales / NBV). */}
                {sales.map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-1.5">{r.productName || '—'} <span className="text-[11px] text-slate-400">({r.productUnit || ''})</span></td>
                    <td className="px-3 py-1.5 text-right">{fmtPct2(Number(r.quantity ?? r.quantityValue) || 0)}</td>
                    <td className="px-3 py-1.5 text-right text-green-700 font-semibold">{fmtPct2(Number(r.salesValue) || 0)}</td>
                    <td className="px-3 py-1.5 text-right">{fmtPct2(Number(r.nbvValue) || 0)}</td>
                  </tr>
                ))}
                <tr className="bg-slate-50 border-t-2 border-slate-200 font-semibold">
                  <td className="px-3 py-1.5 text-right">Total</td>
                  <td className="px-3 py-1.5 text-right">{fmtPct2(totQty)}</td>
                  <td className="px-3 py-1.5 text-right text-green-700">{fmtPct2(totSales)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtPct2(totNbv)}</td>
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
  /* Phase 27 -- defensive de-duplication.
   *
   * Historical submissions where the employee saved a draft and then
   * submitted carry duplicate addedByEmployee rows: a "Not filled"
   * (pending_submit) row left over from the draft AND a fresh "Done"
   * row pushed by the submit handler.  The backend fix prevents new
   * duplicates from being written, but existing submissions still have
   * both rows on disk.  Collapse them here on render by keeping, for
   * each addedByEmployee title, the row with the most "real" status:
   *
   *   done > ongoing > pending > work_not_available > pending_submit
   *
   * System-generated rows (addedByEmployee=false) are never affected --
   * they have unique task ids and stable status semantics.
   */
  const PRIORITY = { done: 5, ongoing: 4, pending: 3, work_not_available: 2, pending_submit: 1 };
  const rawTasks = sub.tasks || [];
  const sysTasks = rawTasks.filter((t) => !t.addedByEmployee);
  const addedByTitle = new Map();
  for (const t of rawTasks) {
    if (!t.addedByEmployee) continue;
    const key = String(t.title || '').trim().toLowerCase();
    const prev = addedByTitle.get(key);
    if (!prev || (PRIORITY[t.status] || 0) > (PRIORITY[prev.status] || 0)) {
      addedByTitle.set(key, t);
    }
  }
  const tasks = [...sysTasks, ...addedByTitle.values()];
  const done    = tasks.filter((t) => t.status === 'done').length;
  const ongoing = tasks.filter((t) => t.status === 'ongoing').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const wna     = tasks.filter((t) => t.status === 'work_not_available').length;

  // Phase 23.3: index dependent-task hand-offs by source task id so the
  // per-row editor can render Original / Transferred-to / Date / Status
  // inline under the task it came from.  Server-attached on the grouped
  // review feed by dailyReviewController._attachDependencies.
  const depsByTask = new Map();
  const unmatchedDeps = [];
  for (const d of sub.dependencies || []) {
    if (d.sourceTaskId) depsByTask.set(String(d.sourceTaskId), [...(depsByTask.get(String(d.sourceTaskId)) || []), d]);
    else unmatchedDeps.push(d);
  }

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
          <TaskRowEditor
            key={t._id}
            submissionId={sub._id}
            task={t}
            dependencies={depsByTask.get(String(t._id)) || depsByTask.get(String(t.taskId)) || []}
            onReload={onReload}
          />
        ))}
      </div>
      {unmatchedDeps.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Dependent Tasks (other)</div>
          {unmatchedDeps.map((d) => <DependencyTransferCard key={d._id} dep={d} />)}
        </div>
      )}
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

function TaskRowEditor({ submissionId, task, dependencies = [], onReload }) {
  const [status, setStatus] = useState(task.status);
  const [reason, setReason] = useState(task.pendingReason || '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  // Phase 23.7 -- marks editor for employee-added extra work rows.
  // System-generated rows show task.points read-only as before; only
  // rows where `addedByEmployee=true` expose this editor.
  const [marks, setMarks] = useState(String(task.awardedMarks ?? 0));
  const [marksEditing, setMarksEditing] = useState(false);
  const [marksBusy, setMarksBusy] = useState(false);
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

  // Phase 23.7 -- save handler for the marks editor.
  const saveMarks = async () => {
    const n = Number(marks);
    if (!Number.isFinite(n) || n < 0) {
      toast.error('Marks must be a number >= 0.');
      return;
    }
    setMarksBusy(true);
    try {
      await api.post('/daily-review/task-marks', {
        submissionId, taskId: task._id, awardedMarks: n,
      });
      toast.success('Marks updated');
      setMarksEditing(false);
      onReload?.();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setMarksBusy(false); }
  };

  return (
    <div className={`rounded border ${meta.cls} px-3 py-1.5`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">{meta.symbol}</span>
          <div className="min-w-0">
            <div className="font-medium text-slate-800 truncate">
              {task.title}
              {task.addedByEmployee && <span className="ml-2 badge text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-200">Extra work</span>}
            </div>
            {/* System rows show their template points; employee-added
                rows show "Awarded: N pts" (read-only label, edited via
                the inline editor on the right). */}
            {task.addedByEmployee ? (
              <div className="text-[11px] text-slate-500">Awarded: {Number(task.awardedMarks) || 0} pts · employee-added</div>
            ) : (
              task.points > 0 && (
                <div className="text-[11px] text-slate-500">{task.points} pts</div>
              )
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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
          {/* Phase 23.7 -- extra-work marks editor.  Only employee-added
              rows show the "Marks" control; HR-defined rows continue to
              earn from their template `points` exactly as before. */}
          {task.addedByEmployee && (
            !marksEditing ? (
              <button className="btn-ghost !py-0.5 !text-xs"
                onClick={() => { setMarks(String(task.awardedMarks ?? 0)); setMarksEditing(true); }}>
                {Number(task.awardedMarks) > 0 ? 'Edit marks' : 'Assign marks'}
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  className="input !py-1 !text-xs max-w-[80px]"
                  value={marks}
                  onChange={(e) => setMarks(e.target.value)}
                  placeholder="pts"
                />
                <button className="btn-primary !py-0.5 !text-xs" disabled={marksBusy} onClick={saveMarks}>
                  {marksBusy ? 'Saving…' : 'Save'}
                </button>
                <button className="btn-ghost !py-0.5 !text-xs" onClick={() => { setMarksEditing(false); setMarks(String(task.awardedMarks ?? 0)); }}>
                  Cancel
                </button>
              </div>
            )
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
      {/* Phase 23.3: dependent-task transfer cards for this row */}
      {dependencies.length > 0 && (
        <div className="mt-2 space-y-1">
          {dependencies.map((d) => <DependencyTransferCard key={d._id} dep={d} />)}
        </div>
      )}
    </div>
  );
}

/* ===================================================================== */
/* Phase 23.3 — Dependent task transfer card                              */
/*                                                                       */
/* Renders one DependencyTask hand-off attached to a submission:         */
/*   Original task name (if no per-row context already shows it)         */
/*   Shared By → Assigned To                                              */
/*   Transferred on  +  (Resolved on / current status)                    */
/*   Remark (if any)                                                      */
/*                                                                       */
/* Read-only.  No buttons -- HR / HOD already manage these from the      */
/* Dependencies page; this card just makes the trail visible inside the   */
/* day's review so the reviewer doesn't have to context-switch.           */
/* ===================================================================== */
function DependencyTransferCard({ dep }) {
  const status = dep.currentStatus || 'open';
  const meta = {
    open:        { label: 'Pending',     cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    in_progress: { label: 'In Progress', cls: 'bg-blue-50  text-blue-700  border-blue-200' },
    resolved:    { label: 'Resolved',    cls: 'bg-green-50 text-green-700 border-green-200' },
  }[status] || { label: status, cls: 'bg-slate-50 text-slate-700 border-slate-200' };
  const fmt = (d) => d ? new Date(d).toLocaleString() : '';
  return (
    <div className="rounded border border-dashed border-indigo-200 bg-indigo-50/40 dark:bg-brand-500/10 dark:border-brand-500/30 px-2.5 py-1.5 text-[12px]">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="font-semibold text-slate-800 dark:text-slate-100 truncate">
          {dep.originalTaskName || '(dependent task)'}
        </div>
        <span className={`badge text-[10px] border whitespace-nowrap ${meta.cls}`}>{meta.label}</span>
      </div>
      <div className="text-slate-700 dark:text-slate-300 mt-0.5">
        Shared by <b>{dep.assignedByName || '—'}</b>
        {dep.assignedByEmployeeId ? <span className="text-slate-500"> ({dep.assignedByEmployeeId})</span> : null}
        <span className="text-slate-500"> → </span>
        Assigned to <b>{dep.assignedToName || '—'}</b>
        {dep.assignedToEmployeeId ? <span className="text-slate-500"> ({dep.assignedToEmployeeId})</span> : null}
      </div>
      <div className="text-slate-600 dark:text-slate-400 mt-0.5">
        Transferred {fmt(dep.transferredAt)}
        {dep.resolvedAt && <> · Resolved {fmt(dep.resolvedAt)}</>}
        {dep.resolutionHours != null && <> · {dep.resolutionHours}h turnaround</>}
      </div>
      {dep.remark && (
        <div className="text-slate-600 dark:text-slate-400 mt-0.5">
          <span className="font-semibold">Remark:</span> {dep.remark}
        </div>
      )}
    </div>
  );
}

/* ===================================================================== */
/* Phase 23.6 — Bulk Discipline + Innovation entry                        */
/*                                                                       */
/* Modal launched from the toolbar above the card list.  Calls           */
/* POST /api/daily-review/bulk-finalize ONCE with every (employee, date) */
/* pair the user selected; the backend loops the existing per-day        */
/* pipeline so review history / audit / notifications all fire exactly  */
/* the same as a single finalise (just N times in a row).                */
/* ===================================================================== */
function BulkScoreModal({ cards, onClose, onDone }) {
  const [d, setD]     = useState('');
  const [maxD, setMaxD] = useState('3');
  const [i, setI]     = useState('');
  const [maxI, setMaxI] = useState('2');
  const [dn, setDn]   = useState('');
  const [iFb, setIFb] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async () => {
    if (cards.length === 0) return;
    setBusy(true);
    try {
      const { data } = await api.post('/daily-review/bulk-finalize', {
        items: cards.map((c) => ({
          employeeId: String(c.employee._id),
          date: new Date(c.date).toISOString().slice(0, 10),
        })),
        disciplineMarks: Number(d) || 0,
        maxDisciplineMarks: Number(maxD) || 3,
        ideaMarks: Number(i) || 0,
        maxIdeaMarks: Number(maxI) || 2,
        disciplineNote: dn,
        ideaFeedback: iFb,
      });
      const okCount = data.ok || 0;
      const failed = (data.failed || []).length;
      if (failed === 0) toast.success(`Bulk-finalised ${okCount} day${okCount === 1 ? '' : 's'}`);
      else if (okCount === 0) toast.error(`All ${failed} item(s) failed: ${data.failed[0]?.error || ''}`);
      else toast.error(`Saved ${okCount}, ${failed} failed: ${data.failed[0]?.error || ''}`);
      onDone();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl max-w-xl w-full m-4 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Bulk Assign Scores</h2>
          <p className="text-sm text-slate-500">Applying the same Discipline + Innovation marks to <b>{cards.length}</b> selected day-card(s).</p>
        </div>
        <div className="max-h-40 overflow-y-auto rounded border border-slate-200 dark:border-slate-700 text-[12px]">
          {cards.map((c, idx) => (
            <div key={idx} className="px-3 py-1.5 border-b border-slate-100 dark:border-slate-700 last:border-b-0 flex items-center justify-between">
              <span className="font-medium text-slate-800 dark:text-slate-100 truncate">
                {c.employee.name} <span className="text-slate-400 font-normal">({c.employee.employeeId})</span>
              </span>
              <span className="text-slate-500">{fmtDate(c.date)}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div>
            <label className="label">Discipline</label>
            <div className="flex items-center gap-2">
              <input className="input" type="number" min="0" value={d} onChange={(e) => setD(e.target.value)} />
              <span className="text-slate-400">/</span>
              <input className="input max-w-[70px]" type="number" min="0" value={maxD} onChange={(e) => setMaxD(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Innovation</label>
            <div className="flex items-center gap-2">
              <input className="input" type="number" min="0" value={i} onChange={(e) => setI(e.target.value)} />
              <span className="text-slate-400">/</span>
              <input className="input max-w-[70px]" type="number" min="0" value={maxI} onChange={(e) => setMaxI(e.target.value)} />
            </div>
          </div>
          <div className="md:col-span-2">
            <label className="label">Discipline Note (optional)</label>
            <input className="input" value={dn} onChange={(e) => setDn(e.target.value)} />
          </div>
          <div className="md:col-span-4">
            <label className="label">Idea Feedback (optional)</label>
            <textarea className="input" rows={2} value={iFb} onChange={(e) => setIFb(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || cards.length === 0}>
            {busy ? 'Applying…' : `Apply to ${cards.length} day${cards.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
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
/* =====================================================================
 * Phase 29 — Attendance Reviews section
 *
 * Companion to the Submission Reviews list above.  Lists every
 * attendance_review-mode employee in scope for the selected date and
 * lets HR / Super Admin act on each one with Approve Present / Mark
 * Absent / Mark Half Day Paid|Unpaid / Mark Leave Paid|Unpaid.  Each
 * action writes a manual Attendance record so the existing
 * deriveAttendance + salary pipelines pick up the resolution.
 * ===================================================================== */
function AttendanceReviewsSection({ date }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/attendance-confirmation/queue', { params: { date } });
      setRows(Array.isArray(data) ? data : []);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);

  const act = async (row, action) => {
    if (!row.confirmation) {
      toast.error('Employee has not confirmed attendance for this day yet.');
      return;
    }
    setBusyId(String(row.confirmation._id));
    try {
      await api.post(`/attendance-confirmation/${row.confirmation._id}/review`, { action });
      toast.success('Attendance reviewed');
      await load();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusyId(''); }
  };

  if (loading) return null; // silently hide while loading; the section is secondary
  if (rows.length === 0) return null;

  const pending = rows.filter((r) => !r.confirmation || r.confirmation.status === 'pending').length;
  const reviewed = rows.length - pending;

  const STATUS_META = {
    pending:              { label: 'Awaiting Review', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    approved_present:     { label: 'Approved Present', cls: 'bg-green-50 text-green-700 border-green-200' },
    marked_absent:        { label: 'Marked Absent',    cls: 'bg-red-50   text-red-700   border-red-200' },
    marked_half_paid:     { label: 'Half Paid',        cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    marked_half_unpaid:   { label: 'Half Unpaid',      cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    marked_paid_leave:    { label: 'Paid Leave',       cls: 'bg-blue-50  text-blue-700  border-blue-200' },
    marked_unpaid_leave:  { label: 'Unpaid Leave',     cls: 'bg-blue-50  text-blue-700  border-blue-200' },
  };

  return (
    <div className="space-y-3 pt-2">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Attendance Reviews</h2>
          <p className="text-xs text-slate-500">Employees on Attendance Review mode for {fmtDate(date)}.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="badge bg-amber-50 text-amber-700">{pending} pending</span>
          <span className="badge-green">{reviewed} resolved</span>
        </div>
      </div>
      <div className="space-y-2">
        {rows.map((row) => {
          const meta = row.confirmation ? STATUS_META[row.confirmation.status] : null;
          const noConfirmation = !row.confirmation;
          const isPending = row.confirmation?.status === 'pending';
          return (
            <div key={String(row.employee._id)} className={`card overflow-hidden ${isPending ? 'ring-1 ring-amber-200' : ''}`}>
              <div className="px-5 py-3 flex items-center justify-between gap-3 flex-wrap bg-slate-50 dark:bg-slate-800/40">
                <div className="min-w-0">
                  <div className="font-semibold text-slate-800 dark:text-slate-100">
                    {row.employee.name} <span className="text-slate-400 font-normal">({row.employee.employeeId})</span>
                  </div>
                  <div className="text-[12px] text-slate-500">
                    {row.employee.department || '—'}
                    {row.confirmation?.confirmedAt && <> · Confirmed {new Date(row.confirmation.confirmedAt).toLocaleString()}</>}
                    {row.confirmation?.reviewedAt && <> · Reviewed {new Date(row.confirmation.reviewedAt).toLocaleString()} {row.confirmation.reviewedBy ? `by ${row.confirmation.reviewedBy.name}` : ''}</>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {meta && <span className={`badge text-[11px] border ${meta.cls}`}>{meta.label}</span>}
                  {noConfirmation && <span className="badge text-[11px] border bg-slate-50 text-slate-600 border-slate-200">Not Confirmed</span>}
                </div>
              </div>
              {isPending && (
                <div className="px-5 py-3 flex flex-wrap gap-2 border-t border-slate-100 dark:border-slate-700">
                  <button className="btn-primary !py-1 !text-xs" disabled={busyId === String(row.confirmation._id)} onClick={() => act(row, 'approve_present')}>Approve Present</button>
                  <button className="btn-secondary !py-1 !text-xs" disabled={busyId === String(row.confirmation._id)} onClick={() => act(row, 'mark_absent')}>Mark Absent</button>
                  <button className="btn-ghost !py-1 !text-xs" disabled={busyId === String(row.confirmation._id)} onClick={() => act(row, 'mark_half_paid')}>Half Day · Paid</button>
                  <button className="btn-ghost !py-1 !text-xs" disabled={busyId === String(row.confirmation._id)} onClick={() => act(row, 'mark_half_unpaid')}>Half Day · Unpaid</button>
                  <button className="btn-ghost !py-1 !text-xs" disabled={busyId === String(row.confirmation._id)} onClick={() => act(row, 'mark_paid_leave')}>Leave · Paid</button>
                  <button className="btn-ghost !py-1 !text-xs" disabled={busyId === String(row.confirmation._id)} onClick={() => act(row, 'mark_unpaid_leave')}>Leave · Unpaid</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
