/**
 * incidentService.js -- authoritative create / promote / resolve /
 * cancel for ComplianceIncident.
 *
 * `recordIncident(candidate)` is idempotent.  It relies on the
 * partial-unique index on {naturalKey, source:'automatic'} at the DB
 * layer, and additionally catches E11000 so a race between two
 * scheduler ticks resolves to a single row.
 *
 * Every mutation also emits a ComplianceEvent row for the timeline
 * and (Phase 4 additive) publishes on the existing realtime bus so
 * any listener that's already subscribed to `penalty:changed` for
 * the same employee gets a nudge.
 */

const mongoose = require('mongoose');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceEvent    = require('../../../models/ComplianceEvent');
const { startOfDay } = require('../../../utils/dateHelpers');
const { logAudit }   = require('../../../utils/audit');
const lifecycle      = require('../lifecycle');
let _rt = null;   // lazy require -- realtime module has its own boot
const _getRT = () => {
  if (_rt) return _rt;
  try { _rt = require('../../realtime'); } catch (_) { _rt = { publish: () => {} }; }
  return _rt;
};

const SYSTEM_ACTOR = 'system';

/**
 * Write a ComplianceEvent row.  Never throws to the caller -- the
 * timeline is best-effort; incident creation must not fail because
 * event fan-out failed.
 */
const _emitEvent = async ({ employee, incidentId, kind, payload, actor }) => {
  try {
    await ComplianceEvent.create({
      employee,
      incidentId: incidentId || null,
      kind,
      payload: payload || {},
      actor: actor || SYSTEM_ACTOR,
      ts: new Date(),
    });
    _getRT().publish(employee, 'compliance:changed', {
      incidentId: incidentId ? String(incidentId) : null,
      kind,
    });
  } catch (e) {
    console.error('[compliance/incidents] emit event failed:', e.message);
  }
};

/**
 * Idempotent creation.  `candidate`:
 *
 *   {
 *     rule,           // full ComplianceRule doc  (required for version + code)
 *     employeeId,     // ObjectId (required)
 *     naturalKey,     // string  (required)
 *     incidentDate,   // Date    (required)
 *     effectiveDate,  // Date    (required)
 *     context,        // scalar snapshot for the audit trail
 *     detectorMeta,   // free-form
 *     source,         // 'automatic' | 'manual'  (default 'automatic')
 *     severity,       // enum override; defaults to rule.severity
 *     req,            // optional Express req for audit
 *     actor,          // optional actor ObjectId (manual creation)
 *   }
 *
 * Returns `{ incident, created }`.  `created` is false when the row
 * already existed (idempotency).
 */
const recordIncident = async (candidate) => {
  const {
    rule, employeeId, naturalKey, incidentDate, effectiveDate,
    context = {}, detectorMeta = {},
    source = 'automatic', severity, req, actor,
  } = candidate || {};

  if (!rule || !rule._id) throw new Error('recordIncident: rule is required.');
  if (!employeeId)        throw new Error('recordIncident: employeeId is required.');
  if (!naturalKey)        throw new Error('recordIncident: naturalKey is required.');
  if (!incidentDate)      throw new Error('recordIncident: incidentDate is required.');
  if (!effectiveDate)     throw new Error('recordIncident: effectiveDate is required.');

  const doc = {
    ruleId:       rule._id,
    ruleVersion:  Number(rule.version) || 1,
    ruleCode:     rule.code,
    employee:     employeeId,
    severity:     severity || rule.severity || 'medium',
    incidentDate: startOfDay(incidentDate),
    effectiveDate: startOfDay(effectiveDate),
    naturalKey,
    context,
    detectorMeta,
    source,
    createdBy:    actor || (req && req.user ? req.user._id : null),
    status:       'candidate',
  };

  let inserted = null;
  try {
    inserted = await ComplianceIncident.create(doc);
  } catch (e) {
    if (e && e.code === 11000) {
      const existing = await ComplianceIncident.findOne({
        naturalKey,
        source,
      }).lean();
      return { incident: existing, created: false };
    }
    throw e;
  }

  await _emitEvent({
    employee: employeeId,
    incidentId: inserted._id,
    kind: 'incident_created',
    payload: {
      ruleCode: rule.code,
      severity: doc.severity,
      incidentDate: doc.incidentDate,
      effectiveDate: doc.effectiveDate,
      source,
    },
    actor: actor || (req && req.user ? req.user._id : SYSTEM_ACTOR),
  });

  // Automatic incidents get a system audit row; manual ones use the
  // caller's actor via logAudit(req, ...).
  if (source === 'automatic') {
    try {
      const AuditLog = require('../../../models/AuditLog');
      await AuditLog.create({
        actor: new mongoose.Types.ObjectId('000000000000000000000000'),
        actorRole: 'system',
        action: 'compliance.incident.create',
        targetType: 'ComplianceIncident',
        targetId: inserted._id,
        targetLabel: `${rule.code}`,
        meta: {
          employee: String(employeeId),
          ruleCode: rule.code,
          naturalKey,
          incidentDate: doc.incidentDate,
          effectiveDate: doc.effectiveDate,
        },
      });
    } catch (e) { console.error('[compliance/incidents] audit failed:', e.message); }
  } else if (req) {
    logAudit(req, {
      action: 'compliance.incident.create',
      targetType: 'ComplianceIncident',
      targetId: inserted._id,
      targetLabel: `${rule.code}`,
      meta: {
        employee: String(employeeId),
        ruleCode: rule.code,
        naturalKey,
        incidentDate: doc.incidentDate,
        effectiveDate: doc.effectiveDate,
        source: 'manual',
      },
    });
  }

  return { incident: inserted.toObject(), created: true };
};

/**
 * Promote a candidate incident to active when `now >= effectiveDate`.
 * Returns the updated incident, or null when no promotion happened.
 *
 * Stabilization patch (C3): the previous implementation did
 * `findOne` -> mutate -> `save`, which is NOT atomic.  Two ticks
 * racing on the same candidate both won the read and both emitted
 * `incident_effective`.  Replaced with `findOneAndUpdate` that
 * matches on `{status:'candidate', effectiveDate:$lte}` in a single
 * atomic operation -- only ONE caller gets the doc back, every
 * concurrent racer receives `null` and returns without emitting.
 */
const promoteToActive = async (incidentId, { now = new Date() } = {}) => {
  const inc = await ComplianceIncident.findOneAndUpdate(
    {
      _id: incidentId,
      status: 'candidate',
      effectiveDate: { $lte: now },
    },
    { $set: { status: 'active' } },
    { new: true },
  );
  if (!inc) return null;   // another tick promoted it OR predicate no longer matches
  await _emitEvent({
    employee: inc.employee,
    incidentId: inc._id,
    kind: 'incident_effective',
    payload: { ruleCode: inc.ruleCode, effectiveDate: inc.effectiveDate },
    actor: SYSTEM_ACTOR,
  });
  try {
    const AuditLog = require('../../../models/AuditLog');
    await AuditLog.create({
      actor: new mongoose.Types.ObjectId('000000000000000000000000'),
      actorRole: 'system',
      action: 'compliance.incident.effective',
      targetType: 'ComplianceIncident',
      targetId: inc._id,
      targetLabel: inc.ruleCode,
      meta: { employee: String(inc.employee) },
    });
  } catch (e) { console.error('[compliance/incidents] audit failed:', e.message); }
  return inc.toObject ? inc.toObject() : inc;
};

/**
 * Resolve an incident (e.g. employee submitted, dependency cleared).
 *
 * Phase 2: an atomic candidate|active -> resolved transition.  A
 * cancelled / waived / expired incident is never silently rewritten to
 * resolved.  Already-resolved is a no-op (no second event).  With
 * `strict` (HR endpoint) a terminal incident is reported as an error;
 * automation callers keep the non-throwing behaviour.
 */
const resolveIncident = async (incidentId, { reason = '', actor = null, req = null, strict = false } = {}) => {
  const prev = await ComplianceIncident.findById(incidentId).lean();
  if (!prev) return null;
  if (prev.status === 'resolved') return prev;
  const resolvedBy = actor || (req && req.user ? req.user._id : null);
  const inc = await ComplianceIncident.findOneAndUpdate(
    { _id: incidentId, status: { $in: lifecycle.OPEN_INCIDENT } },
    { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy } },
    { new: true },
  );
  if (!inc) {
    const cur = await ComplianceIncident.findById(incidentId).lean();
    if (cur && cur.status === 'resolved') return cur;   // lost a race to another resolver
    if (strict) lifecycle.assertOpen(cur, 'resolve');
    return cur;
  }
  await _emitEvent({
    employee: inc.employee,
    incidentId: inc._id,
    kind: 'incident_resolved',
    payload: { reason, from: prev.status, to: 'resolved' },
    actor: resolvedBy || SYSTEM_ACTOR,
  });
  if (req) {
    logAudit(req, {
      action: 'compliance.incident.resolve',
      targetType: 'ComplianceIncident',
      targetId: inc._id,
      targetLabel: inc.ruleCode,
      meta: { reason, employee: String(inc.employee), from: prev.status },
    });
  }
  return inc.toObject ? inc.toObject() : { ...inc };
};

/**
 * Cancel semantics (Batch-3 fix #17, state-hardened in Phase 2).
 *
 * Cancelling asserts "this incident should never have existed."  Allowed
 * only from candidate | active.  A resolved / waived / expired incident is
 * a different terminal outcome and is NOT rewritten (LifecycleError 409).
 * Cancelling an already-cancelled incident is an idempotent no-op: no
 * second reversal, no second event.
 *
 * The first thing the (transactional) callback does is an atomic
 * compare-and-set of the incident open -> cancelled; only the winner
 * continues, so two concurrent cancels cannot both reverse effects.
 * Effects are then claimed one by one (lifecycle.claimAndReverse), which
 * is also what makes each ledger credit happen at most once.
 *
 * End state for the winner:
 *   - incident cancelled (+ cancelReason / cancelledBy / cancelledAt).
 *   - every pending|active effect cancelled, each with ONE inverse ledger
 *     row (direction +1, type 'recovery', reason 'cancel: ...').
 *   - legacy Penalty mirror(s) cancelled once (guarded by status).
 *   - still-pending waiver requests closed (history kept).
 *   - events: waiver_decided (auto) per closed waiver + incident_cancelled.
 */
const cancelIncident = async (incidentId, { reason = '', actor = null, req = null } = {}) => {
  const prev = await ComplianceIncident.findById(incidentId).lean();
  if (!prev) return null;
  if (prev.status === 'cancelled') return { ...prev, alreadyCancelled: true };
  lifecycle.assertOpen(prev, 'cancel');

  const cancelledBy = actor || (req && req.user ? req.user._id : null);
  const cancelReason = String(reason || '').trim();

  // Lazy-require to avoid circular imports (compliance/index.js
  // barrel imports this module).
  const { withComplianceTransaction } = require('../txn');
  const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
  const legacyMirror = require('../legacyMirror');

  let out = null;
  let usedSession = false;
  try {
  await withComplianceTransaction(async (session) => {
    usedSession = !!session;
    out = { claimed: null, current: null, closedWaivers: [], reversed: 0 };
    const claimed = await ComplianceIncident.findOneAndUpdate(
      { _id: incidentId, status: { $in: lifecycle.OPEN_INCIDENT } },
      { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy, cancelReason } },
      session ? { new: true, session } : { new: true },
    );
    if (!claimed) {
      const q = ComplianceIncident.findById(incidentId);
      if (session) q.session(session);
      out.current = await q.lean();
      return;
    }
    out.claimed = claimed;

    const eq = ComplianceActionEffect.find({
      incidentId, status: { $in: lifecycle.OUTSTANDING_EFFECT },
    });
    if (session) eq.session(session);
    const targets = await eq.lean();

    const mirrorIds = [];
    for (const eff of targets) {
      const r = await lifecycle.claimAndReverse({
        effect: eff,
        toStatus: 'cancelled',
        set: { cancelledAt: new Date(), cancelledBy, cancelReason },
        ledgerType: 'recovery',
        reason: `cancel: ${eff.actionType}${cancelReason ? ` (${cancelReason})` : ''}`,
        actor: cancelledBy,
        session,
      });
      if (!r.claimed) continue;
      if (r.credited) out.reversed += 1;
      if (eff.penaltyId) mirrorIds.push(eff.penaltyId);
    }

    // The whole incident is going away, so its legacy mirror (explicit
    // link OR shared natural key) is cancelled once, even when the
    // incident had no effects yet (e.g. a candidate).
    for (const id of await legacyMirror.penaltyIdsFor({ effect: null, incident: prev, session })) {
      if (!mirrorIds.some((x) => String(x) === String(id))) mirrorIds.push(id);
    }
    await lifecycle.mirrorPenalties({
      ids: mirrorIds,
      set: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy,
        cancelReason: `v2 incident cancel: ${cancelReason}`.trim().slice(0, 500),
      },
      session,
      label: 'cancel',
    });

    // A waiver is a request to reverse this incident's effects; once the
    // incident is cancelled there is nothing left to waive.  Reuses the
    // existing 'rejected' status with an explicit system note.
    out.closedWaivers = await lifecycle.closePendingWaivers({
      incidentId, decidedBy: cancelledBy,
      note: 'Closed automatically: the incident was cancelled.', session,
    });
  });
  } catch (e) {
    // Replica set: the transaction rolled everything back.  Standalone:
    // the incident claim is already written -- reopen it so a retry can
    // finish reversing the remaining effects (already-reversed ones are
    // never reversed twice; each is claimed individually).
    if (!usedSession && out && out.claimed) {
      await ComplianceIncident.findOneAndUpdate(
        { _id: incidentId, status: 'cancelled' },
        { $set: { status: prev.status, cancelledAt: null, cancelledBy: null, cancelReason: '' } },
      ).catch(() => {});
    }
    throw e;
  }

  if (!out.claimed) {
    // Lost the race / state changed between our read and the claim.
    const cur = out.current;
    if (cur && cur.status === 'cancelled') return { ...cur, alreadyCancelled: true };
    lifecycle.assertOpen(cur, 'cancel');
    return cur;   // unreachable: assertOpen throws for non-open
  }

  const inc = out.claimed;
  for (const w of out.closedWaivers) {
    await _emitEvent({
      employee: inc.employee,
      incidentId: inc._id,
      kind: 'waiver_decided',
      payload: { decision: 'rejected', auto: true, reason: 'incident_cancelled', waiverId: w._id },
      actor: cancelledBy || SYSTEM_ACTOR,
    });
  }
  await _emitEvent({
    employee: inc.employee,
    incidentId: inc._id,
    kind: 'incident_cancelled',
    payload: { reason: cancelReason, from: prev.status, to: 'cancelled', effectsReversed: out.reversed },
    actor: cancelledBy || SYSTEM_ACTOR,
  });
  if (req) {
    logAudit(req, {
      action: 'compliance.incident.cancel',
      targetType: 'ComplianceIncident',
      targetId: inc._id,
      targetLabel: inc.ruleCode,
      meta: { reason: cancelReason, employee: String(inc.employee), from: prev.status },
    });
  }
  return inc.toObject ? inc.toObject() : { ...inc };
};

/**
 * Batch-1 fix #1 -- resolve every open ComplianceIncident whose
 * `context.submissionId` matches the given submission.  Called from
 * `penaltyEngine.resolveAbsentSubmissionOnSubmit` so the v2 engine
 * closes its incident when the legacy engine closes its Penalty.
 *
 * Idempotent: incidents already in `resolved | waived | cancelled`
 * are left alone.  Rule codes limited to the missed_submission /
 * absent_submission family so we don't accidentally close unrelated
 * v2 incidents that happen to share a submissionId.
 */
const resolveIncidentsBySubmission = async ({ submissionId, reason = '', actor = null } = {}) => {
  if (!submissionId) return { resolved: 0 };
  const rows = await ComplianceIncident.find({
    'context.submissionId': submissionId,
    ruleCode: { $in: ['missed_submission_v2', 'absent_submission_v2'] },
    status: { $in: ['candidate', 'active'] },
  }).select('_id').lean();
  let n = 0;
  for (const r of rows) {
    try {
      await resolveIncident(r._id, { reason, actor });
      n += 1;
    } catch (e) { console.error('[compliance/incidents] resolveBySubmission failed:', e.message); }
  }
  return { resolved: n };
};

/**
 * Batch-1 fix #1 -- resolve every open dependency_pending incident
 * for `employeeId` when the employee has zero open dependencies
 * remaining (mirrors legacy penaltyEngine.onDependencyResolved).
 * The caller performs the "any open?" check; this helper unconditionally
 * closes matching incidents.
 */
const resolveDependencyIncidentsForEmployee = async ({ employeeId, reason = '', actor = null } = {}) => {
  if (!employeeId) return { resolved: 0 };
  const rows = await ComplianceIncident.find({
    employee: employeeId,
    ruleCode: 'dependency_pending_v2',
    status: { $in: ['candidate', 'active'] },
  }).select('_id').lean();
  let n = 0;
  for (const r of rows) {
    try { await resolveIncident(r._id, { reason, actor }); n += 1; }
    catch (e) { console.error('[compliance/incidents] resolveDependency failed:', e.message); }
  }
  return { resolved: n };
};

/**
 * Batch-1 fix #1 -- resolve every open performance_lock incident for
 * `employeeId` when the employee no longer has overdue pending tasks.
 */
const resolvePerformanceLockIncidentsForEmployee = async ({ employeeId, reason = '', actor = null } = {}) => {
  if (!employeeId) return { resolved: 0 };
  const rows = await ComplianceIncident.find({
    employee: employeeId,
    ruleCode: 'performance_lock_v2',
    status: { $in: ['candidate', 'active'] },
  }).select('_id').lean();
  let n = 0;
  for (const r of rows) {
    try { await resolveIncident(r._id, { reason, actor }); n += 1; }
    catch (e) { console.error('[compliance/incidents] resolvePerformanceLock failed:', e.message); }
  }
  return { resolved: n };
};

module.exports = {
  recordIncident,
  promoteToActive,
  resolveIncident,
  cancelIncident,
  // Batch-1 fix #1 -- correlation helpers used by penaltyEngine hooks.
  resolveIncidentsBySubmission,
  resolveDependencyIncidentsForEmployee,
  resolvePerformanceLockIncidentsForEmployee,
  // Exposed for tests -- forces a re-emit without going through the
  // schedule.  Never used in production.
  _emitEvent,
};
