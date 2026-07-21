/**
 * rollout.test.js -- verify the local-dev rollout wiring.
 *
 *   1. ruleSeed auto-enables the seeded rules listed in the env var.
 *   2. Auto-enable is idempotent (second boot does nothing).
 *   3. HR-edited rules (updatedBy !== null) are never re-enabled by
 *      auto-enable -- HR's decision wins.
 *   4. Unknown codes in the env var are logged, not applied.
 *   5. configController surfaces every rollout flag when they are on.
 *
 *   cd backend && node services/compliance/__tests__/rollout.test.js
 */

process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_RULES = 'true';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const ComplianceRule = require('../../../models/ComplianceRule');
_stub.install(ComplianceRule, { uniqueBy: [['code']] });

const featureFlags = require('../../../config/featureFlags');
const ruleSeed = require('../rules/ruleSeed');

(async () => {
  // ---- Case 1: auto-enable applies to seeded rules ----
  _stub.reset();
  process.env.COMPLIANCE_AUTO_ENABLE_SEEDED = 'missed_submission_v2,performance_lock_v2';
  const r1 = await ruleSeed.run();
  assert.strictEqual(r1.created, ruleSeed.SEED.length, 'all seed rules created on first run');
  assert.strictEqual(r1.autoEnabled, 2, 'two seeded rules auto-enabled');

  const rows = _stub.rows(ComplianceRule);
  const missed = rows.find((r) => r.code === 'missed_submission_v2');
  const perf   = rows.find((r) => r.code === 'performance_lock_v2');
  const dep    = rows.find((r) => r.code === 'dependency_pending_v2');
  assert.strictEqual(missed.enabled, true, 'missed_submission_v2 enabled');
  assert.strictEqual(perf.enabled, true, 'performance_lock_v2 enabled');
  assert.strictEqual(dep.enabled, false, 'dependency_pending_v2 not in list -> still disabled');
  console.log('  ok  rollout: seeded rules auto-enabled from env');

  // ---- Case 2: idempotent -- second boot does nothing new ----
  const r2 = await ruleSeed.run();
  assert.strictEqual(r2.created, 0, 'no new rules created on second boot');
  assert.strictEqual(r2.autoEnabled, 0, 'no additional rules auto-enabled second time');
  console.log('  ok  rollout: second boot is a no-op (idempotent)');

  // ---- Case 3: HR-edited rules (updatedBy set) are respected ----
  //   Simulate an HR-disabled rule with an updatedBy signature.
  await ComplianceRule.updateOne(
    { code: 'missed_submission_v2' },
    { $set: { enabled: false, updatedBy: _oid() } },
  );
  const r3 = await ruleSeed.run();
  assert.strictEqual(r3.autoEnabled, 0,
    'HR-touched rule not re-enabled by auto-enable pass');
  const missedAfter = _stub.rows(ComplianceRule).find((r) => r.code === 'missed_submission_v2');
  assert.strictEqual(missedAfter.enabled, false,
    'HR decision to disable respected on next boot');
  console.log('  ok  rollout: HR-edited rules are never overridden');

  // ---- Case 4: unknown code in env is warned + skipped ----
  process.env.COMPLIANCE_AUTO_ENABLE_SEEDED = 'nonexistent_rule_v99,performance_lock_v2';
  await ComplianceRule.updateOne(
    { code: 'performance_lock_v2' },
    { $set: { enabled: false, updatedBy: null } },
  );
  const r4 = await ruleSeed.run();
  assert.strictEqual(r4.autoEnabled, 1, 'only the recognised code was applied');
  console.log('  ok  rollout: unknown codes rejected safely');

  // ---- Case 5: configController surfaces on-flags ----
  process.env.COMPLIANCE_EMPLOYEE_CARD_V2 = 'true';
  process.env.COMPLIANCE_DASHBOARD_V2 = 'true';
  process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';
  process.env.COMPLIANCE_RULES = 'true';
  featureFlags._resetForTest();

  const configController = require('../../../controllers/compliance/configController');
  let body = null;
  const res = { json: (b) => { body = b; return res; } };
  await configController.get({}, res);
  assert.deepStrictEqual(body.features, {
    employeeCardV2: true,
    dashboardV2:    true,
    waiverRecovery: true,
    rules:          true,
  }, 'config endpoint reports every rollout flag as ON');
  console.log('  ok  rollout: /api/compliance/config exposes flags for the frontend');

  _stub.restore();
  console.log('\nrollout: all rollout tests passed');
})()
.catch((e) => {
  console.error('rollout test crashed:', e && e.stack || e);
  _stub.restore();
  process.exit(1);
});
