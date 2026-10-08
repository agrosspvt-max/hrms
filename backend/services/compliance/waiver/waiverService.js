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
const { logAudit } = require('../../../utils/audit');
const notify = require('../../notifyEvents');
const { withComplianceTransaction } = require('../txn');
const legacyMirror = require('../legacyMirror');
const lifecycle = require('../lifecycle');

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
  if (!inc) throw new lifecycle.LifecycleError('waiver.request: incident not found.', { httpStatus: 404, code: 'not_found' });

  // Only candidate|active incidents can be waived; resolved / waived /
  // cancelled / expired are terminal and are not reopened by a request.
  if (!lifecycle.OPEN_INCIDENT.includes(inc.status)) {
    throw new lifecycle.LifecycleError(
      `waiver.request: incident is already ${inc.status}; there is nothing to waive.`,
      { code: `incident_${inc.status}` },
    );
  }
  if (scope === 'partial') {
    const own = await ComplianceActionEffect.find({ incidentId, _id: { $in: effectIds } }).lean();
    if (own.length !== new Set(effectIds.map(String)).size) {
      throw new lifecycle.LifecycleError(
        'waiver.request: every effectId must belong to this incident.',
        { httpStatus: 400, code: 'bad_effect_ids' },
      );
    }
  }

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

  // Idempotent request: a retry / double-click with an identical pending
  // request returns the existing one instead of queueing a duplicate.
  const sameKey = (a) => [...a].map(String).sort().join(',');
  const dup = (await ComplianceWaiver.find({ incidentId, status: 'pending' }).lean())
    .find((w) => w.scope === scope && sameKey(w.effectIds || []) === sameKey(effectIds || []));
  if (dup) return dup;

  // `requestKey` + the partial unique index make this race-proof: two
  // concurrent identical requests resolve to one pending row.
  const requestKey = `${incidentId}|${scope}|${sameKey(effectIds || [])}`;
  let waiver;
  try {
    waiver = await ComplianceWaiver.create({
      incidentId, employee: inc.employee,
      scope, effectIds,
      reason: String(reason || '').trim(),
      evidenceUrl: String(evidenceUrl || '').trim(),
      requestedBy, requestedAt: new Date(),
      status: 'pending',
      requestKey,
    });
  } catch (e) {
    if (e && e.code === 11000) {
      const winner = await ComplianceWaiver.findOne({ requestKey, status: 'pending' }).lean();
      if (winner) return winner;
    }
    throw e;
  }

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
 * HR decides on a waiver.  Body: `{ decision, note, decidedBy, req }`.
 *
 * Phase 2 state rules:
 *   - A waiver is decided at most once.  Repeating the SAME outcome
 *     returns the stored decision unchanged (no event, no credit);
 *     asking for a DIFFERENT outcome is a 409.
 *   - Rejecting is allowed whatever state the incident is in (it only
 *     clears the queue).  Approving requires the incident to be
 *     candidate|active -- an approval can never resurrect or rewrite a
 *     cancelled / resolved / waived incident.
 *   - Approval runs as ONE unit: claim the waiver (pending -> decided),
 *     claim + credit each targeted effect, mirror the legacy Penalty,
 *     and, if nothing outstanding remains, move the incident open ->
 *     waived with a conditional update.  On replica sets the unit is a
 *     transaction (a failure rolls the claim back); on standalone Mongo
 *     a failure is compensated explicitly below.
 */
const _APPROVALS = ['approved', 'auto_approved'];

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
  const existing = await ComplianceWaiver.findById(waiverId).lean();
  if (!existing) throw new lifecycle.LifecycleError('waiver.decide: waiver not found.', { httpStatus: 404, code: 'not_found' });

  const sameOutcome = (a, b) => a === b || (_APPROVALS.includes(a) && _APPROVALS.includes(b));
  if (existing.status !== 'pending') {
    if (sameOutcome(existing.status, decision)) return { ...existing, alreadyDecided: true };
    throw new lifecycle.LifecycleError(
      `waiver.decide: this waiver is already ${existing.status}; it cannot be ${decision}.`,
      { code: `waiver_${existing.status}` },
    );
  }

  const incPre = await ComplianceIncident.findById(existing.incidentId).lean();
  if (!incPre) throw new lifecycle.LifecycleError('waiver.decide: incident missing.', { httpStatus: 404, code: 'not_found' });

  const decidedNote = String(note || '').trim();
  const claimPatch = { status: decision, decidedBy, decidedAt: new Date(), decisionNote: decidedNote };
  let waiver = null;
  let incidentAfter = incPre.status;
  let waivedEffectIds = [];
  let closedWaivers = [];

  if (decision === 'rejected') {
    // Atomic claim: only ONE concurrent / repeated review wins.
    waiver = await ComplianceWaiver.findOneAndUpdate(
      { _id: waiverId, status: 'pending' }, { $set: claimPatch }, { new: true },
    );
  } else {
    lifecycle.assertOpen(incPre, 'approve this waiver');
    let usedSession = false;
    let out = null;
    try {
      await withComplianceTransaction(async (session) => {
        usedSession = !!session;
        out = { claimed: null, effectIds: [], incidentStatus: null, closed: [] };
        const opts = session ? { new: true, session } : { new: true };
        const claimed = await ComplianceWaiver.findOneAndUpdate(
          { _id: waiverId, status: 'pending' }, { $set: claimPatch }, opts,
        );
        if (!claimed) return;                       // someone else decided it
        out.claimed = claimed;

        const iq = ComplianceIncident.findById(claimed.incidentId);
        if (session) iq.session(session);
        const inc = await iq.lean();
        lifecycle.assertOpen(inc, 'approve this waiver');
        out.incidentStatus = inc.status;

        const base = { incidentId: claimed.incidentId };
        const eq = ComplianceActionEffect.find(
          claimed.scope === 'full'
            ? { ...base, status: { $in: lifecycle.OUTSTANDING_EFFECT } }
            : { ...base, _id: { $in: claimed.effectIds || [] } },
        );
        if (session) eq.session(session);
        const targets = await eq.lean();

        const mirrorIds = [];
        for (const eff of targets) {
          const r = await lifecycle.claimAndReverse({
            effect: eff,
            toStatus: 'waived',
            set: {
              waivedAt: new Date(), waivedBy: decidedBy,
              waiverId: claimed._id, waiverReason: claimed.reason,
            },
            ledgerType: 'waiver',
            reason: `waiver of ${eff.actionType}`,
            refs: { waiverId: claimed._id },
            actor: decidedBy,
            session,
          });
          if (!r.claimed) continue;
          out.effectIds.push(eff._id);
          // Explicit per-effect link only; the incident-wide natural-key
          // mirror is added below solely when the incident is fully waived.
          if (eff.penaltyId) mirrorIds.push(eff.penaltyId);
        }
        if (claimed.scope === 'partial' && out.effectIds.length === 0) {
          throw new lifecycle.LifecycleError(
            'waiver.decide: none of the targeted effects can be waived (already waived, resolved or cancelled).',
            { code: 'nothing_to_waive' },
          );
        }

        // Auto-close the incident when nothing outstanding remains.  The
        // conditional update is what stops an approval from overwriting a
        // concurrently cancelled / resolved incident.
        const rq = ComplianceActionEffect.find({ ...base, status: { $in: lifecycle.OUTSTANDING_EFFECT } });
        if (session) rq.session(session);
        const remaining = await rq.lean();
        if (remaining.length === 0) {
          const closedInc = await ComplianceIncident.findOneAndUpdate(
            { _id: claimed.incidentId, status: { $in: lifecycle.OPEN_INCIDENT } },
            { $set: { status: 'waived', waivedAt: new Date(), waivedBy: decidedBy, waiverId: claimed._id } },
            opts,
          );
          if (!closedInc) {
            throw new lifecycle.LifecycleError(
              'waiver.decide: the incident changed state while the waiver was being applied.',
              { code: 'incident_state_changed' },
            );
          }
          out.incidentStatus = 'waived';
          for (const id of await legacyMirror.penaltyIdsFor({ effect: null, incident: inc, session })) {
            if (!mirrorIds.some((x) => String(x) === String(id))) mirrorIds.push(id);
          }
          out.closed = await lifecycle.closePendingWaivers({
            incidentId: claimed.incidentId, exceptId: claimed._id, decidedBy,
            note: 'Closed automatically: the incident was waived.', session,
          });
        }
        await lifecycle.mirrorPenalties({
          ids: mirrorIds,
          set: {
            status: 'cancelled',
            cancelledAt: new Date(),
            cancelledBy: decidedBy || null,
            cancelReason: `v2 waiver: ${claimed.reason || ''}`.trim().slice(0, 500),
          },
          session,
          label: 'waiver',
        });
      });
    } catch (e) {
      // Replica set: the transaction already rolled the claim back.
      // Standalone: the claim was written before the failure -- undo it.
      // A state conflict (LifecycleError) means the incident can no longer
      // be waived, so close the request instead of leaving it pending on
      // a terminal incident; any other failure returns it to the queue.
      if (!usedSession && out && out.claimed) {
        const back = (e instanceof lifecycle.LifecycleError)
          ? { status: 'rejected', decisionNote: 'Closed automatically: the incident can no longer be waived.' }
          : { status: 'pending', decidedBy: null, decidedAt: null, decisionNote: '' };
        await ComplianceWaiver.findOneAndUpdate({ _id: waiverId, status: decision }, { $set: back })
          .catch(async () => {
            await ComplianceWaiver.findOneAndUpdate(
              { _id: waiverId, status: decision },
              { $set: { status: 'rejected', decisionNote: 'Closed automatically: approval failed.' } },
            ).catch(() => {});
          });
      }
      throw e;
    }
    waiver = out && out.claimed;
    if (waiver) {
      incidentAfter = out.incidentStatus;
      waivedEffectIds = out.effectIds;
      closedWaivers = out.closed;
    }
  }

  if (!waiver) {
    // Lost the race: report the stored decision, change nothing.
    const now = await ComplianceWaiver.findById(waiverId).lean();
    if (now && now.status !== 'pending' && !sameOutcome(now.status, decision)) {
      throw new lifecycle.LifecycleError(
        `waiver.decide: this waiver is already ${now.status}; it cannot be ${decision}.`,
        { code: `waiver_${now.status}` },
      );
    }
    return now ? { ...now, alreadyDecided: true } : now;
  }

  for (const w of closedWaivers) {
    await _emitEvent({
      employee: incPre.employee,
      incidentId: waiver.incidentId,
      kind: 'waiver_decided',
      payload: { decision: 'rejected', auto: true, reason: 'incident_waived', waiverId: w._id },
      actor: decidedBy,
    });
  }
  await _emitEvent({
    employee: incPre.employee,
    incidentId: waiver.incidentId,
    kind: 'waiver_decided',
    payload: {
      decision, note: waiver.decisionNote, scope: waiver.scope, waiverId: waiver._id,
      effectIds: waivedEffectIds, incidentFrom: incPre.status, incidentTo: incidentAfter,
    },
    actor: decidedBy,
  });

  if (req) {
    logAudit(req, {
      action: 'compliance.waiver.decide',
      targetType: 'ComplianceWaiver',
      targetId: waiver._id,
      targetLabel: incPre.ruleCode,
      meta: {
        decision, note: waiver.decisionNote,
        incidentId: String(waiver.incidentId), scope: waiver.scope,
        incidentFrom: incPre.status, incidentTo: incidentAfter,
      },
    });
  }

  // Batch-1 fix #5 / #9 -- correct-shape notification via compliance helper.
  const notifyCompliance = require('../notifications/notifyCompliance');
  notifyCompliance.send({
    incident: incPre,
    event: 'waiver_decided',
    message: `Waiver ${decision}${waiver.decisionNote ? `: ${waiver.decisionNote}` : ''}`,
    mode: 'active',
  });

  return waiver.toObject ? waiver.toObject() : { ...waiver };
};

module.exports = { request, decide };
