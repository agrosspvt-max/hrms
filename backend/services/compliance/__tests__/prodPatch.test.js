/**
 * prodPatch.test.js -- regression suite for the pre-production
 * engineering patches.
 *
 *   H5 -- ComplianceIncident {context.submissionId:1} sparse index
 *   H7 -- Legacy Penalty mirror recovers _id on E11000
 *   H1 -- Escalation step only memoised on full success
 *   H2 -- Escalation effectiveDate normalised; effect+ledger+memo atomic
 *
 *   cd backend && node services/compliance/__tests__/prodPatch.test.js
 */

process.env.NODE_ENV = 'test';
process.env.MISSED_SUBMISSION_EFFECTIVE_FROM = '2020-01-01';
process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User                    = require('../../../models/User');
const Submission              = require('../../../models/Submission');
const Attendance              = require('../../../models/Attendance');
const DependencyTask          = require('../../../models/DependencyTask');
const Template                = require('../../../models/Template');
const Penalty                 = require('../../../models/Penalty');
const ComplianceRule          = require('../../../models/ComplianceRule');
const ComplianceIncident      = require('../../../models/ComplianceIncident');
const ComplianceActionEffect  = require('../../../models/ComplianceActionEffect');
const ComplianceEvent         = require('../../../models/ComplianceEvent');
const ComplianceWaiver        = require('../../../models/ComplianceWaiver');
const ComplianceRecovery      = require('../../../models/ComplianceRecovery');
const MarksLedger             = require('../../../models/MarksLedger');
const FinancialLedger         = require('../../../models/FinancialLedger');
const PercentageLedger        = require('../../../models/PercentageLedger');
const AttendanceLedger        = require('../../../models/AttendanceLedger');
const AuditLog                = require('../../../models/AuditLog');

_stub.install(User);
_stub.install(Submission);
_stub.install(Attendance);
_stub.install(DependencyTask);
_stub.install(Template);
_stub.install(Penalty, { uniqueBy: [['employee', 'category', 'targetDate', 'submission']] });
_stub.install(ComplianceRule, { uniqueBy: [['code']] });
_stub.install(ComplianceIncident, { uniqueBy: [['naturalKey', 'source']] });
_stub.install(ComplianceActionEffect, {
  uniqueBy: [['incidentId', 'ruleActionId', 'effectiveDate']],
});
_stub.install(ComplianceEvent);
_stub.install(ComplianceWaiver);
_stub.install(ComplianceRecovery);
_stub.install(MarksLedger);
_stub.install(FinancialLedger);
_stub.install(PercentageLedger);
_stub.install(AttendanceLedger);
_stub.install(AuditLog);

const compliance = require('../../compliance');
const critical = require('../critical');
const featureFlags = require('../../../config/featureFlags');
featureFlags._resetForTest();

// ---------------------------------------------------------------
// H5 -- ComplianceIncident sparse index on context.submissionId
// ---------------------------------------------------------------
(async () => {
  const specs = ComplianceIncident.schema.indexes();
  const hasIndex = specs.some((s) => {
    const [key, opts] = s;
    return key && key['context.submissionId'] === 1
      && opts && opts.sparse === true;
  });
  assert.strictEqual(hasIndex, true,
    'ComplianceIncident declares sparse index on {context.submissionId:1}');
  console.log('  ok  H5: index {context.submissionId:1, sparse:true} declared');
})()

// ---------------------------------------------------------------
// H7 -- Penalty mirror recovers _id on E11000
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  critical.beginTick && critical.beginTick();

  const empId = _oid();
  const submissionId = _oid();
  const effectiveDate = new Date('2026-07-17T00:00:00Z');

  // --- Path A: create.  No pre-existing Penalty; mirror is written
  // fresh and effect.penaltyId gets set to the new _id. ---
  const ruleA = await ComplianceRule.create({
    code: 'rA', name: 'x', category: 'submission',
    detector: 'built_in.performance_lock', enabled: true,
    severity: 'high', version: 1, trigger: {}, scope: {},
    actions: [{ _id: _oid(), type: 'performance_lock', enabled: true, config: {} }],
    notifications: {}, recovery: {}, waiver: {},
  });
  const incA = await ComplianceIncident.create({
    ruleId: ruleA._id, ruleVersion: 1, ruleCode: 'rA',
    employee: empId, severity: 'high',
    incidentDate: effectiveDate, effectiveDate,
    status: 'active', naturalKey: 'nkA', source: 'automatic',
    context: { submissionId },
    detectorMeta: { oldest: { submissionId } },
  });
  await compliance.actionEngine.apply({ incident: incA, day: effectiveDate });
  const effectsA = _stub.rows(ComplianceActionEffect).filter((e) => String(e.incidentId) === String(incA._id));
  assert.strictEqual(effectsA.length, 1, 'one effect created');
  const penaltiesA = _stub.rows(Penalty);
  assert.strictEqual(penaltiesA.length, 1, 'mirror Penalty created on fresh path');
  assert.strictEqual(String(effectsA[0].penaltyId), String(penaltiesA[0]._id),
    'effect.penaltyId points at newly-created mirror');
  console.log('  ok  H7 (create): fresh mirror Penalty; effect.penaltyId set');

  // --- Path B: duplicate.  Legacy engine already inserted a Penalty
  // with the same natural key; mirror-write hits E11000; we must
  // recover the existing _id and NOT create a duplicate. ---
  _stub.reset();
  critical.beginTick && critical.beginTick();
  const submissionB = _oid();
  const preExisting = await Penalty.create({
    employee: empId, category: 'performance_lock',
    source: 'automatic', probable: false, status: 'active',
    targetDate: effectiveDate, submission: submissionB,
    rule: 'legacy', reason: 'legacy engine wrote first',
  });
  const ruleB = await ComplianceRule.create({
    code: 'rB', name: 'x', category: 'submission',
    detector: 'built_in.performance_lock', enabled: true,
    severity: 'high', version: 1, trigger: {}, scope: {},
    actions: [{ _id: _oid(), type: 'performance_lock', enabled: true, config: {} }],
    notifications: {}, recovery: {}, waiver: {},
  });
  const incB = await ComplianceIncident.create({
    ruleId: ruleB._id, ruleVersion: 1, ruleCode: 'rB',
    employee: empId, severity: 'high',
    incidentDate: effectiveDate, effectiveDate,
    status: 'active', naturalKey: 'nkB', source: 'automatic',
    context: { submissionId: submissionB },
    detectorMeta: { oldest: { submissionId: submissionB } },
  });
  const applied = await compliance.actionEngine.apply({ incident: incB, day: effectiveDate });
  // No error surfaced from the mirror duplicate path.
  const mirrorErrors = applied.errors.filter((e) => e.reason === 'legacy_penalty');
  assert.deepStrictEqual(mirrorErrors, [], 'no error surfaced on duplicate mirror');
  const penaltiesB = _stub.rows(Penalty);
  assert.strictEqual(penaltiesB.length, 1, 'no duplicate Penalty created (still 1)');
  const effectsB = _stub.rows(ComplianceActionEffect).filter((e) => String(e.incidentId) === String(incB._id));
  assert.strictEqual(String(effectsB[0].penaltyId), String(preExisting._id),
    'effect.penaltyId recovered from the pre-existing legacy Penalty');
  console.log('  ok  H7 (duplicate): existing Penalty _id recovered; no dup');

  // --- Path C: waiver on the mirrored effect cancels the shared Penalty ---
  const waiver = await compliance.waiverService.request({
    incidentId: incB._id, scope: 'full', reason: 'test',
    requestedBy: _oid(),
  });
  await compliance.waiverService.decide({
    waiverId: waiver._id, decision: 'approved', decidedBy: _oid(),
  });
  const penAfterWaiver = _stub.rows(Penalty).find((p) => String(p._id) === String(preExisting._id));
  assert.strictEqual(penAfterWaiver.status, 'cancelled',
    'waiver cascaded to the recovered mirror Penalty');
  console.log('  ok  H7 (waiver): mirror Penalty cancelled via effect.penaltyId');

  // --- Path D: recovery on the mirrored effect resolves the shared Penalty ---
  _stub.reset();
  critical.beginTick && critical.beginTick();
  const submissionD = _oid();
  const preExistingD = await Penalty.create({
    employee: empId, category: 'performance_lock',
    source: 'automatic', probable: false, status: 'active',
    targetDate: effectiveDate, submission: submissionD,
    rule: 'legacy', reason: 'legacy wrote first',
  });
  const ruleD = await ComplianceRule.create({
    code: 'rD', name: 'x', category: 'submission',
    detector: 'built_in.performance_lock', enabled: true,
    severity: 'high', version: 1, trigger: {}, scope: {},
    actions: [{ _id: _oid(), type: 'performance_lock', enabled: true, config: {} }],
    notifications: {}, recovery: {}, waiver: {},
  });
  const incD = await ComplianceIncident.create({
    ruleId: ruleD._id, ruleVersion: 1, ruleCode: 'rD',
    employee: empId, severity: 'high',
    incidentDate: effectiveDate, effectiveDate,
    status: 'active', naturalKey: 'nkD', source: 'automatic',
    context: { submissionId: submissionD },
    detectorMeta: { oldest: { submissionId: submissionD } },
  });
  await compliance.actionEngine.apply({ incident: incD, day: effectiveDate });
  await compliance.recoveryService.apply({
    incidentId: incD._id, mode: 'restore', reason: 'test', actor: _oid(),
  });
  const penAfterRecovery = _stub.rows(Penalty).find((p) => String(p._id) === String(preExistingD._id));
  assert.strictEqual(penAfterRecovery.status, 'resolved',
    'recovery cascaded to the recovered mirror Penalty');
  console.log('  ok  H7 (recovery): mirror Penalty resolved via effect.penaltyId');

  // --- Path E: cancel on the incident cancels the shared Penalty ---
  _stub.reset();
  critical.beginTick && critical.beginTick();
  const submissionE = _oid();
  const preExistingE = await Penalty.create({
    employee: empId, category: 'performance_lock',
    source: 'automatic', probable: false, status: 'active',
    targetDate: effectiveDate, submission: submissionE,
    rule: 'legacy', reason: 'legacy wrote first',
  });
  const ruleE = await ComplianceRule.create({
    code: 'rE', name: 'x', category: 'submission',
    detector: 'built_in.performance_lock', enabled: true,
    severity: 'high', version: 1, trigger: {}, scope: {},
    actions: [{ _id: _oid(), type: 'performance_lock', enabled: true, config: {} }],
    notifications: {}, recovery: {}, waiver: {},
  });
  const incE = await ComplianceIncident.create({
    ruleId: ruleE._id, ruleVersion: 1, ruleCode: 'rE',
    employee: empId, severity: 'high',
    incidentDate: effectiveDate, effectiveDate,
    status: 'active', naturalKey: 'nkE', source: 'automatic',
    context: { submissionId: submissionE },
    detectorMeta: { oldest: { submissionId: submissionE } },
  });
  await compliance.actionEngine.apply({ incident: incE, day: effectiveDate });
  await compliance.incidentService.cancelIncident(incE._id,
    { reason: 'test cancel', actor: _oid() });
  const penAfterCancel = _stub.rows(Penalty).find((p) => String(p._id) === String(preExistingE._id));
  assert.strictEqual(penAfterCancel.status, 'cancelled',
    'cancel cascaded to the recovered mirror Penalty');
  console.log('  ok  H7 (cancel): mirror Penalty cancelled via effect.penaltyId');
})

// ---------------------------------------------------------------
// H1 + H2 -- escalation retry semantics + idempotency
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const escalationRunner = require('../escalation/escalationRunner');
  const registry = require('../registry/actionExecutorRegistry');

  const empId = _oid();
  const stepId = _oid();
  const actionId = _oid();

  const rule = await ComplianceRule.create({
    code: 'r_esc', name: 'x', category: 'submission',
    detector: 'built_in.missed_submission', enabled: true,
    severity: 'medium', version: 1, trigger: {}, scope: {},
    actions: [],
    escalation: [{
      _id: stepId,
      afterDays: 3,
      actionsAdd: [{ _id: actionId, type: 'financial_fine', enabled: true, config: { amount: 200 } }],
    }],
    notifications: {}, recovery: {}, waiver: {},
  });
  const oldDay = new Date('2026-07-10T00:00:00Z');
  const now = new Date('2026-07-17T00:00:00Z');

  const inc = await ComplianceIncident.create({
    ruleId: rule._id, ruleVersion: 1, ruleCode: 'r_esc',
    employee: empId, severity: 'medium',
    incidentDate: oldDay, effectiveDate: oldDay,
    status: 'active', naturalKey: 'nk_esc', source: 'automatic',
    context: {},
  });

  // ---- H1 case A: missing executor -> step NOT memoised, error counted ----
  const originalGet = registry.get;
  let missingCount = 0;
  registry.get = (code) => {
    if (code === 'financial_fine') { missingCount += 1; return null; }   // simulate missing
    return originalGet.call(registry, code);
  };
  const r1 = await escalationRunner.run({ day: now });
  registry.get = originalGet;

  assert.ok(missingCount >= 1, 'lookup for missing executor was invoked');
  assert.strictEqual(r1.stepsFired, 0, 'no steps fired when executor missing');
  assert.ok(r1.errors >= 1, 'error counted for missing executor');
  const incAfterMiss = await ComplianceIncident.findById(inc._id);
  const memoAfterMiss = (incAfterMiss.detectorMeta && incAfterMiss.detectorMeta.escalatedStepIds) || [];
  assert.deepStrictEqual(memoAfterMiss, [],
    'escalatedStepIds NOT populated when step could not fully succeed');
  assert.strictEqual(_stub.rows(FinancialLedger).length, 0, 'no ledger row written');
  console.log('  ok  H1: missing executor leaves step un-memoised (will retry)');

  // ---- H1 case B: executor throws -> step NOT memoised ----
  const origActionEngine = require('../actions/actionEngine');
  const brokenGet = registry.get;
  registry.get = (code) => {
    if (code === 'financial_fine') return async () => { throw new Error('boom'); };
    return brokenGet.call(registry, code);
  };
  const r2 = await escalationRunner.run({ day: now });
  registry.get = originalGet;

  assert.strictEqual(r2.stepsFired, 0, 'step did not report as fired');
  assert.ok(r2.errors >= 1, 'error counted');
  const incAfterThrow = await ComplianceIncident.findById(inc._id);
  const memoAfterThrow = (incAfterThrow.detectorMeta && incAfterThrow.detectorMeta.escalatedStepIds) || [];
  assert.deepStrictEqual(memoAfterThrow, [],
    'escalatedStepIds NOT populated when executor threw');
  console.log('  ok  H1: executor throw leaves step un-memoised (will retry)');

  // ---- H2 case A: successful escalation memoises + writes effect ----
  const r3 = await escalationRunner.run({ day: now });
  assert.strictEqual(r3.stepsFired, 1, 'step fired once on the successful run');
  const effects = _stub.rows(ComplianceActionEffect).filter(
    (e) => String(e.incidentId) === String(inc._id),
  );
  assert.strictEqual(effects.length, 1, 'one effect written');
  const finRows = _stub.rows(FinancialLedger);
  assert.strictEqual(finRows.length, 1, 'one financial ledger row written');
  const incAfterOk = await ComplianceIncident.findById(inc._id);
  assert.deepStrictEqual(
    (incAfterOk.detectorMeta && incAfterOk.detectorMeta.escalatedStepIds) || [],
    [String(stepId)],
    'escalatedStepIds populated after full success',
  );
  console.log('  ok  H2: successful escalation writes effect + memo atomically');

  // ---- H2 case B: repeated ticks are idempotent ----
  // Second tick same day: memo present -> skip.
  const r4 = await escalationRunner.run({ day: now });
  assert.strictEqual(r4.stepsFired, 0, 'second same-day tick fires nothing');
  const effectsAfter2 = _stub.rows(ComplianceActionEffect).filter(
    (e) => String(e.incidentId) === String(inc._id),
  );
  assert.strictEqual(effectsAfter2.length, 1, 'still one effect (memo prevented duplicate)');
  console.log('  ok  H2: repeated same-day tick short-circuits via memo');

  // ---- H2 case C: cross-day tick with SAME startOfDay(day) hits natural-key
  //   Even if the memo were somehow lost, the natural-key on
  //   (incidentId, ruleActionId, effectiveDate) prevents duplication
  //   when effectiveDate is normalised to startOfDay. ----
  // Wipe the memo to simulate a memo-save failure from before the patch.
  await ComplianceIncident.updateMany(
    { _id: inc._id },
    { $set: { detectorMeta: {} } },
  );
  const nowLaterSameDay = new Date('2026-07-17T18:00:00Z');   // same UTC day
  const r5 = await escalationRunner.run({ day: nowLaterSameDay });
  const effectsAfter3 = _stub.rows(ComplianceActionEffect).filter(
    (e) => String(e.incidentId) === String(inc._id),
  );
  assert.strictEqual(effectsAfter3.length, 1,
    'natural-key on startOfDay(day) prevents duplicate even without memo');
  // Memo should be re-populated by the successful step.
  const incAfterC = await ComplianceIncident.findById(inc._id);
  assert.deepStrictEqual(
    (incAfterC.detectorMeta && incAfterC.detectorMeta.escalatedStepIds) || [],
    [String(stepId)],
    'memo re-populated after retry',
  );
  console.log('  ok  H2: cross-tick same-day protected by natural-key on startOfDay');
})

.then(() => {
  _stub.restore();
  console.log('\nprodPatch: all regression tests passed');
})
.catch((e) => {
  console.error('prodPatch test crashed:', e && e.stack || e);
  _stub.restore();
  process.exit(1);
});
