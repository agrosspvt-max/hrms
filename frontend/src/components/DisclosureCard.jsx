import { useEffect, useState } from 'react';
import api from '../api/axios';
import { useToast } from '../context/ToastContext.jsx';
import { errMsg } from '../utils/helpers';
import {
  DISCLOSURE_TYPES, emptyDisclosure, changeType, changeCorrectable,
  validateDisclosure, buildDisclosurePayload,
} from '../utils/disclosure';

const YesNo = ({ name, value, onChange }) => (
  <div className="flex gap-4">
    {[{ v: true, l: 'Yes' }, { v: false, l: 'No' }].map((o) => (
      <label key={o.l} className="flex items-center gap-1.5 text-sm">
        <input type="radio" name={name} checked={value === o.v} onChange={() => onChange(o.v)} />
        {o.l}
      </label>
    ))}
  </div>
);

/**
 * DisclosureCard -- day-level, like DailyReflectionCard: one disclosure per
 * employee per business date, saved via /api/disclosures and hydrated from
 * the employee's OWN record for the target date.
 */
export default function DisclosureCard({ date = null, label = null }) {
  const targetIso = date || new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState(emptyDisclosure());
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setForm(emptyDisclosure()); setSavedAt(null);
    api.get('/disclosures/mine', { params: { date: targetIso } })
      .then(({ data }) => {
        if (cancelled || !data) return;
        setForm({
          type: data.type || '',
          details: data.details || '',
          correctable: typeof data.correctable === 'boolean' ? data.correctable : null,
          corrected: typeof data.corrected === 'boolean' ? data.corrected : null,
          authorizedBy: data.authorizedBy || '',
        });
        setSavedAt(new Date(data.updatedAt || data.createdAt));
      })
      .catch(() => { /* starts empty on any error */ });
    return () => { cancelled = true; };
  }, [targetIso]);

  const error = form.type ? validateDisclosure(form) : '';

  const save = async () => {
    if (busy) return;                       // double-click guard (server is idempotent too)
    const msg = validateDisclosure(form);
    if (msg) { toast.error(msg); return; }
    setBusy(true);
    try {
      await api.post('/disclosures', buildDisclosurePayload(form, targetIso));
      setSavedAt(new Date());
      toast.success('Disclosure saved');
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="card card-body space-y-3 bg-slate-50 border-slate-200">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-800">{label || 'Disclosure'}</div>
          <div className="text-[11px] text-slate-500">Optional. Tell HR about a mistake, an exception you were granted, or anything else about today's work.</div>
        </div>
        {savedAt && <span className="text-[11px] text-slate-500">Saved {savedAt.toLocaleTimeString()}</span>}
      </div>

      <div>
        <label className="label">Disclosure Type</label>
        <select className="input max-w-xs" value={form.type}
          onChange={(e) => setForm((f) => changeType(f, e.target.value))}>
          <option value="">Select Disclosure Type</option>
          {DISCLOSURE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      {form.type && (
        <div>
          <label className="label">Details <span className="text-red-500">*</span></label>
          <textarea className="input" rows={3} maxLength={2000}
            placeholder={form.type === 'mistake' ? 'Explain the mistake' : form.type === 'exception' ? 'Describe the exception' : 'Details'}
            value={form.details} onChange={(e) => setForm((f) => ({ ...f, details: e.target.value }))} />
        </div>
      )}

      {form.type === 'mistake' && (
        <div className="space-y-3">
          <div>
            <label className="label">Whether the mistake is correctable? <span className="text-red-500">*</span></label>
            <YesNo name={`correctable-${targetIso}`} value={form.correctable}
              onChange={(v) => setForm((f) => changeCorrectable(f, v))} />
          </div>
          {form.correctable === true && (
            <div>
              <label className="label">Did you correct the mistake? <span className="text-red-500">*</span></label>
              <YesNo name={`corrected-${targetIso}`} value={form.corrected}
                onChange={(v) => setForm((f) => ({ ...f, corrected: v }))} />
            </div>
          )}
        </div>
      )}

      {form.type === 'exception' && (
        <div>
          <label className="label">Who authorized the Exception? <span className="text-red-500">*</span></label>
          <input className="input max-w-md" maxLength={200}
            placeholder="Enter name of person who authorized the exception"
            value={form.authorizedBy} onChange={(e) => setForm((f) => ({ ...f, authorizedBy: e.target.value }))} />
        </div>
      )}

      {form.type && (
        <div className="flex items-center justify-end gap-3">
          {error && <span className="text-[11px] text-slate-500">{error}</span>}
          <button className="btn-secondary" disabled={busy || !!error} onClick={save}>
            {busy ? 'Saving…' : 'Save Disclosure'}
          </button>
        </div>
      )}
    </div>
  );
}
