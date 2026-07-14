import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import SheetReviewGrid from '../../components/SheetReviewGrid.jsx';
import ScheduleTag from '../../components/ScheduleTag.jsx';
import { RowStatusBadge, DependencyBadge, DependencyLine, depMap, matchRowFilter, RowStatusFilter, TaskStatusTable, SheetDependencyDetails } from '../../components/RowStatus.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { errMsg } from '../../utils/helpers';

/**
 * HOD - Submission Reviews
 *
 * Department-scoped review queue.  What a HOD can do is gated by the
 * permissions HR granted (canReview / canRemark / canMarks / canRecommend).
 * Marks entered are RECOMMENDATIONS that prefill HR's screen - HR remains
 * the final authority.  A HOD can NEVER touch innovation
 * marks; those are HR-only.
 *
 * Review drafts are held in the parent keyed by submission id, so collapsing
 * / reopening a row (or changing filters) does not lose unsaved edits.
 */
const STAGE = {
  under_hod: { text: 'Awaiting review', cls: 'badge-amber' },
  hod_reviewed: { text: 'Reviewed by you', cls: 'badge-blue' },
  finalized: { text: 'Finalized by HR', cls: 'badge-green' },
};

// Build the initial editing draft for a submission.  Marks start EMPTY
// unless the HOD already submitted marks for this row.
function buildDraft(s) {
  const marksGiven = !!s.hodReview?.marksGiven;
  const sheetMarks = {};
  ((s.sheet && s.sheet.scores) || []).forEach((sc) => {
    sheetMarks[sc.key] = {
      marksAwarded: marksGiven && sc.marksAwarded != null ? sc.marksAwarded : '',
      remark: sc.remark || '',
    };
  });
  const fieldMarks = {};
  (s.excelResponses || []).forEach((r) => {
    if (r.markEligible) fieldMarks[r.fieldName] = marksGiven && r.marksAwarded != null ? r.marksAwarded : '';
  });
  return {
    remarks: s.hodReview?.remarks || '',
    recommend: s.hodReview?.recommend || '',
    sheetMarks,
    fieldMarks,
  };
}

export default function HODReviews() {
  const today = new Date().toISOString().substring(0, 10);
  const [date, setDate] = useState(today);
  const [status, setStatus] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [drafts, setDrafts] = useState({}); // { [submissionId]: draft }
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/submissions/hod/reviews', { params: { date, status } });
      setItems(data);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date, status]);

  const toggle = (s) => {
    setOpenId((id) => (id === s._id ? null : s._id));
    // Seed a draft the first time a row is opened; never overwrite edits.
    setDrafts((d) => (d[s._id] ? d : { ...d, [s._id]: buildDraft(s) }));
  };
  const setDraft = (id, patch) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const clearDraft = (id) =>
    setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });

  const pending = items.filter((i) => i.currentReviewStage === 'under_hod').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Team Submission Reviews</h1>
          <p className="text-sm text-slate-500">Review your department's reports. HR finalises after you.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge-amber">{pending} awaiting</span>
          <input className="input max-w-[170px]" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <select className="input max-w-[180px]" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All stages</option>
            <option value="under_hod">Awaiting my review</option>
            <option value="hod_reviewed">Reviewed by me</option>
            <option value="finalized">Finalized by HR</option>
          </select>
        </div>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          items.length === 0 ? <EmptyState title="Nothing to review" subtitle="No department submissions for this date." /> : (
            <table className="table">
              <thead>
                <tr>
                  <th className="w-10"></th>
                  <th>Employee</th><th>Template</th><th>Submitted</th><th>Stage</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <Row key={s._id} s={s} expanded={openId === s._id}
                    onToggle={() => toggle(s)}
                    draft={drafts[s._id]}
                    setDraft={(patch) => setDraft(s._id, patch)}
                    onSaved={() => { clearDraft(s._id); load(); }} />
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}

function Row({ s, expanded, onToggle, draft, setDraft, onSaved }) {
  const st = STAGE[s.currentReviewStage] || STAGE.under_hod;
  return (
    <>
      <tr className={expanded ? 'bg-slate-50' : ''}>
        <td>
          <button onClick={onToggle} className="p-1 hover:bg-slate-100 rounded">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </td>
        <td className="font-medium">{s.employee?.name}<div className="text-[11px] text-slate-500">{s.employee?.employeeId}</div></td>
        <td>{s.template?.title}<div className="mt-0.5"><ScheduleTag frequency={s.frequency} label={s.scheduleLabel} /></div></td>
        <td className="text-xs">{s.submittedAt ? new Date(s.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'}</td>
        <td><span className={st.cls}>{st.text}</span></td>
      </tr>
      {expanded && (
        <tr><td colSpan="5" className="bg-slate-50">
          <Detail s={s} draft={draft || buildDraft(s)} setDraft={setDraft} onSaved={onSaved} />
        </td></tr>
      )}
    </>
  );
}

function Detail({ s, draft, setDraft, onSaved }) {
  const { user } = useAuth();
  const perms = user?.hodPermissions || {};
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const isSheet = s.templateType === 'sheet';
  const isExcel = s.templateType === 'excel';
  const deps = depMap(s.dependencies);
  const [rowFilter, setRowFilter] = useState('all');

  const setSheetMark = (key, patch) =>
    setDraft({ sheetMarks: { ...draft.sheetMarks, [key]: { ...draft.sheetMarks[key], ...patch } } });
  const setFieldMark = (name, val) =>
    setDraft({ fieldMarks: { ...draft.fieldMarks, [name]: val } });

  const save = async () => {
    setBusy(true);
    try {
      const payload = {};
      if (perms.canRemark) payload.remarks = draft.remarks;
      if (perms.canRecommend) payload.recommend = draft.recommend;
      if (perms.canMarks) {
        if (isSheet) {
          payload.scores = ((s.sheet && s.sheet.scores) || []).map((sc) => ({
            key: sc.key,
            marksAwarded: Number(draft.sheetMarks[sc.key]?.marksAwarded) || 0,
            remark: draft.sheetMarks[sc.key]?.remark || '',
          }));
        } else if (isExcel) {
          payload.excelResponses = (s.excelResponses || [])
            .filter((r) => r.markEligible)
            .map((r) => ({ fieldName: r.fieldName, marksAwarded: Number(draft.fieldMarks[r.fieldName]) || 0 }));
        }
        // NOTE: no innovation marks - HR-only.
      }
      await api.post(`/submissions/${s._id}/hod-review`, payload);
      toast.success('Review submitted to HR');
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const canDoAnything = perms.canReview;

  return (
    <div className="p-5 space-y-4 border-t border-slate-200">
      {!canDoAnything && (
        <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
          You don't have review permissions for submissions. Contact HR.
        </div>
      )}

      {/* Spreadsheet */}
      {isSheet && s.sheet && (
        <div className="space-y-2">
          <div className="text-sm font-semibold text-slate-800">Report</div>
          <div className="text-[11px] text-slate-500">
            {perms.canMarks ? 'Enter recommended marks in the highlighted areas.' : 'View only — you cannot give marks.'}
          </div>
          <SheetReviewGrid
            sheet={s.sheet}
            marks={draft.sheetMarks}
            onMark={(key, patch) => setSheetMark(key, patch)}
            readOnly={!perms.canMarks}
            deps={Object.fromEntries((s.dependencies || []).map((d) => [d.sourceTaskId, d]))}
          />
          <SheetDependencyDetails sheet={s.sheet} deps={deps} />
        </div>
      )}

      {/* Excel */}
      {isExcel && (
        <div className="overflow-x-auto">
          <div className="flex justify-end mb-2"><RowStatusFilter value={rowFilter} onChange={setRowFilter} /></div>
          <table className="table">
            <thead><tr><th>Field</th><th>Value</th><th>Status</th><th>Dependency</th><th>Marks (recommend)</th></tr></thead>
            <tbody>
              {(s.excelResponses || []).filter((r) => matchRowFilter(r.rowStatus, deps.get(r.fieldName), rowFilter)).map((r) => {
                const dep = deps.get(r.fieldName);
                return (
                  <tr key={r._id || r.fieldName}>
                    <td className="font-medium">{r.fieldName}</td>
                    <td className="whitespace-pre-wrap text-slate-700">{String(r.value ?? '') || <span className="text-slate-400">—</span>}</td>
                    <td>
                      {r.rowStatus ? <RowStatusBadge status={r.rowStatus} /> : <span className="text-slate-300">—</span>}
                      <div className="mt-1"><DependencyBadge dep={dep} /></div>
                    </td>
                    <td className="align-top">
                      {dep ? <DependencyLine dep={dep} /> : (r.rowStatus === 'pending' && r.pendingReason ? <span className="text-[11px] text-slate-500">Reason: {r.pendingReason}</span> : <span className="text-slate-300">—</span>)}
                    </td>
                    <td>
                      {r.markEligible ? (
                        <div className="flex items-center gap-1">
                          <input className="input w-24" type="number" min="0" max={r.maxMarks}
                            disabled={!perms.canMarks}
                            placeholder="Marks"
                            value={draft.fieldMarks[r.fieldName] ?? ''}
                            onChange={(e) => setFieldMark(r.fieldName, e.target.value === '' ? '' : Number(e.target.value))} />
                          <span className="text-xs text-slate-500">/ {r.maxMarks}</span>
                        </div>
                      ) : <span className="text-slate-400 text-xs">n/a</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Task template - unified status table with inline dependency info */}
      {!isSheet && !isExcel && (
        <>
          <TaskStatusTable tasks={s.tasks} deps={deps} rowFilter={rowFilter} setRowFilter={setRowFilter} />
          <div className="text-[11px] text-slate-500">
            Innovation marks are decided by HR and are not shown here.
          </div>
        </>
      )}

      {/* Self note + idea (context) */}
      {(s.selfNote || s.idea) && (
        <div className="grid md:grid-cols-2 gap-3">
          {s.selfNote && <div className="bg-white border border-slate-200 rounded-lg p-3 text-sm"><div className="text-[11px] uppercase text-slate-500 mb-1">Self note</div>{s.selfNote}</div>}
          {s.idea && <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm"><div className="text-[11px] uppercase text-blue-700 mb-1">Idea</div>{s.idea}</div>}
        </div>
      )}

      {/* Remarks + recommendation + save */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        {perms.canRemark && (
          <div>
            <label className="label">Remarks to HR</label>
            <textarea className="input" rows={2} value={draft.remarks} onChange={(e) => setDraft({ remarks: e.target.value })} placeholder="Your observations for HR..." />
          </div>
        )}
        <div className="flex items-center justify-between flex-wrap gap-2">
          {perms.canRecommend ? (
            <div className="flex items-center gap-2">
              <label className="label !mb-0">Recommendation</label>
              <select className="input max-w-[200px]" value={draft.recommend} onChange={(e) => setDraft({ recommend: e.target.value })}>
                <option value="">No recommendation</option>
                <option value="approve">Recommend approval</option>
                <option value="needs_changes">Needs changes</option>
              </select>
            </div>
          ) : <span />}
          <button className="btn-primary" disabled={busy || !canDoAnything} onClick={save}>
            {busy ? 'Saving...' : (s.currentReviewStage === 'hod_reviewed' ? 'Update Review' : 'Submit Review to HR')}
          </button>
        </div>
      </div>
    </div>
  );
}

const TaskList = ({ title, cls, tasks = [], showReason }) => (
  <div className="bg-white rounded-xl border border-slate-200 p-4">
    <div className="flex items-center justify-between mb-2">
      <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">{title}</div>
      <span className={cls}>{tasks.length}</span>
    </div>
    {tasks.length === 0
      ? <div className="text-xs text-slate-400 italic">None.</div>
      : <ul className="space-y-1.5">
          {tasks.map((t) => (
            <li key={t._id} className="text-sm text-slate-700">
              {t.title}
              {showReason && t.pendingReason && <div className="text-[11px] text-slate-500">Reason: {t.pendingReason}</div>}
            </li>
          ))}
        </ul>}
  </div>
);
