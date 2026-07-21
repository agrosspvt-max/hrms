/**
 * phase5.test.js -- unit tests for the Phase 5 action engine.
 *
 *   - Every built-in executor emits the correct effectDoc + ledgerAppends.
 *   - Marks strategy chain falls through until it produces a non-zero.
 *   - actionEngine.apply persists ComplianceActionEffect + ledger rows.
 *   - Idempotent per (incidentId, ruleActionId, effectiveDate).
 *   - performance_lock BC shim writes Penalty when compliance.dualWrite
 *     is off; skips when it's on.
 *   - Ledger runningBalance accumulates append-only.
 */

process.env.NODE_ENV = 'test';
process.env.MISSED_SUBMISSION_EFFECTIVE_FROM = '2020-01-01';

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
_stub.install(MarksLedger);
_stub.install(FinancialLedger);
_stub.install(PercentageLedger);
_stub.install(AttendanceLedger);
_stub.install(AuditLog);
_stub.install(Penalty);

const compliance = require('../../compliance');
const executors = require('../actions/executors');
const strategies = require('../marks/strategies');
const ledgerService = compliance.ledgerService;
const actionEngine = compliance.actionEngine;
const featureFlags = require('../../../config/featureFlags');

const _incident = (over = {}) => ({
  _id: _oid(),
  employee: _oid(),
  effectiveDate: new Date('2026-07-17T00:00:00Z'),
  incidentDate:  new Date('2026-07-16T00:00:00Z'),
  status: 'active',
  ruleId: _oid(),
  ruleActionId: _oid(),
  context: {},
  detectorMeta: {},
  ...over,
});

const _actionCfg = (over = {}) => ({
  _id: _oid(),
  type: 'financial_fine',
  enabled: true,
  config: {},
  ...over,
});

// ---------------------------------------------------------------
// Test 1 -- executors emit correct effect + ledger shapes
// ---------------------------------------------------------------
(async () => {
  _stub.reset();
  strategies.registerAll();
  executors.registerAll();
  const rule = { _id: _oid(), code: 'r' };

  // financial_fine
  const ff = await executors._ALL.financial_fine({
    rule, actionConfig: _actionCfg({ config: { amount: 200 } }),
    incident: _incident(),
  });
  assert.strictEqual(ff.effectDoc.actionType, 'financial_fine');
  assert.strictEqual(ff.effectDoc.amount, 200);
  assert.strictEqual(ff.ledgerAppends[0].ledger, 'financial');
  assert.strictEqual(ff.ledgerAppends[0].quantity, 200);
  assert.strictEqual(ff.ledgerAppends[0].direction, -1);

  // financial_fine, critical
  const ffc = await executors._ALL.financial_fine({
    rule, actionConfig: _actionCfg({ config: { amount: 200, criticalAmount: 300 } }),
    incident: _incident({ detectorMeta: { criticalTask: true } }),
  });
  assert.strictEqual(ffc.effectDoc.amount, 300, 'critical uses criticalAmount');

  // percent_reduction capped by maxCap
  const pr = await executors._ALL.percent_reduction({
    rule, actionConfig: _actionCfg({ config: { percentPerDay: 5, maxCap: 3 } }),
    incident: _incident(),
  });
  assert.strictEqual(pr.effectDoc.percent, 3, 'percent clamped to maxCap');
  assert.strictEqual(pr.ledgerAppends[0].ledger, 'percentage');

  // fixed_marks_reduction
  const fm = await executors._ALL.fixed_marks_reduction({
    rule, actionConfig: _actionCfg({ config: { marks: 7 } }),
    incident: _incident(),
  });
  assert.strictEqual(fm.effectDoc.marks, 7);
  assert.strictEqual(fm.ledgerAppends[0].ledger, 'marks');

  // half_day_lwp + full_day_lwp
  const hd = await executors._ALL.half_day_lwp({
    rule, actionConfig: _actionCfg(), incident: _incident(),
  });
  assert.strictEqual(hd.effectDoc.attendanceUnit, 0.5);
  assert.strictEqual(hd.ledgerAppends[0].quantity, 0.5);
  const fd = await executors._ALL.full_day_lwp({
    rule, actionConfig: _actionCfg(), incident: _incident(),
  });
  assert.strictEqual(fd.effectDoc.attendanceUnit, 1.0);

  // warning / notification / manager_notification -- no ledger.
  const warn = await executors._ALL.warning({ rule, actionConfig: _actionCfg(), incident: _incident() });
  assert.strictEqual(warn.ledgerAppends.length, 0);

  // performance_lock -- passes overdue snapshot + emits legacyPenalty.
  const pl = await executors._ALL.performance_lock({
    rule, actionConfig: _actionCfg(),
    incident: _incident({ detectorMeta: { oldest: { taskTitle: 'X' } } }),
  });
  assert.deepStrictEqual(pl.effectDoc.taskRef, { taskTitle: 'X' });
  assert.strictEqual(pl.legacyPenalty.category, 'performance_lock');
  console.log('  ok  executors: every built-in emits correct shape');
})()
// ---------------------------------------------------------------
// Test 2 -- marks strategy chain
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = { _id: _oid(), department: _oid() };
  const day = new Date('2026-07-16T00:00:00Z');

  // admin_defined with a fixed number wins on first pass.
  const v1 = await strategies.compute({
    strategy: 'admin_defined', config: { marks: 12 },
    employee: emp, day,
  });
  assert.strictEqual(v1, 12);

  // asked strategy returns 0, chain falls through to admin_defined.
  const v2 = await strategies.compute({
    strategy: 'last_n_avg', config: { N: 7, marks: 5 },
    employee: emp, day,
  });
  assert.strictEqual(v2, 5, 'falls through to admin_defined when data empty');

  // Seed some Submission history for last_n_avg.
  await Submission.create({
    employee: emp._id, template: _oid(), submitted: true,
    date: new Date('2026-07-14T00:00:00Z'),
    earnedPoints: 10, deleted: false, isTestData: false,
  });
  await Submission.create({
    employee: emp._id, template: _oid(), submitted: true,
    date: new Date('2026-07-15T00:00:00Z'),
    earnedPoints: 20, deleted: false, isTestData: false,
  });
  const v3 = await strategies.compute({
    strategy: 'last_n_avg', config: { N: 7 },
    employee: emp, day,
  });
  assert.strictEqual(v3, 15, 'last_n_avg averages recent submissions');

  console.log('  ok  strategies: chain + last_n_avg computation');
})
// ---------------------------------------------------------------
// Test 3 -- ledgerService append + runningBalance
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = _oid();
  const day = new Date('2026-07-17T00:00:00Z');
  const r1 = await ledgerService.append({
    ledger: 'financial', employee: emp, date: day,
    direction: -1, quantity: 200, type: 'action',
  });
  assert.strictEqual(r1.runningBalance, -200);
  const r2 = await ledgerService.append({
    ledger: 'financial', employee: emp, date: day,
    direction: -1, quantity: 100, type: 'action',
  });
  assert.strictEqual(r2.runningBalance, -300, 'accumulates');
  const r3 = await ledgerService.append({
    ledger: 'financial', employee: emp, date: day,
    direction: +1, quantity: 50, type: 'waiver',
  });
  assert.strictEqual(r3.runningBalance, -250, 'positive reverses');
  const bal = await ledgerService.balance({ ledger: 'financial', employee: emp });
  assert.strictEqual(bal, -250);
  console.log('  ok  ledgerService: append-only + runningBalance');
})
// ---------------------------------------------------------------
// Test 4 -- actionEngine.apply persists effect + ledger rows
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const ruleActionId = _oid();
  const rule = await ComplianceRule.create({
    code: 'test_rule', name: 'x', category: 'submission',
    detector: 'built_in.missed_submission',
    enabled: true, severity: 'medium', version: 1,
    trigger: {}, scope: {},
    actions: [{
      _id: ruleActionId, type: 'financial_fine', enabled: true,
      config: { amount: 250 },
    }],
    notifications: {}, recovery: {}, waiver: {},
  });
  const inc = await ComplianceIncident.create({
    ruleId: rule._id, ruleVersion: rule.version, ruleCode: rule.code,
    employee: _oid(), severity: 'medium',
    incidentDate:  new Date('2026-07-16T00:00:00Z'),
    effectiveDate: new Date('2026-07-17T00:00:00Z'),
    status: 'active',
    naturalKey: 'test_rule|X|2026-07-16|Y',
    context: {}, source: 'automatic',
  });
  const r = await actionEngine.apply({ incident: inc });
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.effects.length, 1);
  const effRow = _stub.rows(ComplianceActionEffect)[0];
  assert.strictEqual(effRow.amount, 250);
  assert.strictEqual(effRow.actionType, 'financial_fine');
  const finRow = _stub.rows(FinancialLedger)[0];
  assert.strictEqual(finRow.quantity, 250);
  assert.strictEqual(finRow.runningBalance, -250);
  console.log('  ok  actionEngine: persists effect + ledger row');

  // Re-run: idempotent via unique index.
  const r2 = await actionEngine.apply({ incident: inc });
  assert.strictEqual(r2.errors.length, 0);
  assert.strictEqual(r2.effects.length, 1);
  assert.strictEqual(r2.effects[0].created, false, 'second apply -> created:false');
  const finRows = _stub.rows(FinancialLedger);
  assert.strictEqual(finRows.length, 1, 'no duplicate ledger row on re-apply');
  console.log('  ok  actionEngine: idempotent re-apply');
})
// ---------------------------------------------------------------
// Test 5 -- performance_lock BC shim writes Penalty
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  featureFlags._resetForTest();  // ensure compliance.dualWrite = off (default)

  const ruleActionId = _oid();
  const rule = await ComplianceRule.create({
    code: 'perf_test', name: 'x', category: 'submission',
    detector: 'built_in.performance_lock', enabled: true, severity: 'high', version: 1,
    trigger: {}, scope: {},
    actions: [{ _id: ruleActionId, type: 'performance_lock', enabled: true, config: {} }],
    notifications: {}, recovery: {}, waiver: {},
  });
  const inc = await ComplianceIncident.create({
    ruleId: rule._id, ruleVersion: 1, ruleCode: 'perf_test',
    employee: _oid(), severity: 'high',
    incidentDate: new Date('2026-07-16T00:00:00Z'),
    effectiveDate: new Date('2026-07-17T00:00:00Z'),
    status: 'active', naturalKey: 'perf_test|X|2026-07-16', context: {},
    detectorMeta: { oldest: { taskTitle: 'overdue' } },
    source: 'automatic',
  });
  const r = await actionEngine.apply({ incident: inc });
  assert.strictEqual(r.errors.length, 0);
  const legacyRows = _stub.rows(Penalty).filter((p) => p.category === 'performance_lock');
  assert.strictEqual(legacyRows.length, 1, 'BC shim wrote a Penalty row');
  assert.strictEqual(String(legacyRows[0].incidentId), String(inc._id),
    'Penalty carries back-reference to incident');
  console.log('  ok  actionEngine: performance_lock BC shim writes Penalty');

  // Now flip dualWrite on -- next apply should NOT mirror-write.
  process.env.COMPLIANCE_DUAL_WRITE = 'true';
  featureFlags._resetForTest();
  const inc2 = await ComplianceIncident.create({
    ruleId: rule._id, ruleVersion: 1, ruleCode: 'perf_test',
    employee: _oid(), severity: 'high',
    incidentDate: new Date('2026-07-18T00:00:00Z'),
    effectiveDate: new Date('2026-07-19T00:00:00Z'),
    status: 'active', naturalKey: 'perf_test|X|2026-07-18', context: {},
    detectorMeta: { oldest: { taskTitle: 'overdue' } },
    source: 'automatic',
  });
  await actionEngine.apply({ incident: inc2 });
  const legacyRows2 = _stub.rows(Penalty).filter((p) => p.category === 'performance_lock');
  assert.strictEqual(legacyRows2.length, 1, 'dualWrite on -> no new Penalty mirror');
  console.log('  ok  actionEngine: dualWrite flag turns off Penalty mirror');
  delete process.env.COMPLIANCE_DUAL_WRITE;
  featureFlags._resetForTest();
})
// ---------------------------------------------------------------
// Test 6 -- disabled actions are skipped
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const rule = await ComplianceRule.create({
    code: 'disabled_action', name: 'x', category: 'submission',
    detector: 'built_in.missed_submission', enabled: true, severity: 'medium', version: 1,
    trigger: {}, scope: {},
    actions: [
      { _id: _oid(), type: 'financial_fine', enabled: false, config: { amount: 999 } },
      { _id: _oid(), type: 'warning', enabled: true, config: {} },
    ],
    notifications: {}, recovery: {}, waiver: {},
  });
  const inc = await ComplianceIncident.create({
    ruleId: rule._id, ruleVersion: 1, ruleCode: 'disabled_action',
    employee: _oid(), severity: 'medium',
    incidentDate: new Date('2026-07-16T00:00:00Z'),
    effectiveDate: new Date('2026-07-17T00:00:00Z'),
    status: 'active', naturalKey: 'disabled_action|X|2026-07-16', context: {},
    source: 'automatic',
  });
  const r = await actionEngine.apply({ incident: inc });
  assert.strictEqual(r.effects.length, 1, 'only enabled action ran');
  assert.strictEqual(r.effects[0].effect.actionType, 'warning');
  const finRows = _stub.rows(FinancialLedger);
  assert.strictEqual(finRows.length, 0);
  console.log('  ok  actionEngine: disabled actions skipped');
})
.then(() => {
  _stub.restore();
  console.log('\nphase5: all unit tests passed');
})
.catch((e) => {
  console.error('phase5 test crashed:', e && e.stack || e);
  _stub.restore();
  process.exit(1);
});
