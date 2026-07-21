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
const ledgerService = require('../ledger/ledgerService');
const { logAudit } = require('../../../utils/audit');
const notify = require('../../notifyEvents');
const { withComplianceTransaction } = require('../txn');

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

  const inc = await ComplianceIncident.findById(incidentId);
  if (!inc) throw new Error('recovery.apply: incident not found.');

  const targets = effectIds && effectIds.length
    ? await ComplianceActionEffect.find({
        _id: { $in: effectIds }, incidentId,
      }).lean()
    : await ComplianceActionEffect.find({
        incidentId, status: { $in: ['pending', 'active'] },
      }).lean();

  const recovery = await ComplianceRecovery.create({
    incidentId, employee: inc.employee,
    effectIds: targets.map((t) => t._id),
    mode, reason: String(reason || '').trim(),
    createdBy: actor,
  });

  const ledgerFor = {
    zero_daily_marks:      'marks',
    add_daily_total:       'marks',
    fixed_marks_reduction: 'marks',
    percent_reduction:     'percentage',
    financial_fine:        'financial',
    half_day_lwp:          'attendance',
    full_day_lwp:          'attendance',
  };
  const qtyFor = (e) => ({
    zero_daily_marks:      e.marks,
    add_daily_total:       e.marks,
    fixed_marks_reduction: e.marks,
    percent_reduction:     e.percent,
    financial_fine:        e.amount,
    half_day_lwp:          e.attendanceUnit,
    full_day_lwp:          e.attendanceUnit,
  }[e.actionType]);

  // Batch-2 fix #8 -- wrap the per-effect loop + auto-close in one
  // Mongo transaction so a crash mid-loop cannot leave the incident
  // half-recovered.  Standalone Mongo falls back to sequential mode.
  await withComplianceTransaction(async (session) => {
    for (const e of targets) {
      if (['resolved', 'waived', 'cancelled'].includes(e.status)) continue;

      const ledger = ledgerFor[e.actionType];
      const q = qtyFor(e);
      if (ledger && Number.isFinite(q) && q > 0) {
        await ledgerService.append({
          ledger,
          employee: inc.employee,
          date: new Date(),
          direction: +1,
          quantity: q,
          type: 'recovery',
          reason: `${mode}: ${e.actionType}`,
          refIncidentId: incidentId,
          refEffectId: e._id,
          refRecoveryId: recovery._id,
          createdBy: actor,
          session,
        });
      }

      await ComplianceActionEffect.updateMany(
        { _id: e._id },
        { $set: {
            status: 'resolved',
            resolvedAt: new Date(),
            resolvedBy: actor,
            resolvedReason: `${mode}: ${recovery.reason || ''}`,
        } },
        session ? { session } : undefined,
      );

      // Batch-1 fix #3 + Batch-2 fix #8 -- Penalty mirror in the same
      // session.  `restore` recovers marks; `information` / `neutral`
      // also mark the underlying Penalty resolved for dashboard parity.
      if (e.penaltyId) {
        try {
          const Penalty = require('../../../models/Penalty');
          await Penalty.updateOne(
            { _id: e.penaltyId, status: { $nin: ['cancelled', 'resolved', 'expired'] } },
            { $set: {
                status: 'resolved',
                resolvedAt: new Date(),
                resolvedBy: actor,
                restorationReason: `v2 recovery ${mode}: ${recovery.reason || ''}`.trim().slice(0, 500),
            } },
            session ? { session } : undefined,
          );
        } catch (mirrorErr) {
          console.error('[compliance/recovery] mirror Penalty resolve failed:', mirrorErr.message);
          if (session) throw mirrorErr;
        }
      }
    }

    // Auto-resolve incident when nothing outstanding remains.
    const remaining = await ComplianceActionEffect.find({
      incidentId, status: { $in: ['pending', 'active'] },
    }).session(session).lean();
    if (remaining.length === 0) {
      inc.status = 'resolved';
      inc.resolvedAt = new Date();
      inc.resolvedBy = actor;
      if (session) await inc.save({ session });
      else await inc.save();
    }
  });

  await _emitEvent({
    employee: inc.employee, incidentId,
    kind: 'recovery_applied',
    payload: { mode, effectIds: targets.map((t) => t._id), reason: recovery.reason },
    actor,
  });

  if (req) {
    logAudit(req, {
      action: 'compliance.recovery.apply',
      targetType: 'ComplianceRecovery',
      targetId: recovery._id,
      targetLabel: inc.ruleCode,
      meta: {
        mode, incidentId: String(incidentId),
        effectCount: targets.length, reason: recovery.reason,
      },
    });
  }

  // Batch-1 fix #5 / #9 -- correct-shape notification via compliance helper.
  const notifyCompliance = require('../notifications/notifyCompliance');
  notifyCompliance.send({
    incident: inc,
    event: 'recovery_applied',
    message: `Recovery applied (${mode})${recovery.reason ? `: ${recovery.reason}` : ''}`,
    mode: 'active',
  });

  return recovery.toObject();
};

module.exports = { apply };
