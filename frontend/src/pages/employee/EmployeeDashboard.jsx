import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import Collapsible from '../../components/Collapsible.jsx';
import StatCard from '../../components/StatCard.jsx';
import SheetGrid from '../../components/SheetGrid.jsx';
import SheetWorkflowGrid from '../../components/SheetWorkflowGrid.jsx';
import UpcomingEventsWidget from '../../components/UpcomingEventsWidget.jsx';
import ScheduleTag from '../../components/ScheduleTag.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { delayBadgeClass, delayLabel, errMsg, fmtDate } from '../../utils/helpers';

export default function EmployeeDashboard({ embedded = false } = {}) {
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  // Local UI state per task
  const [taskState, setTaskState] = useState({}); // { submissionId: { taskId: {status, pendingReason} } }
  const [selfRating, setSelfRating] = useState({});
  const [selfNote, setSelfNote] = useState({});
  const [idea, setIdea] = useState({});
  const [excelValues, setExcelValues] = useState({}); // { subId: { fieldName: value } }
  const [sheetState, setSheetState] = useState({}); // { subId: workingSheet }
  // Per-row task status for sheet "task rows" (scored rows with statusTracking)
  // { subId: { [scoreKey]: { rowStatus, pendingReason, dependencyType, dependencyAssignedTo, dependencyRemark } } }
  const [sheetStatus, setSheetStatus] = useState({});
  const [assignable, setAssignable] = useState([]); // users for dependency hand-off
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const [myDeps, setMyDeps] = useState([]); // dependency work assigned to me

  // Roster of accounts a dependency can be handed to (any active user).
  useEffect(() => {
    api.get('/dependencies/assignable').then((r) => setAssignable(r.data || [])).catch(() => {});
  }, []);

  const loadDeps = () =>
    api.get('/dependencies/mine', { params: { status: 'all' } }).then((r) => setMyDeps(r.data || [])).catch(() => {});
  useEffect(() => { loadDeps(); }, []);

  const resolveDep = async (id) => {
    try { await api.post(`/dependencies/${id}/resolve`, {}); toast.success('Dependency resolved'); loadDeps(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  const load = async () => {
    setLoading(true);
    const [a, b] = await Promise.all([
      api.get('/submissions/today'),
      api.get('/dashboard/employee/summary'),
    ]);
    // Seed editable working copies for unsubmitted sheet reports.
    const seed = {};
    (a.data.submissions || []).forEach((s) => {
      if (s.templateType === 'sheet' && !s.submitted && s.sheet) {
        seed[s._id] = JSON.parse(JSON.stringify(s.sheet));
      }
    });
    setSheetState(seed);
    setData(a.data);
    setSummary(b.data);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  if (loading || !data) return <Loader />;

  const setTask = (subId, taskId, patch) =>
    setTaskState((s) => ({
      ...s,
      [subId]: { ...(s[subId] || {}), [taskId]: { ...(s[subId]?.[taskId] || { status: 'pending_submit' }), ...patch } },
    }));

  // ---- sheet (advanced spreadsheet) helpers ----
  const sheetColFieldType = (ws, c) =>
    (ws.cells.find((x) => x.c === c && x.role === 'input')?.fieldType) || 'text';

  const setSheetRowStatus = (subId, key, patch) =>
    setSheetStatus((s) => ({
      ...s,
      [subId]: { ...(s[subId] || {}), [key]: { ...(s[subId]?.[key] || { dependencyType: 'independent' }), ...patch } },
    }));

  const setSheetCell = (subId, r, c, value) =>
    setSheetState((s) => {
      const ws = s[subId];
      if (!ws) return s;
      const cells = ws.cells.map((x) => (x.r === r && x.c === c ? { ...x, value } : x));
      return { ...s, [subId]: { ...ws, cells } };
    });

  const addSheetRow = (subId) =>
    setSheetState((s) => {
      const ws = s[subId];
      if (!ws) return s;
      const r = ws.rowCount;
      const newCells = (ws.columns || []).map((co) => ({
        r, c: co.index, value: '', role: 'input',
        fieldType: sheetColFieldType(ws, co.index),
        editable: true, hidden: false, options: [], addedByEmployee: true,
      }));
      return {
        ...s,
        [subId]: {
          ...ws,
          rowCount: r + 1,
          rows: [...(ws.rows || []), { index: r, label: String(r + 1), hidden: false }],
          cells: [...ws.cells, ...newCells],
        },
      };
    });

  const submit = async (sub) => {
    setBusy(true);
    try {
      if (sub.templateType === 'sheet') {
        const ws = sheetState[sub._id] || sub.sheet;
        // Task rows = scored rows HR flagged with statusTracking.
        const taskRows = (ws.scores || []).filter((sc) => sc.statusTracking);
        const statusMap = sheetStatus[sub._id] || {};
        // Validate every task row has a status (+ reason / dependency fields).
        for (const sc of taskRows) {
          const st = statusMap[sc.key] || {};
          if (!['done', 'pending', 'work_not_available'].includes(st.rowStatus)) {
            toast.error(`Choose a status for: ${sc.label || 'task row'}`); setBusy(false); return;
          }
          if (st.rowStatus === 'pending' && !(st.pendingReason || '').trim()) {
            toast.error(`Reason required for pending row: ${sc.label || ''}`); setBusy(false); return;
          }
          if ((st.rowStatus === 'done' || st.rowStatus === 'pending') && st.dependencyType === 'dependent') {
            if (!st.dependencyAssignedTo) { toast.error(`Select who to assign: ${sc.label || ''}`); setBusy(false); return; }
            if (!(st.dependencyRemark || '').trim()) { toast.error(`Dependency remark required for: ${sc.label || ''}`); setBusy(false); return; }
          }
        }
        const scores = taskRows.map((sc) => {
          const st = statusMap[sc.key] || {};
          return {
            key: sc.key,
            rowStatus: st.rowStatus,
            pendingReason: st.pendingReason || '',
            dependencyType: st.dependencyType || 'independent',
            dependencyAssignedTo: st.dependencyType === 'dependent' ? st.dependencyAssignedTo : undefined,
            dependencyRemark: st.dependencyType === 'dependent' ? st.dependencyRemark : '',
          };
        });
        await api.post(`/submissions/${sub._id}/submit`, {
          sheet: { cells: ws.cells, scores },
          selfRating: selfRating[sub._id],
          selfNote: selfNote[sub._id],
          idea: idea[sub._id],
        });
      } else if (sub.templateType === 'excel') {
        const values = excelValues[sub._id] || {};
        const responses = sub.excelResponses.map((r) => ({
          fieldName: r.fieldName,
          value: values[r.fieldName] !== undefined ? values[r.fieldName] : r.value,
        }));
        await api.post(`/submissions/${sub._id}/submit`, {
          excelResponses: responses,
          selfRating: selfRating[sub._id],
          selfNote: selfNote[sub._id],
          idea: idea[sub._id],
        });
      } else {
        const localTasks = sub.tasks.map((t) => {
          const st = taskState[sub._id]?.[t._id] || { status: 'pending_submit' };
          return { taskId: t._id, status: st.status, pendingReason: st.pendingReason };
        });
        if (localTasks.some((t) => t.status === 'pending_submit')) {
          toast.error('Please choose a status for every task');
          setBusy(false);
          return;
        }
        if (localTasks.some((t) => t.status === 'pending' && !t.pendingReason)) {
          toast.error('Reason required for all pending tasks');
          setBusy(false);
          return;
        }
        await api.post(`/submissions/${sub._id}/submit`, {
          tasks: localTasks,
          selfRating: selfRating[sub._id],
          selfNote: selfNote[sub._id],
          idea: idea[sub._id],
        });
      }
      toast.success('Submitted!');
      load();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const markBacklogDone = async (item) => {
    try {
      await api.post('/submissions/backlog/complete', {
        submissionId: item.submissionId, taskId: item.taskId,
      });
      toast.success('Task marked complete');
      load();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <div className="space-y-6">
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold text-slate-900">My Dashboard</h1>
          <p className="text-sm text-slate-500">{fmtDate(data.date)}</p>
        </div>
      )}

      {!embedded && summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="30-day Completion"
            value={`${summary.last30Days.completionPercentage.toFixed(1)}%`}
            sub={`${summary.last30Days.submissions} submissions`}
            accent="green"
          />
          <StatCard
            label="Pendency"
            value={summary.backlogCount}
            accent={summary.backlogCount > 0 ? 'red' : 'brand'}
          />
          <StatCard
            label="Leave Balance"
            value={(summary.leaveBalance?.yearlyAllowance || 0) - (summary.leaveBalance?.used || 0)}
            sub={`of ${summary.leaveBalance?.yearlyAllowance || 0}`}
            accent="blue"
            to="/my-leaves"
          />
          <StatCard
            label="Pending Leaves"
            value={summary.pendingLeaves}
            accent="amber"
            to="/my-leaves"
          />
        </div>
      )}

      {!embedded && <UpcomingEventsWidget limit={4} days={21} />}

      {/* Dependency Work assigned to me - hidden in embedded mode because
          the host (e.g. MyTasks) already has a richer, filterable inbox. */}
      {!embedded && myDeps.length > 0 && (() => {
        const open = myDeps.filter((d) => d.currentStatus !== 'resolved');
        return (
          <Collapsible
            title="Dependency Work"
            subtitle={`${open.length} open hand-off(s) assigned to you`}
            right={<span className={open.length === 0 ? 'badge-green' : 'badge-amber'}>{open.length}</span>}
            defaultOpen={open.length > 0}
          >
            {open.length === 0 ? (
              <div className="text-sm text-slate-500">No open dependency work. 🎉</div>
            ) : (
              <div className="space-y-2">
                {open.map((d) => {
                  const days = Math.max(0, Math.floor((Date.now() - new Date(d.waitingSince || d.createdAt)) / 86400000));
                  const prio = d.priority === 'high' ? 'badge-red' : d.priority === 'low' ? 'badge-gray' : 'badge-amber';
                  return (
                    <div key={d._id} className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-[200px]">
                          <div className="text-sm font-semibold text-slate-800">{d.originalTaskName || 'Dependency task'}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            From <b>{d.assignedBy?.name || d.assignedByName || 'Someone'}</b>
                            {d.departmentName ? ` · ${d.departmentName}` : ''}
                            {d.templateTitle ? ` · ${d.templateTitle}` : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={prio}>{(d.priority || 'normal').toUpperCase()}</span>
                          <span className="badge-gray">Waiting {days}d</span>
                          <button className="btn-secondary !py-1" onClick={() => resolveDep(d._id)}>Resolve</button>
                        </div>
                      </div>
                      {d.remark && <div className="text-xs text-slate-600 mt-2"><b>Remark:</b> {d.remark}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </Collapsible>
        );
      })()}

      {/* Leave / weekly off banners */}
      {data.onLeave && (
        <div className="card card-body bg-amber-50 border-amber-200">
          <div className="text-sm font-semibold text-amber-800">You are on approved leave today.</div>
          <div className="text-xs text-amber-700 mt-1">
            {data.leaveInfo.leaveType?.toUpperCase()} • {fmtDate(data.leaveInfo.fromDate)} – {fmtDate(data.leaveInfo.toDate)}
          </div>
        </div>
      )}
      {!data.onLeave && data.weeklyOff && (
        <div className="card card-body bg-blue-50 border-blue-200">
          <div className="text-sm font-semibold text-blue-800">Today is your weekly off. Enjoy your day!</div>
        </div>
      )}
      {!data.onLeave && data.holiday && (
        <div className="card card-body bg-purple-50 border-purple-200">
          <div className="text-sm font-semibold text-purple-800">Today is a holiday: {data.holiday.name}</div>
          {data.holiday.description && (
            <div className="text-xs text-purple-700 mt-1">{data.holiday.description}</div>
          )}
          <div className="text-[11px] text-purple-700 mt-1 capitalize">Type: {data.holiday.type}</div>
        </div>
      )}
      {!data.onLeave && data.workingDespiteOff && (
        <div className="card card-body bg-amber-50 border-amber-200">
          <div className="text-sm font-semibold text-amber-900">
            Working day today (HR override)
          </div>
          <div className="text-xs text-amber-800 mt-1">
            {data.weeklyOffOriginal
              ? 'Today is normally your weekly off, but HR has assigned override work below.'
              : data.holidayOriginal
              ? `Today is normally a holiday (${data.holidayOriginal.name}), but HR has assigned override work below.`
              : 'HR has assigned override work to a non-working day.'}
          </div>
        </div>
      )}

      {/* Today's tasks per submission */}
      {!data.onLeave && !data.weeklyOff && !data.holiday && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Today's Tasks</h2>
          {data.submissions.length === 0 && (
            <EmptyState title="No tasks assigned for today" subtitle="HR has not assigned any templates to you yet." />
          )}
          {data.submissions.map((sub) => (
            <Collapsible
              key={sub._id}
              defaultOpen
              title={sub.template?.title || 'Template'}
              subtitle={sub.scheduleLabel || (sub.submitted ? 'Submitted'
                : sub.templateType === 'sheet' ? 'Spreadsheet report'
                : sub.templateType === 'excel' ? 'Excel report'
                : `${sub.tasks.length} task(s)`)}
              right={<span className="inline-flex items-center gap-2">
                <ScheduleTag frequency={sub.frequency} label={sub.scheduleLabel} />
                {sub.holidayOverride && (
                  <span
                    className="badge bg-orange-50 text-orange-700"
                    title={sub.overrideReason ? `Override reason: ${sub.overrideReason}` : 'Manually assigned on a non-working day'}
                  >
                    {new Date(sub.date).getUTCDay() === 0 ? 'Weekend Assignment' : 'Holiday Override'}
                  </span>
                )}
                {sub.submitted ? <span className="badge-green">Submitted</span> : <span className="badge-amber">Pending</span>}
              </span>}
            >
              {sub.submitted ? (
                <SubmittedSummary sub={sub} />
              ) : sub.templateType === 'sheet' ? (
                <>
                  <SheetReportForm
                    sub={sub}
                    ws={sheetState[sub._id] || sub.sheet}
                    onCellChange={(r, c, v) => setSheetCell(sub._id, r, c, v)}
                    onAddRow={() => addSheetRow(sub._id)}
                    status={sheetStatus[sub._id] || {}}
                    onStatusChange={(key, patch) => setSheetRowStatus(sub._id, key, patch)}
                    assignable={assignable}
                  />

                  {/* Self-observation + Idea */}
                  <div className="mt-4 bg-slate-50 rounded-lg p-3">
                    <div className="text-sm font-semibold text-slate-800 mb-2">Self Observation (informational only)</div>
                    <div className="grid md:grid-cols-3 gap-3">
                      <div>
                        <label className="label">Rating (0-10)</label>
                        <input className="input" type="number" min="0" max="10" step="0.5" placeholder="0 - 10"
                          value={selfRating[sub._id] || ''}
                          onChange={(e) => setSelfRating((s) => ({ ...s, [sub._id]: Number(e.target.value) }))} />
                      </div>
                      <div className="md:col-span-2">
                        <label className="label">Note</label>
                        <input className="input" placeholder="Anything you want HR to know"
                          value={selfNote[sub._id] ?? ''}
                          onChange={(e) => setSelfNote((s) => ({ ...s, [sub._id]: e.target.value }))} />
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 bg-blue-50 border border-blue-100 rounded-lg p-3">
                    <div className="text-sm font-semibold text-blue-900 mb-1">Business Idea / Innovation</div>
                    <textarea className="input" rows={2} placeholder="Optional - share any improvement idea"
                      value={idea[sub._id] ?? ''}
                      onChange={(e) => setIdea((s) => ({ ...s, [sub._id]: e.target.value }))} />
                  </div>

                  <div className="mt-4 flex justify-end">
                    <button className="btn-primary" disabled={busy} onClick={() => submit(sub)}>
                      Submit Report
                    </button>
                  </div>
                </>
              ) : sub.templateType === 'excel' ? (
                <>
                  <ExcelReportForm
                    sub={sub}
                    values={excelValues[sub._id] || {}}
                    onChange={(fieldName, value) => setExcelValues((s) => ({
                      ...s,
                      [sub._id]: { ...(s[sub._id] || {}), [fieldName]: value },
                    }))}
                  />

                  {/* Self-observation + Idea (shared with task form) */}
                  <div className="mt-4 bg-slate-50 rounded-lg p-3">
                    <div className="text-sm font-semibold text-slate-800 mb-2">Self Observation (informational only)</div>
                    <div className="grid md:grid-cols-3 gap-3">
                      <div>
                        <label className="label">Rating (0-10)</label>
                        <input className="input" type="number" min="0" max="10" step="0.5" placeholder="0 - 10"
                          value={selfRating[sub._id] || ''}
                          onChange={(e) => setSelfRating((s) => ({ ...s, [sub._id]: Number(e.target.value) }))} />
                      </div>
                      <div className="md:col-span-2">
                        <label className="label">Note</label>
                        <input className="input" placeholder="Anything you want HR to know"
                          value={selfNote[sub._id] ?? ''}
                          onChange={(e) => setSelfNote((s) => ({ ...s, [sub._id]: e.target.value }))} />
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 bg-blue-50 border border-blue-100 rounded-lg p-3">
                    <div className="text-sm font-semibold text-blue-900 mb-1">Business Idea / Innovation</div>
                    <textarea className="input" rows={2} placeholder="Optional - share any improvement idea"
                      value={idea[sub._id] ?? ''}
                      onChange={(e) => setIdea((s) => ({ ...s, [sub._id]: e.target.value }))} />
                  </div>

                  <div className="mt-4 flex justify-end">
                    <button className="btn-primary" disabled={busy} onClick={() => submit(sub)}>
                      Submit Report
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Task</th>
                          <th>Points</th>
                          <th>Status</th>
                          <th>Reason (if pending)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sub.tasks.map((t) => {
                          const st = taskState[sub._id]?.[t._id]?.status || 'pending_submit';
                          return (
                            <tr key={t._id}>
                              <td className="font-medium text-slate-800">{t.title}</td>
                              <td>{t.points}</td>
                              <td>
                                <select
                                  className="input max-w-[160px]"
                                  value={st}
                                  onChange={(e) => setTask(sub._id, t._id, { status: e.target.value })}
                                >
                                  <option value="pending_submit">Select...</option>
                                  <option value="done">Done</option>
                                  <option value="pending">Pending</option>
                                  <option value="work_not_available">Work Not Available</option>
                                </select>
                              </td>
                              <td>
                                <input
                                  className="input"
                                  placeholder={st === 'pending' ? 'Required' : 'N/A'}
                                  disabled={st !== 'pending'}
                                  value={taskState[sub._id]?.[t._id]?.pendingReason || ''}
                                  onChange={(e) => setTask(sub._id, t._id, { pendingReason: e.target.value })}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Self-observation */}
                  <div className="mt-4 bg-slate-50 rounded-lg p-3">
                    <div className="text-sm font-semibold text-slate-800 mb-2">Self Observation (informational only)</div>
                    <div className="grid md:grid-cols-3 gap-3">
                      <div>
                        <label className="label">Rating (0-10)</label>
                        <input
                          className="input"
                          type="number" min="0" max="10" step="0.5"
                          placeholder="0 - 10"
                          value={selfRating[sub._id] || ''}
                          onChange={(e) => setSelfRating((s) => ({ ...s, [sub._id]: Number(e.target.value) }))}
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="label">Note</label>
                        <input
                          className="input"
                          placeholder="e.g. Could improve time management"
                          value={selfNote[sub._id] ?? ''}
                          onChange={(e) => setSelfNote((s) => ({ ...s, [sub._id]: e.target.value }))}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Innovation / Idea */}
                  <div className="mt-3 bg-blue-50 border border-blue-100 rounded-lg p-3">
                    <div className="text-sm font-semibold text-blue-900 mb-1">Business Idea / Innovation</div>
                    <div className="text-[11px] text-blue-700 mb-2">
                      Share one suggestion or idea you think could help the business. HR can award up to 2 marks for this.
                    </div>
                    <textarea
                      className="input"
                      rows={2}
                      placeholder="Type your idea here..."
                      value={idea[sub._id] ?? ''}
                      onChange={(e) => setIdea((s) => ({ ...s, [sub._id]: e.target.value }))}
                    />
                  </div>

                  <div className="mt-4 flex justify-end">
                    <button className="btn-primary" disabled={busy} onClick={() => submit(sub)}>
                      Submit
                    </button>
                  </div>
                </>
              )}
            </Collapsible>
          ))}
        </div>
      )}

      {/* Pendency */}
      <Collapsible
        title="Pendency"
        subtitle={`${data.backlog.length} pending task(s)`}
        right={<span className={data.backlog.length === 0 ? 'badge-green' : 'badge-red'}>{data.backlog.length}</span>}
        defaultOpen={data.backlog.length > 0}
      >
        {data.backlog.length === 0
          ? <div className="text-sm text-slate-500">No pending work. Great job!</div>
          : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Template</th>
                    <th>Schedule</th>
                    <th>Reason</th>
                    <th>Pending since</th>
                    <th>Delay</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.backlog.map((b) => (
                    <tr key={`${b.submissionId}-${b.taskId}`}>
                      <td className="font-medium">{b.title}</td>
                      <td>{b.templateTitle}</td>
                      <td><ScheduleTag frequency={b.frequency} label={b.scheduleLabel} /></td>
                      <td className="text-slate-500">{b.pendingReason}</td>
                      <td>{fmtDate(b.pendingSince)}</td>
                      <td><span className={delayBadgeClass(b.daysPending)}>{delayLabel(b.daysPending)}</span></td>
                      <td><button className="btn-secondary" onClick={() => markBacklogDone(b)}>Mark Done</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Collapsible>
    </div>
  );
}

/**
 * Post-submission summary shown on the employee dashboard.  Reveals the
 * HR review (discipline + innovation marks + feedback) once it has been
 * completed; otherwise shows the work-only score with a "Pending Review"
 * badge.
 */
function SubmittedSummary({ sub }) {
  const reviewed = sub.reviewStatus === 'reviewed';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-slate-600">
          Work: <b>{sub.workEarnedPoints ?? sub.earnedPoints}</b> / {sub.workTotalPoints ?? sub.totalPoints} points
        </div>
        {reviewed
          ? <span className="badge-green">Reviewed</span>
          : <span className="badge-amber">Awaiting HR review</span>}
      </div>

      {reviewed && (
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="bg-slate-50 rounded-lg p-3">
            <div className="text-[11px] uppercase text-slate-500">Discipline</div>
            <div className="text-lg font-semibold text-slate-900">
              {sub.disciplineMarks}/{sub.maxDisciplineMarks}
            </div>
            {sub.disciplineNote && <div className="text-xs text-slate-600 mt-1 italic">"{sub.disciplineNote}"</div>}
          </div>
          <div className="bg-slate-50 rounded-lg p-3">
            <div className="text-[11px] uppercase text-slate-500">Innovation</div>
            <div className="text-lg font-semibold text-slate-900">
              {sub.ideaMarks}/{sub.maxIdeaMarks}
            </div>
            {sub.ideaFeedback && <div className="text-xs text-slate-600 mt-1 italic">"{sub.ideaFeedback}"</div>}
          </div>
          <div className="bg-brand-50 rounded-lg p-3 border border-brand-100">
            <div className="text-[11px] uppercase text-brand-700">Final</div>
            <div className="text-lg font-semibold text-brand-700">
              {sub.earnedPoints}/{sub.totalPoints} ({sub.completionPercentage.toFixed(1)}%)
            </div>
            <div className="text-[11px] text-brand-600 mt-1">includes discipline + innovation</div>
          </div>
        </div>
      )}

      {/* Sheet report: show the submitted grid (+ per-target marks once reviewed) */}
      {sub.templateType === 'sheet' && sub.sheet && (
        <div className="space-y-3">
          <SheetGrid sheet={sub.sheet} mode="readonly" showHidden={false} scoreMap={reviewed ? buildScoreMapFromScores(sub.sheet.scores) : {}} height={280} />
          {reviewed && (sub.sheet.scores || []).length > 0 && (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Scored area</th><th>Type</th><th>Marks</th><th>Remark</th></tr></thead>
                <tbody>
                  {sub.sheet.scores.map((sc) => (
                    <tr key={sc.key}>
                      <td className="font-medium">{sc.label || sc.key}</td>
                      <td className="capitalize text-slate-500">{sc.type}</td>
                      <td><b>{sc.marksAwarded}</b>/{sc.maxMarks}</td>
                      <td className="text-slate-600">{sc.remark || <span className="text-slate-300">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Excel report: show submitted values (+ per-field marks once reviewed) */}
      {sub.templateType === 'excel' && (sub.excelResponses || []).length > 0 && (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Your value</th>
                {reviewed && <th>Marks</th>}
              </tr>
            </thead>
            <tbody>
              {sub.excelResponses.map((r) => (
                <tr key={r._id || r.fieldName}>
                  <td className="font-medium">
                    {r.fieldName}
                    {r.markEligible && <span className="ml-1 badge-blue">scored</span>}
                  </td>
                  <td className="text-slate-700 whitespace-pre-wrap">{String(r.value ?? '') || <span className="text-slate-400">—</span>}</td>
                  {reviewed && (
                    <td>{r.markEligible ? <b>{r.marksAwarded}/{r.maxMarks}</b> : <span className="text-slate-400">n/a</span>}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sub.idea && (
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
          <div className="text-[11px] uppercase text-blue-700 mb-1">Your idea</div>
          <div className="text-sm text-slate-700 whitespace-pre-wrap">{sub.idea}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Dynamic, spreadsheet-style report form rendered from the submission's
 * excelResponses (which mirror the template's columns).  Renders the
 * right input per fieldType and surfaces which fields are scored.
 */
function ExcelReportForm({ sub, values, onChange }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">
        Fill in your report below. Fields marked <span className="badge-blue">scored</span> contribute to your performance marks (awarded by HR on review).
      </div>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Value</th>
              <th className="w-28">Max marks</th>
            </tr>
          </thead>
          <tbody>
            {sub.excelResponses.map((r) => {
              const v = values[r.fieldName] !== undefined ? values[r.fieldName] : (r.value ?? '');
              return (
                <tr key={r._id || r.fieldName}>
                  <td className="font-medium align-top pt-3">
                    {r.fieldName}
                    {r.markEligible && <span className="ml-1 badge-blue">scored</span>}
                  </td>
                  <td>
                    <ExcelField type={r.fieldType} value={v} onChange={(val) => onChange(r.fieldName, val)} options={r.options} />
                  </td>
                  <td className="align-top pt-3 text-slate-500">
                    {r.markEligible ? r.maxMarks : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* Build a scoreMap (keyed) from a submission's sheet.scores for highlighting */
function buildScoreMapFromScores(scores) {
  return Object.fromEntries((scores || []).map((s) => [s.key, s]));
}

/**
 * Editable spreadsheet the employee fills directly in the HRMS - the
 * layout HR uploaded, with only the input cells editable.  Hidden rows /
 * columns are never shown to the employee.
 */
function SheetReportForm({ sub, ws, onCellChange, onAddRow, status = {}, onStatusChange, assignable = [] }) {
  const sheet = ws || sub.sheet;
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">
        Fill the highlighted cells of your report. Task rows (right-hand columns) capture the workflow
        status &amp; dependency directly on the same row.
      </div>
      <SheetWorkflowGrid
        sheet={sheet}
        onCellChange={onCellChange}
        status={status}
        onStatusChange={onStatusChange}
        assignable={assignable}
      />
      {sheet.allowEmployeeAddRows && (
        <button className="btn-secondary !py-1" onClick={onAddRow}>+ Add row</button>
      )}
    </div>
  );
}

function ExcelField({ type, value, onChange, options = [] }) {
  if (type === 'number') {
    return <input className="input" type="number" value={value === 0 ? 0 : (value || '')} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  }
  if (type === 'textarea') {
    return <textarea className="input" rows={2} value={value || ''} onChange={(e) => onChange(e.target.value)} />;
  }
  if (type === 'date') {
    return <input className="input" type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} />;
  }
  if (type === 'dropdown') {
    return (
      <select className="input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select...</option>
        {(options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return <input className="input" value={value || ''} onChange={(e) => onChange(e.target.value)} />;
}
