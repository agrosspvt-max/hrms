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

/** Resolve an incident (e.g. employee submitted, dependency cleared). */
const resolveIncident = async (incidentId, { reason = '', actor = null, req = null } = {}) => {
  const inc = await ComplianceIncident.findById(incidentId);
  if (!inc || inc.status === 'resolved') return inc ? inc.toObject() : null;
  inc.status = 'resolved';
  inc.resolvedAt = new Date();
  inc.resolvedBy = actor || (req && req.user ? req.user._id : null);
  await inc.save();
  await _emitEvent({
    employee: inc.employee,
    incidentId: inc._id,
    kind: 'incident_resolved',
    payload: { reason },
    actor: inc.resolvedBy || SYSTEM_ACTOR,
  });
  if (req) {
    logAudit(req, {
      action: 'compliance.incident.resolve',
      targetType: 'ComplianceIncident',
      targetId: inc._id,
      targetLabel: inc.ruleCode,
      meta: { reason, employee: String(inc.employee) },
    });
  }
  return inc.toObject();
};

/**
 * Batch-3 fix #17 -- cancel semantics.
 *
 * Cancelling an incident asserts "this incident should never have
 * existed."  It is functionally equivalent to a full recovery, but
 * with distinct audit + status semantics ("cancelled" vs
 * "resolved").  End state after `cancelIncident`:
 *
 *   - ComplianceIncident.status = 'cancelled', cancelReason set.
 *   - Every ComplianceActionEffect in pending|active flips to
 *     'cancelled' with cancelReason.  Effects already in a terminal
 *     state (resolved / waived / cancelled / expired) are left alone.
 *   - For every effect that shifted, an INVERSE ledger row is written
 *     (direction=+1, type='recovery', reason prefixed with 'cancel:')
 *     so the running balance returns to what it was before the
 *     incident's actions applied.
 *   - Mirror Penalty rows (legacy F&P shim) are moved to status
 *     'cancelled' so the pre-v2 UI stays consistent.
 *   - Existing timeline event `incident_cancelled` still fires;
 *     audit log entry preserved verbatim.
 *
 * Wrapped in `withComplianceTransaction` so ledger reversals + effect
 * flips + Penalty mirror + incident status flip are atomic on
 * replica-set Mongo.  Standalone Mongo falls back to serial writes;
 * the nightly reconciler is the safety net there.
 *
 * Idempotent: a second cancel on an already-cancelled incident is a
 * no-op.  Idempotent under retry-in-transaction: effect flips guard
 * on their own status, ledger reversal only runs for
 * still-pending/active effects.
 */
const cancelIncident = async (incidentId, { reason = '', actor = null, req = null } = {}) => {
  const inc = await ComplianceIncident.findById(incidentId);
  if (!inc) return null;
  if (inc.status === 'cancelled') return inc.toObject();
  const cancelledBy = actor || (req && req.user ? req.user._id : null);
  const cancelReason = String(reason || '').trim();

  // Lazy-require to avoid circular imports (compliance/index.js
  // barrel imports this module).
  const { withComplianceTransaction } = require('../txn');
  const ledgerService = require('../ledger/ledgerService');
  const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
  const Penalty = require('../../../models/Penalty');

  const _LEDGER_FOR = {
    zero_daily_marks:      'marks',
    add_daily_total:       'marks',
    fixed_marks_reduction: 'marks',
    percent_reduction:     'percentage',
    financial_fine:        'financial',
    half_day_lwp:          'attendance',
    full_day_lwp:          'attendance',
  };
  const _QTY_FOR = (e) => ({
    zero_daily_marks:      e.marks,
    add_daily_total:       e.marks,
    fixed_marks_reduction: e.marks,
    percent_reduction:     e.percent,
    financial_fine:        e.amount,
    half_day_lwp:          e.attendanceUnit,
    full_day_lwp:          e.attendanceUnit,
  }[e.actionType]);

  await withComplianceTransaction(async (session) => {
    const targets = await ComplianceActionEffect.find({
      incidentId: inc._id,
      status: { $in: ['pending', 'active'] },
    }).session(session).lean();

    for (const eff of targets) {
      const ledger = _LEDGER_FOR[eff.actionType];
      const q = _QTY_FOR(eff);
      // Inverse ledger row (skipped automatically when quantity is
      // zero by ledgerService.append -- Batch-3 fix #16).
      if (ledger && Number.isFinite(q) && q > 0) {
        await ledgerService.append({
          ledger,
          employee: eff.employee,
          date: new Date(),
          direction: +1,
          quantity: q,
          type: 'recovery',
          reason: `cancel: ${eff.actionType}${cancelReason ? ` (${cancelReason})` : ''}`,
          refIncidentId: eff.incidentId,
          refEffectId: eff._id,
          createdBy: cancelledBy,
          session,
        });
      }
      await ComplianceActionEffect.updateMany(
        { _id: eff._id },
        { $set: {
            status: 'cancelled',
            cancelledAt: new Date(),
            cancelledBy,
            cancelReason,
        } },
        session ? { session } : undefined,
      );
      // Mirror the cancel onto the legacy Penalty row in the same session.
      if (eff.penaltyId) {
        try {
          await Penalty.updateOne(
            { _id: eff.penaltyId, status: { $nin: ['cancelled', 'resolved', 'expired'] } },
            { $set: {
                status: 'cancelled',
                cancelledAt: new Date(),
                cancelledBy,
                cancelReason: `v2 incident cancel: ${cancelReason}`.trim().slice(0, 500),
            } },
            session ? { session } : undefined,
          );
        } catch (mirrorErr) {
          console.error('[compliance/cancel] mirror Penalty cancel failed:', mirrorErr.message);
          if (session) throw mirrorErr;
        }
      }
    }

    inc.status = 'cancelled';
    inc.cancelledAt = new Date();
    inc.cancelledBy = cancelledBy;
    inc.cancelReason = cancelReason;
    if (session) await inc.save({ session });
    else await inc.save();
  });

  await _emitEvent({
    employee: inc.employee,
    incidentId: inc._id,
    kind: 'incident_cancelled',
    payload: { reason: inc.cancelReason },
    actor: inc.cancelledBy || SYSTEM_ACTOR,
  });
  if (req) {
    logAudit(req, {
      action: 'compliance.incident.cancel',
      targetType: 'ComplianceIncident',
      targetId: inc._id,
      targetLabel: inc.ruleCode,
      meta: { reason: inc.cancelReason, employee: String(inc.employee) },
    });
  }
  return inc.toObject();
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
