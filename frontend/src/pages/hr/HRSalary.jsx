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
            <button className="btn-primary" disabled={busy || !rangeValid} onClick={generateAll}>{busy ? 'Generating...' : 'Generate / Refresh All Slips'}</button>
          </div>
        </div>
      </div>

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
