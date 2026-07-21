/**
 * phase6.test.js -- unit tests for Phase 6 lifecycle services.
 *
 *   - waiverService.request + waiverService.decide (approved / rejected).
 *   - Partial vs full waiver semantics.
 *   - Ledger inverse rows written on approval.
 *   - Incident auto-flips to `waived` when every effect is closed.
 *   - recoveryService.apply reverses effects + writes inverse ledger rows.
 *   - escalationRunner memoises applied steps per incident.
 *   - timelineService reads events in the right order.
 *   - ledgerReconciler.runOnce detects drift.
 *
 *   cd backend && node services/compliance/__tests__/phase6.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');

const _oid = () => new mongoose.Types.ObjectId();

const User = require('../../../models/User');
const Submission = require('../../../models/Submission');
const Template = require('../../../models/Template');
const ComplianceRule = require('../../../models/ComplianceRule');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceEvent = require('../../../models/ComplianceEvent');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const ComplianceWaiver   = require('../../../models/ComplianceWaiver');
const ComplianceRecovery = require('../../../models/ComplianceRecovery');
const MarksLedger = require('../../../models/MarksLedger');
const FinancialLedger = require('../../../models/FinancialLedger');
const PercentageLedger = require('../../../models/PercentageLedger');
const AttendanceLedger = require('../../../models/AttendanceLedger');
const AuditLog = require('../../../models/AuditLog');
const Penalty = require('../../../models/Penalty');

_stub.install(User);
_stub.install(Submission);
_stub.install(Template);
_stub.install(ComplianceRule, { uniqueBy: [['code']] });
_stub.install(ComplianceIncident, { uniqueBy: [['naturalKey', 'source']] });
_stub.install(ComplianceEvent);
_stub.install(ComplianceActionEffect, {
  uniqueBy: [['incidentId', 'ruleActionId', 'effectiveDate']],
});
_stub.install(ComplianceWaiver);
_stub.install(ComplianceRecovery);
_stub.install(MarksLedger);
_stub.install(FinancialLedger);
_stub.install(PercentageLedger);
_stub.install(AttendanceLedger);
_stub.install(AuditLog);
_stub.install(Penalty);

const compliance = require('../../compliance');
const waiverService   = compliance.waiverService;
const recoveryService = compliance.recoveryService;
const timelineService = compliance.timelineService;
const escalationRunner = compliance.escalationRunner;
const ledgerReconciler = compliance.ledgerReconciler;
const actionEngine = compliance.actionEngine;

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
const _seedRule = async (over = {}) => await ComplianceRule.create({
  code: over.code || 'r_seed',
  name: 'r', category: 'submission',
  detector: 'built_in.missed_submission',
  enabled: true, severity: 'medium', version: 1,
  trigger: over.trigger || {},
  scope: {},
  actions: over.actions || [],
  notifications: {}, recovery: over.recovery || { allowed: true },
  waiver: over.waiver || { allowed: true, partialAllowed: true },
  escalation: over.escalation || [],
});

const _seedIncident = async (rule, over = {}) => await ComplianceIncident.create({
  ruleId: rule._id, ruleVersion: rule.version, ruleCode: rule.code,
  employee: over.employee || _oid(), severity: 'medium',
  incidentDate: over.incidentDate || new Date('2026-07-16T00:00:00Z'),
  effectiveDate: over.effectiveDate || new Date('2026-07-17T00:00:00Z'),
  status: over.status || 'active',
  naturalKey: over.naturalKey || `nk-${_oid()}`,
  context: {}, source: 'automatic',
  detectorMeta: over.detectorMeta || {},
});

// ---------------------------------------------------------------
// Test 1 -- Waiver: request + decide(approved) writes inverse ledger
// row and updates the incident
// ---------------------------------------------------------------
(async () => {
  _stub.reset();
  const emp = _oid();
  const raid1 = _oid();
  const raid2 = _oid();
  const rule = await _seedRule({
    code: 'r_waiver_test',
    actions: [
      { _id: raid1, type: 'financial_fine', enabled: true, config: { amount: 250 } },
      { _id: raid2, type: 'percent_reduction', enabled: true, config: { percent: 5 } },
    ],
  });
  const inc = await _seedIncident(rule, { employee: emp });
  await actionEngine.apply({ incident: inc });
  const effects = _stub.rows(ComplianceActionEffect);
  assert.strictEqual(effects.length, 2);

  // File a partial waiver on just the financial_fine.
  const financialEffect = effects.find((e) => e.actionType === 'financial_fine');
  const waiver = await waiverService.request({
    incidentId: inc._id, scope: 'partial',
    effectIds: [financialEffect._id],
    reason: 'genuine emergency', requestedBy: emp,
  });
  assert.strictEqual(waiver.status, 'pending');
  console.log('  ok  waiver: request stored with pending status');

  const decided = await waiverService.decide({
    waiverId: waiver._id, decision: 'approved', decidedBy: _oid(),
  });
  assert.strictEqual(decided.status, 'approved');

  const finRows = _stub.rows(FinancialLedger);
  const debit  = finRows.find((r) => r.type === 'action');
  const credit = finRows.find((r) => r.type === 'waiver');
  assert.ok(debit,  'action row exists');
  assert.ok(credit, 'waiver inverse row exists');
  assert.strictEqual(debit.direction, -1);
  assert.strictEqual(credit.direction, +1);
  assert.strictEqual(credit.quantity, 250);
  // Running balance should net to 0 for financial.
  assert.strictEqual(credit.runningBalance, 0);
  console.log('  ok  waiver: approved -> inverse ledger row + balance restored');

  // The percentage effect should be untouched (partial waiver).
  const pctRows = _stub.rows(PercentageLedger).filter((r) => r.type === 'waiver');
  assert.strictEqual(pctRows.length, 0);

  // Incident status still active (percent action still outstanding).
  const incNow = _stub.rows(ComplianceIncident).find((i) => String(i._id) === String(inc._id));
  assert.strictEqual(incNow.status, 'active');
  console.log('  ok  waiver: partial waiver leaves other actions active');

  // Waive the remaining effect -> incident becomes 'waived'.
  const percentEffect = effects.find((e) => e.actionType === 'percent_reduction');
  const w2 = await waiverService.request({
    incidentId: inc._id, scope: 'partial',
    effectIds: [percentEffect._id],
    reason: 'follow-up', requestedBy: emp,
  });
  await waiverService.decide({
    waiverId: w2._id, decision: 'approved', decidedBy: _oid(),
  });
  const incNow2 = _stub.rows(ComplianceIncident).find((i) => String(i._id) === String(inc._id));
  assert.strictEqual(incNow2.status, 'waived',
    'incident flips to waived when every effect is closed');
  console.log('  ok  waiver: incident auto-flips to waived when all effects closed');
})()

// ---------------------------------------------------------------
// Test 2 -- Waiver rejection leaves effects untouched
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = _oid();
  const rule = await _seedRule({
    code: 'r_reject',
    actions: [{ _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 100 } }],
  });
  const inc = await _seedIncident(rule, { employee: emp });
  await actionEngine.apply({ incident: inc });
  const eff = _stub.rows(ComplianceActionEffect)[0];

  const w = await waiverService.request({
    incidentId: inc._id, scope: 'full', reason: 'trying', requestedBy: emp,
  });
  const decided = await waiverService.decide({
    waiverId: w._id, decision: 'rejected', note: 'no', decidedBy: _oid(),
  });
  assert.strictEqual(decided.status, 'rejected');
  const effRow = _stub.rows(ComplianceActionEffect).find((e) => String(e._id) === String(eff._id));
  assert.strictEqual(effRow.status, 'active', 'rejected -> effect untouched');
  console.log('  ok  waiver: rejected leaves effects untouched');
})

// ---------------------------------------------------------------
// Test 3 -- Recovery reverses effects + writes inverse rows
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = _oid();
  const rule = await _seedRule({
    code: 'r_recover',
    actions: [
      { _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 500 } },
      { _id: _oid(), type: 'half_day_lwp',   enabled: true, config: {} },
    ],
  });
  const inc = await _seedIncident(rule, { employee: emp });
  await actionEngine.apply({ incident: inc });

  const rec = await recoveryService.apply({
    incidentId: inc._id, mode: 'restore', reason: 'HR override', actor: _oid(),
  });
  assert.strictEqual(rec.mode, 'restore');
  const finRev = _stub.rows(FinancialLedger).find((r) => r.type === 'recovery');
  const attRev = _stub.rows(AttendanceLedger).find((r) => r.type === 'recovery');
  assert.ok(finRev && finRev.direction === +1);
  assert.ok(attRev && attRev.direction === +1);
  assert.strictEqual(finRev.runningBalance, 0);
  assert.strictEqual(attRev.runningBalance, 0);
  const incNow = _stub.rows(ComplianceIncident).find((i) => String(i._id) === String(inc._id));
  assert.strictEqual(incNow.status, 'resolved',
    'incident flips to resolved when every effect recovered');
  console.log('  ok  recovery: restore reverses ledgers + resolves incident');
})

// ---------------------------------------------------------------
// Test 4 -- Recovery of a specific subset (effectIds)
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = _oid();
  const rule = await _seedRule({
    code: 'r_partial_recover',
    actions: [
      { _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 100 } },
      { _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 200 } },
    ],
  });
  const inc = await _seedIncident(rule, { employee: emp });
  await actionEngine.apply({ incident: inc });
  const effs = _stub.rows(ComplianceActionEffect);
  await recoveryService.apply({
    incidentId: inc._id, mode: 'restore',
    effectIds: [effs[0]._id],
    actor: _oid(),
  });
  const eff0 = _stub.rows(ComplianceActionEffect).find((e) => String(e._id) === String(effs[0]._id));
  const eff1 = _stub.rows(ComplianceActionEffect).find((e) => String(e._id) === String(effs[1]._id));
  assert.strictEqual(eff0.status, 'resolved');
  assert.strictEqual(eff1.status, 'active', 'unspecified effect stays active');
  const incNow = _stub.rows(ComplianceIncident).find((i) => String(i._id) === String(inc._id));
  assert.strictEqual(incNow.status, 'active');
  console.log('  ok  recovery: partial recovery leaves untargeted effects alone');
})

// ---------------------------------------------------------------
// Test 5 -- Escalation runner applies pending steps once
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const stepId = _oid();
  const rule = await _seedRule({
    code: 'r_esc',
    actions: [{ _id: _oid(), type: 'warning', enabled: true, config: {} }],
    escalation: [{
      _id: stepId, afterDays: 3,
      actionsAdd: [{ _id: _oid(), type: 'financial_fine', config: { amount: 500 } }],
    }],
  });
  const inc = await _seedIncident(rule, {
    effectiveDate: new Date('2026-07-15T00:00:00Z'),
  });
  await actionEngine.apply({ incident: inc });

  // Day 2 -- too early.
  const r1 = await escalationRunner.run({ day: new Date('2026-07-17T00:00:00Z') });
  assert.strictEqual(r1.stepsFired, 0);

  // Day 4 -- crossed threshold.
  const r2 = await escalationRunner.run({ day: new Date('2026-07-19T00:00:00Z') });
  assert.strictEqual(r2.stepsFired, 1, 'step fires once threshold passed');
  const finRows = _stub.rows(FinancialLedger).filter((r) => r.type === 'action');
  assert.strictEqual(finRows.length, 1);

  // Day 5 -- memoised, does not re-fire.
  const r3 = await escalationRunner.run({ day: new Date('2026-07-20T00:00:00Z') });
  assert.strictEqual(r3.stepsFired, 0, 'memoised: does not re-fire same step');
  console.log('  ok  escalation: step fires once + memoised');
})

// ---------------------------------------------------------------
// Test 6 -- Timeline read
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = _oid();
  const rule = await _seedRule({ code: 'r_tl', actions: [
    { _id: _oid(), type: 'notification', enabled: true, config: {} },
  ] });
  const inc = await _seedIncident(rule, { employee: emp });
  // Seed events directly.
  await ComplianceEvent.create({
    employee: emp, incidentId: inc._id, kind: 'incident_created',
    payload: {}, actor: 'system', ts: new Date('2026-07-16T00:00:00Z'),
  });
  await ComplianceEvent.create({
    employee: emp, incidentId: inc._id, kind: 'incident_effective',
    payload: {}, actor: 'system', ts: new Date('2026-07-17T00:00:00Z'),
  });
  const perEmp = await timelineService.forEmployee({ employeeId: emp });
  assert.strictEqual(perEmp.length, 2, 'forEmployee returns all events');
  const perInc = await timelineService.forIncident({ incidentId: inc._id });
  assert.strictEqual(perInc.length, 2);
  assert.strictEqual(perInc[0].kind, 'incident_created', 'forIncident sorts ascending');
  console.log('  ok  timeline: read shape');
})

// ---------------------------------------------------------------
// Test 7 -- Ledger reconciler detects drift
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = _oid();
  await MarksLedger.create({
    employee: emp, date: new Date('2026-07-16'),
    direction: -1, quantity: 10, runningBalance: -10, type: 'action',
  });
  await MarksLedger.create({
    employee: emp, date: new Date('2026-07-17'),
    direction: -1, quantity: 5, runningBalance: -999,   // <-- bad!
    type: 'action',
  });
  const summary = await ledgerReconciler.runOnce();
  assert.strictEqual(summary.marks.checked, 2);
  assert.strictEqual(summary.marks.drift.length, 1, 'reconciler flags one row');
  assert.strictEqual(summary.marks.drift[0].expected, -15);
  console.log('  ok  reconciler: detects runningBalance drift');
})

// ---------------------------------------------------------------
// Test 8 -- Waiver policy gates (partial disallowed)
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const rule = await _seedRule({
    code: 'r_no_partial',
    actions: [{ _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 100 } }],
    waiver: { allowed: true, partialAllowed: false, reasonRequired: true },
  });
  const inc = await _seedIncident(rule);
  await actionEngine.apply({ incident: inc });
  let threw = null;
  try {
    await waiverService.request({
      incidentId: inc._id, scope: 'partial',
      effectIds: [_stub.rows(ComplianceActionEffect)[0]._id],
      reason: 'x', requestedBy: _oid(),
    });
  } catch (e) { threw = e; }
  assert.ok(threw && /partial waivers/i.test(threw.message),
    'partial waiver refused when rule.waiver.partialAllowed=false');
  console.log('  ok  waiver: partialAllowed=false enforced');
})

.then(() => {
  _stub.restore();
  console.log('\nphase6: all unit tests passed');
})
.catch((e) => {
  console.error('phase6 test crashed:', e && e.stack || e);
  _stub.restore();
  process.exit(1);
});
