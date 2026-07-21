/**
 * phase9.test.js -- unit tests for the migration framework.
 *
 * Does NOT execute the backfill against production; runs against
 * the shared stubMongo harness so we can prove:
 *
 *   - project(penalty) returns synthetic incident + effect shapes.
 *   - mappingFor(penalty) returns null for categories with no rule.
 *   - Dry-run mode does NOT write.
 *   - Commit mode refused when flag off.
 *   - Commit mode refused when >=50% already backfilled.
 *   - Commit mode writes and back-references incidentId.
 *   - Rollback (dry) reports; rollback (commit) deletes only the
 *     synthetic rows and clears the Penalty back-reference.
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User = require('../../../models/User');
const Penalty = require('../../../models/Penalty');
const ComplianceRule = require('../../../models/ComplianceRule');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');

_stub.install(User);
_stub.install(Penalty);
_stub.install(ComplianceRule, { uniqueBy: [['code']] });
_stub.install(ComplianceIncident, { uniqueBy: [['naturalKey', 'source']] });
_stub.install(ComplianceActionEffect, {
  uniqueBy: [['incidentId', 'ruleActionId', 'effectiveDate']],
});

const projection = require('../backfill/penaltyProjectionService');
const backfill = require('../backfill/backfillJob');
const featureFlags = require('../../../config/featureFlags');

const _mkRule = async (code, actionType) => await ComplianceRule.create({
  code, name: code, category: 'submission',
  detector: 'built_in.missed_submission',
  enabled: false, severity: 'medium', version: 1,
  trigger: {}, scope: {},
  actions: [{ _id: _oid(), type: actionType, enabled: true, config: {} }],
  notifications: {}, recovery: {}, waiver: {},
});

const _mkPenalty = async (over) => await Penalty.create({
  employee: _oid(),
  category: over.category,
  source: 'automatic',
  probable: false,
  status: over.status || 'active',
  targetDate: over.targetDate || new Date('2026-07-16T00:00:00Z'),
  penaltyMarks: over.penaltyMarks || 0,
  amount: over.amount || 0,
  completionPercent: over.completionPercent || 0,
  submission: over.submission || null,
  incidentId: null,
  effectiveDate: over.effectiveDate || new Date('2026-07-16T00:00:00Z'),
});

// ---------------------------------------------------------------
// Test 1 -- projection shapes
// ---------------------------------------------------------------
(async () => {
  _stub.reset();
  const p = await _mkPenalty({ category: 'missed_submission', penaltyMarks: 8 });
  const proj = projection.project(p);
  assert.ok(proj);
  assert.strictEqual(proj.incident.ruleCode, 'missed_submission_v2');
  assert.strictEqual(proj.effect.actionType, 'zero_daily_marks');
  assert.strictEqual(proj.effect.marks, 8);
  assert.strictEqual(proj.incident.__synthetic, true);
  console.log('  ok  projection: missed_submission -> synthetic pair');

  // Unmapped category returns null.
  const p2 = await _mkPenalty({ category: 'critical_threshold' });
  assert.strictEqual(projection.project(p2), null);
  console.log('  ok  projection: unmapped category returns null');

  // Natural key format.
  const nk = projection.naturalKeyFor(p);
  assert.match(nk, /^legacy_projection\|[a-f0-9]{24}$/);
})()

// ---------------------------------------------------------------
// Test 2 -- Dry-run does NOT write
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  featureFlags._resetForTest();
  await _mkRule('missed_submission_v2', 'zero_daily_marks');
  await _mkPenalty({ category: 'missed_submission', penaltyMarks: 5 });
  const r = await backfill.run();
  assert.strictEqual(r.mode, 'dry-run');
  assert.strictEqual(r.scanned, 1);
  assert.strictEqual(r.projected, 1);
  assert.strictEqual(r.committed, 0);
  assert.strictEqual(_stub.rows(ComplianceIncident).length, 0);
  console.log('  ok  backfill: dry-run projects without writing');
})

// ---------------------------------------------------------------
// Test 3 -- Commit refused when flag off
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  featureFlags._resetForTest();
  await _mkRule('missed_submission_v2', 'zero_daily_marks');
  await _mkPenalty({ category: 'missed_submission' });
  let threw = null;
  try { await backfill.run({ commit: true }); } catch (e) { threw = e; }
  assert.ok(threw && /flag is off/i.test(threw.message));
  assert.strictEqual(_stub.rows(ComplianceIncident).length, 0);
  console.log('  ok  backfill: commit refused when flag off');
})

// ---------------------------------------------------------------
// Test 4 -- Commit writes when flag on
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  process.env.COMPLIANCE_LEGACY_BACKFILL = 'true';
  featureFlags._resetForTest();
  await _mkRule('missed_submission_v2', 'zero_daily_marks');
  await _mkRule('dependency_pending_v2', 'financial_fine');
  const p1 = await _mkPenalty({ category: 'missed_submission', penaltyMarks: 5 });
  const p2 = await _mkPenalty({ category: 'dependency_pending' });
  const r = await backfill.run({ commit: true });
  assert.strictEqual(r.mode, 'commit');
  assert.strictEqual(r.projected, 2);
  assert.strictEqual(r.committed, 2);
  const incs = _stub.rows(ComplianceIncident);
  assert.strictEqual(incs.length, 2);
  const effs = _stub.rows(ComplianceActionEffect);
  assert.strictEqual(effs.length, 2);
  // Penalty rows now carry incidentId back-reference.
  const pens = _stub.rows(Penalty);
  assert.ok(pens.every((pp) => !!pp.incidentId), 'every legacy Penalty back-references incident');
  console.log('  ok  backfill: commit writes synthetic incidents + back-refs');

  // Re-run should skip -- safety check trips (>=50% already backfilled).
  let threw = null;
  try { await backfill.run({ commit: true }); } catch (e) { threw = e; }
  assert.ok(threw && /already carry incidentId/i.test(threw.message));
  console.log('  ok  backfill: re-commit refused by safety check');

  delete process.env.COMPLIANCE_LEGACY_BACKFILL;
  featureFlags._resetForTest();
})

// ---------------------------------------------------------------
// Test 5 -- Rollback removes only synthetic rows
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  process.env.COMPLIANCE_LEGACY_BACKFILL = 'true';
  featureFlags._resetForTest();
  await _mkRule('missed_submission_v2', 'zero_daily_marks');
  await _mkPenalty({ category: 'missed_submission' });
  await backfill.run({ commit: true });

  // Seed a genuine (non-synthetic) incident too.
  const genuineNk = 'missed_submission_v2|X|2026-07-16|Y';
  await ComplianceIncident.create({
    ruleId: _oid(), ruleVersion: 1, ruleCode: 'missed_submission_v2',
    employee: _oid(), severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    naturalKey: genuineNk, status: 'active',
    source: 'automatic', context: {},
  });

  const beforeIncs = _stub.rows(ComplianceIncident).length;
  const dry = await backfill.deleteSynthetic();
  assert.strictEqual(dry.mode, 'dry-run');
  assert.strictEqual(dry.scanned, 1, 'dry-run only reports synthetic count');
  assert.strictEqual(_stub.rows(ComplianceIncident).length, beforeIncs,
    'dry-run does not touch anything');

  const cmt = await backfill.deleteSynthetic({ commit: true });
  assert.strictEqual(cmt.mode, 'commit');
  assert.strictEqual(cmt.deletedIncidents, 1, 'exactly one synthetic incident removed');
  // Genuine incident remains.
  const remaining = _stub.rows(ComplianceIncident);
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].naturalKey, genuineNk);
  // Penalty back-ref cleared.
  const p = _stub.rows(Penalty)[0];
  assert.strictEqual(p.incidentId, null);
  console.log('  ok  backfill: rollback removes only synthetic rows');
  delete process.env.COMPLIANCE_LEGACY_BACKFILL;
  featureFlags._resetForTest();
})

.then(() => {
  _stub.restore();
  console.log('\nphase9: all unit tests passed');
})
.catch((e) => {
  console.error('phase9 test crashed:', e && e.stack || e);
  _stub.restore();
  process.exit(1);
});
