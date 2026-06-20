import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { fmtMoney, errMsg, authUrl } from '../../utils/helpers';

// 'YYYY-MM-DD' (UTC) for a date - matches the backend periodKey format.
const ymd = (d) => {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};

// Human-readable payroll period for a slip (falls back to the month).
const periodText = (s) => {
  if (s?.periodStart && s?.periodEnd) {
    const f = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    return `${f(s.periodStart)} → ${f(s.periodEnd)}`;
  }
  return s?.month || '';
};

/** Read the payroll breakdown from a slip with a legacy fallback. */
function slipPayroll(s) {
  if (s.payroll && s.payroll.earnings) {
    return { e: s.payroll.earnings, d: s.payroll.deductions, att: s.payroll.attendanceSummary || {} };
  }
  const gross = s.grossSalary || 0;
  return {
    e: { grossEarnings: gross + (s.bonuses || 0) },
    d: { pf: 0, esic: 0, pt: 0, tds: 0, totalDeductions: s.deductions || 0 },
    att: { lopDays: s.unpaidLeaves || 0 },
  };
}

export default function HRSalary() {
  // Default to the current calendar month (first -> last day) as a sensible
  // starting payroll cycle; HR can pick any custom range.
  const now = new Date();
  const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const [startDate, setStartDate] = useState(ymd(firstDay));
  const [endDate, setEndDate] = useState(ymd(lastDay));
  const [slips, setSlips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  // Phase 31.4 -- per-employee generate modal state.
  const [oneOpen, setOneOpen] = useState(false);
  const [employees, setEmployees] = useState([]);
  const toast = useToast();

  const rangeValid = startDate && endDate && startDate <= endDate;

  const load = async () => {
    if (!rangeValid) { setSlips([]); setLoading(false); return; }
    setLoading(true);
    const { data } = await api.get('/salary', { params: { periodStart: startDate, periodEnd: endDate } });
    setSlips(data);
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [startDate, endDate]);
  // Phase 31.4 -- lazily load the employee list for the individual
  // generate modal so the page itself doesn't pay for it on every visit.
  useEffect(() => {
    if (!oneOpen || employees.length > 0) return;
    api.get('/employees', { params: { status: 'active' } })
      .then((r) => setEmployees(r.data || []))
      .catch(() => {});
  }, [oneOpen, employees.length]);

  const generateAll = async () => {
    if (!rangeValid) { toast.error('Start date must be on or before end date'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/salary/generate-all', { startDate, endDate });
      toast.success(`Generated ${data.count} slip(s)`);
      load();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  const updateSlip = async (id, patch) => {
    try {
      await api.patch(`/salary/${id}`, patch);
      toast.success('Updated');
      setModal(null);
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const openAdjust = (s) => {
    // Hydrate the items arrays so the modal always has something to edit.
    // If a slip was created before this feature shipped, fall back to a
    // single line built from the legacy numeric fields.
    const bonusItems = (s.bonusItems && s.bonusItems.length)
      ? s.bonusItems.map((x) => ({ amount: x.amount, note: x.note || '' }))
      : (s.bonuses ? [{ amount: s.bonuses, note: s.bonusNote || '' }] : []);
    const deductionItems = (s.deductionItems && s.deductionItems.length)
      ? s.deductionItems.map((x) => ({ amount: x.amount, note: x.note || '' }))
      : (s.deductions ? [{ amount: s.deductions, note: s.deductionNote || '' }] : []);
    setModal({ ...s, bonusItems, deductionItems });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex justify-between items-center flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold">Salary Management</h1>
            <p className="text-sm text-slate-500">
              Pick a <b>payroll period</b> (start &amp; end date) and click <b>Generate / Refresh All Slips</b>.
              Attendance, leaves, half-days &amp; deductions are calculated only within the selected range
              (both dates inclusive). Re-running the same period updates existing slips in place.
            </p>
          </div>
          <div className="flex gap-2 items-end flex-wrap">
            <div>
              <label className="label">Start date</label>
              <input className="input max-w-[170px]" type="date" value={startDate} max={endDate || undefined} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="label">End date</label>
              <input className="input max-w-[170px]" type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <a className="btn-secondary" href={authUrl(`/api/salary/export.csv?periodStart=${startDate}&periodEnd=${endDate}`)}>Export CSV</a>
            {/* Phase 31.4: per-employee generate -- bulk button untouched. */}
            <button className="btn-secondary" onClick={() => setOneOpen(true)}>+ Individual Salary</button>
            <button className="btn-primary" disabled={busy || !rangeValid} onClick={generateAll}>{busy ? 'Generating...' : 'Generate / Refresh All Slips'}</button>
          </div>
        </div>
      </div>

      {oneOpen && (
        <IndividualGenerateModal
          employees={employees}
          defaultStartDate={startDate}
          defaultEndDate={endDate}
          onClose={() => setOneOpen(false)}
          onGenerated={() => { setOneOpen(false); load(); }}
        />
      )}

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          slips.length === 0 ? <EmptyState title="No slips for this period" subtitle="Click 'Generate / Refresh All Slips' to compute payroll for the selected date range." /> :
          <table className="table">
            <thead><tr>
              <th>Employee</th><th>Present</th><th>Paid Lv</th><th>Half</th><th>LOP</th>
              <th>Gross</th><th>PF</th><th>ESIC</th><th>PT</th><th>TDS</th><th>Deductions</th><th>Net</th><th></th>
            </tr></thead>
            <tbody>
              {slips.map((s) => {
                const p = slipPayroll(s);
                return (
                <tr key={s._id}>
                  <td className="font-medium">
                    {s.employee?.name || s.employeeName || <em className="text-slate-400">Deleted employee</em>}
                    <div className="text-[11px] text-slate-500">
                      {s.employee?.employeeId || s.employeeEmpId || s.employeeEmail || ''}
                    </div>
                  </td>
                  <td>{s.presentDays}</td><td>{s.paidLeaves}</td>
                  <td>{(s.halfPaidDays || 0) + (s.halfUnpaidDays || 0)}</td>
                  <td>{p.att.lopDays ?? s.unpaidLeaves}</td>
                  <td>{fmtMoney(p.e.grossEarnings)}</td>
                  <td className="text-red-700">{fmtMoney(p.d.pf)}</td>
                  <td className="text-red-700">{fmtMoney(p.d.esic)}</td>
                  <td className="text-red-700">{fmtMoney(p.d.pt)}</td>
                  <td className="text-red-700">{fmtMoney(p.d.tds)}</td>
                  <td className="text-red-700">-{fmtMoney(p.d.totalDeductions)}</td>
                  <td className="font-bold">{fmtMoney(s.netSalary)}</td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost" onClick={() => openAdjust(s)}>Adjust</button>
                    <a className="btn-ghost text-brand-700" href={authUrl(`/api/salary/${s._id}/pdf`)} target="_blank" rel="noreferrer">PDF</a>
                  </td>
                </tr>
              ); })}
            </tbody>
          </table>}
      </div>

      {modal && (
        <AdjustModal modal={modal} setModal={setModal} onSave={updateSlip} />
      )}
    </div>
  );
}

/**
 * Adjust-salary modal with repeating bonus / deduction line editors.
 * Each line has its own amount + note inputs and a remove button; HR
 * can hit "+ Add bonus" / "+ Add deduction" to add as many rows as
 * needed.  Totals + net salary preview update live.
 */
function AdjustModal({ modal, setModal, onSave }) {
  const bonusItems = modal.bonusItems || [];
  const deductionItems = modal.deductionItems || [];

  const updateItems = (key, items) => setModal({ ...modal, [key]: items });

  const addRow = (key) => updateItems(key, [...(modal[key] || []), { amount: 0, note: '' }]);
  const removeRow = (key, idx) => updateItems(key, modal[key].filter((_, i) => i !== idx));
  const editRow = (key, idx, patch) => {
    const next = [...modal[key]];
    next[idx] = { ...next[idx], ...patch };
    updateItems(key, next);
  };

  const sum = (arr) => (arr || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const totalBonus = sum(bonusItems);
  const totalDeduction = sum(deductionItems);
  const newNet = Math.max(0, (modal.grossSalary || 0) + totalBonus - totalDeduction);

  return (
    <Modal
      open
      onClose={() => setModal(null)}
      size="lg"
      title={`Adjust salary - ${modal.employee?.name || ''} (${periodText(modal)})`}
      footer={<>
        <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
        <button
          className="btn-primary"
          onClick={() => onSave(modal._id, {
            bonusItems: modal.bonusItems || [],
            deductionItems: modal.deductionItems || [],
          })}
        >Save</button>
      </>}
    >
      <div className="space-y-5">
        {/* Phase 31.3 -- payable-days breakdown.  Surfaces how the
            standardised rule (Monthly Gross ÷ Calendar Days) arrived at
            the final figure: month days, present, absent, paid leave,
            holiday worked, payable days, per-day, gross, adjustment,
            deduction, final. */}
        <SalaryBreakdown slip={modal} />

        {/* Additional Compensation (per-payslip ad-hoc additions) */}
        <ItemEditor
          title="Additional Compensation"
          accent="green"
          items={bonusItems}
          onAdd={() => addRow('bonusItems')}
          onRemove={(i) => removeRow('bonusItems', i)}
          onEdit={(i, p) => editRow('bonusItems', i, p)}
          total={totalBonus}
        />

        {/* Deductions */}
        <ItemEditor
          title="Deductions"
          accent="red"
          items={deductionItems}
          onAdd={() => addRow('deductionItems')}
          onRemove={(i) => removeRow('deductionItems', i)}
          onEdit={(i, p) => editRow('deductionItems', i, p)}
          total={totalDeduction}
        />

        {/* Live preview */}
        <div className="bg-slate-50 rounded-lg p-3 border border-slate-200 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">Gross</span><span>{fmtMoney(modal.grossSalary)}</span></div>
          <div className="flex justify-between text-green-700"><span>Additional Compensation</span><span>+ {fmtMoney(totalBonus)}</span></div>
          <div className="flex justify-between text-red-700"><span>Deductions</span><span>- {fmtMoney(totalDeduction)}</span></div>
          <div className="border-t border-slate-200 mt-2 pt-2 flex justify-between font-semibold">
            <span>Net Salary</span><span>{fmtMoney(newNet)}</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ItemEditor({ title, accent, items, onAdd, onRemove, onEdit, total }) {
  const accentMap = {
    green: { head: 'text-green-700', sign: '+' },
    red: { head: 'text-red-700', sign: '-' },
  };
  const a = accentMap[accent];
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className={`text-sm font-semibold ${a.head}`}>{title} <span className="text-slate-400 font-normal text-xs">({items.length} line{items.length !== 1 ? 's' : ''})</span></div>
        <button type="button" onClick={onAdd} className="btn-secondary !py-1 !px-3 text-xs">+ Add {title.toLowerCase().replace(/s$/, '')}</button>
      </div>

      {items.length === 0 && (
        <div className="text-xs text-slate-500 italic px-3 py-4 bg-slate-50 rounded-lg border border-dashed border-slate-200">
          No {title.toLowerCase()} yet. Click "+ Add" to create a line.
        </div>
      )}

      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-start">
            <div className="col-span-3">
              {i === 0 && <label className="label">Amount</label>}
              <input
                className="input"
                type="number" min="0"
                placeholder="Amount"
                value={it.amount || ''}
                onChange={(e) => onEdit(i, { amount: e.target.value === '' ? 0 : Number(e.target.value) })}
              />
            </div>
            <div className="col-span-8">
              {i === 0 && <label className="label">Note</label>}
              <input
                className="input"
                placeholder={accent === 'green' ? 'e.g. Diwali bonus' : 'e.g. Late attendance fine'}
                value={it.note}
                onChange={(e) => onEdit(i, { note: e.target.value })}
              />
            </div>
            <div className="col-span-1 flex">
              {i === 0 && <div className="w-full mb-1">&nbsp;</div>}
              <button
                type="button"
                onClick={() => onRemove(i)}
                title="Remove this line"
                className="w-9 h-9 rounded-lg border border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 grid place-items-center"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      {items.length > 0 && (
        <div className={`text-xs ${a.head} mt-2 font-medium text-right`}>
          Total {title.toLowerCase()}: {a.sign} {fmtMoney(total)}
        </div>
      )}
    </div>
  );
}

/* =====================================================================
 * Phase 31.4 — Generate Individual Salary
 *
 * Wraps the existing `POST /api/salary/generate` endpoint (which has
 * always accepted an `employeeId` plus a date range) into a focused UI.
 * Bulk generation is untouched; this just adds a per-employee path.
 *
 * Access control: the endpoint is gated by `authorize('hr')` on the
 * route which accepts HR + Super Admin and rejects HOD / employees.
 * Same gate as bulk -- no parallel permission logic here.
 * ===================================================================== */
function IndividualGenerateModal({ employees, defaultStartDate, defaultEndDate, onClose, onGenerated }) {
  const [employeeId, setEmployeeId] = useState('');
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate]     = useState(defaultEndDate);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async () => {
    if (!employeeId) { toast.error('Pick an employee.'); return; }
    if (!startDate || !endDate || startDate > endDate) { toast.error('Provide a valid date range.'); return; }
    setBusy(true);
    try {
      await api.post('/salary/generate', { employeeId, startDate, endDate });
      toast.success('Salary slip generated');
      onGenerated();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} size="md" title="Generate Individual Salary"
      footer={<>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Generating…' : 'Generate Salary'}
        </button>
      </>}>
      <div className="space-y-3 text-sm">
        <p className="text-slate-500 text-xs">
          Same payroll engine + same validations + same slip format as bulk generation.
          Use this when you only need to recompute one employee.
        </p>
        <div>
          <label className="label">Employee</label>
          <select className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">— Select —</option>
            {employees.map((e) => (
              <option key={e._id} value={e._id}>
                {e.name}{e.employeeId ? ` · ${e.employeeId}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Start Date</label>
            <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="label">End Date</label>
            <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* =====================================================================
 * Phase 31.3 — Salary breakdown panel
 *
 * Renders the standardised payroll breakdown documented in the spec:
 *
 *   Month Days        Calendar days in the salary month
 *   Present Days      Days the employee was marked present
 *   Absent Days       Days the employee was marked absent
 *   Approved Leave    Full-day paid + unpaid leaves
 *   Holiday Worked    Sundays / holidays the employee submitted on
 *   Payable Days      monthDays - absent - unpaid - 0.5*halfUnpaid
 *                     + holidayWorked
 *   Per Day Salary    monthlyGross ÷ monthDays
 *   Gross Salary      monthlyGross (constant for the month)
 *   Adjustment        + perDay × holidayWorked
 *   Deduction         − perDay × (absent + unpaid + 0.5*halfUnpaid)
 *                     − all PF / ESIC / PT / TDS / penalties from payroll
 *   Final Salary      net payable in hand
 * ===================================================================== */
export function SalaryBreakdown({ slip }) {
  if (!slip) return null;
  const payroll = slip.payroll || {};
  const att = payroll.attendanceSummary || {};
  const ded = payroll.deductions || {};
  // Pull from the slip's canonical fields; fall back to payroll engine
  // values when present (older slips may lack the top-level fields).
  const monthDays      = slip.monthDays || att.monthDays || slip.workingDays || 0;
  const presentDays    = slip.presentDays ?? att.presentDays ?? 0;
  const absentDays     = slip.absentDays ?? 0;
  const approvedLeaves = (slip.paidLeaves || 0) + (slip.unpaidLeaves || 0);
  const halfPaid       = slip.halfPaidDays || 0;
  const halfUnpaid     = slip.halfUnpaidDays || 0;
  const holidayWorked  = slip.holidayWorkedDays || att.holidayWorkedDays || 0;
  const payableDays    = slip.payableDays || 0;
  const perDay         = slip.perDaySalary || (monthDays > 0 ? slip.monthlySalary / monthDays : 0);
  const grossSalary    = slip.monthlySalary || 0;
  const adjustment     = (payroll.holidayWorkedCredit || 0)
                       + (slip.bonuses || 0);
  const deduction      = ded.totalDeductions ?? slip.deductions ?? 0;
  const finalSalary    = slip.netSalary ?? 0;

  const Row = ({ k, v, cls = '' }) => (
    <div className={`flex justify-between text-sm ${cls}`}>
      <span className="text-slate-500 dark:text-slate-400">{k}</span>
      <span className="font-medium text-slate-800 dark:text-slate-100">{v}</span>
    </div>
  );
  return (
    <div className="rounded-lg border border-indigo-100 dark:border-brand-500/30 bg-indigo-50/40 dark:bg-brand-500/10 p-3 space-y-1">
      <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-brand-300 mb-1">
        Payable Days Breakdown
      </div>
      <Row k="Month Days"        v={monthDays} />
      <Row k="Present Days"      v={presentDays} />
      <Row k="Absent Days"       v={absentDays} />
      <Row k="Approved Leave"    v={approvedLeaves} />
      {(halfPaid + halfUnpaid) > 0 && (
        <Row k="Half Days (paid / unpaid)" v={`${halfPaid} / ${halfUnpaid}`} />
      )}
      <Row k="Holiday Worked"    v={holidayWorked} />
      <div className="border-t border-indigo-200/70 dark:border-brand-500/30 my-1" />
      <Row k="Total Payable Days" v={payableDays} cls="font-semibold" />
      <Row k="Per Day Salary"    v={fmtMoney(perDay)} />
      <Row k="Gross Salary"      v={fmtMoney(grossSalary)} />
      {adjustment > 0 && <Row k="Adjustment" v={`+ ${fmtMoney(adjustment)}`} cls="text-green-700 dark:text-green-300" />}
      <Row k="Deduction"         v={`− ${fmtMoney(deduction)}`} cls="text-red-700 dark:text-red-300" />
      <div className="border-t border-indigo-200/70 dark:border-brand-500/30 my-1" />
      <Row k="Final Salary"      v={fmtMoney(finalSalary)} cls="font-bold text-base" />
    </div>
  );
}
