/**
 * phase3.test.js -- ruleService validation + seeder shape.
 * Pure logic tests; no Mongo required.
 *
 *   cd backend && node services/compliance/__tests__/phase3.test.js
 */

const assert = require('assert');
process.env.NODE_ENV = 'test';

const ruleService = require('../rules/ruleService');
const ruleSeed    = require('../rules/ruleSeed');
const ComplianceRule = require('../../../models/ComplianceRule');

// -----------------------------------------------------------
// validateRulePayload -- accept + reject cases
// -----------------------------------------------------------
{
  // Minimum valid payload (create).
  const ok = {
    code: 'test.rule',
    name: 'Test',
    category: 'submission',
    detector: 'built_in.missed_submission',
  };
  ruleService.validateRulePayload(ok, { isUpdate: false });
  console.log('  ok  validate: minimum create payload passes');

  // Missing required fields.
  assert.throws(() => ruleService.validateRulePayload({}, { isUpdate: false }),
    /Missing required field/);
  assert.throws(() => ruleService.validateRulePayload({ code: 'x' }, { isUpdate: false }),
    /Missing required field: name/);
  console.log('  ok  validate: missing required fields throw');

  // Update payload does NOT require code/name/etc.
  ruleService.validateRulePayload({ enabled: true }, { isUpdate: true });
  console.log('  ok  validate: update permits partial payload');

  // Category enum.
  assert.throws(() => ruleService.validateRulePayload(
    { ...ok, category: 'not-a-category' }, { isUpdate: false }),
    /Invalid category/);
  console.log('  ok  validate: category enum enforced');

  // Severity enum.
  assert.throws(() => ruleService.validateRulePayload(
    { ...ok, severity: 'oops' }, { isUpdate: false }),
    /Invalid severity/);
  console.log('  ok  validate: severity enum enforced');

  // Action type enum + duplicate _id.
  assert.throws(() => ruleService.validateRulePayload(
    { ...ok, actions: [{ type: 'not_a_real_type' }] }, { isUpdate: false }),
    /Invalid action type/);
  const dupPayload = {
    ...ok,
    actions: [
      { _id: 'dup', type: 'financial_fine' },
      { _id: 'dup', type: 'financial_fine' },
    ],
  };
  assert.throws(() => ruleService.validateRulePayload(dupPayload, { isUpdate: false }),
    /Duplicate action _id/);
  console.log('  ok  validate: action type enum + duplicate _id detection');

  // marksStrategy enum.
  assert.throws(() => ruleService.validateRulePayload(
    { ...ok, actions: [{ type: 'zero_daily_marks', config: { marksStrategy: 'invented' } }] },
    { isUpdate: false }),
    /Invalid marksStrategy/);
  console.log('  ok  validate: marksStrategy enum enforced');

  // Trigger delay / threshold / cutoffTime shape.
  assert.throws(() => ruleService.validateRulePayload(
    { ...ok, trigger: { evaluationDelayDays: -1 } }, { isUpdate: false }),
    /non-negative/);
  assert.throws(() => ruleService.validateRulePayload(
    { ...ok, trigger: { thresholdDays: 'a' } }, { isUpdate: false }),
    /non-negative/);
  assert.throws(() => ruleService.validateRulePayload(
    { ...ok, trigger: { cutoffTime: '9:00' } }, { isUpdate: false }),
    /HH:MM/);
  console.log('  ok  validate: trigger fields shape enforced');

  // Waiver approverRoles enum.
  assert.throws(() => ruleService.validateRulePayload(
    { ...ok, waiver: { approverRoles: ['random'] } }, { isUpdate: false }),
    /waiver.approverRoles entry/);
  console.log('  ok  validate: waiver approverRoles enum enforced');

  // Recovery mode enum.
  assert.throws(() => ruleService.validateRulePayload(
    { ...ok, recovery: { modes: ['bogus'] } }, { isUpdate: false }),
    /Invalid recovery mode/);
  console.log('  ok  validate: recovery.modes enum enforced');

  // Escalation shape.
  assert.throws(() => ruleService.validateRulePayload(
    { ...ok, escalation: [{ afterDays: 0 }] }, { isUpdate: false }),
    /afterDays must be >= 1/);
  assert.throws(() => ruleService.validateRulePayload(
    { ...ok, escalation: [{ afterDays: 1, actionsAdd: [{ type: 'not_a_type' }] }] },
    { isUpdate: false }),
    /escalation action type/);
  console.log('  ok  validate: escalation shape enforced');
}

// -----------------------------------------------------------
// Seeder shape -- every SEED entry must validate cleanly and
// materialise into a valid ComplianceRule document.
// -----------------------------------------------------------
{
  assert.ok(Array.isArray(ruleSeed.SEED) && ruleSeed.SEED.length > 0,
    'seeder exports SEED array');
  const codes = new Set();
  for (const spec of ruleSeed.SEED) {
    assert.ok(spec.code, 'seed entry has code');
    assert.ok(!codes.has(spec.code), `seed codes are unique: ${spec.code}`);
    codes.add(spec.code);
    // Validate as a create payload.
    ruleService.validateRulePayload(spec, { isUpdate: false });
    // Instantiate and validate synchronously.
    const doc = new ComplianceRule({ ...spec, enabled: false, version: 1 });
    const err = doc.validateSync();
    assert.strictEqual(err, undefined,
      `seed rule ${spec.code}: mongoose validateSync passes`);
  }
  console.log(`  ok  seeder: ${ruleSeed.SEED.length} rules validate cleanly`);
}

// -----------------------------------------------------------
// Enum surface exports
// -----------------------------------------------------------
{
  assert.ok(Array.isArray(ruleService.ACTION_TYPES) && ruleService.ACTION_TYPES.length > 0);
  assert.ok(Array.isArray(ruleService.MARKS_STRATEGIES) && ruleService.MARKS_STRATEGIES.length > 0);
  assert.ok(Array.isArray(ruleService.CATEGORIES));
  assert.ok(Array.isArray(ruleService.APPROVER_ROLES));
  assert.ok(Array.isArray(ruleService.RECOVERY_MODES));
  console.log('  ok  ruleService: enum surface exported');
}

// -----------------------------------------------------------
// Feature-flag gate + authz check on the controller
//
// express-async-handler catches thrown errors and forwards them to
// `next(err)` -- so we capture via a custom `next` rather than
// awaiting a Promise rejection.
// -----------------------------------------------------------
(async () => {
  const featureFlags = require('../../../config/featureFlags');
  const ruleController = require('../../../controllers/compliance/ruleController');

  const _invoke = async (handler, { user }) => {
    let statusCode = 200;
    let errCaught = null;
    const res = { status(c) { statusCode = c; return this; }, json() {} };
    const req = { user };
    await handler(req, res, (err) => { errCaught = err; });
    return { statusCode, err: errCaught };
  };

  // Flag off -> 404 with "not enabled" message.
  featureFlags._resetForTest();
  const off = await _invoke(ruleController.list, { user: { role: 'super_admin' } });
  assert.strictEqual(off.statusCode, 404, 'flag off -> 404');
  assert.ok(off.err && /not enabled/i.test(off.err.message),
    'flag off -> error mentions "not enabled"');
  console.log('  ok  controller: rules flag off returns 404');

  // Flag on + non-admin -> 403.
  process.env.COMPLIANCE_RULES = 'true';
  featureFlags._resetForTest();
  const nonAdmin = await _invoke(ruleController.list, { user: { role: 'employee' } });
  assert.strictEqual(nonAdmin.statusCode, 403, 'flag on + non-admin -> 403');
  assert.ok(nonAdmin.err && /HR \/ Super Admin/i.test(nonAdmin.err.message),
    'flag on + non-admin -> HR / Super Admin error');
  console.log('  ok  controller: authz -> 403 for non-admin');

  // Flag on + non-super-admin creating -> 403.
  const nonSA = await _invoke(ruleController.create, { user: { role: 'hr' } });
  assert.strictEqual(nonSA.statusCode, 403, 'HR without complianceRules feature -> 403 create');
  console.log('  ok  controller: HR without feature perm cannot create rules');

  delete process.env.COMPLIANCE_RULES;
  featureFlags._resetForTest();
  console.log('\nphase3: all tests passed');
})().catch((e) => {
  console.error('phase3 test crashed:', e && e.stack || e);
  process.exit(1);
});
