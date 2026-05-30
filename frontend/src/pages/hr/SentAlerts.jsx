import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import Modal from '../../components/Modal.jsx';
import StatCard from '../../components/StatCard.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';

/**
 * HR Sent Alerts
 *
 * Audit-log style view of every notification the current HR user has
 * sent.  Each row shows recipient, type, subject and a clear read /
 * unread badge along with the read-at timestamp.  Rows are expandable
 * to show the full message body and any referenced backlog tasks.
 */
export default function SentAlerts() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');     // '' | 'read' | 'unread'
  const [type, setType] = useState('');         // '' | 'backlog_alert' | 'general'
  const [q, setQ] = useState('');               // recipient name / employeeId / email
  const [openId, setOpenId] = useState(null);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/notifications/sent');
      setItems(data);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    return items.filter((n) => {
      if (status === 'read' && !n.read) return false;
      if (status === 'unread' && n.read) return false;
      if (type && n.type !== type) return false;
      if (q) {
        const s = q.toLowerCase();
        return (
          n.recipient?.name?.toLowerCase().includes(s) ||
          n.recipient?.employeeId?.toLowerCase().includes(s) ||
          n.recipient?.email?.toLowerCase().includes(s) ||
          n.title?.toLowerCase().includes(s)
        );
      }
      return true;
    });
  }, [items, status, type, q]);

  const totals = useMemo(() => ({
    total: items.length,
    read: items.filter((n) => n.read).length,
    unread: items.filter((n) => !n.read).length,
    backlog: items.filter((n) => n.type === 'backlog_alert').length,
  }), [items]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-end flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Sent Alerts</h1>
          <p className="text-sm text-slate-500">All notifications you've sent to employees, with read receipts.</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={load}>Refresh</button>
          <button className="btn-primary" onClick={() => setBroadcastOpen(true)}>+ New Broadcast</button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Sent" value={totals.total} accent="brand" />
        <StatCard label="Read by Employee" value={totals.read} accent="green" />
        <StatCard label="Still Unread" value={totals.unread} accent="amber" />
        <StatCard label="Pendency Alerts" value={totals.backlog} accent="red" />
      </div>

      <div className="card card-body grid md:grid-cols-3 gap-3">
        <input className="input" placeholder="Search recipient / subject..." value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="read">Read</option>
          <option value="unread">Unread</option>
        </select>
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          <option value="backlog_alert">Pendency alerts</option>
          <option value="general">General</option>
        </select>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          filtered.length === 0 ? <EmptyState title="No sent alerts" subtitle={items.length === 0 ? 'You haven\'t sent any notifications yet.' : 'Try clearing your filters.'} /> :
          <table className="table">
            <thead>
              <tr>
                <th className="w-10"></th>
                <th>Sent</th>
                <th>Recipient</th>
                <th>Type</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Read At</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((n) => (
                <Row
                  key={n._id}
                  n={n}
                  expanded={openId === n._id}
                  onToggle={() => setOpenId((id) => id === n._id ? null : n._id)}
                />
              ))}
            </tbody>
          </table>}
      </div>

      {broadcastOpen && (
        <BroadcastModal
          onClose={() => setBroadcastOpen(false)}
          onSent={() => { setBroadcastOpen(false); load(); }}
        />
      )}
    </div>
  );
}

function Row({ n, expanded, onToggle }) {
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
        <td className="text-xs whitespace-nowrap">
          {new Date(n.createdAt).toLocaleDateString()}
          <div className="text-[10px] text-slate-500">{new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        </td>
        <td className="font-medium">
          {n.recipient?.name || <em className="text-slate-400">Deleted user</em>}
          <div className="text-[11px] text-slate-500">{n.recipient?.employeeId}</div>
        </td>
        <td>
          {n.type === 'backlog_alert'
            ? <span className="badge-amber">Pendency</span>
            : <span className="badge-gray">General</span>}
        </td>
        <td className="max-w-xs truncate">{n.title}</td>
        <td>
          {n.read
            ? <span className="badge-green">Read</span>
            : <span className="badge-red">Unread</span>}
        </td>
        <td className="text-xs whitespace-nowrap">
          {n.readAt
            ? <>
                {new Date(n.readAt).toLocaleDateString()}
                <div className="text-[10px] text-slate-500">{new Date(n.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              </>
            : <span className="text-slate-400">—</span>}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan="7" className="bg-slate-50 p-5">
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div>
                <div className="text-[11px] uppercase text-slate-500 font-semibold mb-1">Message</div>
                <p className="text-sm text-slate-800 whitespace-pre-wrap">{n.message}</p>
              </div>

              {n.relatedTitles?.length > 0 && (
                <div>
                  <div className="text-[11px] uppercase text-slate-500 font-semibold mb-1">
                    Referenced task{n.relatedTitles.length !== 1 ? 's' : ''}
                  </div>
                  <ul className="text-sm text-slate-700 list-disc pl-5">
                    {n.relatedTitles.map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                </div>
              )}

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t border-slate-100 text-xs">
                <Field label="Sent at" value={new Date(n.createdAt).toLocaleString()} />
                <Field label="Recipient email" value={n.recipient?.email || '-'} />
                <Field label="Read" value={n.read ? 'Yes' : 'No'} cls={n.read ? 'text-green-700' : 'text-red-700'} />
                <Field label="Read at" value={n.readAt ? new Date(n.readAt).toLocaleString() : '-'} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const Field = ({ label, value, cls = '' }) => (
  <div>
    <div className="text-slate-500">{label}</div>
    <div className={`font-medium ${cls}`}>{value}</div>
  </div>
);

/**
 * Broadcast composer modal.  Picks an audience (all / by department /
 * by designation / specific employees) and posts the notification to
 * every selected recipient via POST /api/notifications.
 */
function BroadcastModal({ onClose, onSent }) {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [audience, setAudience] = useState('all'); // 'all' | 'department' | 'designation' | 'custom'
  const [selectedDepts, setSelectedDepts] = useState([]);
  const [selectedDesigs, setSelectedDesigs] = useState([]);
  const [selectedEmps, setSelectedEmps] = useState([]);
  const [search, setSearch] = useState('');

  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const toast = useToast();

  useEffect(() => {
    Promise.all([
      api.get('/employees', { params: { status: 'active', role: 'employee' } }),
      api.get('/departments'),
      api.get('/designations'),
    ])
      .then(([e, d, ds]) => {
        setEmployees(e.data);
        setDepartments(d.data);
        setDesignations(ds.data);
      })
      .catch((err) => toast.error(errMsg(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line
  }, []);

  const toggle = (arr, setArr, val) => {
    setArr(arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);
  };

  // Derive the actual recipient list from the audience + selections
  const recipients = useMemo(() => {
    if (!employees.length) return [];
    if (audience === 'all') return employees;
    if (audience === 'department') {
      return employees.filter((e) => selectedDepts.includes(String(e.department?._id || e.department || '')));
    }
    if (audience === 'designation') {
      return employees.filter((e) => selectedDesigs.includes(String(e.designation?._id || e.designation || '')));
    }
    if (audience === 'custom') {
      return employees.filter((e) => selectedEmps.includes(String(e._id)));
    }
    return [];
  }, [audience, employees, selectedDepts, selectedDesigs, selectedEmps]);

  const filteredEmployees = useMemo(() => {
    if (!search) return employees;
    const s = search.toLowerCase();
    return employees.filter((e) =>
      e.name?.toLowerCase().includes(s) ||
      e.employeeId?.toLowerCase().includes(s) ||
      e.email?.toLowerCase().includes(s)
    );
  }, [employees, search]);

  const send = async () => {
    if (!title.trim() || !message.trim()) {
      toast.error('Subject and message are required');
      return;
    }
    if (recipients.length === 0) {
      toast.error('Select at least one recipient');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post('/notifications', {
        recipients: recipients.map((r) => r._id),
        title: title.trim(),
        message: message.trim(),
        type: 'general',
      });
      toast.success(`Broadcast sent to ${data.count} employee${data.count !== 1 ? 's' : ''}`);
      onSent();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const audienceOptions = [
    { v: 'all', l: `All active (${employees.length})` },
    { v: 'department', l: 'By department' },
    { v: 'designation', l: 'By designation' },
    { v: 'custom', l: 'Specific employees' },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="New Broadcast"
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button
          className="btn-primary"
          disabled={busy || recipients.length === 0}
          onClick={send}
        >
          {busy ? 'Sending...' : `Send to ${recipients.length} employee${recipients.length !== 1 ? 's' : ''}`}
        </button>
      </>}
    >
      <div className="space-y-4">
        <div>
          <label className="label">Subject</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Office closed on Friday"
          />
        </div>

        <div>
          <label className="label">Message</label>
          <textarea
            className="input"
            rows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your announcement..."
          />
        </div>

        <div>
          <label className="label">Send to</label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {audienceOptions.map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setAudience(opt.v)}
                className={`px-3 py-2 rounded-lg text-xs border transition ${
                  audience === opt.v
                    ? 'bg-brand-600 text-white border-brand-600'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {opt.l}
              </button>
            ))}
          </div>
        </div>

        {loading ? <Loader /> : (
          <>
            {audience === 'department' && (
              <div className="bg-slate-50 rounded-lg p-3 max-h-[220px] overflow-y-auto border border-slate-200">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-semibold text-slate-700">Select departments</div>
                  <div className="flex gap-3">
                    <button type="button" className="text-xs text-brand-600 hover:underline"
                      onClick={() => setSelectedDepts(departments.map((d) => d._id))}>Select all</button>
                    <button type="button" className="text-xs text-slate-500 hover:underline"
                      onClick={() => setSelectedDepts([])}>Clear</button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {departments.map((d) => (
                    <label key={d._id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedDepts.includes(d._id)}
                        onChange={() => toggle(selectedDepts, setSelectedDepts, d._id)}
                      />
                      {d.name}
                    </label>
                  ))}
                  {departments.length === 0 && <div className="text-xs text-slate-500 italic">No departments.</div>}
                </div>
              </div>
            )}

            {audience === 'designation' && (
              <div className="bg-slate-50 rounded-lg p-3 max-h-[220px] overflow-y-auto border border-slate-200">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-semibold text-slate-700">Select designations</div>
                  <div className="flex gap-3">
                    <button type="button" className="text-xs text-brand-600 hover:underline"
                      onClick={() => setSelectedDesigs(designations.map((d) => d._id))}>Select all</button>
                    <button type="button" className="text-xs text-slate-500 hover:underline"
                      onClick={() => setSelectedDesigs([])}>Clear</button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {designations.map((d) => (
                    <label key={d._id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedDesigs.includes(d._id)}
                        onChange={() => toggle(selectedDesigs, setSelectedDesigs, d._id)}
                      />
                      {d.title}
                    </label>
                  ))}
                  {designations.length === 0 && <div className="text-xs text-slate-500 italic">No designations.</div>}
                </div>
              </div>
            )}

            {audience === 'custom' && (
              <div className="bg-slate-50 rounded-lg p-3 max-h-[280px] overflow-y-auto border border-slate-200">
                <div className="flex items-center justify-between mb-2 sticky top-0 bg-slate-50 pb-2">
                  <div className="text-xs font-semibold text-slate-700">Select employees</div>
                  <div className="flex gap-3">
                    <button type="button" className="text-xs text-brand-600 hover:underline"
                      onClick={() => setSelectedEmps(filteredEmployees.map((e) => String(e._id)))}>Select all (filtered)</button>
                    <button type="button" className="text-xs text-slate-500 hover:underline"
                      onClick={() => setSelectedEmps([])}>Clear</button>
                  </div>
                </div>
                <input
                  className="input mb-2"
                  placeholder="Search by name / ID / email..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="space-y-1">
                  {filteredEmployees.map((e) => (
                    <label key={e._id} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedEmps.includes(String(e._id))}
                        onChange={() => toggle(selectedEmps, setSelectedEmps, String(e._id))}
                      />
                      <span className="flex-1">
                        {e.name} <span className="text-slate-400">({e.employeeId})</span>
                      </span>
                      <span className="text-[11px] text-slate-500">{e.department?.name}</span>
                    </label>
                  ))}
                  {filteredEmployees.length === 0 && <div className="text-xs text-slate-500 italic">No matching employees.</div>}
                </div>
              </div>
            )}
          </>
        )}

        {/* Live recipient count */}
        <div className="bg-brand-50 border border-brand-100 rounded-lg p-3 text-sm text-brand-800">
          {recipients.length === 0 ? (
            <span>No recipients selected yet.</span>
          ) : (
            <span>
              <b>{recipients.length}</b> employee{recipients.length !== 1 ? 's' : ''} will receive this broadcast.
            </span>
          )}
        </div>
      </div>
    </Modal>
  );
}
