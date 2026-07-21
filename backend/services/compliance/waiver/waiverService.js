/**
 * waiverService.js -- request + decide flow for ComplianceWaiver.
 *
 * A waiver targets EITHER the whole incident (`scope:'full'`) OR a
 * subset of its ActionEffects (`scope:'partial'`).  On decision:
 *
 *   - approved: targeted effects flip to `status:'waived'`, each one
 *     gets an inverse ledger row (`type:'waiver'`, direction +1) so
 *     running balance goes back up.
 *   - rejected: effects untouched, waiver row records the decision.
 *
 * When every effect on the incident is `waived | resolved | cancelled`,
 * the incident itself flips to `waived`.
 */

const mongoose = require('mongoose');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const ComplianceWaiver = require('../../../models/ComplianceWaiver');
const ComplianceRule = require('../../../models/ComplianceRule');
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
  } catch (e) { console.error('[compliance/waiver] event emit failed:', e.message); }
};

/**
 * Employee (or HR-on-behalf) files a waiver request.
 *
 *   request({ incidentId, scope, effectIds, reason, evidenceUrl,
 *             requestedBy, req })
 */
const request = async (args) => {
  const {
    incidentId, scope, effectIds = [], reason = '', evidenceUrl = '',
    requestedBy, req,
  } = args || {};
  if (!incidentId)   throw new Error('waiver.request: incidentId is required.');
  if (!requestedBy)  throw new Error('waiver.request: requestedBy is required.');
  if (!['full', 'partial'].includes(scope)) {
    throw new Error("waiver.request: scope must be 'full' or 'partial'.");
  }
  if (scope === 'partial' && effectIds.length === 0) {
    throw new Error('waiver.request: partial waiver requires at least one effectId.');
  }
  const inc = await ComplianceIncident.findById(incidentId).lean();
  if (!inc) throw new Error('waiver.request: incident not found.');

  const rule = await ComplianceRule.findById(inc.ruleId).lean();
  if (!rule) throw new Error('waiver.request: rule not found.');
  if (rule.waiver && rule.waiver.allowed === false) {
    throw new Error('waiver.request: rule does not allow waivers.');
  }
  if (scope === 'partial' && rule.waiver && rule.waiver.partialAllowed === false) {
    throw new Error('waiver.request: rule does not allow partial waivers.');
  }
  if (rule.waiver && rule.waiver.reasonRequired && !String(reason || '').trim()) {
    throw new Error('waiver.request: reason is required by this rule.');
  }

  const waiver = await ComplianceWaiver.create({
    incidentId, employee: inc.employee,
    scope, effectIds,
    reason: String(reason || '').trim(),
    evidenceUrl: String(evidenceUrl || '').trim(),
    requestedBy, requestedAt: new Date(),
    status: 'pending',
  });

  await _emitEvent({
    employee: inc.employee,
    incidentId,
    kind: 'waiver_requested',
    payload: { scope, effectIds, reason: waiver.reason },
    actor: requestedBy,
  });

  if (req) {
    logAudit(req, {
      action: 'compliance.waiver.request',
      targetType: 'ComplianceWaiver',
      targetId: waiver._id,
      targetLabel: inc.ruleCode,
      meta: { scope, effectIds, reason: waiver.reason, incidentId: String(incidentId) },
    });
  }

  // Batch-1 fix #5 / #9 -- use the compliance notify helper so the
  // Notification body has the correct Penalty-shaped adapter fields.
  const notifyCompliance = require('../notifications/notifyCompliance');
  notifyCompliance.send({
    incident: inc,
    event: 'waiver_requested',
    message: `Waiver request received: ${waiver.reason}`,
    mode: 'probable',
  });

  return waiver.toObject();
};

/**
 * Batch-1 fix #3 / Batch-2 fix #8 -- mirror the effect waiver onto
 * the legacy Penalty row (if any) so the pre-v2 F&P surface stays
 * consistent with the v2 UI.  Runs inside the caller's session when
 * one is provided (Batch-2 makes waiver atomic).
 */
const _cancelMirroredPenalty = async ({ effect, waiver, decidedBy, session = null }) => {
  if (!effect || !effect.penaltyId) return;
  try {
    const Penalty = require('../../../models/Penalty');
    await Penalty.updateOne(
      { _id: effect.penaltyId, status: { $nin: ['cancelled', 'resolved', 'expired'] } },
      { $set: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: decidedBy || null,
          cancelReason: `v2 waiver: ${waiver && waiver.reason || ''}`.trim().slice(0, 500),
      } },
      session ? { session } : undefined,
    );
  } catch (e) {
    console.error('[compliance/waiver] mirror Penalty cancel failed:', e.message);
    // Re-throw when in a transaction so the whole waiver aborts.
    if (session) throw e;
  }
};

/**
 * Apply an approval to a single effect: waive + inverse ledger row +
 * mirror Penalty cancel.  All three writes participate in the caller's
 * `session` when provided (Batch-2 fix #8).
 */
const _applyEffectWaiver = async ({ effect, waiver, decidedBy, req, ruleCode, session = null }) => {
  if (effect.status === 'waived' || effect.status === 'resolved'
      || effect.status === 'cancelled') return effect;
  const updates = {
    status: 'waived',
    waivedAt: new Date(),
    waivedBy: decidedBy,
    waiverId: waiver._id,
    waiverReason: waiver.reason,
  };

  // Determine which ledger to reverse.
  const ledgerFor = {
    zero_daily_marks:      'marks',
    add_daily_total:       'marks',
    fixed_marks_reduction: 'marks',
    percent_reduction:     'percentage',
    financial_fine:        'financial',
    half_day_lwp:          'attendance',
    full_day_lwp:          'attendance',
  }[effect.actionType];

  const q = {
    zero_daily_marks:      effect.marks,
    add_daily_total:       effect.marks,
    fixed_marks_reduction: effect.marks,
    percent_reduction:     effect.percent,
    financial_fine:        effect.amount,
    half_day_lwp:          effect.attendanceUnit,
    full_day_lwp:          effect.attendanceUnit,
  }[effect.actionType];

  if (ledgerFor && Number.isFinite(q) && q > 0) {
    await ledgerService.append({
      ledger: ledgerFor,
      employee: effect.employee,
      date: new Date(),
      direction: +1,
      quantity: q,
      type: 'waiver',
      reason: `waiver of ${effect.actionType}`,
      refIncidentId: effect.incidentId,
      refEffectId: effect._id,
      refWaiverId: waiver._id,
      createdBy: decidedBy,
      session,
    });
  }

  await ComplianceActionEffect.updateMany(
    { _id: effect._id },
    { $set: updates },
    session ? { session } : undefined,
  );

  // Mirror the state onto the legacy Penalty row in the same session.
  await _cancelMirroredPenalty({ effect, waiver, decidedBy, session });

  return { ...effect, ...updates };
};

/**
 * HR decides on a waiver.  Body: `{ decision, note, decidedBy, req }`.
 */
const decide = async (args) => {
  const {
    waiverId, decision, note = '',
    decidedBy, req,
  } = args || {};
  if (!waiverId)   throw new Error('waiver.decide: waiverId is required.');
  if (!decidedBy)  throw new Error('waiver.decide: decidedBy is required.');
  if (!['approved', 'rejected', 'auto_approved'].includes(decision)) {
    throw new Error("waiver.decide: decision must be 'approved' | 'rejected' | 'auto_approved'.");
  }
  const waiver = await ComplianceWaiver.findById(waiverId);
  if (!waiver) throw new Error('waiver.decide: waiver not found.');
  if (waiver.status !== 'pending') return waiver.toObject();

  waiver.status = decision;
  waiver.decidedBy = decidedBy;
  waiver.decidedAt = new Date();
  waiver.decisionNote = String(note || '').trim();
  await waiver.save();

  const inc = await ComplianceIncident.findById(waiver.incidentId);
  if (!inc) throw new Error('waiver.decide: incident missing.');

  if (decision === 'approved' || decision === 'auto_approved') {
    // Batch-2 fix #8 -- wrap every effect flip + ledger append +
    // mirror Penalty cancel + incident auto-close inside a single
    // Mongo transaction.  On replica-set Mongo a mid-loop crash
    // rolls back everything; on standalone Mongo the helper falls
    // back to sequential writes (behaviour identical to Batch 1).
    await withComplianceTransaction(async (session) => {
      const targetIds = waiver.scope === 'full'
        ? (await ComplianceActionEffect.find({ incidentId: waiver.incidentId })
            .session(session).lean())
            .filter((e) => ['pending', 'active'].includes(e.status))
            .map((e) => e._id)
        : waiver.effectIds;
      for (const eid of targetIds) {
        const q = ComplianceActionEffect.findById(eid);
        if (session) q.session(session);
        const eff = await q.lean();
        if (!eff) continue;
        await _applyEffectWaiver({
          effect: eff, waiver, decidedBy, req, ruleCode: inc.ruleCode, session,
        });
      }

      // Auto-resolve incident when nothing outstanding remains.  The
      // check runs inside the same session so a concurrent partial
      // waiver can't observe a half-updated set.
      const remaining = await ComplianceActionEffect.find({
        incidentId: waiver.incidentId,
        status: { $in: ['pending', 'active'] },
      }).session(session).lean();
      if (remaining.length === 0) {
        inc.status = 'waived';
        inc.waivedAt = new Date();
        inc.waivedBy = decidedBy;
        inc.waiverId = waiver._id;
        if (session) await inc.save({ session });
        else await inc.save();
      }
    });
  }

  await _emitEvent({
    employee: inc.employee,
    incidentId: waiver.incidentId,
    kind: 'waiver_decided',
    payload: { decision, note: waiver.decisionNote, scope: waiver.scope },
    actor: decidedBy,
  });

  if (req) {
    logAudit(req, {
      action: 'compliance.waiver.decide',
      targetType: 'ComplianceWaiver',
      targetId: waiver._id,
      targetLabel: inc.ruleCode,
      meta: {
        decision, note: waiver.decisionNote,
        incidentId: String(waiver.incidentId), scope: waiver.scope,
      },
    });
  }

  // Batch-1 fix #5 / #9 -- correct-shape notification via compliance helper.
  const notifyCompliance = require('../notifications/notifyCompliance');
  notifyCompliance.send({
    incident: inc,
    event: 'waiver_decided',
    message: `Waiver ${decision}${waiver.decisionNote ? `: ${waiver.decisionNote}` : ''}`,
    mode: 'active',
  });

  return waiver.toObject();
};

module.exports = { request, decide };
