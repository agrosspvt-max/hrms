import { useMemo, useState } from 'react';
import api from '../../../api/axios';
import Modal from '../../../components/Modal.jsx';
import { useToast } from '../../../context/ToastContext.jsx';
import { useAuth } from '../../../context/AuthContext.jsx';
import { errMsg } from '../../../utils/helpers';
import { actionMeta, ruleTitle } from '../../../utils/incidentPresenter.js';

/**
 * LifecycleActionModal -- single, shared confirmation surface for
 * every manual compliance lifecycle action.  Used by both the
 * timeline card actions dropdown and the incident-detail summary
 * buttons so the reason-required + preview + audit contract is
 * enforced identically everywhere.
 *
 * All work is delegated to the existing backend endpoints (no
 * business logic on the frontend).  The modal is a thin veneer that:
 *   1. Shows what will happen server-side (preview list).
 *   2. Shows ledger before/after deltas the user can eyeball.
 *   3. Requires a meaningful reason (>= 5 non-whitespace chars).
 *   4. Calls one endpoint on Confirm.
 *   5. Renders a success panel with the reference IDs the API
 *      returned.
 *
 * Props:
 *   open                boolean
 *   onClose             ()  → void
 *   onDone              (result) → void   fired after success panel closes
 *   action              one of ACTIONS below
 *   incident            the ComplianceIncident doc (with populated employee)
 *   effects             array of ComplianceActionEffect docs
 *   waiver              { _id, ... }  required for waive-approve / waive-reject
 *   currentImpact       optional {marks:{balance}, financial:{balance}, ...}
 *                       used to render before/after ledger deltas
 */

const ACTIONS = {
  activate: {
    title: 'Activate incident',
    verb: 'Activate',
    endpoint: (id) => ({ method: 'post', url: `/compliance/incidents/${id}/activate` }),
    reversesEffects: false,
    fireActions: true,
    warnCopy: 'The action engine will execute immediately, bypassing the scheduled effective date.',
    successTitle: 'Incident activated',
    validStates: ['candidate'],
  },
  cancel: {
    title: 'Cancel incident',
    verb: 'Cancel',
    endpoint: (id) => ({ method: 'post', url: `/compliance/incidents/${id}/cancel` }),
    reversesEffects: true,
    warnCopy: 'This incident and every applied consequence will be reversed as if it never occurred.',
    successTitle: 'Incident cancelled',
    validStates: ['candidate', 'active'],
  },
  recover: {
    title: 'Apply recovery',
    verb: 'Recover',
    endpoint: (id) => ({ method: 'post', url: `/compliance/incidents/${id}/recover` }),
    extraBody: (state) => ({ mode: state.mode || 'restore' }),
    reversesEffects: true,
    warnCopy: 'Every applied ledger entry will be reversed and the incident marked resolved.',
    successTitle: 'Recovery applied',
    hasModeSelector: true,
    validStates: ['active'],
  },
  waive: {
    title: 'Direct waive (HR)',
    verb: 'Waive & approve',
    endpoint: (id) => ({ method: 'post', url: `/compliance/incidents/${id}/waive` }),
    extraBody: () => ({ scope: 'full' }),
    reversesEffects: true,
    warnCopy: 'A waiver record is created and auto-approved; every ledger entry is reversed.',
    successTitle: 'Waiver approved',
    validStates: ['active'],
  },
  'waive-approve': {
    title: 'Approve waiver request',
    verb: 'Approve waiver',
    endpoint: (id, waiverId) => ({ method: 'post', url: `/compliance/incidents/${id}/waive/decide` }),
    extraBody: (state) => ({ waiverId: state.waiverId, decision: 'approved', note: state.reason }),
    reversesEffects: true,
    warnCopy: 'The pending waiver will be approved and every ledger entry will be reversed.',
    successTitle: 'Waiver approved',
    validStates: ['active', 'candidate'],
  },
  'waive-reject': {
    title: 'Reject waiver request',
    verb: 'Reject waiver',
    endpoint: (id, waiverId) => ({ method: 'post', url: `/compliance/incidents/${id}/waive/decide` }),
    extraBody: (state) => ({ waiverId: state.waiverId, decision: 'rejected', note: state.reason }),
    reversesEffects: false,
    warnCopy: 'The waiver request will be rejected. No ledger entries are reversed.',
    successTitle: 'Waiver rejected',
    validStates: ['active', 'candidate'],
  },
  resolve: {
    title: 'Resolve incident',
    verb: 'Resolve',
    endpoint: (id) => ({ method: 'post', url: `/compliance/incidents/${id}/resolve` }),
    reversesEffects: false,
    warnCopy: 'Incident is marked resolved.  Existing ledger entries are preserved (use Recovery to also refund).',
    successTitle: 'Incident resolved',
    validStates: ['active', 'candidate'],
  },
};

export default function LifecycleActionModal({
  open, onClose, onDone,
  action, incident, effects = [], waiver = null, currentImpact = null,
}) {
  const spec = ACTIONS[action];
  const toast = useToast();
  const { user } = useAuth();
  const [reason, setReason] = useState('');
  const [mode, setMode]     = useState('restore');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  // Reset every time the modal reopens for a new action.
  useMemo(() => {
    if (open) { setReason(''); setMode('restore'); setSubmitting(false); setResult(null); }
    return null;
  }, [open, action, incident && incident._id]);

  // Which effects are still open (candidate/active) and therefore
  // reversible by this action.  Used to compute the preview deltas.
  const targets = useMemo(() => {
    if (!spec || !spec.reversesEffects) return [];
    return (effects || []).filter((e) => ['pending', 'active'].includes(e.status));
  }, [effects, spec]);

  // Sum reversals per ledger family, based on the executor's ledger
  // mapping (see incidentPresenter.actionMeta).
  const deltas = useMemo(() => {
    const acc = { marks: 0, financial: 0, percentage: 0, attendance: 0 };
    for (const e of targets) {
      const meta = actionMeta(e.actionType);
      if (!meta.ledger) continue;
      if (meta.ledger === 'marks')      acc.marks      += Number(e.marks) || 0;
      if (meta.ledger === 'financial')  acc.financial  += Number(e.amount) || 0;
      if (meta.ledger === 'percentage') acc.percentage += Number(e.percent) || 0;
      if (meta.ledger === 'attendance') acc.attendance += Number(e.attendanceUnit) || 0;
    }
    return acc;
  }, [targets]);

  if (!open || !spec) return null;

  const reasonValid = String(reason || '').trim().length >= 5;
  const canSubmit = !submitting && reasonValid && (!spec.hasModeSelector || mode);

  // Compose the endpoint + body via the ACTIONS spec.
  const onSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const call = spec.endpoint(incident._id, waiver && waiver._id);
      const body = {
        reason: reason.trim(),
        ...(spec.extraBody ? spec.extraBody({ reason: reason.trim(), mode, waiverId: waiver && waiver._id }) : {}),
      };
      const { data } = await api[call.method](call.url, body);
      // Compose a success summary that the panel renders.
      setResult({
        response: data,
        appliedChanges: buildAppliedChanges(spec, targets, deltas),
        reference: buildReference(spec, data, waiver),
      });
    } catch (e) {
      toast.error(errMsg(e));
      setSubmitting(false);
    }
  };
  const close = () => {
    if (result && onDone) onDone(result);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={spec.title}
      size="lg"
      footer={result ? (
        <button className="btn-primary" onClick={close}>Done</button>
      ) : (
        <>
          <button className="btn-secondary" onClick={close} disabled={submitting}>Cancel</button>
          <button className="btn-primary" onClick={onSubmit} disabled={!canSubmit}>
            {submitting ? 'Working…' : spec.verb}
          </button>
        </>
      )}
    >
      {result ? (
        <SuccessPanel spec={spec} result={result} incident={incident} user={user} />
      ) : (
        <ConfirmPanel
          spec={spec} incident={incident} targets={targets} deltas={deltas}
          currentImpact={currentImpact}
          waiver={waiver}
          reason={reason} setReason={setReason} reasonValid={reasonValid}
          mode={mode} setMode={setMode}
        />
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Confirm panel — action preview + reason input                       */
/* ------------------------------------------------------------------ */
function ConfirmPanel({
  spec, incident, targets, deltas, currentImpact, waiver,
  reason, setReason, reasonValid, mode, setMode,
}) {
  const previewLines = useMemo(() => {
    const lines = [];
    if (spec.reversesEffects) {
      if (deltas.marks     > 0) lines.push(`Recover ${deltas.marks} mark${deltas.marks === 1 ? '' : 's'}`);
      if (deltas.financial > 0) lines.push(`Refund ₹${deltas.financial}`);
      if (deltas.percentage > 0) lines.push(`Reverse ${deltas.percentage}% completion reduction`);
      if (deltas.attendance > 0) lines.push(`Restore ${deltas.attendance} attendance unit${deltas.attendance === 1 ? '' : 's'}`);
      const notifyOnly = targets.filter((e) => !actionMeta(e.actionType).ledger);
      if (notifyOnly.length) lines.push(`Close ${notifyOnly.length} non-ledger effect(s) (notifications, warnings, performance-lock)`);
    }
    if (spec.fireActions)   lines.push('Fire the action engine and write ledger rows');
    if (targets.some((e) => e.penaltyId)) lines.push('Cancel the mirrored legacy Penalty row');
    if (spec === ACTIONS['waive-reject']) lines.push('Mark the pending waiver as rejected');
    lines.push('Update the incident status');
    lines.push('Emit a timeline event and update dashboard analytics');
    lines.push('Write an audit-log entry');
    lines.push('Notify the employee');
    return lines;
  }, [spec, targets, deltas]);

  return (
    <div className="space-y-4">
      {/* Action headline */}
      <div className="border rounded-md p-3 bg-slate-50">
        <div className="text-[11px] uppercase text-slate-500 font-semibold">Action</div>
        <div className="text-base font-semibold text-slate-900">{spec.title}</div>
        <div className="text-sm text-slate-600 mt-1">{spec.warnCopy}</div>
      </div>

      {/* Preview list */}
      <div>
        <div className="text-[11px] uppercase text-slate-500 font-semibold mb-1">This action will:</div>
        <ul className="text-sm text-slate-800 space-y-1">
          {previewLines.map((line, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className="text-emerald-600">✓</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Ledger deltas (before/after) */}
      {spec.reversesEffects && (
        <DeltaTable deltas={deltas} currentImpact={currentImpact} />
      )}

      {/* Recovery mode selector */}
      {spec.hasModeSelector && (
        <div>
          <label className="text-[11px] uppercase text-slate-500 font-semibold">Recovery mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}
            className="w-full border rounded-md text-sm px-2 py-1.5 mt-1">
            <option value="restore">Restore (reverse ledger + resolve)</option>
            <option value="information">Information (reverse ledger; analytics counts the day)</option>
            <option value="neutral">Neutral (reverse ledger; analytics ignores the day)</option>
          </select>
        </div>
      )}

      {/* Reason (mandatory) */}
      <div>
        <label className="text-[11px] uppercase text-slate-500 font-semibold">
          Reason <span className="text-red-500">*</span>
        </label>
        <textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Explain why this action is being taken.  Visible in the audit trail."
          className={`w-full border rounded-md text-sm px-2 py-1.5 mt-1 ${reason && !reasonValid ? 'border-red-400' : ''}`}
        />
        <div className="text-[11px] text-slate-500 mt-1">
          {reasonValid
            ? `${reason.trim().length} characters`
            : `Minimum 5 characters. ${reason.trim().length} entered.`}
        </div>
      </div>

      {/* Existing waiver context (for waive-approve / waive-reject) */}
      {waiver && (
        <div className="border rounded-md p-2 bg-amber-50 text-xs text-amber-900">
          Pending waiver requested by employee on {new Date(waiver.requestedAt).toLocaleString()}.
          {waiver.reason && <div className="mt-1">Employee reason: <em>{waiver.reason}</em></div>}
        </div>
      )}

      <div className="text-[11px] text-slate-500 italic">This action cannot be undone.</div>
    </div>
  );
}

function DeltaTable({ deltas, currentImpact }) {
  const rows = [];
  const cur = currentImpact || {};
  const push = (family, label, delta, unit, prefixUnit = false) => {
    if (!delta) return;   // hide unchanged ledgers
    const current = cur[family] ? Number(cur[family].balance) || 0 : null;
    const after = current == null ? null : current + delta;
    rows.push({ label, delta, unit, prefixUnit, current, after });
  };
  push('marks',      'Marks',            deltas.marks,      'pts');
  push('financial',  'Financial fine',   deltas.financial,  '₹', true);
  push('percentage', 'Completion',       deltas.percentage, '%');
  push('attendance', 'Attendance',       deltas.attendance, 'unit(s)');

  if (rows.length === 0) return null;
  const fmt = (v, unit, prefix) => {
    if (v == null) return '—';
    const abs = Math.abs(v);
    if (prefix) return `${v < 0 ? '−' : ''}${unit}${abs}`;
    return `${v < 0 ? '−' : ''}${abs} ${unit}`;
  };
  return (
    <div>
      <div className="text-[11px] uppercase text-slate-500 font-semibold mb-1">Change summary</div>
      <div className="border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium text-slate-600">Ledger</th>
              <th className="text-right px-3 py-1.5 font-medium text-slate-600">Current</th>
              <th className="text-right px-3 py-1.5 font-medium text-slate-600">After</th>
              <th className="text-right px-3 py-1.5 font-medium text-emerald-700">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-3 py-1.5">{r.label}</td>
                <td className="px-3 py-1.5 text-right text-slate-500">{fmt(r.current, r.unit, r.prefixUnit)}</td>
                <td className="px-3 py-1.5 text-right font-medium">{fmt(r.after, r.unit, r.prefixUnit)}</td>
                <td className="px-3 py-1.5 text-right text-emerald-700 font-medium">
                  +{r.prefixUnit ? `${r.unit}${r.delta}` : `${r.delta} ${r.unit}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Success panel                                                       */
/* ------------------------------------------------------------------ */
function SuccessPanel({ spec, result, incident, user }) {
  const now = new Date();
  return (
    <div className="space-y-3">
      <div className="text-2xl">✅</div>
      <div className="text-lg font-semibold text-slate-900">{spec.successTitle}</div>
      <div>
        <div className="text-[11px] uppercase text-slate-500 font-semibold mb-1">Changes applied</div>
        <ul className="text-sm text-slate-800 space-y-1">
          {result.appliedChanges.map((line, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className="text-emerald-600">✓</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
      <dl className="text-sm border-t pt-3 space-y-1">
        {result.reference && (
          <div className="flex gap-2"><dt className="text-slate-500 min-w-[7rem]">Reference</dt>
            <dd className="text-slate-800"><code className="text-[12px]">{result.reference}</code></dd></div>
        )}
        <div className="flex gap-2"><dt className="text-slate-500 min-w-[7rem]">Rule</dt>
          <dd className="text-slate-800">{ruleTitle(incident.ruleCode)}</dd></div>
        <div className="flex gap-2"><dt className="text-slate-500 min-w-[7rem]">Completed by</dt>
          <dd className="text-slate-800">{user && (user.name || user.email) ? user.name || user.email : 'HR'}</dd></div>
        <div className="flex gap-2"><dt className="text-slate-500 min-w-[7rem]">Completed at</dt>
          <dd className="text-slate-800">{now.toLocaleString()}</dd></div>
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reference + summary composition                                     */
/* ------------------------------------------------------------------ */
function buildAppliedChanges(spec, targets, deltas) {
  const lines = [];
  if (spec.reversesEffects) {
    if (deltas.marks     > 0) lines.push(`Marks recovered (+${deltas.marks})`);
    if (deltas.financial > 0) lines.push(`Financial fine refunded (₹${deltas.financial})`);
    if (deltas.percentage > 0) lines.push(`Completion percentage restored (+${deltas.percentage}%)`);
    if (deltas.attendance > 0) lines.push(`Attendance restored (+${deltas.attendance})`);
    const notifyOnly = targets.filter((e) => !actionMeta(e.actionType).ledger);
    if (notifyOnly.length) lines.push(`${notifyOnly.length} non-ledger effect(s) closed`);
  }
  if (spec.fireActions) lines.push('Action engine executed');
  lines.push('Incident status updated');
  lines.push('Timeline event emitted');
  lines.push('Dashboard analytics refreshed');
  lines.push('Employee notified');
  lines.push('Audit log entry written');
  return lines;
}
function buildReference(spec, response, waiver) {
  // Compose a stable short reference based on what came back.
  if (waiver && waiver._id) return `WAIVER-${String(waiver._id).slice(-6).toUpperCase()}`;
  if (response && response._id) {
    const prefix = spec === ACTIONS.recover ? 'RECOV'
                 : spec === ACTIONS.waive   ? 'WAIVER'
                 : spec === ACTIONS.cancel  ? 'CANCEL'
                 : spec === ACTIONS.activate ? 'ACT'
                 : spec === ACTIONS.resolve ? 'RESOLVE'
                 : 'REF';
    return `${prefix}-${String(response._id).slice(-6).toUpperCase()}`;
  }
  return null;
}

/**
 * validActionsFor(incident, waivers) -- pure helper for the timeline
 * card dropdown.  Returns [{key, label}].  Consumers pass the incident
 * status + a list of associated waivers; each pending waiver adds
 * approve/reject entries.
 */
export function validActionsFor(incident, waivers = []) {
  if (!incident) return [];
  const s = incident.status;
  const out = [];
  if (s === 'candidate') {
    out.push({ key: 'activate', label: 'Activate immediately' });
    out.push({ key: 'cancel',   label: 'Cancel incident',      danger: true });
  } else if (s === 'active') {
    out.push({ key: 'waive',    label: 'Waive (direct)' });
    out.push({ key: 'recover',  label: 'Apply recovery' });
    out.push({ key: 'resolve',  label: 'Mark resolved' });
    out.push({ key: 'cancel',   label: 'Cancel incident',      danger: true });
  }
  for (const w of waivers || []) {
    if (w && w.status === 'pending') {
      out.push({ key: 'waive-approve', label: 'Approve waiver request', waiverId: w._id });
      out.push({ key: 'waive-reject',  label: 'Reject waiver request',  waiverId: w._id, danger: true });
    }
  }
  return out;
}
