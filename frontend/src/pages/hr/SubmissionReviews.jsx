import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import SheetReviewGrid from '../../components/SheetReviewGrid.jsx';
import ScheduleTag from '../../components/ScheduleTag.jsx';
import { RowStatusBadge, DependencyBadge, DependencyLine, depMap, matchRowFilter, RowStatusFilter, TaskStatusTable, SheetDependencyDetails } from '../../components/RowStatus.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtDate } from '../../utils/helpers';

/**
 * HR Submission Reviews
 *
 * Lists every submitted record for a given day, lets HR expand each row to
 * see the full task breakdown (done / pending / N-A), self-observation, the
 * employee-submitted idea, then attach Discipline + Innovation marks and
 * save the review. Saving recomputes the final percentage on the server.
 */
const STAGE_LABEL = {
  submitted: { text: 'Submitted', cls: 'badge-gray' },
  under_hod: { text: 'Under HOD', cls: 'badge-amber' },
  hod_reviewed: { text: 'HOD Reviewed', cls: 'badge-blue' },
  under_hr: { text: 'Under HR', cls: 'badge-amber' },
  under_super_admin: { text: 'Waiting for Super Admin Review', cls: 'badge bg-purple-50 text-purple-700' },
  finalized: { text: 'Finalized', cls: 'badge-green' },
};
const StageBadge = ({ stage }) => {
  const s = STAGE_LABEL[stage] || STAGE_LABEL.submitted;
  return <span className={s.cls}>{s.text}</span>;
};

export default function SubmissionReviews() {
  const today = new Date().toISOString().substring(0, 10);
  const [date, setDate] = useState(today);
  const [status, setStatus] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [drafts, setDrafts] = useState({}); // { [submissionId]: draft } - survives collapse/filter
  const toast = useToast();

  const toggle = (s) => {
    setOpenId((id) => (id === s._id ? null : s._id));
    setDrafts((d) => (d[s._id] ? d : { ...d, [s._id]: buildHrDraft(s) }));
  };
  const setDraft = (id, patch) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const clearDraft = (id) => setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/submissions/reviews', { params: { date, status } });
      setItems(data);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date, status]);

  const pendingCount = items.filter((i) => i.reviewStatus === 'pending').length;
  const reviewedCount = items.filter((i) => i.reviewStatus === 'reviewed').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Submission Reviews</h1>
          <p className="text-sm text-slate-500">
            Evaluate each daily submission and award discipline + innovation marks.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge-amber">{pendingCount} pending</span>
          <span className="badge-green">{reviewedCount} reviewed</span>
          <input className="input max-w-[170px]" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <select className="input max-w-[170px]" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="pending">Pending Review</option>
            <option value="reviewed">Reviewed</option>
          </select>
        </div>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          items.length === 0 ? <EmptyState title="No submissions for this date" /> : (
            <table className="table">
              <thead>
                <tr>
                  <th className="w-10"></th>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Template</th>
                  <th>Submitted</th>
                  <th>Work %</th>
                  <th>Pending</th>
                  <th>Pendency</th>
                  <th>Stage</th>
                  <th>Final %</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <ReviewRow
                    key={s._id}
                    submission={s}
                    expanded={openId === s._id}
                    onToggle={() => toggle(s)}
                    draft={drafts[s._id]}
                    setDraft={(patch) => setDraft(s._id, patch)}
                    onSaved={() => { clearDraft(s._id); load(); }}
                  />
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}

/**
 * Build the HR editing draft for a submission.  Mark fields start EMPTY
 * (so inputs show a placeholder, never a preset 0) unless the submission
 * was already reviewed, or a HOD prefilled report marks.
 */
function buildHrDraft(s) {
  const reviewed = s.reviewStatus === 'reviewed';
  const prefillReport = reviewed || !!s.hodReview?.marksGiven;
  const fieldMarks = {};
  (s.excelResponses || []).forEach((r) => {
    if (r.markEligible) fieldMarks[r.fieldName] = prefillReport && r.marksAwarded != null ? r.marksAwarded : '';
  });
  const sheetMarks = {};
  ((s.sheet && s.sheet.scores) || []).forEach((sc) => {
    sheetMarks[sc.key] = {
      marksAwarded: prefillReport && sc.marksAwarded != null ? sc.marksAwarded : '',
      remark: sc.remark || '',
    };
  });
  // Employee-added tasks (task templates only): seed each row's
  // awardedMarks from the stored value when the submission has already
  // been reviewed, otherwise leave blank so HR enters fresh marks.
  const taskMarks = {};
  (s.tasks || []).forEach((t) => {
    if (t.addedByEmployee) {
      taskMarks[String(t._id)] = reviewed && t.awardedMarks != null ? t.awardedMarks : '';
    }
  });
  return {
    disciplineMarks: reviewed ? (s.disciplineMarks ?? '') : '',
    maxDisciplineMarks: s.maxDisciplineMarks ?? 3,
    disciplineNote: s.disciplineNote || '',
    ideaMarks: reviewed ? (s.ideaMarks ?? '') : '',
    maxIdeaMarks: s.maxIdeaMarks ?? 2,
    ideaFeedback: s.ideaFeedback || '',
    fieldMarks,
    sheetMarks,
    taskMarks,
  };
}

function ReviewRow({ submission: s, expanded, onToggle, draft, setDraft, onSaved }) {
  const workPct = s.workTotalPoints > 0 ? (s.workEarnedPoints / s.workTotalPoints) * 100 : 0;
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
        <td>{s.employee?.department?.name || '-'}</td>
        <td>{s.template?.title}<div className="mt-0.5"><ScheduleTag frequency={s.frequency} label={s.scheduleLabel} /></div></td>
        <td className="text-xs">{s.submittedAt ? new Date(s.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'}</td>
        <td>{workPct.toFixed(0)}%<div className="text-[11px] text-slate-500">{s.workEarnedPoints}/{s.workTotalPoints}</div></td>
        <td>{s.pendingTasks?.length || 0}</td>
        <td>{s.backlogCount}</td>
        <td><StageBadge stage={s.currentReviewStage} /></td>
        <td className="font-semibold">{s.reviewStatus === 'reviewed' ? `${s.completionPercentage.toFixed(0)}%` : '-'}</td>
        <td>
          {s.reviewStatus === 'reviewed'
            ? <span className="badge-green">Reviewed</span>
            : <span className="badge-amber">Pending Review</span>}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan="11" className="bg-slate-50">
            <ReviewDetail submission={s} draft={draft || buildHrDraft(s)} setDraft={setDraft} onSaved={onSaved} />
          </td>
        </tr>
      )}
    </>
  );
}

function ReviewDetail({ submission: s, draft, setDraft, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [rowFilter, setRowFilter] = useState('all');
  const toast = useToast();

  const isExcel = s.templateType === 'excel';
  const isSheet = s.templateType === 'sheet';
  // Dependency data keyed by source row id (task _id / field name / score key).
  const deps = depMap(s.dependencies);

  // All editing state lives in the parent-held `draft` so it survives
  // collapse / reopen / filter changes until save.
  const {
    disciplineMarks, maxDisciplineMarks, disciplineNote,
    ideaMarks, maxIdeaMarks, ideaFeedback, fieldMarks, sheetMarks, taskMarks,
  } = draft;
  const setFieldMarks = (name, val) => setDraft({ fieldMarks: { ...fieldMarks, [name]: val } });
  const setSheetMark = (key, patch) => setDraft({ sheetMarks: { ...sheetMarks, [key]: { ...sheetMarks[key], ...patch } } });
  const setTaskMark = (taskId, val) => setDraft({ taskMarks: { ...(taskMarks || {}), [taskId]: val } });

  // For excel, the "work" component comes from the sum of field marks
  // entered here.  For task templates it's the HR-defined points
  // (cached) PLUS the per-row awardedMarks HR is entering live for any
  // employee-added rows.
  const excelEarned = (s.excelResponses || [])
    .filter((r) => r.markEligible)
    .reduce((sum, r) => sum + (Number(fieldMarks[r.fieldName]) || 0), 0);

  const sheetEarned = ((s.sheet && s.sheet.scores) || [])
    .reduce((sum, sc) => sum + (Number(sheetMarks[sc.key]?.marksAwarded) || 0), 0);

  // Employee-added rows live only on task templates.  We split the task
  // points: HR-defined "done" rows keep their cached points, added rows
  // contribute the live awardedMarks the reviewer is typing.
  const isTask = !isExcel && !isSheet;
  const taskHrEarned = isTask
    ? (s.tasks || []).filter((t) => !t.addedByEmployee && t.status === 'done')
        .reduce((sum, t) => sum + (Number(t.points) || 0), 0)
    : 0;
  const taskHrTotal = isTask
    ? (s.tasks || []).filter((t) => !t.addedByEmployee && (t.status === 'done' || t.status === 'pending'))
        .reduce((sum, t) => sum + (Number(t.points) || 0), 0)
    : 0;
  const taskAddedEarned = isTask
    ? (s.tasks || []).filter((t) => t.addedByEmployee)
        .reduce((sum, t) => sum + (Number((taskMarks || {})[String(t._id)]) || 0), 0)
    : 0;
  const taskEarned = taskHrEarned + taskAddedEarned;
  const taskTotal  = taskHrTotal  + taskAddedEarned;

  const workEarned = isSheet ? sheetEarned : isExcel ? excelEarned : taskEarned;
  const workTotalLive = isTask ? taskTotal : (s.workTotalPoints || 0);
  const finalEarned = workEarned + Number(disciplineMarks || 0) + Number(ideaMarks || 0);
  const finalTotal = workTotalLive + Number(maxDisciplineMarks || 0) + Number(maxIdeaMarks || 0);
  const finalPct = finalTotal > 0 ? (finalEarned / finalTotal) * 100 : 0;

  const save = async () => {
    if (Number(disciplineMarks) > Number(maxDisciplineMarks)) {
      toast.error('Discipline marks cannot exceed the configured max');
      return;
    }
    if (Number(ideaMarks) > Number(maxIdeaMarks)) {
      toast.error('Innovation marks cannot exceed the configured max');
      return;
    }
    // Validate excel field marks don't exceed each field's max
    if (isExcel) {
      const bad = (s.excelResponses || []).find(
        (r) => r.markEligible && Number(fieldMarks[r.fieldName] || 0) > (r.maxMarks || 0)
      );
      if (bad) {
        toast.error(`Marks for "${bad.fieldName}" cannot exceed ${bad.maxMarks}`);
        return;
      }
    }
    // Validate sheet target marks don't exceed each target's max
    if (isSheet) {
      const bad = ((s.sheet && s.sheet.scores) || []).find(
        (sc) => Number(sheetMarks[sc.key]?.marksAwarded || 0) > (sc.maxMarks || 0)
      );
      if (bad) {
        toast.error(`Marks for "${bad.label || bad.key}" cannot exceed ${bad.maxMarks}`);
        return;
      }
    }
    setBusy(true);
    try {
      await api.post(`/submissions/${s._id}/review`, {
        disciplineMarks: Number(disciplineMarks),
        maxDisciplineMarks: Number(maxDisciplineMarks),
        disciplineNote,
        ideaMarks: Number(ideaMarks),
        maxIdeaMarks: Number(maxIdeaMarks),
        ideaFeedback,
        excelResponses: isExcel
          ? (s.excelResponses || [])
              .filter((r) => r.markEligible)
              .map((r) => ({ fieldName: r.fieldName, marksAwarded: Number(fieldMarks[r.fieldName]) || 0 }))
          : undefined,
        scores: isSheet
          ? ((s.sheet && s.sheet.scores) || []).map((sc) => ({
              key: sc.key,
              marksAwarded: Number(sheetMarks[sc.key]?.marksAwarded) || 0,
              remark: sheetMarks[sc.key]?.remark || '',
            }))
          : undefined,
        // Task templates: employee-added row marks.  Backend recomputes
        // workEarned / workTotal to include these.
        taskMarks: isTask
          ? (s.tasks || [])
              .filter((t) => t.addedByEmployee)
              .map((t) => ({
                taskId: String(t._id),
                awardedMarks: Number((taskMarks || {})[String(t._id)]) || 0,
              }))
          : undefined,
      });
      toast.success('Review saved');
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const hodR = s.hodReview;
  const hasHod = hodR && hodR.reviewedAt;

  return (
    <div className="p-5 space-y-4 border-t border-slate-200">
      {/* HOD review context - HR sees the recommendation and can override */}
      {hasHod && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm font-semibold text-blue-900">HOD Review</div>
            <div className="flex items-center gap-2">
              {hodR.marksGiven && <span className="badge-blue">Marks prefilled below</span>}
              {hodR.recommend === 'approve' && <span className="badge-green">Recommends approval</span>}
              {hodR.recommend === 'needs_changes' && <span className="badge-amber">Flagged: needs changes</span>}
            </div>
          </div>
          {hodR.remarks
            ? <p className="text-sm text-slate-700 mt-2 whitespace-pre-wrap">"{hodR.remarks}"</p>
            : <p className="text-xs text-slate-500 mt-2 italic">No remarks from HOD.</p>}
          <div className="text-[11px] text-slate-500 mt-2">
            Reviewed by HOD on {new Date(hodR.reviewedAt).toLocaleString()}. You have final authority — adjust marks below before finalizing.
          </div>
        </div>
      )}

      {/* Sheet report: review INSIDE the spreadsheet - marks are injected
          into the sheet (row -> Marks column, column -> Marks row,
          cell -> inline). */}
      {isSheet && s.sheet && (
        <Section title="Spreadsheet Report" badgeClass="badge-green" count={(s.sheet.scores || []).length}>
          <div className="space-y-3">
            <div className="text-[11px] text-slate-500">
              Review the report exactly as the employee filled it. Enter marks directly in the highlighted
              <span className="mx-1 px-1 rounded bg-amber-100 text-amber-800">Marks</span>
              areas. Hidden / HR-only rows &amp; columns are shown to you (hatched) but were never visible to the employee.
            </div>
            {(s.sheet.scores || []).length === 0 && (
              <Empty>No scoring areas were configured on this template - nothing to mark.</Empty>
            )}
            <SheetReviewGrid
              sheet={s.sheet}
              marks={sheetMarks}
              onMark={(key, patch) => setSheetMark(key, patch)}
              deps={Object.fromEntries((s.dependencies || []).map((d) => [d.sourceTaskId, d]))}
            />
            <SheetDependencyDetails sheet={s.sheet} deps={deps} />
            <div className="text-xs text-slate-600 text-right">
              Report marks: <b>{sheetEarned}</b> / {s.workTotalPoints || 0}
            </div>
          </div>
        </Section>
      )}

      {/* Excel report: submitted values + status/dependency + field-wise marking */}
      {isExcel && (
        <Section title="Excel Report" badgeClass="badge-blue" count={(s.excelResponses || []).length}>
          <div className="flex justify-end mb-2"><RowStatusFilter value={rowFilter} onChange={setRowFilter} /></div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Submitted value</th>
                  <th>Status</th>
                  <th>Dependency</th>
                  <th className="w-40">Marks awarded</th>
                </tr>
              </thead>
              <tbody>
                {(s.excelResponses || []).filter((r) => matchRowFilter(r.rowStatus, deps.get(r.fieldName), rowFilter)).map((r) => {
                  const dep = deps.get(r.fieldName);
                  return (
                    <tr key={r._id || r.fieldName}>
                      <td className="font-medium">{r.fieldName}</td>
                      <td className="text-slate-700 whitespace-pre-wrap">
                        {String(r.value ?? '') || <span className="text-slate-400">—</span>}
                      </td>
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
                            <input
                              className="input w-20"
                              type="number" min="0" max={r.maxMarks}
                              placeholder="Marks"
                              value={fieldMarks[r.fieldName] ?? ''}
                              onChange={(e) => setFieldMarks(r.fieldName, e.target.value === '' ? '' : Number(e.target.value))}
                            />
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
          <div className="mt-2 text-xs text-slate-600 text-right">
            Report marks: <b>{excelEarned}</b> / {s.workTotalPoints || 0}
          </div>
        </Section>
      )}

      {/* Task templates: unified row-status table with inline dependency info */}
      {!isExcel && !isSheet && (
        <TaskStatusTable tasks={s.tasks} deps={deps} rowFilter={rowFilter} setRowFilter={setRowFilter} />
      )}

      {/* Employee-added tasks (task templates only): HR awards marks
          here.  These rows have no pre-set points; the value HR enters
          contributes equally to earned and total points. */}
      {!isExcel && !isSheet && (s.tasks || []).some((t) => t.addedByEmployee) && (
        <Section
          title="Employee-Added Tasks"
          badgeClass="badge-blue"
          count={(s.tasks || []).filter((t) => t.addedByEmployee).length}
        >
          <div className="text-[11px] text-slate-500 mb-2">
            Tasks the employee added on top of the assigned template. Marks you enter here
            count toward both <b>earned</b> and <b>total</b> points.
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Task (added by employee)</th>
                  <th className="w-40">Awarded Marks</th>
                </tr>
              </thead>
              <tbody>
                {(s.tasks || []).filter((t) => t.addedByEmployee).map((t) => (
                  <tr key={t._id}>
                    <td className="font-medium text-slate-800">{t.title}</td>
                    <td>
                      <input
                        className="input w-28"
                        type="number" min="0"
                        placeholder="Marks"
                        value={(taskMarks || {})[String(t._id)] ?? ''}
                        onChange={(e) => setTaskMark(String(t._id), e.target.value === '' ? '' : Number(e.target.value))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-xs text-slate-600 text-right">
            Additional marks subtotal: <b>{taskAddedEarned}</b>
          </div>
        </Section>
      )}

      <div className="grid md:grid-cols-3 gap-3">
        {/* Self observation */}
        <Section title="Self Observation">
          {s.selfRating == null && !s.selfNote
            ? <Empty>Employee did not record self observation.</Empty>
            : <div className="text-sm space-y-1">
                <div>Rating: <span className="font-semibold text-slate-800">{s.selfRating ?? '-'}/10</span></div>
                {s.selfNote && <div className="text-slate-600">"{s.selfNote}"</div>}
              </div>}
        </Section>

        {/* Idea / innovation */}
        <Section title="Business Idea / Innovation" badgeClass="badge-blue" count={s.idea ? 1 : 0}>
          {s.idea
            ? <p className="text-sm text-slate-700 whitespace-pre-wrap">{s.idea}</p>
            : <Empty>Employee did not share an idea.</Empty>}
        </Section>

        {/* Submission meta */}
        <Section title="Submission Details">
          <div className="text-sm space-y-1 text-slate-700">
            <Row label="Submitted" value={s.submittedAt ? new Date(s.submittedAt).toLocaleString() : '-'} />
            <Row label="Work earned" value={`${s.workEarnedPoints} pts`} />
            <Row label="Work total" value={`${s.workTotalPoints} pts`} />
            <Row label="Date" value={fmtDate(s.date)} />
          </div>
        </Section>
      </div>

      {/* Marking section */}
      <div className="card">
        <div className="card-head">
          <div>
            <div className="text-sm font-semibold text-slate-900">HR Evaluation</div>
            <div className="text-xs text-slate-500">Marks are added to BOTH earned and total points.</div>
          </div>
          {s.reviewStatus === 'reviewed' && (
            <span className="badge-green">Already reviewed - editing will update marks</span>
          )}
        </div>
        <div className="card-body grid md:grid-cols-2 gap-5">
          {/* Discipline */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Discipline</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Marks</label>
                <input className="input" type="number" min="0" max={maxDisciplineMarks}
                  placeholder="Enter marks"
                  value={disciplineMarks ?? ''} onChange={(e) => setDraft({ disciplineMarks: e.target.value === '' ? '' : Number(e.target.value) })} />
              </div>
              <div>
                <label className="label">Max</label>
                <input className="input" type="number" min="0" placeholder="3"
                  value={maxDisciplineMarks || ''}
                  onChange={(e) => setDraft({ maxDisciplineMarks: e.target.value === '' ? '' : Number(e.target.value) })} />
              </div>
            </div>
            <div>
              <label className="label">Discipline note (optional)</label>
              <textarea className="input" rows={2} value={disciplineNote}
                onChange={(e) => setDraft({ disciplineNote: e.target.value })} placeholder="e.g. punctual, neat sub-mission..." />
            </div>
          </div>

          {/* Innovation */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Innovation / Idea</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Marks</label>
                <input className="input" type="number" min="0" max={maxIdeaMarks}
                  placeholder="Enter marks"
                  value={ideaMarks ?? ''} onChange={(e) => setDraft({ ideaMarks: e.target.value === '' ? '' : Number(e.target.value) })} />
              </div>
              <div>
                <label className="label">Max</label>
                <input className="input" type="number" min="0" placeholder="2"
                  value={maxIdeaMarks || ''}
                  onChange={(e) => setDraft({ maxIdeaMarks: e.target.value === '' ? '' : Number(e.target.value) })} />
              </div>
            </div>
            <div>
              <label className="label">Feedback on the idea (optional)</label>
              <textarea className="input" rows={2} value={ideaFeedback}
                onChange={(e) => setDraft({ ideaFeedback: e.target.value })} placeholder="e.g. great suggestion, will discuss in retro" />
            </div>
          </div>
        </div>

        <div className="px-5 pb-5 flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm text-slate-600 bg-slate-50 rounded-lg px-3 py-2 border border-slate-200">
            Final: <span className="font-semibold text-slate-900">{finalEarned}</span> / {finalTotal}
            {' '}({finalPct.toFixed(1)}%)
            <span className="ml-3 text-[11px] text-slate-500">
              {isExcel || isSheet ? 'report' : 'work'} {workEarned}/{s.workTotalPoints} • discipline {disciplineMarks || 0}/{maxDisciplineMarks} • idea {ideaMarks || 0}/{maxIdeaMarks}
            </span>
          </div>
          <button className="btn-primary" disabled={busy} onClick={save}>
            {busy ? 'Saving...' : (s.reviewStatus === 'reviewed' ? 'Update Review' : 'Save Review')}
          </button>
        </div>
      </div>
    </div>
  );
}

const Section = ({ title, badgeClass, count, children }) => (
  <div className="bg-white rounded-xl border border-slate-200 p-4">
    <div className="flex items-center justify-between mb-2">
      <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">{title}</div>
      {badgeClass !== undefined && count !== undefined && (
        <span className={badgeClass}>{count}</span>
      )}
    </div>
    {children}
  </div>
);

const Row = ({ label, value }) => (
  <div className="flex justify-between gap-3">
    <span className="text-slate-500">{label}</span>
    <span className="font-medium">{value}</span>
  </div>
);

const Empty = ({ children }) => <div className="text-xs text-slate-400 italic">{children}</div>;
