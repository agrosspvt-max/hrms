/**
 * lifecycle.js -- shared state-machine rules + the single idempotency
 * gate for compliance lifecycle operations (cancel / waive / recover).
 *
 * Incident state machine (Phase 2):
 *
 *   candidate | active   (OPEN)      -- the only states a lifecycle
 *                                      operation may move an incident OUT of.
 *   resolved | waived | cancelled | expired  (TERMINAL) -- never rewritten
 *                                      into another terminal outcome.
 *
 * Effect state machine: pending|active -> {resolved | waived | cancelled}.
 * An effect leaves pending|active exactly once, and that transition is
 * the idempotency anchor for ledger reversals: `claimAndReverse` does an
 * atomic compare-and-set on the effect, and ONLY the caller that wins the
 * claim writes the compensating ledger row.  A loser (concurrent or
 * repeated request) gets `claimed:false` and writes nothing.
 */
const ComplianceActionEffect = require('../../models/ComplianceActionEffect');
const ComplianceWaiver = require('../../models/ComplianceWaiver');
const ledgerService = require('./ledger/ledgerService');

const OPEN_INCIDENT = Object.freeze(['candidate', 'active']);
const TERMINAL_INCIDENT = Object.freeze(['resolved', 'waived', 'cancelled', 'expired']);
const OUTSTANDING_EFFECT = Object.freeze(['pending', 'active']);

/** Carries an HTTP status so controllers can answer 404/409, not a blanket 400/500. */
class LifecycleError extends Error {
  constructor(message, { httpStatus = 409, code = 'invalid_transition' } = {}) {
    super(message);
    this.name = 'LifecycleError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

const assertOpen = (incident, operation) => {
  if (!incident) throw new LifecycleError(`${operation}: incident not found.`, { httpStatus: 404, code: 'not_found' });
  if (!OPEN_INCIDENT.includes(incident.status)) {
    throw new LifecycleError(
      `Cannot ${operation}: the incident is already ${incident.status}.`,
      { code: `incident_${incident.status}` },
    );
  }
};

const LEDGER_FOR = Object.freeze({
  zero_daily_marks:      'marks',
  add_daily_total:       'marks',
  fixed_marks_reduction: 'marks',
  percent_reduction:     'percentage',
  financial_fine:        'financial',
  half_day_lwp:          'attendance',
  full_day_lwp:          'attendance',
});
const quantityOf = (e) => ({
  zero_daily_marks:      e.marks,
  add_daily_total:       e.marks,
  fixed_marks_reduction: e.marks,
  percent_reduction:     e.percent,
  financial_fine:        e.amount,
  half_day_lwp:          e.attendanceUnit,
  full_day_lwp:          e.attendanceUnit,
}[e.actionType]);

/**
 * Atomically move ONE effect out of pending|active and, only if this
 * call won the claim, append its compensating (+1) ledger row.
 *
 * Returns `{ claimed, credited }`.  `credited` is false when the effect
 * has no ledger footprint (zero quantity / unknown type) or a reversal
 * for the effect already exists (legacy state left by the pre-Phase-2
 * race); the status flip still happens so the effect leaves the
 * outstanding set.
 */
const claimAndReverse = async ({
  effect, toStatus, set = {}, ledgerType, reason, refs = {}, actor = null, session = null,
}) => {
  const priorStatus = effect.status;
  const claimed = await ComplianceActionEffect.findOneAndUpdate(
    { _id: effect._id, status: { $in: OUTSTANDING_EFFECT } },
    { $set: { status: toStatus, ...set } },
    session ? { session } : undefined,
  );
  if (!claimed) return { claimed: false, credited: false };

  const ledger = LEDGER_FOR[effect.actionType];
  const q = quantityOf(effect);
  let credited = false;
  if (ledger && Number.isFinite(q) && q > 0) {
    try {
      const already = await ledgerService.hasReversal({ ledger, effectId: effect._id, session });
      if (!already) {
        await ledgerService.append({
          ledger,
          employee: effect.employee,
          date: new Date(),
          direction: +1,
          quantity: q,
          type: ledgerType,
          reason,
          refIncidentId: effect.incidentId,
          refEffectId: effect._id,
          refRecoveryId: refs.recoveryId || null,
          refWaiverId: refs.waiverId || null,
          createdBy: actor,
          session,
        });
        credited = true;
      }
    } catch (err) {
      // With a session the surrounding transaction rolls the claim back.
      // Without one (standalone Mongo) the claim is already written, so
      // hand the effect back to the state we found it in; otherwise a
      // retry would see nothing outstanding and the credit would be lost.
      if (!session) {
        const undo = Object.fromEntries(Object.keys(set).map((k) => [k, null]));
        await ComplianceActionEffect.updateOne(
          { _id: effect._id, status: toStatus },
          { $set: { ...undo, status: priorStatus } },
        ).catch(() => {});
      }
      throw err;
    }
  }
  return { claimed: true, credited };
};

/**
 * Update legacy Penalty mirror rows.  Guarded on status so a repeat is a
 * no-op and a cancelled/resolved/expired row is never resurrected or
 * re-stamped.  Errors abort the surrounding transaction when there is one.
 */
const mirrorPenalties = async ({ ids, set, session = null, label = 'lifecycle' }) => {
  if (!ids || !ids.length) return;
  const Penalty = require('../../models/Penalty');
  try {
    await Penalty.updateMany(
      { _id: { $in: ids }, status: { $nin: ['cancelled', 'resolved', 'expired'] } },
      { $set: set },
      session ? { session } : undefined,
    );
  } catch (e) {
    console.error(`[compliance/${label}] mirror Penalty update failed:`, e.message);
    if (session) throw e;
  }
};

/**
 * Close still-pending waiver requests on an incident (history kept; the
 * rows are marked 'rejected' with a system note).  Returns the closed rows.
 */
const closePendingWaivers = async ({ incidentId, exceptId = null, decidedBy, note, session = null }) => {
  const q = ComplianceWaiver.find({ incidentId, status: 'pending' });
  if (session) q.session(session);
  const rows = (await q.lean()).filter((w) => !exceptId || String(w._id) !== String(exceptId));
  if (!rows.length) return [];
  await ComplianceWaiver.updateMany(
    { _id: { $in: rows.map((w) => w._id) }, status: 'pending' },
    { $set: { status: 'rejected', decidedBy, decidedAt: new Date(), decisionNote: note } },
    session ? { session } : undefined,
  );
  return rows;
};

module.exports = {
  OPEN_INCIDENT, TERMINAL_INCIDENT, OUTSTANDING_EFFECT,
  LifecycleError, assertOpen,
  LEDGER_FOR, quantityOf,
  claimAndReverse, mirrorPenalties, closePendingWaivers,
};
