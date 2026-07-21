/**
 * phase1.test.js
 *
 * Node-native tests for the Phase 1 scaffold.  Deliberately does NOT
 * depend on Jest/Mocha so it runs anywhere with just Node.  Every
 * failure aborts the process with a non-zero exit code.
 *
 * Usage:
 *   cd backend && node services/compliance/__tests__/phase1.test.js
 */

const assert = require('assert');
const path   = require('path');

process.env.NODE_ENV = 'test';

// -----------------------------------------------------------
// Feature flags
// -----------------------------------------------------------
const featureFlags = require('../../../config/featureFlags');
{
  featureFlags._resetForTest();
  // Defaults declared -> resolves to declared value.
  assert.strictEqual(featureFlags.isEnabled('compliance.scaffold'), true,
    'compliance.scaffold defaults to true');
  assert.strictEqual(featureFlags.isEnabled('compliance.newEngine'), false,
    'compliance.newEngine defaults to false');
  // Undeclared -> false.
  assert.strictEqual(featureFlags.isEnabled('made.up.flag'), false,
    'unknown flag falls back to false');
  // snapshot returns every known key.
  const snap = featureFlags.snapshot();
  assert.ok(Object.keys(snap).includes('compliance.scaffold'),
    'snapshot includes compliance.scaffold');
  assert.ok(Object.keys(snap).includes('compliance.legacyGone'),
    'snapshot includes compliance.legacyGone');
  // Empty/undefined flag name resolves false without throwing.
  assert.strictEqual(featureFlags.isEnabled(''), false);
  assert.strictEqual(featureFlags.isEnabled(null), false);
  console.log('  ok  featureFlags: defaults + snapshot');
}

// Env override.
{
  process.env.COMPLIANCE_NEW_ENGINE = 'true';
  featureFlags._resetForTest();
  assert.strictEqual(featureFlags.isEnabled('compliance.newEngine'), true,
    'env override flips flag on');
  delete process.env.COMPLIANCE_NEW_ENGINE;
  process.env.COMPLIANCE_NEW_ENGINE = 'no';
  featureFlags._resetForTest();
  assert.strictEqual(featureFlags.isEnabled('compliance.newEngine'), false,
    'env value "no" resolves to false');
  delete process.env.COMPLIANCE_NEW_ENGINE;
  featureFlags._resetForTest();
  console.log('  ok  featureFlags: env override + case handling');
}

// -----------------------------------------------------------
// Registries -- shape + duplicate protection
// -----------------------------------------------------------
const detectorRegistry = require('../registry/detectorRegistry');
const actionExecutorRegistry = require('../registry/actionExecutorRegistry');
const marksStrategyRegistry = require('../registry/marksStrategyRegistry');

for (const [name, reg] of [
  ['detector', detectorRegistry],
  ['action executor', actionExecutorRegistry],
  ['marks strategy', marksStrategyRegistry],
]) {
  reg._resetForTest();
  assert.deepStrictEqual(reg.list(), [],
    `${name}: empty registry has empty list`);

  const fn = async () => [];
  reg.register('test.code_a', fn);
  reg.register('test.code_b', fn);
  assert.deepStrictEqual(reg.list(), ['test.code_a', 'test.code_b'],
    `${name}: list is sorted`);
  assert.strictEqual(reg.get('test.code_a'), fn,
    `${name}: get returns the registered fn`);
  assert.strictEqual(reg.get('does.not.exist'), null,
    `${name}: get returns null for unknown code`);

  assert.throws(() => reg.register('test.code_a', fn), /already registered/,
    `${name}: duplicate registration throws`);
  assert.throws(() => reg.register('', fn), /non-empty string/,
    `${name}: empty code throws`);
  assert.throws(() => reg.register('foo', 'bar'), /must be a function/,
    `${name}: non-fn throws`);
  reg._resetForTest();
  console.log(`  ok  ${name} registry: register + get + list + guards`);
}

// -----------------------------------------------------------
// naturalKey builders
// -----------------------------------------------------------
const naturalKey = require('../naturalKey');
{
  // Missed submission includes the submission id.
  const k1 = naturalKey.missedSubmissionKey({
    ruleCode: 'missed_submission_v2',
    employeeId: '6605c9f2e2a70b5f2c33aa41',
    day: new Date('2026-07-16T18:30:00.000Z'),
    submissionId: '6702d5b1a3f4c2e1e8b7d92c',
  });
  assert.strictEqual(k1,
    'missed_submission_v2|6605c9f2e2a70b5f2c33aa41|2026-07-16|6702d5b1a3f4c2e1e8b7d92c',
    'missedSubmissionKey format');

  // Day normalised to UTC midnight regardless of input time.
  const k2 = naturalKey.dependencyPendingKey({
    ruleCode: 'dependency_pending_v2',
    employeeId: 'e1',
    day: '2026-07-16',
  });
  assert.strictEqual(k2, 'dependency_pending_v2|e1|2026-07-16');

  // Manual with token.
  const k3 = naturalKey.manualIncidentKey({
    ruleCode: 'misinformation_v2',
    employeeId: 'e2',
    day: new Date('2026-07-17T00:00:00Z'),
    token: 'ticket-42',
  });
  assert.strictEqual(k3, 'misinformation_v2|e2|2026-07-17|ticket-42');

  // Same inputs produce identical keys (idempotency contract).
  const kA = naturalKey.buildKey({ ruleCode: 'r', employeeId: 'e', day: '2026-07-16', extra: 'x' });
  const kB = naturalKey.buildKey({ ruleCode: 'r', employeeId: 'e', day: '2026-07-16', extra: 'x' });
  assert.strictEqual(kA, kB, 'buildKey is deterministic');

  console.log('  ok  naturalKey: deterministic + UTC-day + optional scalars');
}

// -----------------------------------------------------------
// dates.computeEffectiveDate
// -----------------------------------------------------------
const dates = require('../dates');
{
  const base = new Date('2026-07-16T10:00:00Z');
  const day0 = dates.computeEffectiveDate({ trigger: { evaluationDelayDays: 0 } }, base);
  const day1 = dates.computeEffectiveDate({ trigger: { evaluationDelayDays: 1 } }, base);
  const day3 = dates.computeEffectiveDate({ trigger: { evaluationDelayDays: 3 } }, base);

  assert.strictEqual(day0.toISOString(), '2026-07-16T00:00:00.000Z',
    'delay 0 lands on same UTC day midnight');
  assert.strictEqual(day1.toISOString(), '2026-07-17T00:00:00.000Z',
    'delay 1 lands on next UTC day midnight');
  assert.strictEqual(day3.toISOString(), '2026-07-19T00:00:00.000Z',
    'delay 3 lands three days later');

  // Missing/negative delay -> clamped to zero.
  const missing = dates.computeEffectiveDate({}, base);
  const negative = dates.computeEffectiveDate({ trigger: { evaluationDelayDays: -5 } }, base);
  assert.strictEqual(missing.toISOString(), '2026-07-16T00:00:00.000Z',
    'missing delay clamps to 0');
  assert.strictEqual(negative.toISOString(), '2026-07-16T00:00:00.000Z',
    'negative delay clamps to 0');
  console.log('  ok  dates.computeEffectiveDate: delay math + clamps');
}

// -----------------------------------------------------------
// Event registry entries for compliance events
// -----------------------------------------------------------
const eventRegistry = require('../../events/registry');
{
  const required = [
    'compliance.incident_created',
    'compliance.incident_effective',
    'compliance.action_applied',
    'compliance.waiver_requested',
    'compliance.waiver_decided',
    'compliance.recovery_applied',
    'compliance.incident_resolved',
    'compliance.incident_cancelled',
    'compliance.escalated',
    'compliance.rule_updated',
  ];
  for (const code of required) {
    assert.ok(eventRegistry.isKnown(code), `event ${code} is registered`);
    const spec = eventRegistry.describe(code);
    assert.ok(spec.owner, `event ${code} has an owner`);
  }
  console.log('  ok  event registry: compliance.* codes registered');
}

// -----------------------------------------------------------
// Barrel export shape
// -----------------------------------------------------------
{
  const barrel = require(path.join('..', 'index.js'));
  for (const key of ['featureFlags', 'detectorRegistry', 'actionExecutorRegistry',
                     'marksStrategyRegistry', 'naturalKey', 'dates', 'logBoot']) {
    assert.ok(barrel[key], `barrel exports ${key}`);
  }
  // logBoot is idempotent -- calling twice should print at most once.
  barrel.logBoot();
  barrel.logBoot();
  console.log('  ok  barrel exports + logBoot idempotency');
}

console.log('\nphase1: all tests passed');
