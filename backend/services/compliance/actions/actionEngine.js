/**
 * actionEngine.js -- persist ComplianceActionEffect + ledger rows for
 * a promoted incident.
 *
 * Called from ruleEvaluationScheduler.tick during the "promote"
 * phase, and directly when Phase 6's escalation runner adds actions
 * mid-flight.  Idempotent per (incidentId, ruleActionId, effectiveDate)
 * via the ComplianceActionEffect partial-unique index.
 *
 * Also handles:
 *   - Auto-recurring: `config.recurring:true` re-emits per day; the
 *     scheduler is responsible for re-invoking apply on each daily
 *     tick with the new effective day.
 *   - Backward-compat: `executor.legacyPenalty` triggers a mirror
 *     Penalty write for `performance_lock` when compliance.dualWrite
 *     is off.
 */

const ComplianceRule = require('../../../models/ComplianceRule');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const ComplianceEvent = require('../../../models/ComplianceEvent');
const Penalty = require('../../../models/Penalty');
const registry = require('../registry/actionExecutorRegistry');
const ledgerService = require('../ledger/ledgerService');
const { isEnabled } = require('../../../config/featureFlags');
const { startOfDay } = require('../../../utils/dateHelpers');
const { withComplianceTransaction } = require('../txn');
const notifyCompliance = require('../notifications/notifyCompliance');

const _emit = async ({ employee, incidentId, kind, payload }) => {
  try {
    await ComplianceEvent.create({
      employee, incidentId, kind, payload: payload || {},
      actor: 'system', ts: new Date(),
    });
  } catch (e) { console.error('[compliance/actions] emit failed:', e.message); }
};

/**
 * Apply every enabled action on the incident's rule for `day`.
 *
 *   apply({ incident, day, recurringOnly })
 *     -> { effects: [], errors: [] }
 *
 * The engine loads the rule fresh so a live edit is honoured.
 *
 * Stabilization patch (C1): the `recurringOnly` option (default
 * false) restricts the loop to actions with
 * `config.recurring === true`.  The scheduler's `_runRecurring`
 * pass sets this so one-shot actions (`zero_daily_marks`,
 * `fixed_marks_reduction`, `warning`, `notification`,
 * `performance_lock`, `half_day_lwp`, `full_day_lwp`) do NOT
 * re-fire on subsequent daily ticks.  Without this filter every
 * missed-submission incident was accumulating a fresh marks
 * deduction every day forever.
 */
const apply = async ({ incident, day, recurringOnly = false } = {}) => {
  const out = { effects: [], errors: [] };
  if (!incident) return out;
  const effectiveDate = startOfDay(day || incident.effectiveDate);

  const rule = await ComplianceRule.findById(incident.ruleId).lean();
  if (!rule) {
    out.errors.push({ reason: 'rule_missing', ruleId: incident.ruleId });
    return out;
  }

  for (const actionCfg of (rule.actions || [])) {
    if (!actionCfg.enabled) continue;
    // Recurring-only pass -- skip one-shot actions on subsequent ticks.
    if (recurringOnly && !(actionCfg.config && actionCfg.config.recurring === true)) {
      continue;
    }
    const executor = registry.get(actionCfg.type);
    if (!executor) {
      out.errors.push({ reason: 'no_executor', type: actionCfg.type });
      continue;
    }
    let executorOut;
    try {
      executorOut = await executor({
        rule, actionConfig: actionCfg, incident,
        employee: { _id: incident.employee, department: incident.context?.departmentId },
      });
    } catch (e) {
      out.errors.push({ reason: 'executor_threw', type: actionCfg.type, error: e.message });
      continue;
    }
    if (!executorOut || !executorOut.effectDoc) continue;

    // Stabilization patch (C4): wrap effect + every ledger write in
    // a single Mongo transaction so a crash mid-write cannot orphan
    // an effect.  On standalone Mongo the helper falls back to the
    // serial path; the nightly reconciler is the safety net there.
    let effect;
    let ledgerRefs = { marks: null, financial: null, percentage: null, attendance: null };
    let alreadyExisted = false;
    let txnErr = null;
    const txnResult = await withComplianceTransaction(async (session) => {
      try {
        const created = session
          ? await ComplianceActionEffect.create([{
              ...executorOut.effectDoc,
              incidentId: incident._id,
              ruleId: rule._id,
              ruleActionId: actionCfg._id,
              employee: incident.employee,
              effectiveDate,
            }], { session })
          : [await ComplianceActionEffect.create({
              ...executorOut.effectDoc,
              incidentId: incident._id,
              ruleId: rule._id,
              ruleActionId: actionCfg._id,
              employee: incident.employee,
              effectiveDate,
            })];
        effect = created[0];
      } catch (e) {
        if (e && e.code === 11000) {
          alreadyExisted = true;
          const q = ComplianceActionEffect.findOne({
            incidentId: incident._id,
            ruleActionId: actionCfg._id,
            effectiveDate,
          });
          if (session) q.session(session);
          effect = await q;
          return;
        }
        txnErr = e;
        throw e;
      }
      for (const append of (executorOut.ledgerAppends || [])) {
        const row = await ledgerService.append({
          ...append,
          employee: incident.employee,
          refIncidentId: incident._id,
          refEffectId: effect._id,
          createdBy: null,
          session,
        });
        // Batch-3 fix #16 -- ledgerService.append returns null for
        // zero-quantity rows (skipped by design).  Only record the
        // ref when an actual row was written.
        if (row && row._id) ledgerRefs[append.ledger] = row._id;
      }
      if (Object.values(ledgerRefs).some((v) => v)) {
        effect.ledgerRefs = ledgerRefs;
        if (session) await effect.save({ session });
        else if (effect.save) await effect.save();
      }
    }).catch((e) => {
      // Non-11000 failures were re-thrown from inside the block.
      if (!txnErr) txnErr = e;
      return null;
    });
    if (txnErr && !alreadyExisted) {
      out.errors.push({ reason: 'effect_create_or_ledger', type: actionCfg.type, error: txnErr.message });
      continue;
    }
    if (alreadyExisted) {
      out.effects.push({ effect: effect && (effect.toObject ? effect.toObject() : effect), created: false });
      continue;
    }

    // Legacy Penalty mirror-write (BC shim) -- only when
    // compliance.dualWrite is OFF (Phase 9 flips it on to stop
    // mirror-writing).
    if (executorOut.legacyPenalty && !isEnabled('compliance.dualWrite')) {
      const mirrorNaturalKey = {
        employee: incident.employee,
        category: executorOut.legacyPenalty.category,
        source: 'automatic',
        probable: false,
        targetDate: effectiveDate,
        submission: (incident.context && incident.context.submissionId) || null,
      };
      let mirrorId = null;
      try {
        const doc = await Penalty.create({
          ...mirrorNaturalKey,
          status: 'active',
          penaltyMarks: Number(executorOut.legacyPenalty.penaltyMarks) || 0,
          rule: `${rule.code}:${actionCfg.type}`,
          reason: `Compliance v2 mirror: ${actionCfg.type}`,
          effectiveDate,
          overdueRef: executorOut.legacyPenalty.overdueRef || {},
          incidentId: incident._id,
        });
        mirrorId = doc && doc._id;
      } catch (e) {
        // Prod-patch H7 -- E11000 means the legacy penaltyEngine
        // (which runs BEFORE the v2 tick in dailyComplianceScheduler)
        // already inserted the same natural key.  Recover its _id
        // so waiver / recovery / cancel can find the mirror row via
        // effect.penaltyId and keep the two surfaces consistent.
        // Silent failure at this step (leaving penaltyId=null) is
        // what previously caused the v2 waiver/cancel to leave the
        // legacy Penalty active on the pre-v2 F&P surface.
        if (e && e.code === 11000) {
          try {
            const existing = await Penalty.findOne(mirrorNaturalKey).select('_id').lean();
            if (existing && existing._id) mirrorId = existing._id;
          } catch (lookupErr) {
            // Non-fatal: log and continue.  effect.penaltyId stays
            // null; behaviour degrades to the pre-patch state.
            console.error('[compliance/actions] mirror Penalty lookup after dup failed:',
              lookupErr.message);
          }
        } else {
          out.errors.push({ reason: 'legacy_penalty', error: e.message });
        }
      }
      if (mirrorId && effect && effect.save) {
        effect.penaltyId = mirrorId;
        try {
          await effect.save();
        } catch (saveErr) {
          console.error('[compliance/actions] effect.penaltyId save failed:', saveErr.message);
        }
      }
    }

    await _emit({
      employee: incident.employee,
      incidentId: incident._id,
      kind: 'action_applied',
      payload: {
        ruleCode: rule.code,
        actionType: actionCfg.type,
        effectId: effect._id,
        effectiveDate,
      },
    });

    // Batch-1 fix #5: dispatch notification intents AFTER the effect
    // row + ledger writes are committed.  Executor returns
    // `notifications: [{audience, event, message, mode}]`; each entry
    // fires one Notification row via the compliance notify helper.
    // Best-effort -- never blocks the caller.
    for (const n of (executorOut.notifications || [])) {
      try {
        notifyCompliance.send({
          incident,
          effect: effect.toObject ? effect.toObject() : effect,
          event: n.event || 'action_applied',
          message: n.message || '',
          mode: n.mode || 'active',
        });
      } catch (_) { /* silent */ }
    }

    out.effects.push({ effect: effect.toObject ? effect.toObject() : effect, created: true });
  }
  return out;
};

/**
 * True when the rule has at least one enabled action with
 * `config.recurring: true`.  Called by the scheduler to decide
 * whether to re-run apply() daily for an already-active incident.
 */
const hasRecurring = (rule) => {
  const acts = (rule && rule.actions) || [];
  return acts.some((a) => a.enabled && a.config && a.config.recurring === true);
};

module.exports = { apply, hasRecurring };
