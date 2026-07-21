/**
 * ruleEvaluationScheduler.js -- Compliance v2 tick loop.
 *
 * Phase 4 responsibility (this file):
 *
 *   1. For every enabled ComplianceRule, resolve scope -> employee ids.
 *   2. For each employee, run the rule's detector; upsert incidents
 *      via IncidentService.recordIncident (idempotent via naturalKey).
 *   3. Promote any incident whose effectiveDate has arrived to `active`.
 *
 * Phase 5 will bolt on action execution + ledger writes; Phase 6 will
 * add escalation.  Both hook in AFTER promotion and are gated by
 * their own feature flags, so this Phase-4 tick is safe to run on
 * production with `compliance.newEngine` on and `compliance.actionEngine`
 * off -- it produces incidents only.
 */

const ComplianceRule = require('../../../models/ComplianceRule');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const detectorRegistry = require('../registry/detectorRegistry');
const scope = require('../scope');
const incidentService = require('../incidents/incidentService');
const { computeEffectiveDate } = require('../dates');
const { startOfDay } = require('../../../utils/dateHelpers');
const User = require('../../../models/User');
const actionEngine = require('../actions/actionEngine');
const { isEnabled } = require('../../../config/featureFlags');
const escalationRunner = require('../escalation/escalationRunner');
const critical = require('../critical');
const workingDayContext = require('../workingDayContext');

// Stabilization patch (C7): drop the module-scoped cache in favour
// of a per-tick preload.  The previous cache never expired and made
// department renames stale in long-running processes.
const _preloadEmployees = async (ids) => {
  if (!ids.length) return new Map();
  const rows = await User.find({ _id: { $in: ids } })
    .select('_id name employeeId department designation weeklyOff attendanceMode')
    .lean();
  return new Map(rows.map((r) => [String(r._id), r]));
};

/**
 * Bounded-concurrency map.  Runs `fn(item)` for every item with at
 * most `concurrency` in flight at once.  Preserves output order.
 * Purely functional; no external dep.
 */
const _pMap = async (items, concurrency, fn) => {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(Math.max(1, concurrency), items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        try { out[idx] = { ok: true, value: await fn(items[idx], idx) }; }
        catch (e) { out[idx] = { ok: false, error: e }; }
      }
    });
  await Promise.all(workers);
  return out;
};

// Tunable via env; default 32 which matches the driver's default pool.
const _CONCURRENCY = Math.max(
  1, Math.min(256, Number(process.env.COMPLIANCE_TICK_CONCURRENCY) || 32),
);

/**
 * Set of detector codes that consume the working-day context
 * (holidays + approved leaves).  Any detector added here shares the
 * SAME per-tick globalCtx + employeeLeaveMap; a new WDC-aware
 * detector just needs its code added here.
 */
const WDC_DETECTORS = new Set(['built_in.performance_lock']);
const _needsWDC = (rule) => WDC_DETECTORS.has(rule.detector);

/**
 * Run detectors for every enabled rule against every in-scope
 * employee.  Returns aggregate counts.
 *
 * Two-pass structure so working-day inputs are loaded exactly once
 * per tick regardless of how many WDC-aware rules are enabled:
 *
 *   Pass 1: resolve each rule's cohort and detector.  Collect the
 *           UNION of employee ids across every WDC-aware rule.
 *   Preload: one holiday query, one `Leave.find({employee:{$in:...}})`
 *           over that union.  Skipped entirely if no WDC-aware rule
 *           is enabled.
 *   Pass 2: run detection.  WDC-aware detectors get the shared
 *           globalCtx + employeeLeaveMap; non-WDC detectors see
 *           `null` and incur no overhead.
 */
const _runDetection = async (day) => {
  const rules = await ComplianceRule.find({ enabled: true }).lean();
  const stats = { rules: 0, candidates: 0, created: 0, skipped: 0, errors: 0 };

  // ---- Pass 1: resolve scope for every rule up front ----
  const perRule = [];
  const wdcEmpIds = [];
  const wdcSeen = new Set();
  for (const rule of rules) {
    stats.rules += 1;
    const detect = detectorRegistry.get(rule.detector);
    if (!detect) {
      console.error('[compliance/tick] no detector registered for', rule.detector);
      stats.errors += 1;
      continue;
    }
    let empIds;
    try {
      empIds = await scope.resolveEmployeeIds(rule);
    } catch (e) {
      console.error('[compliance/tick] scope resolve failed:', rule.code, e.message);
      stats.errors += 1;
      continue;
    }
    if (!empIds.length) continue;
    const needsWDC = _needsWDC(rule);
    if (needsWDC) {
      for (const id of empIds) {
        const k = String(id);
        if (wdcSeen.has(k)) continue;
        wdcSeen.add(k);
        wdcEmpIds.push(id);
      }
    }
    perRule.push({ rule, detect, empIds, needsWDC });
  }

  // ---- Shared per-tick working-day preload (one holiday + one leave query) ----
  let globalCtx = null;
  let employeeLeaveMap = null;
  if (wdcEmpIds.length > 0) {
    globalCtx = await workingDayContext.loadGlobalWorkingDayContext(day);
    employeeLeaveMap = await workingDayContext.loadEmployeeLeaveMap(wdcEmpIds, day);
  }

  // ---- Pass 2: run detection with the shared context ----
  for (const { rule, detect, empIds, needsWDC } of perRule) {
    // Stabilization patch (C7): preload every employee in one bulk
    // query, then fan detectors out with bounded concurrency.
    const empById = await _preloadEmployees(empIds);
    const results = await _pMap(empIds, _CONCURRENCY, async (empId) => {
      const employee = empById.get(String(empId));
      if (!employee) return { employeeId: empId, candidates: [] };
      const candidates = await detect({
        rule, employee, day,
        globalCtx:        needsWDC ? globalCtx        : null,
        employeeLeaveMap: needsWDC ? employeeLeaveMap : null,
      });
      return { employeeId: employee._id, candidates };
    });
    for (const r of results) {
      if (!r.ok) {
        stats.errors += 1;
        console.error('[compliance/tick] detector failed:', rule.code, '-', r.error.message);
        continue;
      }
      const { employeeId, candidates } = r.value;
      for (const c of candidates) {
        stats.candidates += 1;
        try {
          const effectiveDate = computeEffectiveDate(rule, c.incidentDate);
          const { created } = await incidentService.recordIncident({
            rule,
            employeeId,
            naturalKey: c.naturalKey,
            incidentDate: c.incidentDate,
            effectiveDate,
            context: c.context || {},
            detectorMeta: c.detectorMeta || {},
            source: 'automatic',
          });
          if (created) stats.created += 1;
          else         stats.skipped += 1;
        } catch (e) {
          stats.errors += 1;
          console.error('[compliance/tick] recordIncident failed:', rule.code, e.message);
        }
      }
    }
  }
  return stats;
};

/** Promote candidates whose effectiveDate has arrived, then apply
 *  the rule's actions (gated by `compliance.actionEngine`).
 *  Returns aggregate counters. */
const _runPromotion = async (day) => {
  const target = startOfDay(day);
  const stale = await ComplianceIncident.find({
    status: 'candidate',
    effectiveDate: { $lte: target },
  }).select('_id').lean();
  let promoted = 0;
  let actionsFired = 0;
  let actionErrors = 0;
  for (const c of stale) {
    const r = await incidentService.promoteToActive(c._id, { now: target });
    if (r) {
      promoted += 1;
      if (isEnabled('compliance.actionEngine')) {
        const applied = await actionEngine.apply({ incident: r, day: target });
        actionsFired += applied.effects.length;
        actionErrors += applied.errors.length;
      }
    }
  }
  return { promoted, considered: stale.length, actionsFired, actionErrors };
};

/** Re-apply recurring actions for still-active incidents.  Idempotent
 *  by (incident, ruleAction, effectiveDate) partial-unique. */
const _runRecurring = async (day) => {
  if (!isEnabled('compliance.actionEngine')) {
    return { rules: 0, actionsFired: 0, actionErrors: 0 };
  }
  const target = startOfDay(day);
  const activeRules = await ComplianceRule.find({ enabled: true }).lean();
  let rulesTouched = 0;
  let fired = 0;
  let errs  = 0;
  for (const rule of activeRules) {
    if (!actionEngine.hasRecurring(rule)) continue;
    rulesTouched += 1;
    const activeIncidents = await ComplianceIncident.find({
      ruleId: rule._id,
      status: 'active',
    }).lean();
    for (const inc of activeIncidents) {
      // Stabilization patch (C1): recurring-only so one-shot actions
      // don't re-fire on subsequent daily ticks.
      const applied = await actionEngine.apply({
        incident: inc, day: target, recurringOnly: true,
      });
      fired += applied.effects.length;
      errs  += applied.errors.length;
    }
  }
  return { rules: rulesTouched, actionsFired: fired, actionErrors: errs };
};

/**
 * Public entry point.  Called from dailyComplianceScheduler once per
 * calendar day (with a boot catch-up).  Cheap to call twice within
 * the same day -- every write is idempotent.
 */
const tick = async ({ day = new Date() } = {}) => {
  const t0 = Date.now();
  // Batch-2 pre-batch hardening: per-tick criticality cache.
  // Clearing here means every rule evaluation starts with a clean
  // slate; within one tick, repeated Template lookups still de-dup.
  critical.beginTick();
  // Batch-2 fix #11 (rework) -- working-day context split.
  // `_runDetection` lazy-loads the global (holiday) context on
  // first use and issues ONE bulk leave-query per rule cohort,
  // keyed by employeeId.  There is no cross-employee cache -- see
  // services/compliance/workingDayContext.js for the invariants.
  const detected = await _runDetection(day);
  const promoted = await _runPromotion(day);
  const recurring = await _runRecurring(day);
  let escalation = { incidents: 0, stepsFired: 0, errors: 0 };
  if (isEnabled('compliance.waiverRecovery')) {
    try { escalation = await escalationRunner.run({ day }); }
    catch (e) { console.error('[compliance/escalation] failed:', e.message); }
  }
  const ms = Date.now() - t0;
  console.log(
    `[compliance/tick] day=${startOfDay(day).toISOString().slice(0,10)} `
    + `rules=${detected.rules} candidates=${detected.candidates} `
    + `created=${detected.created} skipped=${detected.skipped} `
    + `promoted=${promoted.promoted}/${promoted.considered} `
    + `actions=${promoted.actionsFired + recurring.actionsFired + escalation.stepsFired} `
    + `errors=${detected.errors + promoted.actionErrors + recurring.actionErrors + escalation.errors} `
    + `${ms}ms`,
  );
  return { detected, promoted, recurring, escalation, ms };
};

module.exports = { tick };
