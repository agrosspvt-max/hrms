import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
// Phase 48 -- cross-browser month picker replaces the native
// <input type="month"> which degraded to a plain text input in
// Firefox and Safari (Isha's account was on Firefox).
import MonthPicker from '../../components/MonthPicker.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, monthKey, fmtDate } from '../../utils/helpers';
import { subscribe } from '../../realtime';
// Phase 50 — HR/SA "Notes" tab inside the expanded employee card.
import AttendanceNotesModal from '../../components/AttendanceNotesModal.jsx';

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
  // Phase 16: today, no submission yet -- work in progress.
  ongoing: 'bg-amber-400',
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
  ongoing: 'Ongoing',
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
  // Phase 29.4 -- date-range bulk attendance modal.
  const [bulkRangeOpen, setBulkRangeOpen] = useState(false);

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

  // Phase 47 -- attendance edit happens on another tab / by bulk; for
  // every currently-open employee card refresh its data.  Closed cards
  // simply pick up fresh data the next time HR expands them.
  useEffect(() => {
    return subscribe('attendance:changed', () => {
      const openIds = Object.keys(openMap).filter((id) => openMap[id]);
      openIds.forEach((id) => fetchAttendance(id));
    });
    // eslint-disable-next-line
  }, [month, openMap]);

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
    // Phase 61 -- Absent -> Present transition requires an explicit
    // Performance Penalty / Neutral Adjustment choice.
    const isPresentType = editing.status === 'present'
      || editing.status === 'half_paid'
      || editing.status === 'half_unpaid';
    const needsDecision = editing.prevStatus === 'absent' && isPresentType;
    if (needsDecision && !editing.penaltyDecision) {
      toast.error('Choose Performance Penalty or Neutral Adjustment first.');
      return;
    }
    setEditing((e) => ({ ...e, saving: true }));
    try {
      await api.put(`/attendance/employee/${editing.employee._id}/status`, {
        date: editing.date,
        status: editing.status,
        note: editing.note,
        // Phase 61 -- only sent on the specific transition.
        penaltyDecision: needsDecision ? editing.penaltyDecision : undefined,
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
          <MonthPicker value={month} onChange={setMonth} />
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
              {/* Phase 29.4: opens the date-range bulk apply modal. */}
              <button className="btn-secondary !py-1" disabled={bulkBusy} onClick={() => setBulkRangeOpen(true)}>
                Date Range…
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

      {/* Phase 29.4 -- date-range bulk attendance modal */}
      {bulkRangeOpen && (
        <BulkRangeModal
          employeeIds={Array.from(selected)}
          onClose={() => setBulkRangeOpen(false)}
          onApplied={(result) => {
            setBulkRangeOpen(false);
            setBulkResult({
              status: result.status,
              date: `${result.fromDate} → ${result.toDate}`,
              succeededCount: result.appliedCount,
              failedCount: result.failedCount + result.skippedCount,
            });
            clearSelection();
            const openIds = Object.keys(openMap).filter((id) => openMap[id]);
            openIds.forEach((id) => fetchAttendance(id));
          }}
        />
      )}

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

            {/* Phase 61 -- Manual Attendance Correction.
                When HR flips Absent -> Present-type on a day the
                employee never submitted work for, they MUST pick
                one of the two Phase-61 options.  The backend
                enforces this by only creating the penalty when
                penaltyDecision === 'performance_penalty'. */}
            {editing.prevStatus === 'absent'
              && (editing.status === 'present' || editing.status === 'half_paid' || editing.status === 'half_unpaid') && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
                <div className="text-[11px] uppercase tracking-wide text-amber-800 font-semibold">
                  Missing-Submission Handling
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="penaltyDecision"
                    checked={editing.penaltyDecision === 'performance_penalty'}
                    onChange={() => setEditing({ ...editing, penaltyDecision: 'performance_penalty' })}
                  />
                  <span>
                    <b>Option A · Performance Penalty.</b>{' '}
                    Available &amp; Earned marks remain unchanged.  A
                    penalty equal to Earned Marks is recorded so
                    Final Marks become <b>0</b>.  Affects performance
                    but keeps the history intact.
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="penaltyDecision"
                    checked={editing.penaltyDecision === 'neutral_adjustment'}
                    onChange={() => setEditing({ ...editing, penaltyDecision: 'neutral_adjustment' })}
                  />
                  <span>
                    <b>Option B · Neutral Adjustment.</b>{' '}
                    Day is completely ignored.  Available = 0, Earned
                    = 0, Penalty = 0.  No positive or negative effect
                    on performance.
                  </span>
                </label>
                <div className="text-[11px] text-amber-800/80">
                  This decision is stored permanently in the audit log.
                </div>
              </div>
            )}

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
  // Phase 50 -- second tab inside the expanded card: attendance grid
  // (existing) OR notes calendar (new).  Kept local to the card so
  // each employee's tab state is independent.
  const [tab, setTab] = useState('attendance');
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
        <div className="border-t border-slate-100">
          {/* Phase 50 -- tab strip.  Attendance is the default so the
              existing HR muscle memory is preserved.  Notes shows the
              same employee's per-day calendar reminders. */}
          <div className="flex items-center gap-1 border-b border-slate-100 bg-slate-50/60 dark:bg-slate-800/40 px-3">
            {[
              { id: 'attendance', label: 'Attendance' },
              { id: 'notes',      label: 'Notes' },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2 text-sm border-b-2 -mb-px ${
                  tab === t.id
                    ? 'border-brand-500 text-brand-700 font-semibold'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="px-5 py-4">
            {tab === 'attendance' ? (
              !att || att.loading ? <Loader /> :
                att.error ? <div className="text-sm text-red-600">{att.error}</div> :
                <AttendanceBody data={att.data} employee={employee} onEditDay={onEditDay} />
            ) : (
              <EmployeeNotesTab employee={employee} monthDataForCalendar={att?.data} />
            )}
          </div>
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

/* =====================================================================
 * Phase 29.4 — Bulk Attendance · Date Range modal
 *
 * Three-step flow:
 *   1. Configure: pick From / To / Status / Note.
 *   2. Preview:   POST /attendance/bulk-range/preview, render the
 *                  conflicts table and let HR pick a resolution mode
 *                  (skip / override / review individually).
 *   3. Apply:     POST /attendance/bulk-range/apply with the chosen
 *                  mode + (optional) per-row selection set.  Calls
 *                  onApplied(result) so the parent can refresh.
 * ===================================================================== */
/* =====================================================================
 * Phase 50 — HR/SA Notes tab inside the expanded employee card.
 *
 * Shows every note on the employee's calendar for the visible month,
 * with search + priority/completed filters + full CRUD + optional lock.
 * The employee-side calendar reads the same records.  Notes never
 * generate notifications and never touch attendance / payroll / leave.
 * ===================================================================== */
function EmployeeNotesTab({ employee /* , monthDataForCalendar */ }) {
  const toast = useToast();
  const [notes, setNotes]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [q, setQ]                 = useState('');
  const [priority, setPriority]   = useState('');   // '' | 'normal' | 'important'
  const [completed, setCompleted] = useState('');   // '' | 'true' | 'false'
  // Phase 52 -- track "modal open" independently of "which date" so
  // the +Assign Note button can open the modal with NO preset date
  // (letting the compose form's date picker own the choice).
  const [modalDate, setModalDate] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  // Phase 52 -- notes are planning data, independent of attendance.  HR
  // gets their own From/To range (default: today-30d → today+90d) so
  // future notes they create are immediately visible and any HR/SA can
  // schedule a note for ANY date without navigating months in the
  // Attendance tab first.  Employees have the same freedom on their
  // side; this brings HR up to parity.
  const _ymd = (d) => new Date(d).toISOString().slice(0, 10);
  const _addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const [fromDate, setFromDate] = useState(() => _ymd(_addDays(new Date(), -30)));
  const [toDate,   setToDate]   = useState(() => _ymd(_addDays(new Date(), 90)));

  const load = async () => {
    setLoading(true);
    try {
      const params = {
        employee: employee._id,
        from: fromDate, to: toDate,
        archived: 'false',
      };
      if (priority)  params.priority = priority;
      if (completed) params.completed = completed;
      if (q)         params.q = q;
      const { data } = await api.get('/attendance-notes', { params });
      setNotes(data || []);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [employee._id, fromDate, toDate, priority, completed, q]);

  const setStatus = async (n, patch) => {
    try { await api.patch(`/attendance-notes/${n._id}`, patch); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const remove = async (n) => {
    if (!confirm(`Delete "${n.title}"?`)) return;
    try { await api.delete(`/attendance-notes/${n._id}`); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const toggleLock = async (n) => {
    try { await api.patch(`/attendance-notes/${n._id}`, { locked: !n.locked }); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  // Group by ISO date for the "note calendar" list rendering.
  const byDay = new Map();
  for (const n of notes) {
    const k = new Date(n.date).toISOString().slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(n);
  }
  const days = [...byDay.keys()].sort();

  return (
    <div className="space-y-4">
      {/* Search + filters + assign button */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[200px]">
          <label className="label text-[10px] uppercase">Search</label>
          <input
            className="input"
            placeholder="Search title / description…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {/* Phase 52 -- HR/SA get an independent From/To range so they
            can look at (and schedule notes into) any past or future
            date without navigating months in the Attendance tab. */}
        <div>
          <label className="label text-[10px] uppercase">From</label>
          <input
            type="date"
            className="input max-w-[150px]"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </div>
        <div>
          <label className="label text-[10px] uppercase">To</label>
          <input
            type="date"
            className="input max-w-[150px]"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
          />
        </div>
        <div>
          <label className="label text-[10px] uppercase">Priority</label>
          <select className="input max-w-[150px]" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">All</option>
            <option value="normal">Normal</option>
            <option value="important">Important</option>
          </select>
        </div>
        <div>
          <label className="label text-[10px] uppercase">Status</label>
          <select className="input max-w-[150px]" value={completed} onChange={(e) => setCompleted(e.target.value)}>
            <option value="">All</option>
            <option value="false">Pending</option>
            <option value="true">Completed</option>
          </select>
        </div>
        {/* Phase 52 -- open the modal with no date prop so the modal
            treats it as "new note" and the compose form's own date
            picker owns the choice.  HR/SA can then plan for ANY date
            (past / present / future) exactly like the employee flow. */}
        <button
          className="btn-primary !text-xs"
          onClick={() => { setModalDate(null); setModalOpen(true); }}
          title="Assign a note for any date — past, present, or future"
        >
          + Assign Note
        </button>
      </div>

      <div className="text-[11px] text-slate-500">
        Showing notes from {fromDate} to {toDate}. Assigned notes are reminders only — they don't affect performance, tasks, or analytics.
      </div>

      {loading ? <Loader /> :
        notes.length === 0 ? (
          <div className="text-sm text-slate-500 italic bg-slate-50 dark:bg-slate-800/40 rounded p-3">
            No notes match the current filters.
          </div>
        ) : (
          <div className="space-y-3">
            {days.map((d) => (
              <div key={d}>
                <div className="text-[11px] uppercase font-semibold text-slate-500 mb-1">{fmtDate(d)}</div>
                <div className="space-y-2">
                  {byDay.get(d).map((n) => (
                    <div
                      key={n._id}
                      className={`rounded-lg border p-3 ${
                        n.completed
                          ? 'bg-green-50/40 border-green-200 dark:bg-green-500/10 dark:border-green-500/30'
                          : n.priority === 'important'
                            ? 'bg-amber-50/40 border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30'
                            : 'bg-white border-slate-200 dark:bg-slate-800/60 dark:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            {n.priority === 'important'
                              ? <span className="badge-amber">Important</span>
                              : <span className="badge-gray">Normal</span>}
                            {n.completed && <span className="badge-green text-[10px]">DONE</span>}
                            {n.locked   && <span className="badge bg-slate-100 text-slate-600 text-[10px]">🔒 Locked</span>}
                            <span className={`text-sm font-semibold ${n.completed ? 'line-through text-slate-500' : 'text-slate-900 dark:text-slate-100'}`}>
                              {n.title}
                            </span>
                          </div>
                          {n.description && (
                            <div className="text-xs text-slate-600 dark:text-slate-300 mt-1 whitespace-pre-wrap">{n.description}</div>
                          )}
                          <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap items-center gap-2">
                            {n.reminderTime && <span>⏰ {n.reminderTime}</span>}
                            <span>
                              Created by {n.createdBy?.name || n.createdByName || 'Someone'}
                              {n.createdByRole && ` (${n.createdByRole === 'super_admin' ? 'Super Admin' : n.createdByRole.toUpperCase()})`}
                            </span>
                            <span>· {new Date(n.createdAt).toLocaleString()}</span>
                            {n.completedAt && (
                              <span>· completed {new Date(n.completedAt).toLocaleString()}
                                {n.completedBy?.name && ` by ${n.completedBy.name}`}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {!n.completed
                            ? <button className="btn-secondary !py-1 !text-xs" onClick={() => setStatus(n, { completed: true })}>Complete</button>
                            : <button className="btn-ghost !py-1 !text-xs" onClick={() => setStatus(n, { completed: false })}>Undo</button>}
                          <button className="btn-ghost !py-1 !text-xs" onClick={() => { setModalDate(d); setModalOpen(true); }}>Open</button>
                          <button className="btn-ghost !py-1 !text-xs" onClick={() => toggleLock(n)}>{n.locked ? 'Unlock' : 'Lock'}</button>
                          <button className="btn-ghost !py-1 !text-xs text-red-600" onClick={() => remove(n)}>Delete</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

      <AttendanceNotesModal
        open={modalOpen}
        date={modalDate}
        employeeId={employee._id}
        employeeName={employee.name}
        onClose={() => { setModalOpen(false); setModalDate(null); }}
        onChanged={load}
      />
    </div>
  );
}

function BulkRangeModal({ employeeIds, onClose, onApplied }) {
  const toast = useToast();
  const [fromDate, setFromDate] = useState(new Date().toISOString().slice(0, 10));
  const [toDate, setToDate]     = useState(new Date().toISOString().slice(0, 10));
  const [status, setStatus]     = useState('present');
  const [note, setNote]         = useState('');
  const [preview, setPreview]   = useState(null); // { rows, conflictCount, cleanCount }
  const [mode, setMode]         = useState('skip'); // skip | override | selected
  const [selectedCells, setSelectedCells] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const cellKey = (r) => `${r.employeeId}|${r.date}`;
  const conflictRows = preview ? preview.rows.filter((r) => r.hasConflict) : [];

  const doPreview = async () => {
    if (employeeIds.length === 0) { toast.error('Select at least one employee first.'); return; }
    if (!fromDate || !toDate) { toast.error('From and To dates are required.'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/attendance/bulk-range/preview', {
        employeeIds, fromDate, toDate, status,
      });
      setPreview(data);
      setSelectedCells(new Set());
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };
  const doApply = async () => {
    setBusy(true);
    try {
      const body = { employeeIds, fromDate, toDate, status, note: note.trim(), mode };
      if (mode === 'selected') {
        body.selected = [...selectedCells].map((k) => {
          const [employeeId, date] = k.split('|');
          return { employeeId, date };
        });
      }
      const { data } = await api.post('/attendance/bulk-range/apply', body);
      toast.success(`Applied to ${data.appliedCount} day(s); ${data.skippedCount} skipped, ${data.failedCount} failed.`);
      onApplied(data);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };
  const toggleCell = (k) => setSelectedCells((cur) => {
    const n = new Set(cur);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl max-w-3xl w-full m-4 p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Bulk Attendance · Date Range</h2>
          <p className="text-sm text-slate-500">Selected employees: <b>{employeeIds.length}</b></p>
        </div>

        {/* Step 1 -- Configuration */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div>
            <label className="label">Start Date</label>
            <input className="input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <label className="label">End Date</label>
            <input className="input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="present">Present</option>
              <option value="absent">Absent</option>
              <option value="half_paid">Half Day (Paid)</option>
              <option value="half_unpaid">Half Day (Unpaid)</option>
              <option value="full_paid">Full Day Leave (Paid)</option>
              <option value="full_unpaid">Full Day Leave (Unpaid)</option>
              <option value="weekly_off">Weekly Off</option>
            </select>
          </div>
          <div>
            <label className="label">Note (optional)</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        {!preview && (
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn-primary" onClick={doPreview} disabled={busy}>
              {busy ? 'Detecting conflicts…' : 'Preview'}
            </button>
          </div>
        )}

        {/* Step 2 -- Conflicts + mode picker */}
        {preview && (
          <>
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm flex items-center justify-between flex-wrap gap-2">
              <div>
                <b>{preview.totalCells}</b> cells in range · <span className="text-green-700">{preview.cleanCount} clean</span> · <span className="text-amber-700">{preview.conflictCount} conflicts</span>
              </div>
              <button className="btn-ghost !py-0.5 !text-xs" onClick={() => setPreview(null)}>Back</button>
            </div>

            {conflictRows.length > 0 ? (
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Conflicts Found</div>
                <div className="overflow-x-auto max-h-60 border border-slate-200 dark:border-slate-700 rounded">
                  <table className="table text-sm">
                    <thead><tr>
                      {mode === 'selected' && <th></th>}
                      <th>Employee</th><th>Date</th><th>Reason</th>
                    </tr></thead>
                    <tbody>
                      {conflictRows.map((r) => (
                        <tr key={cellKey(r)}>
                          {mode === 'selected' && (
                            <td>
                              <input type="checkbox" checked={selectedCells.has(cellKey(r))} onChange={() => toggleCell(cellKey(r))} />
                            </td>
                          )}
                          <td className="font-medium text-slate-800">{r.name}<div className="text-[11px] text-slate-500">{r.employeeCode}</div></td>
                          <td>{r.date}</td>
                          <td>{r.reason}{r.existingStatus ? <span className="text-[11px] text-slate-500"> · {r.existingStatus}</span> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap gap-3 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="bulkMode" checked={mode === 'skip'} onChange={() => setMode('skip')} />
                    Skip Conflicts <span className="text-[11px] text-slate-500">— apply only to clean cells</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="bulkMode" checked={mode === 'override'} onChange={() => setMode('override')} />
                    Override All <span className="text-[11px] text-slate-500">— apply everywhere</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="bulkMode" checked={mode === 'selected'} onChange={() => setMode('selected')} />
                    Review Individually <span className="text-[11px] text-slate-500">— override only ticked rows</span>
                  </label>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-green-200 dark:border-green-500/30 bg-green-50/60 dark:bg-green-500/10 px-3 py-2 text-sm text-green-800 dark:text-green-300">
                No conflicts — all <b>{preview.totalCells}</b> cells are clean.
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn-primary" onClick={doApply} disabled={busy}>
                {busy ? 'Applying…' : `Apply (${
                  mode === 'override'
                    ? preview.totalCells
                    : mode === 'skip'
                      ? preview.cleanCount
                      : preview.cleanCount + selectedCells.size
                } cell${preview.totalCells === 1 ? '' : 's'})`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
