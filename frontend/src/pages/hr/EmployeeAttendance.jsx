import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, monthKey } from '../../utils/helpers';

/**
 * HR Employee Attendance
 *
 * Lists every active employee as a collapsible card.  Expanding a card
 * lazily loads that employee's attendance for the currently-selected
 * month (so we don't fan-out hundreds of API calls up-front).  Switching
 * the month re-loads only the cards that are currently open.
 */
const STATUS_STYLE = {
  present: 'bg-green-500',
  half_paid: 'bg-blue-500',
  half_unpaid: 'bg-orange-500',
  full_paid: 'bg-purple-500',
  full_unpaid: 'bg-red-500',
  absent: 'bg-red-800',
  weekly_off: 'bg-slate-300',
  holiday: 'bg-indigo-400',
  future: 'bg-slate-100 border border-slate-200',
};

const STATUS_LABEL = {
  present: 'Present',
  half_paid: 'Half Day (Paid)',
  half_unpaid: 'Half Day (Unpaid)',
  full_paid: 'Full Day Leave (Paid)',
  full_unpaid: 'Full Day Leave (Unpaid)',
  absent: 'Absent',
  weekly_off: 'Weekly Off',
  holiday: 'Holiday',
  future: 'Upcoming',
};

// Statuses HR can assign through the manual override modal.
const MANUAL_STATUS_OPTIONS = [
  { value: 'present', label: 'Present' },
  { value: 'half_paid', label: 'Half Day Leave (Paid)' },
  { value: 'half_unpaid', label: 'Half Day Leave (Unpaid)' },
  { value: 'full_paid', label: 'Full Day Leave (Paid)' },
  { value: 'full_unpaid', label: 'Full Day Leave (Unpaid)' },
  { value: 'absent', label: 'Absent' },
  { value: 'weekly_off', label: 'Weekly Off' },
];

export default function EmployeeAttendance() {
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [filterDept, setFilterDept] = useState('');
  const [q, setQ] = useState('');
  const [month, setMonth] = useState(monthKey(new Date()));
  const [loading, setLoading] = useState(true);

  // Map of employeeId -> { loading, data, error }
  const [attendance, setAttendance] = useState({});
  // Map of employeeId -> boolean (is this card expanded)
  const [openMap, setOpenMap] = useState({});

  // The day currently being edited via the HR override modal, or null.
  // Shape: { employee, date, status, note, prevStatus, saving }
  const [editing, setEditing] = useState(null);

  // Bulk-attendance multi-select state.
  const [selected, setSelected] = useState(() => new Set());
  const today = new Date().toISOString().slice(0, 10);
  const [bulkDate, setBulkDate] = useState(today);
  const [bulkStatus, setBulkStatus] = useState('present');
  const [bulkNote, setBulkNote] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);

  const toast = useToast();

  useEffect(() => {
    Promise.all([
      api.get('/employees', { params: { status: 'active' } }),
      api.get('/departments'),
    ])
      .then(([e, d]) => { setEmployees(e.data); setDepartments(d.data); })
      .catch((err) => toast.error(errMsg(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line
  }, []);

  // When the month changes, drop cached attendance so we re-fetch on next expand,
  // and immediately re-fetch any cards that are currently open.
  useEffect(() => {
    setAttendance({});
    const openIds = Object.keys(openMap).filter((id) => openMap[id]);
    openIds.forEach((id) => fetchAttendance(id));
    // eslint-disable-next-line
  }, [month]);

  const fetchAttendance = async (employeeId) => {
    const [year, m] = month.split('-').map(Number);
    setAttendance((cur) => ({ ...cur, [employeeId]: { loading: true } }));
    try {
      const { data } = await api.get(`/attendance/employee/${employeeId}`, {
        params: { year, month: m },
      });
      setAttendance((cur) => ({ ...cur, [employeeId]: { data } }));
    } catch (err) {
      setAttendance((cur) => ({ ...cur, [employeeId]: { error: errMsg(err) } }));
    }
  };

  // Open the override modal for a specific day.  Future days and holidays
  // are not editable.
  const openEdit = (employee, dayEntry) => {
    if (dayEntry.status === 'future' || dayEntry.status === 'holiday') return;
    const iso = new Date(dayEntry.date).toISOString().slice(0, 10);
    const status = ['present', 'half_paid', 'half_unpaid', 'full_paid', 'full_unpaid', 'absent', 'weekly_off']
      .includes(dayEntry.status) ? dayEntry.status : 'present';
    setEditing({
      employee,
      date: iso,
      status,
      note: dayEntry.note || '',
      prevStatus: dayEntry.status,
      source: dayEntry.source,
      leaveId: dayEntry.leaveId || null,
      saving: false,
    });
  };

  /**
   * Revoke an approved leave directly from the attendance calendar.
   * Same backend route the Leave Approvals page uses; this surfaces it
   * where HR actually managing attendance is looking.
   */
  const revokeLeaveFromCalendar = async () => {
    if (!editing?.leaveId) return;
    const ok = window.confirm(
      `Are you sure you want to revoke this approved leave for ${editing.employee.name}?\n` +
      `Attendance for the affected day(s) will revert and the employee's leave balance will be restored.`,
    );
    if (!ok) return;
    const reason = window.prompt('Reason for revoking this leave (optional):', '') || '';
    setEditing((e) => ({ ...e, saving: true }));
    try {
      await api.post(`/leaves/${editing.leaveId}/revoke`, { reason: reason.trim() });
      toast.success('Leave revoked. Balance restored.');
      await fetchAttendance(editing.employee._id);
      setEditing(null);
    } catch (err) {
      toast.error(errMsg(err));
      setEditing((e) => (e ? { ...e, saving: false } : e));
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditing((e) => ({ ...e, saving: true }));
    try {
      await api.put(`/attendance/employee/${editing.employee._id}/status`, {
        date: editing.date,
        status: editing.status,
        note: editing.note,
      });
      toast.success('Attendance updated');
      await fetchAttendance(editing.employee._id);
      setEditing(null);
    } catch (err) {
      toast.error(errMsg(err));
      setEditing((e) => (e ? { ...e, saving: false } : e));
    }
  };

  const clearEdit = async () => {
    if (!editing) return;
    setEditing((e) => ({ ...e, saving: true }));
    try {
      await api.delete(`/attendance/employee/${editing.employee._id}/status`, {
        params: { date: editing.date },
      });
      toast.success('Override removed');
      await fetchAttendance(editing.employee._id);
      setEditing(null);
    } catch (err) {
      toast.error(errMsg(err));
      setEditing((e) => (e ? { ...e, saving: false } : e));
    }
  };

  const toggle = (employeeId) => {
    setOpenMap((m) => {
      const next = { ...m, [employeeId]: !m[employeeId] };
      if (next[employeeId] && !attendance[employeeId]) fetchAttendance(employeeId);
      return next;
    });
  };

  const expandAll = () => {
    const next = {};
    filtered.forEach((e) => {
      next[e._id] = true;
      if (!attendance[e._id]) fetchAttendance(e._id);
    });
    setOpenMap(next);
  };
  const collapseAll = () => setOpenMap({});

  /* ----------------- Bulk-attendance helpers ----------------- */
  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const clearSelection = () => setSelected(new Set());
  const applyBulkAttendance = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!bulkDate) { toast.error('Pick a date.'); return; }
    setBulkBusy(true);
    try {
      const { data } = await api.post('/attendance/bulk', {
        employeeIds: ids,
        date: bulkDate,
        status: bulkStatus,
        note: bulkNote.trim(),
      });
      setBulkResult(data);
      toast.success(`Updated ${data.succeededCount} employee(s)`);
      // Re-fetch open cards so the calendars reflect the change.
      const openIds = Object.keys(openMap).filter((id) => openMap[id]);
      openIds.forEach((id) => fetchAttendance(id));
      clearSelection();
      setBulkNote('');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBulkBusy(false);
    }
  };

  const filtered = employees.filter((e) => {
    if (filterDept && String(e.department?._id || e.department) !== filterDept) return false;
    if (q) {
      const s = q.toLowerCase();
      return (
        e.name?.toLowerCase().includes(s) ||
        e.employeeId?.toLowerCase().includes(s) ||
        e.email?.toLowerCase().includes(s)
      );
    }
    return true;
  });

  if (loading) return <Loader />;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-end flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Employee Attendance</h1>
          <p className="text-sm text-slate-500">
            Expand any employee to view their month-wise attendance calendar.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input max-w-[200px]"
            placeholder="Search name / ID / email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="min-w-[200px]">
            <SearchableSelect
              value={filterDept}
              onChange={setFilterDept}
              options={departments}
              getValue={(d) => d._id}
              getLabel={(d) => d.name}
              placeholder="All departments"
            />
          </div>
          <input
            className="input max-w-[180px]"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
          <button className="btn-secondary" onClick={expandAll}>Expand all</button>
          <button className="btn-secondary" onClick={collapseAll}>Collapse all</button>
        </div>
      </div>

      {/* Legend */}
      <div className="card card-body py-3">
        <div className="flex flex-wrap gap-4 text-xs text-slate-600">
          {Object.entries(STATUS_STYLE).map(([k, c]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className={`w-2.5 h-2.5 rounded-full ${c}`} /> {STATUS_LABEL[k]}
            </span>
          ))}
        </div>
      </div>

      {filtered.length === 0 && <EmptyState title="No employees match the current filter" />}

      {filtered.length > 0 && (
        <div className="card card-body flex flex-wrap items-center gap-3 py-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={filtered.length > 0 && filtered.every((e) => selected.has(e._id))}
              ref={(el) => {
                if (!el) return;
                const some = filtered.some((e) => selected.has(e._id));
                const all  = filtered.every((e) => selected.has(e._id));
                el.indeterminate = some && !all;
              }}
              onChange={(e) => {
                if (e.target.checked) setSelected((p) => new Set([...p, ...filtered.map((x) => x._id)]));
                else setSelected((p) => { const n = new Set(p); filtered.forEach((x) => n.delete(x._id)); return n; });
              }}
            />
            <span>Select all ({filtered.length})</span>
          </label>
          {selected.size > 0 && (
            <>
              <span className="text-sm text-slate-600 ml-2"><b>{selected.size}</b> selected</span>
              <input className="input !py-1 max-w-[150px]" type="date" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} />
              <select className="input !py-1 max-w-[200px]" value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
                <option value="present">Present</option>
                <option value="absent">Absent</option>
                <option value="half_paid">Half Day (Paid)</option>
                <option value="half_unpaid">Half Day (Unpaid)</option>
                <option value="full_paid">Full Day Leave (Paid)</option>
                <option value="full_unpaid">Full Day Leave (Unpaid)</option>
                <option value="weekly_off">Weekly Off</option>
              </select>
              <input className="input !py-1 max-w-[220px]" placeholder="Optional note" value={bulkNote} onChange={(e) => setBulkNote(e.target.value)} />
              <button className="btn-primary !py-1" disabled={bulkBusy} onClick={applyBulkAttendance}>
                {bulkBusy ? 'Applying…' : 'Apply'}
              </button>
              <button className="btn-ghost !py-1 text-slate-600" disabled={bulkBusy} onClick={clearSelection}>Clear</button>
            </>
          )}
        </div>
      )}

      {bulkResult && (
        <div className={`rounded-lg p-3 text-sm ${bulkResult.failedCount > 0 ? 'bg-amber-50 border border-amber-200 text-amber-900' : 'bg-green-50 border border-green-200 text-green-800'}`}>
          Applied <b>{STATUS_LABEL[bulkResult.status] || bulkResult.status}</b> to <b>{bulkResult.succeededCount}</b> employee(s) on {bulkResult.date}.
          {bulkResult.failedCount > 0 && <> {bulkResult.failedCount} skipped.</>}
          <button className="ml-3 underline text-xs" onClick={() => setBulkResult(null)}>Dismiss</button>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((emp) => (
          <EmployeeCard
            key={emp._id}
            employee={emp}
            open={!!openMap[emp._id]}
            onToggle={() => toggle(emp._id)}
            att={attendance[emp._id]}
            onEditDay={openEdit}
            isSelected={selected.has(emp._id)}
            onSelectToggle={() => toggleOne(emp._id)}
          />
        ))}
      </div>

      {editing && (
        <Modal
          open
          size="sm"
          onClose={() => setEditing(null)}
          title={`Edit Attendance — ${editing.employee.name}`}
          footer={<>
            {editing.source === 'manual' && (
              <button className="btn-secondary mr-auto" disabled={editing.saving} onClick={clearEdit}>
                Remove override
              </button>
            )}
            {editing.leaveId && (
              <button
                className="btn-secondary mr-auto !text-red-700 !border-red-200 hover:!bg-red-50"
                disabled={editing.saving}
                onClick={revokeLeaveFromCalendar}
                title="Revoke the approved leave that owns this day. Balance is restored automatically."
              >
                Revoke Leave
              </button>
            )}
            <button className="btn-secondary" disabled={editing.saving} onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn-primary" disabled={editing.saving} onClick={saveEdit}>
              {editing.saving ? 'Saving…' : 'Save changes'}
            </button>
          </>}
        >
          <div className="space-y-3">
            <div className="text-sm text-slate-600">
              Date: <b>{editing.date}</b>
              <span className="ml-2 inline-flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-full ${STATUS_STYLE[editing.prevStatus] || 'bg-slate-200'}`} />
                Current: {STATUS_LABEL[editing.prevStatus] || editing.prevStatus}
                {editing.source && <span className="text-slate-400"> ({editing.source})</span>}
              </span>
            </div>
            {editing.leaveId && (
              <div className="rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2 text-[12px] text-indigo-800">
                This day is owned by an approved leave request. Use <b>Revoke Leave</b> to
                cancel the approval and restore the employee's balance, or change the status
                above to convert it into a manual override (the leave will stay approved).
              </div>
            )}

            <div>
              <label className="label">Attendance Status</label>
              <select
                className="input"
                value={editing.status}
                onChange={(e) => setEditing({ ...editing, status: e.target.value })}
              >
                {MANUAL_STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              {STATUS_EFFECT[editing.status]}
            </div>

            <div>
              <label className="label">Note / Reason (optional)</label>
              <textarea
                className="input"
                rows={2}
                value={editing.note}
                onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                placeholder="Why is this day being changed?"
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Plain-language summary of each status' salary / leave effect.
const STATUS_EFFECT = {
  present: 'No salary deduction. No leave deducted.',
  half_paid: 'Deducts 0.5 leave. No salary deduction.',
  half_unpaid: 'No leave deducted. Cuts 0.5 day salary.',
  full_paid: 'Deducts 1 leave. No salary deduction.',
  full_unpaid: 'No leave deducted. Cuts a full day salary.',
  absent: 'Cuts a full day salary. No leave deducted.',
  weekly_off: 'No salary deduction. No leave deducted.',
};

function EmployeeCard({ employee, open, onToggle, att, onEditDay, isSelected, onSelectToggle }) {
  return (
    <div className={`card ${isSelected ? 'ring-2 ring-brand-200' : ''}`}>
      <button onClick={onToggle} className="w-full flex items-center justify-between px-5 py-4 text-left">
        <div className="flex items-center gap-3">
          {onSelectToggle && (
            <span onClick={(e) => { e.stopPropagation(); onSelectToggle(); }} className="inline-flex items-center">
              <input
                type="checkbox"
                aria-label={`Select ${employee.name}`}
                checked={!!isSelected}
                onChange={onSelectToggle}
                onClick={(e) => e.stopPropagation()}
              />
            </span>
          )}
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={`transition-transform ${open ? 'rotate-90' : ''}`}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 grid place-items-center text-sm font-bold">
            {employee.name?.[0]?.toUpperCase()}
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">{employee.name}</div>
            <div className="text-xs text-slate-500">
              {employee.employeeId}
              {employee.department?.name && <span> • {employee.department.name}</span>}
              {employee.designation?.title && <span> • {employee.designation.title}</span>}
            </div>
          </div>
        </div>
        {att?.data ? (
          <div className="hidden md:flex items-center gap-2 text-xs">
            <Pill label="P" value={att.data.presentDays} color="green" />
            <Pill label="L" value={att.data.paidLeaves + att.data.unpaidLeaves} color="amber" />
            <Pill label="A" value={att.data.absentDays} color="red" />
            <Pill label="WO" value={att.data.weeklyOffDays} color="gray" />
          </div>
        ) : null}
      </button>

      {open && (
        <div className="border-t border-slate-100 px-5 py-4">
          {!att || att.loading ? <Loader /> :
            att.error ? <div className="text-sm text-red-600">{att.error}</div> :
            <AttendanceBody data={att.data} employee={employee} onEditDay={onEditDay} />}
        </div>
      )}
    </div>
  );
}

function AttendanceBody({ data, employee, onEditDay }) {
  if (!data?.perDay?.length) return <div className="text-sm text-slate-500">No data for this month.</div>;
  const startGap = new Date(data.perDay[0].date).getUTCDay();

  return (
    <div className="space-y-4">
      {/* Stat counters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Working Days" value={data.workingDays} />
        <Stat label="Present" value={data.presentDays} cls="text-green-700" />
        <Stat label="Half (Paid)" value={data.halfPaidDays || 0} cls="text-blue-700" />
        <Stat label="Half (Unpaid)" value={data.halfUnpaidDays || 0} cls="text-orange-700" />
        <Stat label="Full Leave (Paid)" value={data.paidLeaves} cls="text-purple-700" />
        <Stat label="Full Leave (Unpaid)" value={data.unpaidLeaves} cls="text-red-700" />
        <Stat label="Absent" value={data.absentDays} cls="text-red-900" />
        <Stat label="Holidays" value={data.holidayDays || 0} cls="text-indigo-700" />
      </div>

      <p className="text-xs text-slate-400">Tip: click any day to manually override its attendance status.</p>

      {/* Calendar */}
      <div>
        <div className="grid grid-cols-7 gap-2 text-xs text-slate-500 mb-2">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="text-center font-medium">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: startGap }).map((_, i) => <div key={`g-${i}`} />)}
          {data.perDay.map((d) => {
            const isFuture = d.status === 'future';
            const editable = !isFuture && d.status !== 'holiday';
            return (
              <button
                type="button"
                key={d.date}
                disabled={!editable}
                onClick={() => editable && onEditDay?.(employee, d)}
                className={`relative aspect-square rounded-lg flex flex-col items-center justify-center text-[11px] transition ${
                  isFuture ? 'border border-dashed border-slate-200 bg-slate-50/40 cursor-default'
                    : editable ? 'border border-slate-100 hover:border-brand-300 hover:ring-1 hover:ring-brand-200 cursor-pointer'
                    : 'border border-slate-100 cursor-default'
                }`}
                title={d.holidayName || STATUS_LABEL[d.status] || d.status}
              >
                {d.source === 'manual' && (
                  <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-slate-900" title="Manual HR override" />
                )}
                <div className={`w-3 h-3 rounded-full mb-1 ${STATUS_STYLE[d.status] || 'bg-slate-200'}`} />
                <div className={`font-semibold ${isFuture ? 'text-slate-400' : ''}`}>{new Date(d.date).getUTCDate()}</div>
                <div className={`text-[10px] truncate w-full text-center px-1 ${isFuture ? 'text-slate-300' : 'text-slate-500'}`}>
                  {d.status === 'holiday' ? (d.holidayName || 'Holiday') : (STATUS_LABEL[d.status] || '')}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const Stat = ({ label, value, cls = 'text-slate-900' }) => (
  <div className="bg-slate-50 rounded-lg py-2 text-center">
    <div className={`text-lg font-semibold ${cls}`}>{value}</div>
    <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
  </div>
);

const Pill = ({ label, value, color }) => {
  const map = {
    green: 'bg-green-50 text-green-700',
    red: 'bg-red-50 text-red-700',
    amber: 'bg-amber-50 text-amber-700',
    gray: 'bg-slate-100 text-slate-600',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full font-medium ${map[color]}`}>
      {label}: {value}
    </span>
  );
};
