/**
 * performanceRecovery.js  --  Phase 64 shared recovery workflow.
 *
 * Spec Part 9: "The same Performance Recovery workflow should be
 * shared by both Missed Submission and Performance Lock."
 *
 * Both entry points end in an HR-picked evaluation mode:
 *
 *   restore     -- Marks restored. Penalty is Resolved.
 *   information -- Analytics values in, marks stay 0.
 *   neutral     -- Day is ignored (Available=Earned=Final=0).
 *
 * The three modes are stamped on the Penalty document; every read
 * path that surfaces submissions (attachFinalMarks) consults them
 * to decide how a day's Available / Earned / Final marks project.
 *
 * Never mutates Submission.earnedPoints -- Part 8 (backward compat).
 * All derivation happens on read via penaltyMath.attachFinalMarks.
 */
const Penalty = require('../models/Penalty');
const { logAudit } = require('../utils/audit');
const notify = require('./notifyEvents');

const VALID_MODES = ['restore', 'information', 'neutral'];

/**
 * Apply an HR decision to a penalty of category='missed_submission'
 * or 'performance_lock'.  Same three modes for both; the caller is
 * responsible for the penalty already being in a state where a
 * decision makes sense (approved reopen, resolved lock, ...).
 *
 *   applyEvaluationMode({ penalty, mode, actor, note })
 *
 * On success returns the updated (lean) Penalty.
 */
const applyEvaluationMode = async ({
  penalty, mode, actor, note = '', req = null,
  /* Phase 64.5 hardening -- transaction support.
   *   session         optional Mongoose ClientSession; when passed,
   *                   penalty.save() participates in the caller's
   *                   transaction and audit/notify are DEFERRED so
   *                   they never fire on a rolled-back write.
   *   deferSideEffects when true, the helper returns
   *                   `{ record, pendingSideEffects }` and the caller
   *                   must invoke pendingSideEffects.fire(req) AFTER
   *                   the transaction commits.  When false or session
   *                   is absent, audit + notify fire inline as before
   *                   (fully backward compatible).
   */
  session = null,
  deferSideEffects = false,
}) => {
  if (!penalty) throw new Error('Penalty required');
  if (!VALID_MODES.includes(mode)) throw new Error(`mode must be one of: ${VALID_MODES.join(', ')}`);

  penalty.evaluationMode = mode;

  if (mode === 'restore') {
    penalty.status = 'resolved';
    penalty.resolvedAt = new Date();
    penalty.resolvedBy  = actor?._id || null;
    penalty.restoredBy  = actor?._id || null;
    penalty.restorationReason = note || '';
    try {
      const originalPenalty = Number(penalty.penaltyMarks) || 0;
      penalty.restoredMarks = originalPenalty;
      if (penalty.submission) {
        const Submission = require('../models/Submission');
        // Read participates in the transaction when a session is
        // provided, so restoredFromFinalMarks is consistent.
        const query = Submission.findById(penalty.submission).select('earnedPoints totalPoints').lean();
        const sub = session ? await query.session(session) : await query;
        if (sub) {
          const earned = Number(sub.earnedPoints) || 0;
          penalty.restoredFromFinalMarks = Math.max(0, earned - originalPenalty);
          penalty.restoredToFinalMarks = earned;
        }
      }
    } catch (_) { /* audit trail best-effort */ }
    penalty.penaltyMarks = 0;
  } else if (mode === 'information') {
    penalty.status = 'active';
    penalty.resolvedAt = null;
  } else if (mode === 'neutral') {
    penalty.status = 'active';
    penalty.resolvedAt = null;
  }

  // Phase 64.5 -- session-aware save.  Falls through to the
  // pre-Phase-64.5 signature when no session is supplied.
  if (session) await penalty.save({ session });
  else         await penalty.save();

  // Bundle the side-effects into a fire() closure.  When the caller
  // opted into `deferSideEffects` we return without firing so a
  // transaction rollback never leaves an audit row or a notification
  // pointing to a phantom penalty state.
  const actionLabel = penalty.category === 'missed_submission'
    ? `missed_submission.${mode}`
    : `performance_lock.${mode}`;
  const meta = { penaltyId: penalty._id, mode, note };
  const LABEL = {
    restore:     'HR Restored Marks',
    information: 'HR Marked as Information Only',
    neutral:     'HR Marked as Neutral Day',
  };
  const auditPayload = {
    action: actionLabel,
    targetType: 'Penalty',
    targetId: penalty._id,
    targetLabel: penalty.category,
    meta,
  };
  const notifyPayload = {
    employeeId: penalty.employee,
    penalty: {
      ...penalty.toObject(),
      employeeMessage: `${LABEL[mode]}: ${note || penalty.reason || ''}`.trim(),
    },
    mode: mode === 'restore' ? 'probable' : 'active',
    // Phase-1 dedupe: each HR recovery action is a distinct event on
    // the SAME penalty document (restore / information / neutral) --
    // pass an explicit event tag so the (recipient, eventKey, variant)
    // partial unique index treats each transition as its own message.
    event: `recovery.${mode}`,
  };
  const pendingSideEffects = {
    fire: (fireReq = req) => {
      try { if (fireReq) logAudit(fireReq, auditPayload); } catch (_) { /* silent */ }
      try { notify.notifyPenalty(notifyPayload); }        catch (_) { /* silent */ }
    },
    auditPayload,
    notifyPayload,
  };

  if (deferSideEffects) {
    return { record: penalty.toObject(), pendingSideEffects };
  }

  // Fire inline (backwards-compatible path).
  pendingSideEffects.fire(req);
  return penalty.toObject();
};

module.exports = {
  VALID_MODES,
  applyEvaluationMode,
};
