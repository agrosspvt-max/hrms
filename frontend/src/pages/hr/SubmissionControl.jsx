import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, authUrl } from '../../utils/helpers';

/**
 * Submission Control Center -- HR / Super Admin admin tool.
 *
 *   - Filter + paginated table of every Submission in the database.
 *   - Bulk multi-select + (soft) Delete / Restore / Mark-Test / Export.
 *   - Per-row View / Edit modals.
 *   - "Include Test Data" + "Show Deleted" toggles drive what's listed.
 *   - Admin tools sub-menu: Rebuild Scores, Rebuild Analytics.
 *
 * Soft-delete architecture: nothing is ever permanently removed.  The
 * default analytics queries throughout the rest of the app AND-in a
 * `deleted:{$ne:true}` + `isTestData:{$ne:true}` filter, so flipping
 * either flag here propagates to every dashboard on the next request
 * (no rebuild step required).
 */
export default function SubmissionControl() {
  // ---- filter state ----
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [employee, setEmployee] = useState('');
  const [department, setDepartment] = useState('');
  const [templateType, setTemplateType] = useState('');
  const [status, setStatus] = useState('');
  const [reviewStatus, setReviewStatus] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [search, setSearch] = useState('');
  const [showDeleted, setShowDeleted] = useState('hide');   // hide | only | all
  const [showTest, setShowTest]       = useState('hide');   // hide | only | all
  // ---- ui state ----
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ total: 0, items: [] });
  const [selected, setSelected] = useState(new Set());
  const [opts, setOpts] = useState({ departments: [], employees: [], templates: [] });
  const [viewing, setViewing] = useState(null);   // submission id
  const [editing, setEditing] = useState(null);   // submission row
  const [deleting, setDeleting] = useState(null); // { ids: [...], reason: '', confirm: '' } or null
  const [bulkBusy, setBulkBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.get('/submission-control/filter-options').then((r) => setOpts(r.data)).catch(() => {});
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const params = { page, limit, showDeleted, showTest };
      if (from) params.from = from;
      if (to)   params.to   = to;
      if (employee)     params.employee     = employee;
      if (department)   params.department   = department;
      if (templateType) params.templateType = templateType;
      if (status)       params.status       = status;
      if (reviewStatus) params.reviewStatus = reviewStatus;
      if (reviewer)     params.reviewer     = reviewer;
      if (search)       params.search       = search;
      const { data } = await api.get('/submission-control', { params });
      setData(data);
      setSelected(new Set());
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [page, limit, showDeleted, showTest]);

  const applyFilters = (e) => { e?.preventDefault?.(); setPage(1); load(); };

  const clearFilters = () => {
    setFrom(''); setTo(''); setEmployee(''); setDepartment('');
    setTemplateType(''); setStatus(''); setReviewStatus(''); setReviewer('');
    setSearch(''); setShowDeleted('hide'); setShowTest('hide');
    setPage(1);
    setTimeout(load, 0);
  };

  const toggleOne = (id) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected((cur) =>
    cur.size === data.items.length ? new Set() : new Set(data.items.map((i) => i._id)));

  // ---- per-row actions ----
  const doDeleteOne = (row) => setDeleting({ ids: [row._id], reason: '', confirm: '', label: `submission for ${row.employee?.name || ''} · ${String(row.date).slice(0,10)}` });
  const doRestoreOne = async (row) => {
    if (!confirm(`Restore this submission? Analytics will include it again on the next request.`)) return;
    try { await api.post(`/submission-control/${row._id}/restore`); toast.success('Restored'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const doMarkTestOne = async (row) => {
    const next = !row.isTestData;
    try { await api.post(`/submission-control/${row._id}/mark-test`, { test: next }); toast.success(next ? 'Marked as test data' : 'Unmarked as test data'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  // ---- bulk actions ----
  const ids = useMemo(() => [...selected], [selected]);
  const bulkDelete = () => {
    if (ids.length === 0) return;
    setDeleting({ ids, reason: '', confirm: '', label: `${ids.length} submission(s)` });
  };
  const bulkRestore = async () => {
    if (ids.length === 0) return;
    if (!confirm(`Restore ${ids.length} submission(s)?`)) return;
    setBulkBusy(true);
    try { const { data } = await api.post('/submission-control/bulk/restore', { ids }); toast.success(`Restored ${data.modified}`); load(); }
    catch (err) { toast.error(errMsg(err)); }
    finally { setBulkBusy(false); }
  };
  const bulkMark = async (flag) => {
    if (ids.length === 0) return;
    if (!confirm(`${flag ? 'Mark' : 'Unmark'} ${ids.length} submission(s) as test data?`)) return;
    setBulkBusy(true);
    try { const { data } = await api.post('/submission-control/bulk/mark-test', { ids, test: flag }); toast.success(`${flag ? 'Marked' : 'Unmarked'} ${data.modified}`); load(); }
    catch (err) { toast.error(errMsg(err)); }
    finally { setBulkBusy(false); }
  };

  // ---- admin tools ----
  const runRebuildScores = async () => {
    if (!confirm('Recompute earnedPoints / totalPoints / completion % on every live submission? This walks the entire collection but is safe to re-run.')) return;
    try { const { data } = await api.post('/submission-control/rebuild-scores'); toast.success(data.message || `Touched ${data.touched}`); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const runRebuildAnalytics = async () => {
    try { const { data } = await api.post('/submission-control/rebuild-analytics'); toast.success(data.message || 'OK'); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const runRebuildCarryForward = async () => {
    if (!confirm('Recompute yesterdayPending + every derived formula on all unsubmitted Calling Reports? Already-submitted reports are never touched. Safe to re-run.')) return;
    try {
      const { data } = await api.post('/submission-control/rebuild-carry-forward');
      toast.success(data.message || `Rebuilt ${data.rebuilt}`);
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const exportUrl = () => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to)   qs.set('to', to);
    if (employee)     qs.set('employee', employee);
    if (department)   qs.set('department', department);
    if (templateType) qs.set('templateType', templateType);
    if (status)       qs.set('status', status);
    if (reviewStatus) qs.set('reviewStatus', reviewStatus);
    if (reviewer)     qs.set('reviewer', reviewer);
    qs.set('showDeleted', showDeleted);
    qs.set('showTest', showTest);
    qs.set('format', 'xlsx');
    return authUrl(`/api/submission-control/export?${qs.toString()}`);
  };

  const pages = Math.max(1, Math.ceil((data.total || 0) / limit));

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Submission Control</h1>
          <p className="text-sm text-slate-500">
            Soft-delete + test-data flags for the entire Submission collection.
            Changes propagate to every analytics view on the next request — no rebuild needed.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <a className="btn-secondary" href={exportUrl()}>Export Filtered</a>
          <details className="relative">
            <summary className="btn-secondary cursor-pointer list-none">Admin Tools ▾</summary>
            <div className="absolute right-0 mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg p-2 z-20 space-y-1">
              <button className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50 rounded" onClick={runRebuildScores}>
                Recalculate Employee Scores
              </button>
              <button className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50 rounded" onClick={runRebuildCarryForward}>
                Rebuild Pending Carry Forward
              </button>
              <button className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50 rounded" onClick={runRebuildAnalytics}>
                Rebuild Analytics (informational)
              </button>
            </div>
          </details>
        </div>
      </div>

      {/* Filter bar */}
      <form className="card card-body grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 items-end" onSubmit={applyFilters}>
        <div>
          <label className="label">From</label>
          <input type="date" className="input" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">To</label>
          <input type="date" className="input" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label className="label">Department</label>
          <SearchableSelect
            value={department}
            onChange={setDepartment}
            options={opts.departments}
            getValue={(d) => d._id}
            getLabel={(d) => d.name}
            placeholder="All"
          />
        </div>
        <div>
          <label className="label">Employee</label>
          <SearchableSelect
            value={employee}
            onChange={setEmployee}
            options={opts.employees}
            getValue={(e) => e._id}
            getLabel={(e) => `${e.name} (${e.employeeId})`}
            getSearchText={(e) => `${e.name} ${e.employeeId || ''} ${e.email || ''}`}
            placeholder="All"
          />
        </div>
        <div>
          <label className="label">Template Type</label>
          <select className="input" value={templateType} onChange={(e) => setTemplateType(e.target.value)}>
            <option value="">All</option>
            <option value="task">Task</option>
            <option value="excel">Excel</option>
            <option value="sheet">Spreadsheet</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div>
          <label className="label">Submission Status</label>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="submitted">Submitted</option>
            <option value="draft">Draft</option>
          </select>
        </div>
        <div>
          <label className="label">Review Status</label>
          <select className="input" value={reviewStatus} onChange={(e) => setReviewStatus(e.target.value)}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="reviewed">Reviewed</option>
          </select>
        </div>
        <div>
          <label className="label">Reviewer</label>
          <SearchableSelect
            value={reviewer}
            onChange={setReviewer}
            options={opts.employees.filter((e) => e.role === 'hr')}
            getValue={(e) => e._id}
            getLabel={(e) => e.name}
            getSearchText={(e) => `${e.name} ${e.employeeId || ''}`}
            placeholder="All"
          />
        </div>
        <div className="md:col-span-2">
          <label className="label">Search</label>
          <input className="input" placeholder="Employee, employee ID, template…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div>
          <label className="label">Show Deleted</label>
          <select className="input" value={showDeleted} onChange={(e) => setShowDeleted(e.target.value)}>
            <option value="hide">Hide</option>
            <option value="only">Only Deleted</option>
            <option value="all">All</option>
          </select>
        </div>
        <div>
          <label className="label">Include Test Data</label>
          <select className="input" value={showTest} onChange={(e) => setShowTest(e.target.value)}>
            <option value="hide">Hide</option>
            <option value="only">Only Test</option>
            <option value="all">All</option>
          </select>
        </div>
        <div className="col-span-2 flex gap-2">
          <button className="btn-primary" type="submit">Apply</button>
          <button className="btn-ghost" type="button" onClick={clearFilters}>Clear</button>
        </div>
      </form>

      {/* Bulk action bar (sticky-feel) */}
      {selected.size > 0 && (
        <div className="card card-body flex items-center justify-between gap-3 flex-wrap bg-brand-50 border-brand-200">
          <div className="text-sm text-brand-800 font-medium">
            {selected.size} row(s) selected
          </div>
          <div className="flex gap-2 flex-wrap">
            <button className="btn-secondary" disabled={bulkBusy} onClick={() => bulkMark(true)}>Mark Test</button>
            <button className="btn-secondary" disabled={bulkBusy} onClick={() => bulkMark(false)}>Unmark Test</button>
            <button className="btn-secondary" disabled={bulkBusy} onClick={bulkRestore}>Restore</button>
            <button className="btn-secondary text-red-700 border-red-300" disabled={bulkBusy} onClick={bulkDelete}>Delete Selected</button>
            <button className="btn-ghost" disabled={bulkBusy} onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card overflow-x-auto">
        {loading ? <Loader /> : data.items.length === 0 ? <EmptyState title="No submissions match the filters" /> : (
          <table className="table">
            <thead>
              <tr>
                <th className="w-10">
                  <input type="checkbox" checked={selected.size === data.items.length && data.items.length > 0} onChange={toggleAll} />
                </th>
                <th>Date</th>
                <th>Employee</th>
                <th>Department</th>
                <th>Assignment</th>
                <th>Template Type</th>
                <th>Submission</th>
                <th>Review</th>
                <th>Reviewer</th>
                <th>Created</th>
                <th>Updated</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s._id} className={`${s.deleted ? 'opacity-60 bg-red-50/40' : s.isTestData ? 'bg-amber-50/40' : ''}`}>
                  <td><input type="checkbox" checked={selected.has(s._id)} onChange={() => toggleOne(s._id)} /></td>
                  <td className="whitespace-nowrap">{String(s.date || '').slice(0, 10)}</td>
                  <td>
                    <div className="font-medium text-slate-800">{s.employee?.name || '—'}</div>
                    <div className="text-[11px] text-slate-500">{s.employee?.employeeId || ''}</div>
                  </td>
                  <td>{s.employee?.department || <span className="text-slate-400">—</span>}</td>
                  <td>
                    <div>{s.template?.title || '—'}</div>
                    <div className="text-[11px] text-slate-500">{s.assignment?.scheduleLabel || s.assignment?.frequency || ''}</div>
                  </td>
                  <td>
                    <div>{s.templateType || ''}</div>
                    {s.customKind && <div className="text-[11px] text-slate-500">{s.customKind}</div>}
                  </td>
                  <td>
                    {s.submitted
                      ? <span className="badge-green">Submitted</span>
                      : <span className="badge-gray">Draft</span>}
                    {s.deleted && <div className="mt-1"><span className="badge bg-red-100 text-red-700">Deleted</span></div>}
                    {s.isTestData && <div className="mt-1"><span className="badge bg-amber-100 text-amber-700">Test</span></div>}
                  </td>
                  <td>
                    {s.reviewStatus === 'reviewed'
                      ? <span className="badge-green">Reviewed</span>
                      : <span className="badge-amber">Pending</span>}
                  </td>
                  <td>{s.reviewedBy?.name || <span className="text-slate-400">—</span>}</td>
                  <td className="text-[11px] text-slate-500 whitespace-nowrap">{s.createdAt ? new Date(s.createdAt).toLocaleString() : ''}</td>
                  <td className="text-[11px] text-slate-500 whitespace-nowrap">{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ''}</td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost" onClick={() => setViewing(s._id)}>View</button>
                    <button className="btn-ghost" onClick={() => setEditing(s)}>Edit</button>
                    {s.deleted ? (
                      <button className="btn-ghost text-green-700" onClick={() => doRestoreOne(s)}>Restore</button>
                    ) : (
                      <button className="btn-ghost text-red-600" onClick={() => doDeleteOne(s)}>Delete</button>
                    )}
                    <button className="btn-ghost" onClick={() => doMarkTestOne(s)}>
                      {s.isTestData ? 'Unmark Test' : 'Mark Test'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {!loading && data.total > limit && (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <div>
            Showing {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} of {data.total}
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
            <span className="px-2 py-1">Page {page} / {pages}</span>
            <button className="btn-ghost" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>Next →</button>
          </div>
        </div>
      )}

      {viewing && <ViewSubmissionModal id={viewing} onClose={() => setViewing(null)} />}
      {editing && <EditSubmissionModal row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {deleting && (
        <DeleteConfirmModal
          state={deleting}
          setState={setDeleting}
          onConfirm={async () => {
            try {
              if (deleting.ids.length === 1) {
                await api.post(`/submission-control/${deleting.ids[0]}/delete`, { confirm: deleting.confirm, reason: deleting.reason });
              } else {
                await api.post('/submission-control/bulk/delete', { ids: deleting.ids, confirm: deleting.confirm, reason: deleting.reason });
              }
              toast.success('Deleted');
              setDeleting(null);
              load();
            } catch (err) { toast.error(errMsg(err)); }
          }}
        />
      )}
    </div>
  );
}

/* ---------------- View modal ---------------- */
function ViewSubmissionModal({ id, onClose }) {
  const [sub, setSub] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/submission-control/${id}`).then((r) => setSub(r.data)).catch((e) => setErr(errMsg(e)));
  }, [id]);
  return (
    <Modal open onClose={onClose} size="xl" title="Submission Details">
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {!sub ? <Loader /> : (
        <div className="space-y-4 text-sm">
          <Section title="Overview">
            <KV k="Employee" v={`${sub.employee?.name || ''} (${sub.employee?.employeeId || ''})`} />
            <KV k="Department" v={sub.employee?.department?.name || ''} />
            <KV k="Template" v={sub.template?.title || ''} />
            <KV k="Type" v={`${sub.templateType || ''}${sub.customKind ? ` / ${sub.customKind}` : ''}`} />
            <KV k="Date" v={String(sub.date || '').slice(0, 10)} />
            <KV k="Submitted" v={sub.submitted ? 'Yes' : 'No'} />
            <KV k="Review" v={`${sub.reviewStatus || ''} (stage: ${sub.currentReviewStage || '—'})`} />
            <KV k="Scores" v={`${sub.earnedPoints ?? 0} / ${sub.totalPoints ?? 0}`} />
            {/* Verification-audit fix (spec item 5) -- full breakdown so
                HR can see EXACTLY which categories deducted marks.
                Available / Earned / per-category penalties / total /
                Final are always shown together when any penalty is
                present.  Historical earnedPoints stays untouched. */}
            {sub.penaltyBreakdown && sub.penaltyBreakdown.totalDeducted > 0 && (() => {
              const bd = sub.penaltyBreakdown;
              const sumMarks = (list) => list.reduce((s, p) => s + (Number(p.penaltyMarks) || 0), 0);
              return (
                <>
                  <KV k="Available Marks" v={`${sub.totalPoints ?? 0}`} />
                  <KV k="Earned Marks"    v={`${sub.earnedPoints ?? 0}`} />
                  <KV k="Attendance Penalty"     v={`−${sumMarks(bd.attendance)}`} />
                  <KV k="Dependency Penalty"     v={`−${sumMarks(bd.dependency)}`} />
                  <KV k="Template Penalty (missing / critical / repeated)" v={`−${sumMarks(bd.template)}`} />
                  <KV k="Manual Penalty"         v={`−${sumMarks(bd.manual)}`} />
                  <KV k="Total Penalty"          v={`−${bd.totalDeducted}`} />
                  <KV k="Final Marks"            v={`${sub.finalMarks ?? 0}`} />
                </>
              );
            })()}
            <KV k="Deleted" v={sub.deleted ? `Yes — by ${sub.deletedBy?.name || ''} on ${sub.deletedAt ? new Date(sub.deletedAt).toLocaleString() : ''}` : 'No'} />
            <KV k="Test Data" v={sub.isTestData ? `Yes — by ${sub.testDataMarkedBy?.name || ''}` : 'No'} />
          </Section>
          {Array.isArray(sub.customResponses) && sub.customResponses.length > 0 && (
            <Section title="Predefined Tasks">
              <pre className="bg-slate-50 border border-slate-200 rounded p-3 text-xs overflow-x-auto">{JSON.stringify(sub.customResponses, null, 2)}</pre>
            </Section>
          )}
          {/* Phase 59 -- Extra Tasks rendered as their OWN section so
              Submission Control matches Submission Review's layout. */}
          {Array.isArray(sub.extraTasks) && sub.extraTasks.length > 0 && (
            <Section title={`Extra Tasks (${sub.extraTasks.length})`}>
              <div className="grid gap-2">
                {sub.extraTasks.map((r, i) => {
                  const wantsValue  = r.responseType === 'number' || r.responseType === 'number_status';
                  const wantsStatus = r.responseType === 'status' || r.responseType === 'number_status';
                  const hasMarks = (r.availableMarks || 0) > 0 || (r.earnedMarks || 0) > 0 || (r.penaltyMarks || 0) > 0;
                  return (
                    <div key={i} className="rounded border border-slate-200 p-2 text-xs">
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-slate-800">{r.label}</div>
                          <div className="text-[10px] uppercase text-slate-500">{r.responseType}</div>
                          {r.description && <div className="text-[11px] text-slate-500">{r.description}</div>}
                          {r.remark && <div className="text-[11px] text-slate-600 mt-0.5"><b>Remark:</b> {r.remark}</div>}
                        </div>
                        <div className="flex items-center gap-1 text-[10px] shrink-0">
                          {wantsValue && (
                            <span className="badge bg-blue-50 text-blue-700">
                              Value: <b>{r.value === '' || r.value == null ? '—' : String(r.value)}</b>
                              {r.responseType === 'number_status' && r.outOfValue > 0 && <> / <b>{r.outOfValue}</b></>}
                            </span>
                          )}
                          {wantsStatus && r.status && (
                            <span className="badge bg-slate-100 text-slate-700">
                              {r.status === 'work_not_available' ? 'Work N/A' : r.status[0].toUpperCase() + r.status.slice(1)}
                            </span>
                          )}
                          {hasMarks && (
                            <span className="badge bg-purple-50 text-purple-700">
                              {r.earnedMarks ?? 0}/{r.availableMarks ?? 0}
                              {r.penaltyMarks > 0 && <> <span className="text-red-700">-{r.penaltyMarks}</span></>}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}
          {Array.isArray(sub.productSales) && sub.productSales.length > 0 && (
            <Section title={`Product Sales (${sub.productSales.length})`}>
              <pre className="bg-slate-50 border border-slate-200 rounded p-3 text-xs overflow-x-auto">{JSON.stringify(sub.productSales, null, 2)}</pre>
            </Section>
          )}
          {Array.isArray(sub.farmerRecords) && sub.farmerRecords.length > 0 && (
            <Section title={`Farmer Records (${sub.farmerRecords.length})`}>
              <pre className="bg-slate-50 border border-slate-200 rounded p-3 text-xs overflow-x-auto">{JSON.stringify(sub.farmerRecords, null, 2)}</pre>
            </Section>
          )}
          {Array.isArray(sub.tasks) && sub.tasks.length > 0 && (
            <Section title={`Tasks (${sub.tasks.length})`}>
              <pre className="bg-slate-50 border border-slate-200 rounded p-3 text-xs overflow-x-auto">{JSON.stringify(sub.tasks, null, 2)}</pre>
            </Section>
          )}
          {/* Phase 60 -- Employee Private Remark.  Backend never
              serves this to a HOD; if the field is present the
              current viewer is HR / Super Admin, so it's safe to
              render as its own Section. */}
          {typeof sub.privateRemark === 'string' && sub.privateRemark.trim() && (
            <Section title={sub.template?.privateRemarkLabel
              ? `${sub.template.privateRemarkLabel} (private)`
              : 'Employee Private Remark (private)'}>
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600 flex-wrap">
                  <span className="uppercase tracking-wide font-semibold text-amber-800">
                    HR / Super Admin only
                  </span>
                  <span>
                    {sub.employee?.name || ''}
                    {sub.employee?.name && (sub.privateRemarkSubmittedAt || sub.submittedAt) ? ' · ' : ''}
                    {sub.privateRemarkSubmittedAt
                      ? new Date(sub.privateRemarkSubmittedAt).toLocaleString()
                      : (sub.submittedAt ? new Date(sub.submittedAt).toLocaleString() : '')}
                  </span>
                </div>
                <div className="text-sm text-slate-800 whitespace-pre-wrap">{sub.privateRemark}</div>
              </div>
            </Section>
          )}
          {Array.isArray(sub.reviewHistory) && sub.reviewHistory.length > 0 && (
            <Section title={`Review History (${sub.reviewHistory.length})`}>
              <pre className="bg-slate-50 border border-slate-200 rounded p-3 text-xs overflow-x-auto">{JSON.stringify(sub.reviewHistory, null, 2)}</pre>
            </Section>
          )}
          {Array.isArray(sub.editHistory) && sub.editHistory.length > 0 && (
            <Section title={`Edit History (${sub.editHistory.length})`}>
              <pre className="bg-slate-50 border border-slate-200 rounded p-3 text-xs overflow-x-auto">{JSON.stringify(sub.editHistory, null, 2)}</pre>
            </Section>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ---------------- Edit modal (freeze-mode) ---------------- */
function EditSubmissionModal({ row, onClose, onSaved }) {
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState({});
  const toast = useToast();

  useEffect(() => {
    api.get(`/submission-control/${row._id}`).then((r) => {
      setSub(r.data);
      setDraft({
        customResponses: JSON.stringify(r.data.customResponses || [], null, 2),
        productSales:    JSON.stringify(r.data.productSales    || [], null, 2),
        farmerRecords:   JSON.stringify(r.data.farmerRecords   || [], null, 2),
        disciplineNote:  r.data.disciplineNote || '',
        ideaFeedback:    r.data.ideaFeedback || '',
      });
    }).catch((e) => toast.error(errMsg(e)));
  }, [row._id]);

  const save = async () => {
    setBusy(true);
    try {
      const payload = { note };
      const tryParse = (s) => { try { return JSON.parse(s); } catch { throw new Error('Invalid JSON: ' + s.slice(0, 40)); } };
      if (draft.customResponses !== undefined) payload.customResponses = tryParse(draft.customResponses);
      if (draft.productSales    !== undefined) payload.productSales    = tryParse(draft.productSales);
      if (draft.farmerRecords   !== undefined) payload.farmerRecords   = tryParse(draft.farmerRecords);
      if (draft.disciplineNote  !== undefined) payload.disciplineNote  = draft.disciplineNote;
      if (draft.ideaFeedback    !== undefined) payload.ideaFeedback    = draft.ideaFeedback;
      await api.put(`/submission-control/${row._id}`, payload);
      toast.success('Saved'); onSaved();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} size="xl" title={`Edit Submission — ${row.employee?.name || ''} · ${String(row.date).slice(0, 10)}`}
      footer={<>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={busy || !sub}>{busy ? 'Saving…' : 'Save'}</button>
      </>}
    >
      {!sub ? <Loader /> : (
        <div className="space-y-3 text-sm">
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-amber-800 text-xs">
            <b>Freeze mode:</b> the server writes exactly what you send here.
            Sales / NBV / quantity values stored on rows are NOT recomputed; if you change a product quantity,
            also update the matching salesValue + nbvValue inline.
          </div>
          <div>
            <label className="label">Custom Responses (JSON)</label>
            <textarea className="input font-mono text-xs" rows={6} value={draft.customResponses} onChange={(e) => setDraft({ ...draft, customResponses: e.target.value })} />
          </div>
          <div>
            <label className="label">Product Sales (JSON)</label>
            <textarea className="input font-mono text-xs" rows={6} value={draft.productSales} onChange={(e) => setDraft({ ...draft, productSales: e.target.value })} />
          </div>
          <div>
            <label className="label">Farmer Records (JSON)</label>
            <textarea className="input font-mono text-xs" rows={6} value={draft.farmerRecords} onChange={(e) => setDraft({ ...draft, farmerRecords: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Discipline Note</label>
              <input className="input" value={draft.disciplineNote || ''} onChange={(e) => setDraft({ ...draft, disciplineNote: e.target.value })} />
            </div>
            <div>
              <label className="label">Idea Feedback</label>
              <input className="input" value={draft.ideaFeedback || ''} onChange={(e) => setDraft({ ...draft, ideaFeedback: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="label">Edit Note (audited)</label>
            <input className="input" placeholder="Why are you editing this submission?" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------------- Type-DELETE confirm modal ---------------- */
function DeleteConfirmModal({ state, setState, onConfirm }) {
  const ok = state.confirm === 'DELETE';
  return (
    <Modal open onClose={() => setState(null)} size="md" title="Confirm Soft-Delete"
      footer={<>
        <button className="btn-secondary" onClick={() => setState(null)}>Cancel</button>
        <button className="btn-primary text-white bg-red-600 hover:bg-red-700" disabled={!ok} onClick={onConfirm}>I understand — Delete</button>
      </>}
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-red-800 text-sm">
          <div className="font-semibold mb-1">WARNING</div>
          Soft-deleting <b>{state.label}</b> will:
          <ul className="list-disc pl-5 mt-1 space-y-0.5">
            <li>Hide it from every analytics view (Calling, Product &amp; Farmer, Dealer, Pendency, Completion, Performance, Leaderboards)</li>
            <li>Hide it from the employee's history and from review queues</li>
            <li>Hide it from salary completion calculations</li>
            <li>Keep it in the database so you (or another admin) can restore it later</li>
          </ul>
        </div>
        <div>
          <label className="label">Reason (audited)</label>
          <input className="input" placeholder="e.g. test data from QA pass" value={state.reason} onChange={(e) => setState({ ...state, reason: e.target.value })} />
        </div>
        <div>
          <label className="label">Type <code className="bg-slate-100 px-1 rounded">DELETE</code> to continue</label>
          <input className="input" value={state.confirm} onChange={(e) => setState({ ...state, confirm: e.target.value })} />
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- tiny presentational helpers ---------------- */
const Section = ({ title, children }) => (
  <div>
    <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">{title}</div>
    <div className="space-y-1">{children}</div>
  </div>
);
const KV = ({ k, v }) => (
  <div className="flex gap-3 text-sm">
    <div className="w-32 text-slate-500">{k}</div>
    <div className="text-slate-800 font-medium break-all">{v || <span className="text-slate-400">—</span>}</div>
  </div>
);
