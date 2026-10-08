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
const ComplianceIncident = require('../../../models/ComplianceIncident');
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

  // Recurring effects of AUTOMATIC incidents belong to the employee-day:
  // detectors emit a fresh day-scoped incident every day a condition
  // persists, and older incidents stay `active`, so without this guard
  // the same day would be charged once per still-active incident
  // (N(N+1)/2 over N days).  Sibling = another automatic incident of the
  // same rule + employee.  Manual incidents are separate HR-asserted
  // events and keep their own recurring effects.
  let siblingIds = null;
  const _siblings = async () => {
    if (siblingIds) return siblingIds;
    const rows = incident.source === 'automatic'
      ? await ComplianceIncident.find({
          ruleId: incident.ruleId, employee: incident.employee, source: 'automatic',
        }).select('_id').lean()
      : [];
    siblingIds = rows.map((r) => r._id).filter((id) => String(id) !== String(incident._id));
    return siblingIds;
  };

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

    // Cross-incident dedupe for recurring effects (any status counts: a
    // waived / cancelled day must not be re-charged by an older incident).
    let recurringKey = null;
    if (actionCfg.config && actionCfg.config.recurring === true && incident.source === 'automatic') {
      recurringKey = ['rec', String(rule._id), String(actionCfg._id), String(incident.employee),
        effectiveDate.toISOString().slice(0, 10)].join('|');
      const sibs = await _siblings();
      const covered = sibs.length
        ? await ComplianceActionEffect.findOne({
            ruleActionId: actionCfg._id,
            employee: incident.employee,
            effectiveDate,
            incidentId: { $in: sibs },
          }).lean()
        : null;
      if (covered) {
        out.effects.push({ effect: covered, created: false, dedupedBy: covered.incidentId });
        continue;
      }
    }
    // Already applied for this incident/action/day?  Answer from a plain
    // read BEFORE any transaction work.  Re-running a scheduler tick (or
    // promoting + recurring-applying the same incident) must not open a
    // transaction just to hit the unique index: on a replica set MongoDB
    // aborts the transaction on E11000, and a follow-up read inside it made
    // the driver retry the callback for ~120 s.
    const existingOwn = await ComplianceActionEffect.findOne({
      incidentId: incident._id, ruleActionId: actionCfg._id, effectiveDate,
    }).lean();
    if (existingOwn) {
      out.effects.push({ effect: existingOwn, created: false });
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
              recurringKey,
            }], { session })
          : [await ComplianceActionEffect.create({
              ...executorOut.effectDoc,
              incidentId: incident._id,
              ruleId: rule._id,
              ruleActionId: actionCfg._id,
              employee: incident.employee,
              effectiveDate,
              recurringKey,
            })];
        effect = created[0];
      } catch (e) {
        // A duplicate key must NOT be handled here: inside a replica-set
        // transaction MongoDB has already aborted it, so any further
        // operation on this session fails and the driver retries the whole
        // callback.  Rethrow; the duplicate is recognised and resolved
        // OUTSIDE the transaction below.  Nothing after the insert (ledger
        // rows) has run, so no partial state exists to undo.
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
    // Lost a race on a unique index (own natural key, or the cross-incident
    // recurringKey).  The transaction has ended; re-read the winner outside
    // it and report an idempotent "already created".  No ledger row was
    // written by this attempt.
    if (txnErr && txnErr.code === 11000) {
      const winner = await ComplianceActionEffect.findOne({
        incidentId: incident._id, ruleActionId: actionCfg._id, effectiveDate,
      }).lean()
        || (recurringKey ? await ComplianceActionEffect.findOne({ recurringKey }).lean() : null);
      if (winner) {
        alreadyExisted = true;
        effect = winner;
        txnErr = null;
      }
    }
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
        // The legacy engine (which runs first in the daily job) already
        // owns the Penalty for this employee/category/day, anchored to the
        // day's PRIMARY submission, whereas this mirror is anchored to the
        // incident's oldest-overdue submission -- a different unique key,
        // so creating it would put TWO active rows on the same day.  Reuse
        // the existing row (any status: a cancelled one must stay so).
        const existingDay = await Penalty.findOne({
          employee: incident.employee,
          category: executorOut.legacyPenalty.category,
          source: 'automatic',
          probable: false,
          targetDate: effectiveDate,
        }).select('_id').lean();
        if (existingDay && existingDay._id) {
          mirrorId = existingDay._id;
        } else {
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
        }
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
