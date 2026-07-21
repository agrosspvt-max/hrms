/**
 * escalationRunner.js -- daily walk of active incidents; applies
 * `rule.escalation` steps once each incident is past its threshold.
 *
 *   rule.escalation = [
 *     { afterDays: 3, actionsAdd: [ {type: 'financial_fine', config: {amount:500}} ] },
 *     { afterDays: 7, actionsAdd: [ {type: 'suspend_incentive'} ] },
 *   ]
 *
 * Each step is applied at most once per incident via a memoised
 * `detectorMeta.escalatedStepIds` set on the incident.  Steps whose
 * `actionsAdd` types don't have executors are logged + skipped.
 */

const ComplianceRule = require('../../../models/ComplianceRule');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const actionExecutorRegistry = require('../registry/actionExecutorRegistry');
const ledgerService = require('../ledger/ledgerService');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const { startOfDay } = require('../../../utils/dateHelpers');
const { withComplianceTransaction } = require('../txn');

const _emitEvent = async ({ employee, incidentId, kind, payload }) => {
  try {
    const ComplianceEvent = require('../../../models/ComplianceEvent');
    await ComplianceEvent.create({
      employee, incidentId, kind, payload: payload || {}, actor: 'system', ts: new Date(),
    });
  } catch (e) { console.error('[compliance/escalation] event emit failed:', e.message); }
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Apply pending escalation steps to every active incident.  Returns
 * counters.  Safe to call multiple times per day -- steps are
 * memoised on the incident's `detectorMeta.escalatedStepIds`.
 */
const run = async ({ day = new Date() } = {}) => {
  const now = new Date(day);
  const stats = { incidents: 0, stepsFired: 0, errors: 0 };

  const rules = await ComplianceRule.find({ enabled: true }).lean();
  const rulesById = new Map(rules.map((r) => [String(r._id), r]));
  const withEscalation = rules.filter((r) => Array.isArray(r.escalation) && r.escalation.length);
  if (!withEscalation.length) return stats;

  const incidents = await ComplianceIncident.find({
    ruleId: { $in: withEscalation.map((r) => r._id) },
    status: 'active',
  });

  for (const inc of incidents) {
    stats.incidents += 1;
    const rule = rulesById.get(String(inc.ruleId));
    if (!rule) continue;
    const ageDays = Math.floor((now - new Date(inc.effectiveDate)) / DAY_MS);
    const already = new Set((inc.detectorMeta && inc.detectorMeta.escalatedStepIds) || []);

    for (const step of rule.escalation || []) {
      if (already.has(String(step._id))) continue;
      if (ageDays < (Number(step.afterDays) || 0)) continue;

      // Prod-patch H1 + H2 --
      //   H1: track per-step success; only memoise the step when
      //       every required action landed cleanly.  A missing
      //       executor or a transient DB error leaves the step
      //       eligible for retry on the next tick.
      //   H2: normalise effectiveDate to startOfDay(day) so the
      //       ComplianceActionEffect natural-key
      //       (incidentId, ruleActionId, effectiveDate) dedupes
      //       cross-tick re-runs on the same day.  Wrap effect +
      //       ledger appends + escalation memo in a single Mongo
      //       transaction so a mid-loop crash cannot leave the
      //       memo out-of-sync with the actual writes.
      const stepEffectiveDate = startOfDay(now);
      const actionsToApply = step.actionsAdd || [];

      // Pre-flight: if ANY action lacks an executor we cannot fully
      // satisfy the step.  Log + count as errors and defer the step
      // (do not memoise) so an operator can register the missing
      // executor and let the next tick complete the step.
      const missingExecutors = actionsToApply.filter(
        (a) => !actionExecutorRegistry.get(a && a.type),
      );
      if (missingExecutors.length) {
        for (const a of missingExecutors) {
          console.error('[compliance/escalation] no executor for', a && a.type);
          stats.errors += 1;
        }
        continue;   // skip step; DO NOT add to `already`
      }

      let stepFullySucceeded = false;
      let firedThisStep = 0;
      let stepErrors = 0;
      try {
        await withComplianceTransaction(async (session) => {
          for (const action of actionsToApply) {
            const executor = actionExecutorRegistry.get(action.type);
            const out = await executor({
              rule, actionConfig: action, incident: inc.toObject(),
              employee: { _id: inc.employee },
            });
            if (!out || !out.effectDoc) continue;

            let effect;
            try {
              const created = session
                ? await ComplianceActionEffect.create([{
                    ...out.effectDoc,
                    incidentId: inc._id,
                    ruleId: rule._id,
                    ruleActionId: action._id || step._id,
                    employee: inc.employee,
                    effectiveDate: stepEffectiveDate,
                  }], { session })
                : [await ComplianceActionEffect.create({
                    ...out.effectDoc,
                    incidentId: inc._id,
                    ruleId: rule._id,
                    ruleActionId: action._id || step._id,
                    employee: inc.employee,
                    effectiveDate: stepEffectiveDate,
                  })];
              effect = Array.isArray(created) ? created[0] : created;
            } catch (e) {
              // Duplicate on the natural key means the same step's
              // action already landed on this day (idempotent
              // cross-tick).  Look it up so ledger appends can
              // reference the pre-existing effect id.
              if (e && e.code === 11000) {
                const q = ComplianceActionEffect.findOne({
                  incidentId: inc._id,
                  ruleActionId: action._id || step._id,
                  effectiveDate: stepEffectiveDate,
                });
                if (session) q.session(session);
                effect = await q;
                if (!effect) continue;   // shouldn't happen; defensive
                // Duplicate path: the ledger row was already written
                // on the first successful application.  Do NOT
                // re-append -- treat as already-applied.
                continue;
              }
              throw e;
            }

            for (const append of (out.ledgerAppends || [])) {
              await ledgerService.append({
                ...append,
                employee: inc.employee,
                refIncidentId: inc._id,
                refEffectId: effect._id,
                createdBy: null,
                session,
              });
            }
            firedThisStep += 1;
            await _emitEvent({
              employee: inc.employee, incidentId: inc._id,
              kind: 'escalated',
              payload: { stepId: step._id, afterDays: step.afterDays, actionType: action.type },
            });
          }

          // Memoise INSIDE the transaction so effects + memo commit
          // together.  If the transaction aborts, the memo never
          // persists and the next tick retries the whole step.
          already.add(String(step._id));
          inc.detectorMeta = {
            ...(inc.detectorMeta || {}),
            escalatedStepIds: [...already],
          };
          if (inc.markModified) inc.markModified('detectorMeta');
          if (session) await inc.save({ session });
          else await inc.save();

          stepFullySucceeded = true;
        });
      } catch (e) {
        console.error('[compliance/escalation] step failed:', rule.code, step._id, e.message);
        stepErrors += 1;
        // Roll the in-memory memo back so the next iteration in
        // this outer loop doesn't skip a later step that we still
        // want to try.  On next tick the DB memo will be missing
        // this step and it will be retried.
        already.delete(String(step._id));
      }

      if (stepFullySucceeded) {
        stats.stepsFired += firedThisStep;
      } else {
        stats.errors += Math.max(1, stepErrors);
      }
    }

    // Prod-patch H2 -- memo now persists inside the per-step txn
    // (or gets rolled back with it), so no separate inc.save() here.
  }

  return stats;
};

module.exports = { run };
