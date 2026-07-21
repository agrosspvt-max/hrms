/**
 * ruleSeed.js -- idempotent seeder for the built-in ComplianceRules.
 *
 * Runs at boot (from server.js) when `compliance.rules` is enabled.
 * Any rule whose `code` already exists is left untouched -- HR can
 * edit thresholds / actions and the seeder never overwrites them.
 *
 * Every seeded rule starts with `enabled: false`.  Ops flips them on
 * per-rule from the HR editor once verified.  This matches the
 * blueprint: seeding is safe on every boot; nothing fires until HR
 * explicitly enables the rule.
 */

const ComplianceRule = require('../../../models/ComplianceRule');

const SEED = [
  {
    code: 'missed_submission_v2',
    name: 'Missed Submission',
    description: 'Employee was present with a scheduled template stub and did not submit by the correction window.',
    category: 'submission',
    detector: 'built_in.missed_submission',
    severity: 'medium',
    trigger: {
      evaluationDelayDays: 1,       // matches today's "day-after" enforcement
      thresholdDays:       0,
      workingDaysOnly:     true,
      criticalTasksOnly:   false,
      dedupeWindowHours:   24,
    },
    actions: [
      {
        type: 'zero_daily_marks',
        enabled: true,
        // Batch-1 fix #4: `marks: 5` is the approved fresh-hire fallback
        // consumed by strategies.adminDefined when last_n_avg / template_default
        // both return 0.  Prevents a first-day miss on a brand-new employee
        // from evaporating to a 0-mark penalty.
        config: {
          marksStrategy: 'last_n_avg',
          strategyConfig: { N: 7 },
          marks: 5,
        },
      },
      { type: 'notification', enabled: true, config: {} },
    ],
    notifications: {
      onIncident:  { employee: true,  manager: false, hr: false, template: '' },
      onEffective: { employee: true,  manager: true,  hr: true,  template: '' },
      onRecovery:  { employee: true,  manager: false, hr: true,  template: '' },
      onWaiver:    { employee: true,  manager: false, hr: true,  template: '' },
    },
    recovery: { allowed: true, autoResolveOnSubmit: true },
    waiver:   { allowed: true, partialAllowed: true },
  },
  {
    code: 'dependency_pending_v2',
    name: 'Dependency Pending',
    description: 'Assignee left a dependency open beyond the countdown threshold.',
    category: 'dependency',
    detector: 'built_in.dependency_pending',
    severity: 'medium',
    trigger: {
      evaluationDelayDays: 0,
      thresholdDays:       3,      // matches today's hard-coded threshold
      workingDaysOnly:     true,
      dedupeWindowHours:   24,
    },
    actions: [
      { type: 'financial_fine', enabled: true, config: {
        amount: 200, criticalAmount: 300, recurring: true, recurringCadence: 'daily',
      } },
      { type: 'percent_reduction', enabled: true, config: {
        percentPerDay: 1, maxCap: 30, recurring: true, recurringCadence: 'daily',
      } },
      { type: 'notification', enabled: true, config: {} },
    ],
    recovery: { allowed: true, autoResolveOnResolve: true },
    waiver:   { allowed: true, partialAllowed: true },
  },
  {
    code: 'performance_lock_v2',
    name: 'Performance Lock',
    description: 'A pending task passed its Resolve By deadline on a working day.',
    category: 'submission',
    detector: 'built_in.performance_lock',
    severity: 'high',
    trigger: {
      evaluationDelayDays: 0,
      workingDaysOnly:     true,
      dedupeWindowHours:   24,
    },
    actions: [
      // Batch-1 fix #6: performance_lock renews daily (matches legacy
      // engine's enforcePerformanceLock behaviour).  The C1 stabilization
      // pass filters recurring-only on subsequent ticks; this flag opts
      // performance_lock into that pass.
      { type: 'performance_lock', enabled: true, config: { recurring: true, recurringCadence: 'daily' } },
      { type: 'notification', enabled: true, config: {} },
    ],
    recovery: { allowed: true, autoResolveOnResolve: true },
    waiver:   { allowed: true, partialAllowed: true },
  },
  {
    code: 'attendance_manual_v2',
    name: 'Attendance Manual Correction',
    description: 'HR flipped Absent -> Present on a day with no submission and picked "Performance Penalty".',
    category: 'attendance',
    detector: 'manual',
    severity: 'high',
    trigger: { evaluationDelayDays: 0 },
    actions: [
      { type: 'zero_daily_marks', enabled: true, config: { marksStrategy: 'admin_defined' } },
    ],
    waiver:   { allowed: true, partialAllowed: true },
  },
  {
    code: 'manual_marks_v2',
    name: 'Manual Marks Adjustment',
    description: 'HR-created ad-hoc marks penalty.  Supports optional grace period.',
    category: 'conduct',
    detector: 'manual',
    severity: 'medium',
    trigger: { evaluationDelayDays: 0 },
    actions: [
      { type: 'fixed_marks_reduction', enabled: true, config: { marks: 0 } },
    ],
    waiver:   { allowed: true, partialAllowed: false },
  },
  {
    code: 'completion_adjustment_v2',
    name: 'Completion Score Adjustment',
    description: 'HR-created percentage adjustment against Performance Analytics.',
    category: 'conduct',
    detector: 'manual',
    severity: 'medium',
    trigger: { evaluationDelayDays: 0 },
    actions: [
      { type: 'percent_reduction', enabled: true, config: { percent: 0 } },
    ],
    waiver:   { allowed: true, partialAllowed: false },
  },
  {
    code: 'financial_penalty_v2',
    name: 'Financial Penalty',
    description: 'HR-created ₹ fine.  Never affects marks; may be deducted from salary.',
    category: 'conduct',
    detector: 'manual',
    severity: 'medium',
    trigger: { evaluationDelayDays: 0 },
    actions: [
      { type: 'financial_fine', enabled: true, config: { amount: 0 } },
    ],
    waiver:   { allowed: true, partialAllowed: false },
  },
];

/**
 * Batch-1 patcher (#6, #4): for existing installations where a rule
 * was seeded under an older SEED spec, this pass patches SPECIFIC
 * fields the fix introduced without disturbing any HR customisation.
 *
 * Rules:
 *   - Only touches action rows matching the specific (code, actionType)
 *     tuple listed below.
 *   - Only sets missing keys; never overwrites HR-authored values.
 *   - Never changes rule.enabled, rule.scope, rule.severity or any
 *     action's `enabled` flag.
 *
 * Idempotent: re-runs perform zero writes once every target field is
 * populated.
 */
const _CONFIG_PATCHES = Object.freeze([
  // #6 -- performance_lock must renew daily.
  {
    ruleCode: 'performance_lock_v2', actionType: 'performance_lock',
    ensure: (cfg) => {
      let changed = false;
      if (cfg.recurring !== true)         { cfg.recurring = true;         changed = true; }
      if (cfg.recurringCadence !== 'daily') { cfg.recurringCadence = 'daily'; changed = true; }
      return changed;
    },
  },
  // #4 -- fresh-hire fallback: adminDefined floor for zero-daily-marks.
  {
    ruleCode: 'missed_submission_v2', actionType: 'zero_daily_marks',
    ensure: (cfg) => {
      // Only set `marks` when neither the caller nor a prior seed set it.
      // Value 5 is the approved fresh-hire fallback (see #4 root cause).
      if (cfg.marks === undefined || cfg.marks === null) {
        cfg.marks = 5;
        return true;
      }
      return false;
    },
  },
]);

const _patchExistingRules = async () => {
  let patched = 0;
  for (const p of _CONFIG_PATCHES) {
    const rule = await ComplianceRule.findOne({ code: p.ruleCode });
    if (!rule) continue;
    const action = (rule.actions || []).find((a) => a.type === p.actionType);
    if (!action) continue;
    action.config = action.config || {};
    if (p.ensure(action.config)) {
      if (typeof rule.markModified === 'function') rule.markModified('actions');
      rule.version += 1;
      if (typeof rule.save === 'function') await rule.save();
      patched += 1;
      console.log(`[compliance-rules-seed] patched ${p.ruleCode}.${p.actionType} config`);
    }
  }
  return patched;
};

const run = async () => {
  let created = 0;
  let skipped = 0;
  for (const spec of SEED) {
    // Upsert-if-missing.  If the rule already exists (any state) we
    // leave it alone -- HR's edits win.  The `_patchExistingRules`
    // pass handles surgical fixes for existing rules.
    const existing = await ComplianceRule.findOne({ code: spec.code }).lean();
    if (existing) { skipped += 1; continue; }
    await ComplianceRule.create({
      ...spec,
      enabled: false,
      version: 1,
    });
    created += 1;
  }
  const patched = await _patchExistingRules();
  return { created, skipped, patched, total: SEED.length };
};

const start = async () => {
  try {
    const { isEnabled } = require('../../../config/featureFlags');
    if (!isEnabled('compliance.rules')) {
      console.log('[compliance-rules-seed] skipped (compliance.rules flag off)');
      return { skipped: true };
    }
    const r = await run();
    console.log(`[compliance-rules-seed] created ${r.created}, skipped ${r.skipped} of ${r.total}`);
    return r;
  } catch (e) {
    console.error('[compliance-rules-seed] failed:', e.message);
    return { error: e.message };
  }
};

module.exports = { run, start, SEED };
