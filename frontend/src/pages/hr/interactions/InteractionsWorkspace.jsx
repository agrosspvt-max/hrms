import { useEffect, useMemo, useState } from 'react';
import api from '../../../api/axios';
import { Loader, EmptyState } from '../../../components/Loader.jsx';
import Modal from '../../../components/Modal.jsx';
import MentionTagTextarea from '../../../components/MentionTagTextarea.jsx';
import ParticipantPicker from '../../../components/ParticipantPicker.jsx';
import { useAuth } from '../../../context/AuthContext.jsx';
import { useToast } from '../../../context/ToastContext.jsx';
import { errMsg, fmtDate } from '../../../utils/helpers';
import { TAG_CATEGORIES, CATEGORY_COLOR, MEETING_TYPES } from './tagCategories.js';

/**
 * Employee Interactions -- redesigned single workspace.
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  Employee Interactions                                  │
 *   │  [Meetings]  [Notes]  [Manage Tags]                     │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  <active tab content>                                   │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Full dark-mode support via Tailwind `dark:` classes.  All chips /
 * dropdowns / cards use paired light/dark background + text values.
 */

const TABS = [
  { key: 'meetings',   label: 'Meetings' },
  { key: 'notes',      label: 'Notes' },
  { key: 'tags',       label: 'Manage Tags' },
];

export default function InteractionsWorkspace() {
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('interactions.tab') || 'meetings'; } catch { return 'meetings'; }
  });
  useEffect(() => { try { localStorage.setItem('interactions.tab', tab); } catch (_) {} }, [tab]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Employee Interactions</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Meetings, HR notebooks, and tags -- one workspace.</p>
      </div>

      <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-700">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === t.key
                ? 'border-brand-600 text-brand-700 dark:text-brand-300'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'meetings' && <MeetingsTab />}
      {tab === 'notes'    && <NotesTab />}
      {tab === 'tags'     && <TagsTab />}
    </div>
  );
}

/* ============================================================ */
/* MEETINGS TAB                                                 */
/* ============================================================ */
function MeetingsTab() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [filters, setFilters] = useState({ search: '', from: '', to: '', tag: '', createdBy: '', meetingType: '', participant: '' });
  const [tags, setTags] = useState([]);
  const [employees, setEmployees] = useState([]);

  useEffect(() => {
    Promise.all([
      api.get('/interaction-tags').then((r) => r.data).catch(() => []),
      api.get('/employees', { params: { status: 'active' } }).then((r) => r.data).catch(() => []),
    ]).then(([t, e]) => { setTags(t); setEmployees(e); });
  }, []);

  const load = () => {
    setLoading(true);
    const params = { type: 'meeting' };
    for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
    if (filters.participant) params.employee = filters.participant;
    api.get('/interactions', { params }).then(({ data }) => setRows(data.rows || []))
      .catch((err) => toast.error(errMsg(err))).finally(() => setLoading(false));
  };
  useEffect(load, [JSON.stringify(filters)]);   // eslint-disable-line

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <FilterBar
          filters={filters}
          onChange={setFilters}
          tags={tags}
          employees={employees}
          scope="meetings"
        />
        <button className="btn-primary" onClick={() => setOpenCreate(true)}>+ Create Meeting</button>
      </div>

      {loading ? <Loader /> : rows.length === 0 ? (
        <EmptyState title="No meetings match the current filters" />
      ) : (
        <div className="grid gap-2">
          {rows.map((r) => <MeetingCard key={r._id} m={r} onOpen={() => setOpenId(r._id)} />)}
        </div>
      )}

      {openCreate && (
        <CreateMeetingModal
          onClose={() => setOpenCreate(false)}
          onCreated={() => { setOpenCreate(false); load(); }}
          employees={employees}
          tags={tags}
        />
      )}
      {openId && (
        <MeetingDetailModal
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={load}
          tags={tags}
        />
      )}
    </div>
  );
}

function MeetingCard({ m, onOpen }) {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-brand-300 dark:hover:border-brand-500 transition p-3"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {m.meeting?.meetingType || 'Meeting'}
          </div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{m.title}</div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            {m.meeting?.date ? fmtDate(m.meeting.date) : fmtDate(m.createdAt)}
            {m.meeting?.time && <> · {m.meeting.time}</>}
            {m.createdBy?.name && <> · by {m.createdBy.name}</>}
            {m.participants?.length > 0 && <> · {m.participants.length} participant{m.participants.length !== 1 ? 's' : ''}</>}
          </div>
          {m.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {m.tags.map((t) => (
                <span
                  key={t._id}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: `${t.color}22`, color: t.color, border: `1px solid ${t.color}55` }}
                >@{t.name}</span>
              ))}
            </div>
          )}
        </div>
        <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">{m.status || 'scheduled'}</span>
      </div>
    </button>
  );
}

function CreateMeetingModal({ onClose, onCreated, employees, tags }) {
  const toast = useToast();
  const [f, setF] = useState({
    title: '', description: '', visibility: 'hr_only',
    meetingType: MEETING_TYPES[0], date: '', time: '', durationMinutes: 30,
    mode: 'offline', location: '',
    participants: [], tags: [], mentions: [],
    initialNote: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const save = async () => {
    if (!f.title.trim()) { toast.error('Title is required.'); return; }
    setBusy(true);
    try {
      const body = {
        type: 'meeting',
        title: f.title,
        description: f.description,
        visibility: f.visibility,
        meeting: {
          date: f.date, time: f.time, durationMinutes: f.durationMinutes,
          mode: f.mode, location: f.location, meetingType: f.meetingType,
        },
        participants: f.participants.map((p) => ({ employee: p })),
        tags: f.tags, mentions: f.mentions,
      };
      const { data } = await api.post('/interactions', body);
      if (f.initialNote.trim()) {
        try { await api.post(`/interactions/${data._id}/notes`, { body: f.initialNote.trim(), visibility: f.visibility }); }
        catch (_) { /* soft */ }
      }
      toast.success('Meeting created');
      onCreated();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} size="lg" title="Create Meeting"
      footer={<>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={busy}>Save</button>
      </>}
    >
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <label className="label">Meeting Title</label>
            <input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Weekly Marketing Sync" />
          </div>
          <div>
            <label className="label">Meeting Type</label>
            <select className="input" value={f.meetingType} onChange={(e) => set('meetingType', e.target.value)}>
              {MEETING_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
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
          <div>
            <label className="label">Meeting Date</label>
            <input className="input" type="date" value={f.date} onChange={(e) => set('date', e.target.value)} />
          </div>
          <div>
            <label className="label">Meeting Time</label>
            <input className="input" type="time" value={f.time} onChange={(e) => set('time', e.target.value)} />
          </div>
          <div>
            <label className="label">Duration (min)</label>
            <input className="input" type="number" value={f.durationMinutes} onChange={(e) => set('durationMinutes', Number(e.target.value))} />
          </div>
          <div>
            <label className="label">Meeting Mode</label>
            <select className="input" value={f.mode} onChange={(e) => set('mode', e.target.value)}>
              <option value="offline">Offline</option>
              <option value="online">Online</option>
              <option value="hybrid">Hybrid</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label">Meeting Link / Location</label>
            <input className="input" value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="Conference Room A / meet.google.com/..." />
          </div>
          <div className="md:col-span-2">
            <label className="label">Description</label>
            <MentionTagTextarea
              rows={3} value={f.description}
              onChange={(v) => set('description', v)}
              tags={tags}
              onMentionPicked={(u) => set('mentions', Array.from(new Set([...(f.mentions || []), String(u._id)])))}
              onTagPicked={(t) => set('tags', Array.from(new Set([...(f.tags || []), String(t._id)])))}
              placeholder="Type ! to mention an employee, @ to add a tag."
            />
          </div>
          <div className="md:col-span-2">
            <label className="label">Participants</label>
            <ParticipantPicker value={f.participants} onChange={(next) => set('participants', next)} employees={employees} />
          </div>
          <div className="md:col-span-2">
            <label className="label">Tags</label>
            <TagChipPicker value={f.tags} onChange={(v) => set('tags', v)} tags={tags} />
          </div>
          <div className="md:col-span-2">
            <label className="label">Initial Notes (optional)</label>
            <MentionTagTextarea
              rows={2} value={f.initialNote}
              onChange={(v) => set('initialNote', v)}
              tags={tags}
              onMentionPicked={() => {}}
              onTagPicked={() => {}}
              placeholder="Agenda, prep, expected outcome..."
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function MeetingDetailModal({ id, onClose, onChanged, tags }) {
  const toast = useToast();
  const { user } = useAuth();
  const canManage = user?.role === 'hr' || user?.role === 'super_admin';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [noteBody, setNoteBody] = useState('');
  const [noteTags, setNoteTags] = useState([]);
  const [status, setStatus] = useState('scheduled');

  const load = () => {
    setLoading(true);
    api.get(`/interactions/${id}`).then(({ data: d }) => {
      setData(d); setStatus(d.interaction?.status || 'scheduled');
    }).catch((err) => { toast.error(errMsg(err)); onClose(); }).finally(() => setLoading(false));
  };
  useEffect(load, [id]);   // eslint-disable-line

  const addNote = async () => {
    if (!noteBody.trim()) { toast.error('Note body is required.'); return; }
    try {
      await api.post(`/interactions/${id}/notes`, { body: noteBody.trim(), tags: noteTags });
      setNoteBody(''); setNoteTags([]);
      load(); onChanged?.();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const setAttendance = async (empId, s) => {
    try { await api.put(`/interactions/${id}/attendance`, { employeeId: empId, attendanceStatus: s }); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const changeStatus = async (s) => {
    try { await api.put(`/interactions/${id}`, { status: s }); setStatus(s); onChanged?.(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <Modal open onClose={onClose} size="xl" title={data?.interaction?.title || 'Meeting'}
      footer={<button className="btn-primary" onClick={onClose}>Close</button>}
    >
      {loading || !data ? <Loader /> : (
        <div className="space-y-4">
          {/* Meeting Information */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 bg-slate-50 dark:bg-slate-800/50">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">Meeting Information</div>
            <div className="text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap">
              {data.interaction.description || <span className="italic text-slate-400">No description</span>}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-2 space-x-2">
              {data.interaction.meeting?.date && <span>📅 {fmtDate(data.interaction.meeting.date)} {data.interaction.meeting.time}</span>}
              {data.interaction.meeting?.durationMinutes && <span>· {data.interaction.meeting.durationMinutes}m</span>}
              <span>· {data.interaction.meeting?.mode || 'offline'}</span>
              {data.interaction.meeting?.location && <span>· 📍 {data.interaction.meeting.location}</span>}
            </div>
            {data.interaction.tags?.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {data.interaction.tags.map((t) => (
                  <span key={t._id} className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: `${t.color}22`, color: t.color, border: `1px solid ${t.color}55` }}>
                    @{t.name}
                  </span>
                ))}
              </div>
            )}
            {canManage && (
              <div className="mt-3 flex items-center gap-2">
                <label className="text-[11px] text-slate-500 dark:text-slate-400">Status:</label>
                <select className="input !py-1 !text-xs max-w-[160px]" value={status} onChange={(e) => changeStatus(e.target.value)}>
                  <option value="scheduled">Scheduled</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            )}
          </div>

          {/* Participants + attendance */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 bg-white dark:bg-slate-900">
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-2">Participants</div>
            {(data.interaction.participants || []).length === 0 ? (
              <div className="text-xs italic text-slate-400">No participants</div>
            ) : (
              <div className="space-y-1.5">
                {data.interaction.participants.map((p) => (
                  <div key={String(p.employee?._id || p.employee)} className="flex items-center justify-between gap-2 text-sm flex-wrap">
                    <div className="text-slate-800 dark:text-slate-100">
                      {p.employee?.name || 'Unknown'}
                      <span className="text-slate-400 ml-1">({p.employee?.employeeId})</span>
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                        {p.invitationStatus}
                      </span>
                      {p.attendanceStatus && (
                        <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-brand-500/30">
                          {p.attendanceStatus}
                        </span>
                      )}
                    </div>
                    {canManage && (
                      <select className="input !py-0.5 !text-xs max-w-[160px]"
                        value={p.attendanceStatus || ''}
                        onChange={(e) => setAttendance(String(p.employee?._id || p.employee), e.target.value || null)}>
                        <option value="">— set attendance —</option>
                        <option value="present">Present</option>
                        <option value="absent">Absent</option>
                        <option value="late">Late</option>
                        <option value="left_early">Left Early</option>
                        <option value="excused">Excused</option>
                      </select>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Notes */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 bg-white dark:bg-slate-900">
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-2">
              Notes {data.notes?.length ? `(${data.notes.length})` : ''}
            </div>
            {(data.notes || []).length === 0 ? (
              <div className="text-xs italic text-slate-400 mb-2">No notes yet.</div>
            ) : (
              <div className="space-y-2 mb-3">
                {data.notes.map((n) => (
                  <div key={n._id} className="border-l-2 border-slate-200 dark:border-slate-700 pl-3 py-1">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-0.5">
                      {n.author?.name || 'Unknown'} · {fmtDate(n.createdAt)}
                    </div>
                    <div className="text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap">{n.body}</div>
                  </div>
                ))}
              </div>
            )}
            {canManage && (
              <div className="space-y-2">
                <MentionTagTextarea
                  rows={3} value={noteBody} onChange={setNoteBody}
                  tags={tags}
                  onTagPicked={(t) => setNoteTags((cur) => Array.from(new Set([...cur, String(t._id)])))}
                  placeholder="Add a note. Type ! to mention, @ to tag."
                />
                <div className="flex justify-end">
                  <button className="btn-primary !py-1 !text-xs" onClick={addNote}>Add Note</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ============================================================ */
/* NOTES TAB                                                    */
/* ============================================================ */
function NotesTab() {
  const [subTab, setSubTab] = useState('personal');
  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-1 text-sm">
        <button
          onClick={() => setSubTab('personal')}
          className={`px-3 py-1.5 rounded transition ${subTab === 'personal'
            ? 'bg-white dark:bg-slate-900 shadow text-brand-700 dark:text-brand-300'
            : 'text-slate-500 dark:text-slate-400'}`}
        >Personal Notes</button>
        <button
          onClick={() => setSubTab('types')}
          className={`px-3 py-1.5 rounded transition ${subTab === 'types'
            ? 'bg-white dark:bg-slate-900 shadow text-brand-700 dark:text-brand-300'
            : 'text-slate-500 dark:text-slate-400'}`}
        >Note Types</button>
      </div>
      {subTab === 'personal' && <PersonalNotesView />}
      {subTab === 'types'    && <NoteTypesView />}
    </div>
  );
}

function PersonalNotesView() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(null);
  const [openCreate, setOpenCreate] = useState(false);
  const [tags, setTags] = useState([]);

  useEffect(() => { api.get('/interaction-tags').then((r) => setTags(r.data)).catch(() => setTags([])); }, []);

  const load = () => {
    setLoading(true);
    api.get('/notes', { params: { scope: 'personal', search } })
      .then(({ data }) => setRows(data.rows || []))
      .catch((err) => toast.error(errMsg(err))).finally(() => setLoading(false));
  };
  useEffect(load, [search]);   // eslint-disable-line

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <input
          className="input max-w-md"
          type="search"
          placeholder="Search personal notes..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn-primary" onClick={() => setOpenCreate(true)}>+ New Personal Note</button>
      </div>
      {loading ? <Loader /> : rows.length === 0 ? (
        <EmptyState title="No personal notes yet" />
      ) : (
        <div className="grid gap-2">
          {rows.map((r) => (
            <button
              key={r._id}
              onClick={() => setOpenId(r._id)}
              className="w-full text-left rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-brand-300 dark:hover:border-brand-500 transition p-3"
            >
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.title}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{fmtDate(r.createdAt)}</div>
              {r.body && <div className="text-sm text-slate-600 dark:text-slate-300 mt-1 line-clamp-2 whitespace-pre-wrap">{r.body}</div>}
              {r.tags?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {r.tags.map((t) => (
                    <span key={t._id} className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: `${t.color}22`, color: t.color, border: `1px solid ${t.color}55` }}>
                      @{t.name}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
      {openCreate && <NoteEditorModal
        onClose={() => setOpenCreate(false)}
        onSaved={() => { setOpenCreate(false); load(); }}
        tags={tags} personal
      />}
      {openId && <NoteEditorModal
        id={openId}
        onClose={() => setOpenId(null)}
        onSaved={() => { setOpenId(null); load(); }}
        tags={tags} personal
      />}
    </div>
  );
}

function NoteTypesView() {
  const toast = useToast();
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openType, setOpenType] = useState(null);
  const [openEdit, setOpenEdit] = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/notes/types').then(({ data }) => setTypes(data || []))
      .catch((err) => toast.error(errMsg(err))).finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-slate-500 dark:text-slate-400">{types.length} notebook{types.length !== 1 ? 's' : ''}</div>
        <button className="btn-primary" onClick={() => setOpenEdit({})}>+ Create Note Type</button>
      </div>
      {loading ? <Loader /> : types.length === 0 ? (
        <EmptyState title="No note types yet. Create your first notebook." />
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
          {types.map((t) => (
            <div key={t._id}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 flex items-start justify-between gap-2"
            >
              <button className="text-left flex-1 min-w-0" onClick={() => setOpenType(t)}>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded" style={{ backgroundColor: t.color }} />
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.icon} {t.name}</div>
                </div>
                {t.description && <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">{t.description}</div>}
                <div className="text-[11px] text-slate-400 mt-1">{t.entryCount} entr{t.entryCount === 1 ? 'y' : 'ies'}</div>
              </button>
              <button className="btn-ghost !py-1 !text-xs" onClick={() => setOpenEdit(t)}>Edit</button>
            </div>
          ))}
        </div>
      )}
      {openType && <NoteTypeNotebook
        type={openType}
        onClose={() => setOpenType(null)}
      />}
      {openEdit && <NoteTypeEditor
        type={openEdit._id ? openEdit : null}
        onClose={() => setOpenEdit(null)}
        onSaved={() => { setOpenEdit(null); load(); }}
      />}
    </div>
  );
}

function NoteTypeEditor({ type, onClose, onSaved }) {
  const toast = useToast();
  const isEdit = !!type;
  const [f, setF] = useState({
    name: type?.name || '',
    description: type?.description || '',
    icon: type?.icon || '',
    color: type?.color || '#6366f1',
    visibility: type?.visibility || 'hr_only',
    archived: !!type?.archived,
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    if (!f.name.trim()) { toast.error('Name is required.'); return; }
    try {
      if (isEdit) await api.patch(`/notes/types/${type._id}`, f);
      else        await api.post('/notes/types', f);
      toast.success('Saved');
      onSaved();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const remove = async () => {
    if (!isEdit) return;
    if (!confirm('Delete this note type? Notes must be reassigned or archived first.')) return;
    try { await api.delete(`/notes/types/${type._id}`); toast.success('Deleted'); onSaved(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  return (
    <Modal open onClose={onClose} size="md" title={isEdit ? `Edit Note Type — ${type.name}` : 'Create Note Type'}
      footer={<>
        {isEdit && <button className="btn-ghost text-red-600" onClick={remove}>Delete</button>}
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={save}>Save</button>
      </>}
    >
      <div className="space-y-3">
        <div>
          <label className="label">Name</label>
          <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Performance Notes" />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">Icon (emoji)</label>
            <input className="input" value={f.icon} onChange={(e) => set('icon', e.target.value)} placeholder="📈" />
          </div>
          <div>
            <label className="label">Color</label>
            <input className="input h-10" type="color" value={f.color} onChange={(e) => set('color', e.target.value)} />
          </div>
          <div>
            <label className="label">Visibility</label>
            <select className="input" value={f.visibility} onChange={(e) => set('visibility', e.target.value)}>
              <option value="hr_only">HR Only</option>
              <option value="managers_hr">Managers + HR</option>
            </select>
          </div>
        </div>
        {isEdit && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.archived} onChange={(e) => set('archived', e.target.checked)} /> Archived
          </label>
        )}
      </div>
    </Modal>
  );
}

function NoteTypeNotebook({ type, onClose }) {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(null);
  const [openCreate, setOpenCreate] = useState(false);
  const [tags, setTags] = useState([]);
  useEffect(() => { api.get('/interaction-tags').then((r) => setTags(r.data)).catch(() => setTags([])); }, []);

  const load = () => {
    setLoading(true);
    api.get('/notes', { params: { noteType: type._id, search } })
      .then(({ data }) => setRows(data.rows || []))
      .catch((err) => toast.error(errMsg(err))).finally(() => setLoading(false));
  };
  useEffect(load, [search]);   // eslint-disable-line

  return (
    <Modal open onClose={onClose} size="xl" title={`${type.icon} ${type.name}`}
      footer={<button className="btn-primary" onClick={onClose}>Close</button>}
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <input className="input max-w-md" type="search" placeholder="Search notes in this notebook..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn-primary" onClick={() => setOpenCreate(true)}>+ New Entry</button>
        </div>
        {loading ? <Loader /> : rows.length === 0 ? (
          <EmptyState title="No entries in this notebook yet." />
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <button
                key={r._id}
                onClick={() => setOpenId(r._id)}
                className="w-full text-left rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-brand-300 dark:hover:border-brand-500 transition p-3"
              >
                <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.title}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{fmtDate(r.createdAt)} · by {r.createdBy?.name}</div>
                {r.body && <div className="text-sm text-slate-600 dark:text-slate-300 mt-1 line-clamp-2 whitespace-pre-wrap">{r.body}</div>}
                {r.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {r.tags.map((t) => (
                      <span key={t._id} className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{ backgroundColor: `${t.color}22`, color: t.color, border: `1px solid ${t.color}55` }}>
                        @{t.name}
                      </span>
                    ))}
                  </div>
                )}
                {r.mentions?.length > 0 && (
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                    Mentions: {r.mentions.map((m) => m.name).join(', ')}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
        {openCreate && <NoteEditorModal onClose={() => setOpenCreate(false)} onSaved={() => { setOpenCreate(false); load(); }} tags={tags} noteType={type._id} />}
        {openId && <NoteEditorModal id={openId} onClose={() => setOpenId(null)} onSaved={() => { setOpenId(null); load(); }} tags={tags} noteType={type._id} />}
      </div>
    </Modal>
  );
}

function NoteEditorModal({ id, onClose, onSaved, tags, personal = false, noteType = null }) {
  const toast = useToast();
  const isEdit = !!id;
  const [f, setF] = useState({ title: '', body: '', tags: [], mentions: [] });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!id) return;
    api.get(`/notes/${id}`).then(({ data }) => setF({
      title: data.title || '', body: data.body || '',
      tags: (data.tags || []).map((t) => String(t._id)),
      mentions: (data.mentions || []).map((m) => String(m._id)),
    })).catch((err) => { toast.error(errMsg(err)); onClose(); });
  }, [id]);   // eslint-disable-line

  const save = async () => {
    if (!f.title.trim()) { toast.error('Title is required.'); return; }
    setBusy(true);
    try {
      if (isEdit) await api.patch(`/notes/${id}`, f);
      else        await api.post('/notes', { ...f, personal, noteType });
      toast.success('Saved');
      onSaved();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!isEdit) return;
    if (!confirm('Delete this note?')) return;
    try { await api.delete(`/notes/${id}`); toast.success('Deleted'); onSaved(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <Modal open onClose={onClose} size="lg" title={isEdit ? 'Edit Note' : 'New Note'}
      footer={<>
        {isEdit && <button className="btn-ghost text-red-600" onClick={remove}>Delete</button>}
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={busy}>Save</button>
      </>}
    >
      <div className="space-y-3">
        <div>
          <label className="label">Title</label>
          <input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Short summary of what this note is about" />
        </div>
        <div>
          <label className="label">Content</label>
          <MentionTagTextarea
            rows={8} value={f.body} onChange={(v) => set('body', v)}
            tags={tags}
            onMentionPicked={(u) => set('mentions', Array.from(new Set([...(f.mentions || []), String(u._id)])))}
            onTagPicked={(t) => set('tags', Array.from(new Set([...(f.tags || []), String(t._id)])))}
            placeholder="Write. Use ! to mention an employee, @ to add a tag."
          />
        </div>
        <div>
          <label className="label">Tags</label>
          <TagChipPicker value={f.tags} onChange={(v) => set('tags', v)} tags={tags} />
        </div>
      </div>
    </Modal>
  );
}

/* ============================================================ */
/* TAGS TAB                                                     */
/* ============================================================ */
function TagsTab() {
  const toast = useToast();
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openEdit, setOpenEdit] = useState(null);
  const [category, setCategory] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/interaction-tags', { params: { category: category || undefined, archived: showArchived ? 'true' : 'false' } })
      .then(({ data }) => setTags(data)).catch((err) => toast.error(errMsg(err))).finally(() => setLoading(false));
  };
  useEffect(load, [category, showArchived]);   // eslint-disable-line

  const remove = async (id) => {
    if (!confirm('Delete this tag?')) return;
    try { await api.delete(`/interaction-tags/${id}`); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <select className="input max-w-[200px]" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {TAG_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
          </label>
        </div>
        <button className="btn-primary" onClick={() => setOpenEdit({ category: 'custom', color: '#64748b' })}>+ New Tag</button>
      </div>
      {loading ? <Loader /> : tags.length === 0 ? (
        <EmptyState title="No tags found" />
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
          {tags.map((t) => (
            <div key={t._id} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: t.color }} />
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">@{t.name}</div>
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 capitalize">{t.category}</div>
                  {t.description && <div className="text-xs text-slate-600 dark:text-slate-300 mt-1">{t.description}</div>}
                </div>
                <div className="flex flex-col items-end gap-1">
                  {t.archived && <span className="badge text-[10px] border bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700">archived</span>}
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-2">
                <button className="btn-ghost !py-1 !text-xs" onClick={() => setOpenEdit(t)}>Edit</button>
                <button className="btn-ghost !py-1 !text-xs text-red-600" onClick={() => remove(t._id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {openEdit && <TagEditor tag={openEdit._id ? openEdit : null} initial={openEdit} onClose={() => setOpenEdit(null)} onSaved={() => { setOpenEdit(null); load(); }} />}
    </div>
  );
}

function TagEditor({ tag, initial, onClose, onSaved }) {
  const toast = useToast();
  const isEdit = !!tag;
  const [f, setF] = useState({
    name: tag?.name || '',
    category: tag?.category || initial?.category || 'custom',
    color: tag?.color || CATEGORY_COLOR[initial?.category || 'custom'] || '#64748b',
    icon: tag?.icon || '',
    description: tag?.description || '',
    archived: !!tag?.archived,
  });
  const set = (k, v) => setF((s) => {
    const next = { ...s, [k]: v };
    // Auto-adopt category default colour if the user hasn't customised it.
    if (k === 'category' && (s.color === CATEGORY_COLOR[s.category] || !s.color)) next.color = CATEGORY_COLOR[v] || s.color;
    return next;
  });
  const save = async () => {
    if (!f.name.trim()) { toast.error('Name is required.'); return; }
    try {
      if (isEdit) await api.put(`/interaction-tags/${tag._id}`, f);
      else        await api.post('/interaction-tags', f);
      toast.success('Saved');
      onSaved();
    } catch (err) { toast.error(errMsg(err)); }
  };
  return (
    <Modal open onClose={onClose} size="md" title={isEdit ? `Edit Tag — @${tag.name}` : 'New Tag'}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={save}>Save</button>
      </>}
    >
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div>
            <label className="label">Category</label>
            <select className="input" value={f.category} onChange={(e) => set('category', e.target.value)}>
              {TAG_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Color</label>
            <input className="input h-10" type="color" value={f.color} onChange={(e) => set('color', e.target.value)} />
          </div>
          <div>
            <label className="label">Icon (emoji, optional)</label>
            <input className="input" value={f.icon} onChange={(e) => set('icon', e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        {isEdit && (
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input type="checkbox" checked={f.archived} onChange={(e) => set('archived', e.target.checked)} /> Archived
          </label>
        )}
      </div>
    </Modal>
  );
}

/* ============================================================ */
/* Reusable pickers                                             */
/* ============================================================ */
function TagChipPicker({ value = [], onChange, tags = [] }) {
  const active = tags.filter((t) => !t.archived);
  const asOptions = active.map((t) => ({
    _id: t._id, name: `@${t.name}`, employeeId: t.category, department: '', color: t.color,
  }));
  return (
    <ParticipantPicker
      value={value}
      onChange={onChange}
      employees={asOptions}
    />
  );
}

function FilterBar({ filters, onChange, tags, employees, scope }) {
  const set = (k, v) => onChange({ ...filters, [k]: v });
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input
        className="input max-w-md"
        type="search"
        placeholder="Search meetings, notes, employees, tags..."
        value={filters.search}
        onChange={(e) => set('search', e.target.value)}
      />
      <input className="input max-w-[150px]" type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
      <input className="input max-w-[150px]" type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
      <select className="input max-w-[180px]" value={filters.tag || ''} onChange={(e) => set('tag', e.target.value)}>
        <option value="">All tags</option>
        {tags.filter((t) => !t.archived).map((t) => <option key={t._id} value={t._id}>@{t.name}</option>)}
      </select>
      {scope === 'meetings' && (
        <select className="input max-w-[180px]" value={filters.meetingType || ''} onChange={(e) => set('meetingType', e.target.value)}>
          <option value="">All types</option>
          {MEETING_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      )}
    </div>
  );
}
