import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/axios';
import StatCard from '../../components/StatCard.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import Modal from '../../components/Modal.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { ClickableCard } from '../../components/AnalyticsDrillDown.jsx';
import MentionTagTextarea from '../../components/MentionTagTextarea.jsx';
import ParticipantPicker from '../../components/ParticipantPicker.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtDate } from '../../utils/helpers';

/**
 * Employee Interactions -- unified HR case-management + searchable
 * history.  Uses the shared HRMS design language (StatCard, Loader,
 * Modal, SearchableSelect, ClickableCard) so no new UI vocabulary is
 * introduced.
 */

const TYPE_META = {
  meeting:                { label: 'Meeting',                 icon: '📅', color: '#0ea5e9' },
  personal_note:          { label: 'Personal Note',           icon: '📝', color: '#64748b' },
  warning:                { label: 'Warning',                 icon: '⚠️', color: '#ef4444' },
  appreciation:           { label: 'Appreciation',            icon: '⭐', color: '#22c55e' },
  follow_up:              { label: 'Follow-up',               icon: '🔁', color: '#6366f1' },
  coaching:               { label: 'Coaching Session',        icon: '🎯', color: '#8b5cf6' },
  performance_discussion: { label: 'Performance Discussion',  icon: '📊', color: '#f59e0b' },
  salary_discussion:      { label: 'Salary Discussion',       icon: '💰', color: '#eab308' },
  training:               { label: 'Training',                icon: '🎓', color: '#0ea5e9' },
  probation_review:       { label: 'Probation Review',        icon: '🗓', color: '#0891b2' },
  exit_discussion:        { label: 'Exit Discussion',         icon: '🚪', color: '#dc2626' },
  other:                  { label: 'Other',                   icon: '💬', color: '#94a3b8' },
};

const VIS_LABEL = {
  hr_only: 'HR Only',
  managers_hr: 'Managers + HR',
  employee_visible: 'Employee Visible',
};

const debounce = (fn, ms = 300) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

export default function EmployeeInteractions() {
  const toast = useToast();
  const { user } = useAuth();
  const canManage = user?.role === 'hr' || user?.role === 'super_admin';

  const [analytics, setAnalytics] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const perPage = 25;
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Filters
  const [filters, setFilters] = useState({
    from: '', to: '', type: '', department: '', designation: '',
    employee: '', createdBy: '', tag: '', visibility: '', status: '',
    followUp: '', search: '',
  });
  const setFilter = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };

  const [opts, setOpts] = useState({ departments: [], designations: [], employees: [], hr: [], tags: [] });

  useEffect(() => {
    Promise.all([
      api.get('/departments').then((r) => r.data).catch(() => []),
      api.get('/designations').then((r) => r.data).catch(() => []),
      api.get('/employees', { params: { status: 'active' } }).then((r) => r.data).catch(() => []),
      api.get('/interaction-tags').then((r) => r.data).catch(() => []),
    ]).then(([departments, designations, employees, tags]) => {
      const hr = (employees || []).filter((e) => e.role === 'hr' || e.role === 'super_admin');
      setOpts({ departments, designations, employees, hr, tags });
    });
  }, []);

  const loadList = () => {
    setLoading(true);
    const params = { page, perPage };
    for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
    api.get('/interactions', { params })
      .then(({ data }) => { setRows(data.rows || []); setTotal(data.total || 0); })
      .catch((err) => toast.error(errMsg(err)))
      .finally(() => setLoading(false));
  };
  const loadAnalytics = () => {
    api.get('/interactions/analytics').then(({ data }) => setAnalytics(data)).catch(() => setAnalytics(null));
  };
  useEffect(() => { loadAnalytics(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [page, JSON.stringify(filters)]);

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Employee Interactions</h1>
          <p className="text-sm text-slate-500">Searchable history of every meeting, note, warning, appreciation, coaching session and more.</p>
        </div>
        <div className="flex gap-2">
          {user?.role === 'super_admin' && <Link to="/interactions/tags" className="btn-secondary">Manage Tags</Link>}
          {canManage && <button className="btn-primary" onClick={() => setCreateOpen(true)}>+ New Interaction</button>}
        </div>
      </div>

      {analytics && (
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          <ClickableCard onClick={() => setFilter('type', '')}>
            <StatCard label="Total Interactions" value={analytics.cards.totalInteractions} accent="slate" />
          </ClickableCard>
          <ClickableCard onClick={() => setFilter('type', 'meeting')}>
            <StatCard label="Meetings" value={analytics.cards.meetings} accent="blue" />
          </ClickableCard>
          <ClickableCard onClick={() => setFilter('type', 'warning')}>
            <StatCard label="Warnings" value={analytics.cards.warnings} accent="red" />
          </ClickableCard>
          <ClickableCard onClick={() => setFilter('type', 'appreciation')}>
            <StatCard label="Appreciations" value={analytics.cards.appreciations} accent="green" />
          </ClickableCard>
          <ClickableCard onClick={() => setFilter('followUp', 'open')}>
            <StatCard label="Open Follow-ups" value={analytics.cards.openFollowUps} accent="amber" />
          </ClickableCard>
          <StatCard label="Today's Meetings" value={analytics.cards.todayMeetings} accent="blue" />
          <StatCard label="This Month" value={analytics.cards.thisMonth} accent="brand" />
          <StatCard
            label="Most Active HR"
            value={analytics.cards.mostActiveHr?.name || '—'}
            accent="brand"
            sub={analytics.cards.mostActiveHr ? `${analytics.cards.mostActiveHr.count} interactions` : ''}
          />
        </div>
      )}

      <div className="card card-body flex flex-wrap items-end gap-3">
        <div>
          <label className="label">From</label>
          <input className="input max-w-[150px]" type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
        </div>
        <div>
          <label className="label">To</label>
          <input className="input max-w-[150px]" type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
        </div>
        <div>
          <label className="label">Type</label>
          <select className="input max-w-[180px]" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
            <option value="">All</option>
            {Object.entries(TYPE_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Department</label>
          <select className="input max-w-[180px]" value={filters.department} onChange={(e) => setFilter('department', e.target.value)}>
            <option value="">All</option>
            {opts.departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Designation</label>
          <select className="input max-w-[180px]" value={filters.designation} onChange={(e) => setFilter('designation', e.target.value)}>
            <option value="">All</option>
            {opts.designations.map((d) => <option key={d._id} value={d._id}>{d.title}</option>)}
          </select>
        </div>
        <div className="min-w-[220px]">
          <label className="label">Employee</label>
          <SearchableSelect
            value={filters.employee} onChange={(v) => setFilter('employee', v)}
            options={opts.employees} getValue={(e) => e._id}
            getLabel={(e) => `${e.name} (${e.employeeId || ''})`}
            getSearchText={(e) => `${e.name} ${e.employeeId || ''}`}
            placeholder="All employees"
          />
        </div>
        <div className="min-w-[200px]">
          <label className="label">Created By</label>
          <SearchableSelect
            value={filters.createdBy} onChange={(v) => setFilter('createdBy', v)}
            options={opts.hr} getValue={(e) => e._id}
            getLabel={(e) => `${e.name}`}
            placeholder="Anyone"
          />
        </div>
        <div>
          <label className="label">Tag</label>
          <select className="input max-w-[200px]" value={filters.tag} onChange={(e) => setFilter('tag', e.target.value)}>
            <option value="">All</option>
            {opts.tags.filter((t) => !t.archived).map((t) => <option key={t._id} value={t._id}>@{t.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Visibility</label>
          <select className="input max-w-[160px]" value={filters.visibility} onChange={(e) => setFilter('visibility', e.target.value)}>
            <option value="">All</option>
            <option value="hr_only">HR Only</option>
            <option value="managers_hr">Managers + HR</option>
            <option value="employee_visible">Employee Visible</option>
          </select>
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input max-w-[160px]" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">All</option>
            <option value="scheduled">Scheduled</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div className="flex-1 min-w-[240px]">
          <label className="label">Search everything</label>
          <input
            className="input" type="search"
            placeholder="Titles, notes, employees, tags, any sentence"
            defaultValue={filters.search}
            onChange={debounce((e) => setFilter('search', e.target.value), 300)}
          />
        </div>
      </div>

      {loading ? <Loader /> : rows.length === 0 ? (
        <EmptyState title="No interactions match the current filters" />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <InteractionCard key={r._id} row={r} onOpen={() => setDetailId(r._id)} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <div>Page {page} of {totalPages} · {total} interactions</div>
          <div className="flex items-center gap-1">
            <button className="btn-ghost !py-1 !text-xs" disabled={page === 1} onClick={() => setPage(1)}>« First</button>
            <button className="btn-ghost !py-1 !text-xs" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
            <button className="btn-ghost !py-1 !text-xs" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
            <button className="btn-ghost !py-1 !text-xs" disabled={page === totalPages} onClick={() => setPage(totalPages)}>Last »</button>
          </div>
        </div>
      )}

      {detailId && (
        <InteractionDetailModal id={detailId} onClose={() => setDetailId(null)} onChanged={() => { loadList(); loadAnalytics(); }} tags={opts.tags} employees={opts.employees} canManage={canManage} />
      )}
      {createOpen && (
        <NewInteractionModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); loadList(); loadAnalytics(); }}
          employees={opts.employees} departments={opts.departments} tags={opts.tags}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------- */
function InteractionCard({ row, onOpen }) {
  const meta = TYPE_META[row.type] || TYPE_META.other;
  const meeting = row.meeting?.date;
  return (
    <button onClick={onOpen} className="card card-body w-full text-left hover:border-brand-300">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span style={{ color: meta.color }}>{meta.icon}</span>
            <span className="badge text-[11px] border" style={{ borderColor: meta.color, color: meta.color }}>{meta.label}</span>
            {row.followUp?.required && !row.followUp?.resolvedAt && (
              <span className="badge text-[11px] border bg-amber-50 text-amber-700 border-amber-200">Follow-up open</span>
            )}
            <span className="text-[11px] text-slate-500">{VIS_LABEL[row.visibility]}</span>
          </div>
          <div className="text-sm font-semibold text-slate-800">{row.title}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {meeting ? fmtDate(meeting) : fmtDate(row.createdAt)}
            {row.meeting?.time && <> · {row.meeting.time}</>}
            {row.createdBy?.name && <> · by {row.createdBy.name}</>}
            {row.participants?.length > 0 && <> · {row.participants.length} participant{row.participants.length !== 1 ? 's' : ''}</>}
            {row.notesCount > 0 && <> · {row.notesCount} note{row.notesCount !== 1 ? 's' : ''}</>}
          </div>
          {row.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {row.tags.map((t) => (
                <span key={t._id} className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: `${t.color}22`, color: t.color, border: `1px solid ${t.color}55` }}>
                  @{t.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Status</div>
          <div className="text-sm font-semibold capitalize">{row.status || 'scheduled'}</div>
        </div>
      </div>
    </button>
  );
}

/* ==================================================
 * New Interaction modal
 * ================================================== */
function NewInteractionModal({ onClose, onCreated, employees, departments, tags }) {
  const toast = useToast();
  const [f, setF] = useState({
    type: 'meeting', title: '', description: '', visibility: 'hr_only',
    meeting: { date: '', time: '', durationMinutes: 30, mode: 'offline', location: '', meetingType: '' },
    participants: [], tags: [], mentions: [], department: '',
    followUp: { required: false, dueDate: '' },
  });
  const [busy, setBusy] = useState(false);
  const set  = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const setM = (k, v) => setF((s) => ({ ...s, meeting: { ...s.meeting, [k]: v } }));

  const isMeeting = ['meeting', 'coaching', 'training', 'performance_discussion', 'salary_discussion', 'probation_review', 'exit_discussion', 'follow_up'].includes(f.type);

  const save = async () => {
    if (!f.title.trim()) { toast.error('Title is required.'); return; }
    setBusy(true);
    try {
      await api.post('/interactions', {
        ...f,
        meeting: isMeeting ? f.meeting : undefined,
        participants: f.participants.map((p) => ({ employee: p })),
      });
      toast.success('Interaction created');
      onCreated?.();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} size="lg" title="New Interaction"
      footer={<><button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={busy}>Save</button></>}>
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="label">Type</label>
            <select className="input" value={f.type} onChange={(e) => set('type', e.target.value)}>
              {Object.entries(TYPE_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Visibility</label>
            <select className="input" value={f.visibility} onChange={(e) => set('visibility', e.target.value)}>
              <option value="hr_only">HR Only</option>
              <option value="managers_hr">Managers + HR</option>
              <option value="employee_visible">Employee Visible</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label">Title</label>
            <input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Weekly Marketing Sync, Verbal Warning — Dealer Complaint" />
          </div>
          <div className="md:col-span-2">
            <label className="label">Description</label>
            <MentionTagTextarea
              rows={3}
              value={f.description}
              onChange={(v) => set('description', v)}
              tags={tags}
              onMentionPicked={(u) => set('mentions', Array.from(new Set([...(f.mentions || []), String(u._id)])))}
              onTagPicked={(t) => set('tags', Array.from(new Set([...(f.tags || []), String(t._id)])))}
              placeholder="Type ! to mention an employee, @ to add a tag."
            />
          </div>
        </div>

        {isMeeting && (
          <div className="grid md:grid-cols-3 gap-3">
            <div>
              <label className="label">Meeting Date</label>
              <input className="input" type="date" value={f.meeting.date} onChange={(e) => setM('date', e.target.value)} />
            </div>
            <div>
              <label className="label">Time</label>
              <input className="input" type="time" value={f.meeting.time} onChange={(e) => setM('time', e.target.value)} />
            </div>
            <div>
              <label className="label">Duration (min)</label>
              <input className="input" type="number" min="0" value={f.meeting.durationMinutes} onChange={(e) => setM('durationMinutes', Number(e.target.value))} />
            </div>
            <div>
              <label className="label">Mode</label>
              <select className="input" value={f.meeting.mode} onChange={(e) => setM('mode', e.target.value)}>
                <option value="offline">Offline</option>
                <option value="online">Online</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="label">Location / Link</label>
              <input className="input" value={f.meeting.location} onChange={(e) => setM('location', e.target.value)} />
            </div>
          </div>
        )}

        <div>
          <label className="label">Participants</label>
          <ParticipantPicker
            value={f.participants}
            onChange={(next) => set('participants', next)}
            employees={employees}
          />
        </div>

        <div>
          <label className="label">Tags</label>
          <ParticipantPicker
            value={f.tags}
            onChange={(next) => set('tags', next)}
            employees={(tags || []).filter((t) => !t.archived).map((t) => ({
              _id: t._id, name: `@${t.name}`, employeeId: t.category, department: '',
            }))}
          />
          <div className="text-[11px] text-slate-500 mt-1">Tags can also be added by typing <span className="font-mono">@</span> inside the description or a note.</div>
        </div>

        <div className="grid md:grid-cols-3 gap-3 items-end">
          <div>
            <label className="label">Department</label>
            <select className="input" value={f.department} onChange={(e) => set('department', e.target.value)}>
              <option value="">—</option>
              {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={f.followUp.required} onChange={(e) => set('followUp', { ...f.followUp, required: e.target.checked })} />
            Requires Follow-up
          </label>
          {f.followUp.required && (
            <div>
              <label className="label">Follow-up date</label>
              <input className="input" type="date" value={f.followUp.dueDate} onChange={(e) => set('followUp', { ...f.followUp, dueDate: e.target.value })} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ==================================================
 * Interaction Detail modal
 * ================================================== */
function InteractionDetailModal({ id, onClose, onChanged, tags, employees, canManage }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [noteBody, setNoteBody] = useState('');
  const [noteTags, setNoteTags] = useState([]);
  const [noteVis, setNoteVis] = useState('hr_only');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    api.get(`/interactions/${id}`)
      .then(({ data }) => setData(data))
      .catch((err) => { toast.error(errMsg(err)); onClose(); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  const addNote = async () => {
    if (!noteBody.trim()) { toast.error('Note body is required.'); return; }
    setBusy(true);
    try {
      await api.post(`/interactions/${id}/notes`, { body: noteBody.trim(), tags: noteTags, visibility: noteVis });
      setNoteBody(''); setNoteTags([]); setNoteVis('hr_only');
      toast.success('Note added');
      load(); onChanged?.();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  const setAttendance = async (empId, attendanceStatus) => {
    try {
      await api.put(`/interactions/${id}/attendance`, { employeeId: empId, attendanceStatus });
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const resolveFollowUp = async () => {
    try {
      await api.post(`/interactions/${id}/follow-up/resolve`);
      toast.success('Follow-up resolved');
      load(); onChanged?.();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const deleteInteraction = async () => {
    if (!confirm('Delete this interaction and all its notes?')) return;
    try {
      await api.delete(`/interactions/${id}`);
      toast.success('Deleted');
      onClose(); onChanged?.();
    } catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <Modal open onClose={onClose} size="xl" title={data?.interaction?.title || 'Interaction'}
      footer={<div className="flex justify-between w-full">
        <div>{canManage && <button className="btn-ghost text-red-600" onClick={deleteInteraction}>Delete</button>}</div>
        <button className="btn-primary" onClick={onClose}>Close</button>
      </div>}>
      {loading || !data ? <Loader /> : (
        <div className="space-y-4">
          <InteractionSummary interaction={data.interaction} onResolveFollowUp={resolveFollowUp} />
          <ParticipantsPanel participants={data.interaction.participants || []} onSetAttendance={canManage ? setAttendance : null} />
          <NotesPanel notes={data.notes} />
          {canManage && (
            <div className="card card-body space-y-2 border-brand-200">
              <div className="text-sm font-semibold">Add Note</div>
              <MentionTagTextarea
                rows={3}
                value={noteBody}
                onChange={setNoteBody}
                tags={tags}
                onMentionPicked={() => { /* body already has !Name */ }}
                onTagPicked={(t) => setNoteTags((cur) => Array.from(new Set([...cur, String(t._id)])))}
                placeholder="Type ! to mention an employee, @ to add a tag."
              />
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex-1 min-w-[220px]">
                  <ParticipantPicker
                    value={noteTags}
                    onChange={setNoteTags}
                    employees={(tags || []).filter((t) => !t.archived).map((t) => ({
                      _id: t._id, name: `@${t.name}`, employeeId: t.category, department: '',
                    }))}
                  />
                </div>
                <select className="input max-w-[180px]" value={noteVis} onChange={(e) => setNoteVis(e.target.value)}>
                  <option value="hr_only">HR Only</option>
                  <option value="managers_hr">Managers + HR</option>
                  <option value="employee_visible">Employee Visible</option>
                </select>
                <button className="btn-primary" onClick={addNote} disabled={busy}>Add Note</button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function InteractionSummary({ interaction, onResolveFollowUp }) {
  const meta = TYPE_META[interaction.type] || TYPE_META.other;
  return (
    <div className="card card-body">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span style={{ color: meta.color }}>{meta.icon}</span>
            <span className="badge text-[11px] border" style={{ borderColor: meta.color, color: meta.color }}>{meta.label}</span>
            <span className="badge text-[11px] border bg-slate-50 text-slate-600 border-slate-200">{VIS_LABEL[interaction.visibility]}</span>
          </div>
          <div className="text-sm text-slate-600 whitespace-pre-wrap">{interaction.description || <span className="text-slate-400 italic">No description</span>}</div>
          <div className="text-[11px] text-slate-500 mt-2">
            Created {fmtDate(interaction.createdAt)}
            {interaction.createdBy?.name && <> by {interaction.createdBy.name}</>}
          </div>
        </div>
        <div className="text-right text-[11px] text-slate-500">
          {interaction.meeting?.date && (
            <>
              <div>Scheduled: {fmtDate(interaction.meeting.date)} {interaction.meeting.time}</div>
              {interaction.meeting.durationMinutes ? <div>{interaction.meeting.durationMinutes} min</div> : null}
              {interaction.meeting.mode && <div className="capitalize">{interaction.meeting.mode}</div>}
              {interaction.meeting.location && <div>📍 {interaction.meeting.location}</div>}
            </>
          )}
        </div>
      </div>
      {interaction.tags?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {interaction.tags.map((t) => (
            <span key={t._id} className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: `${t.color}22`, color: t.color, border: `1px solid ${t.color}55` }}>
              @{t.name}
            </span>
          ))}
        </div>
      )}
      {interaction.followUp?.required && (
        <div className="mt-2 flex items-center gap-2 text-xs text-amber-700">
          <span>Follow-up {interaction.followUp.resolvedAt ? 'resolved' : `due ${interaction.followUp.dueDate ? fmtDate(interaction.followUp.dueDate) : 'soon'}`}</span>
          {!interaction.followUp.resolvedAt && (
            <button className="btn-secondary !py-0.5 !text-xs" onClick={onResolveFollowUp}>Resolve</button>
          )}
        </div>
      )}
    </div>
  );
}

const INV_META = { invited: 'Invited', accepted: 'Accepted', declined: 'Declined', maybe: 'Maybe' };
const ATT_META = { present: 'Present', absent: 'Absent', late: 'Late', left_early: 'Left Early', excused: 'Excused' };

function ParticipantsPanel({ participants, onSetAttendance }) {
  if (participants.length === 0) return (
    <div className="card card-body text-xs text-slate-500 italic">No participants</div>
  );
  return (
    <div className="card card-body">
      <div className="text-sm font-semibold mb-2">Participants</div>
      <div className="space-y-1.5">
        {participants.map((p) => (
          <div key={String(p.employee?._id || p.employee)} className="flex items-center justify-between flex-wrap gap-2 text-sm">
            <div className="min-w-0">
              <span className="font-medium text-slate-800">{p.employee?.name || 'Unknown'}</span>{' '}
              <span className="text-slate-400">({p.employee?.employeeId})</span>
              <span className="ml-2 badge text-[10px] border bg-slate-50 text-slate-600 border-slate-200">{INV_META[p.invitationStatus] || p.invitationStatus}</span>
              {p.attendanceStatus && <span className="ml-1 badge text-[10px] border bg-brand-50 text-brand-700 border-brand-200">{ATT_META[p.attendanceStatus] || p.attendanceStatus}</span>}
            </div>
            {onSetAttendance && (
              <select className="input !py-0.5 !text-xs max-w-[160px]"
                value={p.attendanceStatus || ''}
                onChange={(e) => onSetAttendance(String(p.employee?._id || p.employee), e.target.value || null)}>
                <option value="">— set attendance —</option>
                {Object.entries(ATT_META).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function NotesPanel({ notes }) {
  if (!notes || notes.length === 0) return (
    <div className="card card-body text-xs text-slate-500 italic">No notes yet</div>
  );
  return (
    <div className="card card-body">
      <div className="text-sm font-semibold mb-2">Notes ({notes.length})</div>
      <div className="space-y-2">
        {notes.map((n) => (
          <div key={n._id} className="border-l-2 border-slate-200 pl-3 py-1">
            <div className="text-[11px] text-slate-500 mb-0.5">
              {n.author?.name || 'Unknown'} · {fmtDate(n.createdAt)}
              {n.lastEditedAt && <> · edited</>}
              <span className="ml-2 badge text-[10px] border bg-slate-50 text-slate-600 border-slate-200">{VIS_LABEL[n.visibility]}</span>
            </div>
            <div className="text-sm text-slate-800 whitespace-pre-wrap">{n.body}</div>
            {n.tags?.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {n.tags.map((t) => (
                  <span key={t._id} className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: `${t.color}22`, color: t.color, border: `1px solid ${t.color}55` }}>
                    @{t.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
