import { useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';

/**
 * WaiverRequestModal -- employee (or HR-on-behalf) files a waiver
 * request.  Supports both `full` and `partial` scopes.  Effects that
 * are already resolved / waived / cancelled are hidden from the
 * per-effect checkbox list.
 */
export default function WaiverRequestModal({ incident, effects = [], open, onClose, onSubmitted }) {
  const [scope, setScope] = useState('full');
  const [selected, setSelected] = useState(() => new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  if (!open || !incident) return null;
  const openEffects = (effects || []).filter((e) => ['pending', 'active'].includes(e.status));

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const submit = async () => {
    if (!reason.trim()) { toast.error('Please provide a reason for the waiver request.'); return; }
    if (scope === 'partial' && selected.size === 0) {
      toast.error('Select at least one action to waive.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/compliance/incidents/${incident._id}/waive/request`, {
        scope,
        effectIds: scope === 'partial' ? [...selected] : [],
        reason: reason.trim(),
      });
      toast.success('Waiver request submitted.');
      onSubmitted && onSubmitted();
      onClose && onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Request Waiver">
      <div className="space-y-4">
        <div className="text-xs text-slate-500">
          Ask HR to remove one or more consequences from this incident. Every
          waiver is auditable; only HR / Super Admin can approve.
        </div>
        <div>
          <label className="label">Scope</label>
          <div className="flex items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={scope === 'full'} onChange={() => setScope('full')} />
              <span>Waive the entire incident</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={scope === 'partial'} onChange={() => setScope('partial')} />
              <span>Waive selected actions</span>
            </label>
          </div>
        </div>
        {scope === 'partial' && (
          <div>
            <label className="label">Actions</label>
            {openEffects.length === 0 ? (
              <div className="text-xs text-slate-500 border rounded-md p-3 bg-slate-50">
                No open actions to waive.
              </div>
            ) : (
              <ul className="space-y-1">
                {openEffects.map((e) => (
                  <li key={e._id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.has(e._id)}
                      onChange={() => toggle(e._id)}
                    />
                    <span>{e.actionType}</span>
                    {e.amount ? <span className="text-slate-500 text-xs">₹{e.amount}</span> : null}
                    {e.percent ? <span className="text-slate-500 text-xs">-{e.percent}%</span> : null}
                    {e.marks ? <span className="text-slate-500 text-xs">-{e.marks} pts</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div>
          <label className="label">Reason <span className="text-red-500">*</span></label>
          <textarea
            className="input"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain why HR should waive this."
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
