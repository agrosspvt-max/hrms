/**
 * recoveryService.js -- HR-initiated recovery of one or more effects.
 *
 * Reuses the semantics of the existing `services/performanceRecovery`
 * `applyEvaluationMode` (restore / information / neutral) so downstream
 * consumers see identical behaviour.  Persists ComplianceRecovery,
 * flips targeted effects to `resolved`, appends inverse ledger rows
 * for `restore` mode, and emits `compliance.recovery_applied`.
 */

const ComplianceRecovery = require('../../../models/ComplianceRecovery');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const mongoose = require('mongoose');
const lifecycle = require('../lifecycle');
const { logAudit } = require('../../../utils/audit');
const notify = require('../../notifyEvents');
const { withComplianceTransaction } = require('../txn');
const legacyMirror = require('../legacyMirror');

const _emitEvent = async ({ employee, incidentId, kind, payload, actor }) => {
  try {
    const ComplianceEvent = require('../../../models/ComplianceEvent');
    await ComplianceEvent.create({
      employee, incidentId, kind, payload: payload || {},
      actor: actor || 'system', ts: new Date(),
    });
  } catch (e) { console.error('[compliance/recovery] event emit failed:', e.message); }
};

/**
 * apply({ incidentId, effectIds, mode, reason, actor, req })
 *
 *   mode = 'restore' -> inverse ledger rows + effect.status='resolved'
 *   mode = 'information' -> effect.status='resolved', ledgers reversed
 *                            (day counts in analytics but no marks penalty)
 *   mode = 'neutral' -> effect.status='resolved', ledgers reversed AND
 *                       analytics ignores the day (informational meta)
 *
 * For Phase 6 all three modes share the same ledger reversal path;
 * information / neutral will diverge in Phase 8 analytics when the
 * dashboard consumes `recovery.mode` for its bucket rules.
 *
 * Phase 2 state rules:
 *   - candidate | active: recover the outstanding effects; the incident
 *     becomes `resolved` only when none remain (partial recovery keeps it
 *     open).
 *   - resolved: allowed ONLY to refund effects that were left outstanding
 *     by a "resolve without reversing"; the incident stays `resolved`
 *     (status and resolvedAt/By are not rewritten).
 *   - cancelled | waived | expired: refused (409).  A cancelled or waived
 *     incident is never flipped to resolved.
 *   - Each effect is claimed atomically (pending|active -> resolved) and
 *     credited only by the winner, so concurrent / repeated recoveries
 *     cannot credit twice.  A recovery that claims nothing is refused
 *     (409) and writes NO ComplianceRecovery row, event or ledger entry.
 */
const apply = async (args) => {
  const {
    incidentId, effectIds = null, mode,
    reason = '', actor, req,
  } = args || {};
  if (!incidentId) throw new Error('recovery.apply: incidentId is required.');
  if (!actor)      throw new Error('recovery.apply: actor is required.');
  if (!['restore', 'information', 'neutral'].includes(mode)) {
    throw new Error("recovery.apply: mode must be 'restore' | 'information' | 'neutral'.");
  }

  const incPre = await ComplianceIncident.findById(incidentId).lean();
  if (!incPre) throw new lifecycle.LifecycleError('recovery.apply: incident not found.', { httpStatus: 404, code: 'not_found' });

  const recoveryId = new mongoose.Types.ObjectId();
  const cleanReason = String(reason || '').trim();
  let out = null;

  // Batch-2 fix #8 -- one Mongo transaction (serial on standalone).
  await withComplianceTransaction(async (session) => {
    out = { claimed: [], incidentFrom: null, incidentTo: null, recovery: null, closedWaivers: [] };
    const sess = (q) => (session ? q.session(session) : q);

    // Re-read inside the unit: the pre-read above may be stale.
    const inc = await sess(ComplianceIncident.findById(incidentId)).lean();
    if (!inc) throw new lifecycle.LifecycleError('recovery.apply: incident not found.', { httpStatus: 404, code: 'not_found' });
    out.incidentFrom = inc.status;
    out.incidentTo = inc.status;
    const open = lifecycle.OPEN_INCIDENT.includes(inc.status);
    if (!open && inc.status !== 'resolved') {
      throw new lifecycle.LifecycleError(
        `Cannot recover: the incident is already ${inc.status}.`,
        { code: `incident_${inc.status}` },
      );
    }

    const all = await sess(ComplianceActionEffect.find({ incidentId })).lean();
    const wanted = effectIds && effectIds.length ? new Set(effectIds.map(String)) : null;
    const targets = all.filter((e) =>
      lifecycle.OUTSTANDING_EFFECT.includes(e.status) && (!wanted || wanted.has(String(e._id))));

    const mirrorIds = [];
    for (const e of targets) {
      const r = await lifecycle.claimAndReverse({
        effect: e,
        toStatus: 'resolved',
        set: {
          resolvedAt: new Date(), resolvedBy: actor,
          resolvedReason: `${mode}: ${cleanReason}`,
        },
        ledgerType: 'recovery',
        reason: `${mode}: ${e.actionType}`,
        refs: { recoveryId },
        actor,
        session,
      });
      if (!r.claimed) continue;
      out.claimed.push(e._id);
      if (e.penaltyId) mirrorIds.push(e.penaltyId);
    }

    // Nothing recovered: refuse, unless this is an open incident that has
    // no effects at all (recovery then simply closes it, as before).
    if (out.claimed.length === 0 && !(open && all.length === 0)) {
      throw new lifecycle.LifecycleError(
        'Cannot recover: there are no outstanding effects to recover (already recovered, waived or cancelled).',
        { code: 'nothing_to_recover' },
      );
    }

    // Auto-resolve the incident when nothing outstanding remains.  The
    // conditional update never flips a concurrently cancelled / waived
    // incident to resolved; a resolved incident is left exactly as is.
    const remaining = await sess(ComplianceActionEffect.find({
      incidentId, status: { $in: lifecycle.OUTSTANDING_EFFECT },
    })).lean();
    if (remaining.length === 0) {
      if (open) {
        const closed = await ComplianceIncident.findOneAndUpdate(
          { _id: incidentId, status: { $in: lifecycle.OPEN_INCIDENT } },
          { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy: actor } },
          session ? { new: true, session } : { new: true },
        );
        if (!closed) {
          throw new lifecycle.LifecycleError(
            'Cannot recover: the incident changed state while the recovery was being applied.',
            { code: 'incident_state_changed' },
          );
        }
        out.incidentTo = 'resolved';
        // The refund makes any still-pending waiver request moot; close it
        // (history kept) so it cannot linger against a resolved incident.
        out.closedWaivers = await lifecycle.closePendingWaivers({
          incidentId, decidedBy: actor,
          note: 'Closed automatically: the incident was resolved by recovery.', session,
        });
      }
      // Incident-level legacy mirror (explicit link OR shared natural key)
      // only once the incident has nothing outstanding; a partial
      // recovery touches only the legacy rows explicitly linked to the
      // recovered effects.
      for (const id of await legacyMirror.penaltyIdsFor({ effect: null, incident: inc, session })) {
        if (!mirrorIds.some((x) => String(x) === String(id))) mirrorIds.push(id);
      }
    }
    await lifecycle.mirrorPenalties({
      ids: mirrorIds,
      set: {
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: actor,
        restorationReason: `v2 recovery ${mode}: ${cleanReason}`.trim().slice(0, 500),
      },
      session,
      label: 'recovery',
    });

    const doc = {
      _id: recoveryId, incidentId, employee: inc.employee,
      effectIds: out.claimed, mode, reason: cleanReason, createdBy: actor,
    };
    const created = session
      ? (await ComplianceRecovery.create([doc], { session }))[0]
      : await ComplianceRecovery.create(doc);
    out.recovery = created;
  });

  const recovery = out.recovery;
  for (const w of out.closedWaivers) {
    await _emitEvent({
      employee: incPre.employee, incidentId,
      kind: 'waiver_decided',
      payload: { decision: 'rejected', auto: true, reason: 'incident_recovered', waiverId: w._id },
      actor,
    });
  }
  await _emitEvent({
    employee: incPre.employee, incidentId,
    kind: 'recovery_applied',
    payload: {
      mode, effectIds: out.claimed, reason: cleanReason, recoveryId: recovery._id,
      incidentFrom: out.incidentFrom, incidentTo: out.incidentTo,
    },
    actor,
  });

  if (req) {
    logAudit(req, {
      action: 'compliance.recovery.apply',
      targetType: 'ComplianceRecovery',
      targetId: recovery._id,
      targetLabel: incPre.ruleCode,
      meta: {
        mode, incidentId: String(incidentId),
        effectCount: out.claimed.length, reason: cleanReason,
        incidentFrom: out.incidentFrom, incidentTo: out.incidentTo,
      },
    });
  }

  // Batch-1 fix #5 / #9 -- correct-shape notification via compliance helper.
  const notifyCompliance = require('../notifications/notifyCompliance');
  notifyCompliance.send({
    incident: incPre,
    event: 'recovery_applied',
    message: `Recovery applied (${mode})${cleanReason ? `: ${cleanReason}` : ''}`,
    mode: 'active',
  });

  return recovery.toObject ? recovery.toObject() : { ...recovery };
};

module.exports = { apply };
