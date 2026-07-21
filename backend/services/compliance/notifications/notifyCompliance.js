/**
 * notifyCompliance.js -- unified helper for compliance-driven
 * notification writes.  Bridges the compliance domain (incidents,
 * waivers, recoveries, action effects) to the org-wide
 * `services/notifyEvents.notifyPenalty` writer.
 *
 * Motivation (Batch-1 fix #5 + Batch-2 fix #9): the waiver /
 * recovery services previously called `notify.notifyPenalty` with
 * a Waiver-shaped payload — missing `probable`, `penaltyMarks`,
 * `targetDate` and other fields the notification writer relies on.
 * This helper builds a Penalty-shaped adapter object from an
 * incident + action-effect + optional message so the notification
 * writer always sees a correct shape.
 *
 * Every function is best-effort: exceptions are logged and swallowed.
 * The compliance engine must never fail because a notification write
 * failed.
 */

let _notifyEvents = null;
const _lazyNotify = () => {
  if (_notifyEvents) return _notifyEvents;
  try {
    _notifyEvents = require('../../notifyEvents');
  } catch (_) {
    _notifyEvents = { notifyPenalty: () => {} };
  }
  return _notifyEvents;
};

/**
 * Build the Penalty-shaped adapter object.  Every field the legacy
 * `notifyPenalty` reads is populated with a safe default when the
 * incident cannot supply it.
 */
// Batch-2 fix #9 -- adapter hardening.  Every field the legacy
// notifyPenalty writer reads has a safe default; nested lookups are
// null-guarded; non-finite numeric inputs clamp to 0; message text
// is trimmed + length-capped so a runaway executor never blows out
// the Notification body.
const _safeString = (v, cap = 500) => {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s.length > cap ? s.slice(0, cap) : s;
};
const _safeNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const _buildAdapter = ({ incident, effect = null, event = '', message = '' }) => {
  const inc = incident || {};
  const eff = effect || {};
  const targetDate =
    eff.effectiveDate ||
    inc.effectiveDate ||
    inc.incidentDate ||
    new Date();
  const ruleCode = inc.ruleCode || 'compliance';
  return {
    _id: eff._id || inc._id || null,
    employee: inc.employee || null,
    // Legacy consumers key notifications by `category`; we pass the
    // rule code so the frontend can namespace v2 rows separately.
    category: ruleCode,
    source: 'automatic',
    probable: false,
    status: 'active',
    penaltyMarks: _safeNumber(eff.marks),
    amount: _safeNumber(eff.amount),
    completionPercent: _safeNumber(eff.percent),
    targetDate,
    effectiveDate: targetDate,
    submission: (inc.context && inc.context.submissionId) || null,
    rule: `${ruleCode}${event ? ':' + event : ''}`,
    reason: _safeString(message || ruleCode || 'Compliance event'),
    employeeMessage: _safeString(message),
    incidentId: inc._id || null,
    // Non-legacy addendum -- forward event kind so future consumers can
    // branch without re-parsing `rule`.
    complianceEvent: event || null,
  };
};

/**
 * Fire a compliance notification for a specific incident/effect.
 * `mode` mirrors the legacy notifyPenalty modes (`active`,
 * `probable`, `resolved`).  Never throws.
 */
const _VALID_MODES = new Set(['active', 'probable', 'resolved']);

const send = ({ incident, effect = null, event = '', message = '', mode = 'active' } = {}) => {
  try {
    if (!incident || !incident.employee) return;
    // Batch-2 fix #9 -- coerce mode to a known value so a caller
    // passing an unknown mode string doesn't crash the notification
    // writer downstream.
    const safeMode = _VALID_MODES.has(mode) ? mode : 'active';
    const penalty = _buildAdapter({ incident, effect, event, message });
    // Guard against the (unlikely) case where the adapter couldn't
    // resolve an employee -- notifyPenalty would throw on missing
    // recipient.
    if (!penalty.employee) return;
    _lazyNotify().notifyPenalty({
      employeeId: incident.employee,
      penalty,
      mode: safeMode,
      event: event || null,
    });
  } catch (e) {
    // Never propagate — notifications are best-effort.
    console.error('[compliance/notify] send failed:', e.message);
  }
};

module.exports = { send };
