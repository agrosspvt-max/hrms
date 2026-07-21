/**
 * manualIncident.test.js -- regression suite for the manual-incident
 * workflow added by the CreateIncidentModal + attendance integration.
 *
 * Covers:
 *   - executor override precedence (marks / percent / amount)
 *   - HR override wins over rule default
 *   - Falls back to rule default when override is absent
 *   - Automatic rules (no override) behave exactly as before
 *   - controllers/compliance/incidentController.create round-trips
 *     the override into the ComplianceIncident.detectorMeta.hrOverride
 *     path so the executor sees it on apply
 *
 *   cd backend && node services/compliance/__tests__/manualIncident.test.js
 */

process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';
process.env.COMPLIANCE_RULES = 'true';
process.env.COMPLIANCE_NEW_ENGINE = 'true';
process.env.COMPLIANCE_ACTION_ENGINE = 'true';

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
const featureFlags = require('../../../config/featureFlags');
featureFlags._resetForTest();

const _seedManualRule = async ({ code, actionType, config }) => {
  return ComplianceRule.create({
    code, name: code, category: 'conduct',
    detector: 'manual', enabled: true, severity: 'medium', version: 1,
    trigger: { evaluationDelayDays: 0 }, scope: {},
    actions: [{ _id: _oid(), type: actionType, enabled: true, config }],
    notifications: {}, recovery: {}, waiver: {},
  });
};

(async () => {
  // ==========================================================
  // 1. Financial Fine: HR override wins over rule default
  // ==========================================================
  _stub.reset();
  const empId = _oid();
  const ruleFin = await _seedManualRule({
    code: 'financial_penalty_v2',
    actionType: 'financial_fine',
    config: { amount: 500 },
  });
  const incFin = await ComplianceIncident.create({
    ruleId: ruleFin._id, ruleVersion: 1, ruleCode: ruleFin.code,
    employee: empId, severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'nk_fin_hr', source: 'manual',
    context: {},
    detectorMeta: { source: 'hr_manual', reason: 'test', hrOverride: { amount: 300 } },
  });
  const outFin = await compliance.actionEngine.apply({ incident: incFin });
  assert.deepStrictEqual(outFin.errors, []);
  const finLedger = _stub.rows(FinancialLedger);
  assert.strictEqual(finLedger.length, 1, 'one financial ledger row');
  assert.strictEqual(finLedger[0].quantity, 300,
    'HR override 300 wins over rule default 500');
  console.log('  ok  financial_fine: HR override (300) wins over rule default (500)');

  // ==========================================================
  // 2. Financial Fine: no override -> uses rule default
  // ==========================================================
  _stub.reset();
  const ruleFin2 = await _seedManualRule({
    code: 'financial_penalty_v2', actionType: 'financial_fine',
    config: { amount: 500 },
  });
  const incFin2 = await ComplianceIncident.create({
    ruleId: ruleFin2._id, ruleVersion: 1, ruleCode: ruleFin2.code,
    employee: empId, severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'nk_fin_default', source: 'manual',
    context: {},
    detectorMeta: { source: 'hr_manual', reason: 'test' },   // no hrOverride
  });
  await compliance.actionEngine.apply({ incident: incFin2 });
  const finLedger2 = _stub.rows(FinancialLedger);
  assert.strictEqual(finLedger2[0].quantity, 500,
    'no override -> falls back to rule default (500)');
  console.log('  ok  financial_fine: no HR override -> uses rule default (500)');

  // ==========================================================
  // 3. Manual marks: override precedence
  // ==========================================================
  _stub.reset();
  const ruleMarks = await _seedManualRule({
    code: 'manual_marks_v2', actionType: 'fixed_marks_reduction',
    config: { marks: 5 },
  });
  const incMarks = await ComplianceIncident.create({
    ruleId: ruleMarks._id, ruleVersion: 1, ruleCode: ruleMarks.code,
    employee: empId, severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'nk_m', source: 'manual',
    context: {},
    detectorMeta: { source: 'hr_manual', hrOverride: { marks: 8 } },
  });
  await compliance.actionEngine.apply({ incident: incMarks });
  const marksLedger = _stub.rows(MarksLedger);
  assert.strictEqual(marksLedger[0].quantity, 8, 'HR override 8 wins over rule default 5');
  console.log('  ok  fixed_marks_reduction: HR override (8) wins over rule default (5)');

  // ==========================================================
  // 4. Completion adjustment: override precedence
  // ==========================================================
  _stub.reset();
  const rulePct = await _seedManualRule({
    code: 'completion_adjustment_v2', actionType: 'percent_reduction',
    config: { percent: 10 },
  });
  const incPct = await ComplianceIncident.create({
    ruleId: rulePct._id, ruleVersion: 1, ruleCode: rulePct.code,
    employee: empId, severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'nk_p', source: 'manual',
    context: {},
    detectorMeta: { source: 'hr_manual', hrOverride: { percent: 25 } },
  });
  await compliance.actionEngine.apply({ incident: incPct });
  const pctLedger = _stub.rows(PercentageLedger);
  assert.strictEqual(pctLedger[0].quantity, 25, 'HR override 25 wins over rule default 10');
  console.log('  ok  percent_reduction: HR override (25) wins over rule default (10)');

  // ==========================================================
  // 5. Automatic rule -- no hrOverride populated -> unchanged
  //    behaviour.  This proves the change is backward compatible
  //    for the daily scheduler tick.
  // ==========================================================
  _stub.reset();
  const ruleAuto = await ComplianceRule.create({
    code: 'auto_dep', name: 'x', category: 'dependency',
    detector: 'built_in.dependency_pending', enabled: true,
    severity: 'medium', version: 1,
    trigger: { evaluationDelayDays: 0, thresholdDays: 3 }, scope: {},
    actions: [{ _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 200 } }],
    notifications: {}, recovery: {}, waiver: {},
  });
  const incAuto = await ComplianceIncident.create({
    ruleId: ruleAuto._id, ruleVersion: 1, ruleCode: ruleAuto.code,
    employee: empId, severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'nk_auto', source: 'automatic',
    context: {},
    // NO detectorMeta.hrOverride -- automatic detectors never write this.
  });
  await compliance.actionEngine.apply({ incident: incAuto });
  const autoLedger = _stub.rows(FinancialLedger);
  assert.strictEqual(autoLedger[0].quantity, 200,
    'automatic incident falls back to rule config (200); override path is opt-in');
  console.log('  ok  automatic rules unchanged: no hrOverride -> rule config wins');

  // ==========================================================
  // 6. incidentController.create end-to-end wiring:
  //    the payload the CreateIncidentModal sends round-trips
  //    into a ComplianceIncident.detectorMeta.hrOverride that
  //    the executor will observe on the next apply().
  // ==========================================================
  _stub.reset();
  const ruleE2E = await _seedManualRule({
    code: 'financial_penalty_v2', actionType: 'financial_fine',
    config: { amount: 500 },
  });
  const incidentController = require('../../../controllers/compliance/incidentController');
  const req = {
    user: { _id: _oid(), role: 'hr' },
    body: {
      ruleCode: 'financial_penalty_v2',
      employee: String(empId),
      incidentDate: new Date().toISOString(),
      severity: 'high',
      context: { workDate: new Date().toISOString() },
      detectorMeta: {
        source: 'hr_manual',
        reason: 'Damaged equipment',
        hrOverride: { amount: 750 },
      },
    },
  };
  let statusCode = 200;
  let respBody = null;
  const res = {
    status: (c) => { statusCode = c; return res; },
    json: (b) => { respBody = b; return res; },
  };
  await incidentController.create(req, res, (e) => { if (e) throw e; });
  assert.strictEqual(statusCode, 201, 'controller returns 201 on manual create');
  assert.ok(respBody && respBody._id, 'controller returns the created incident');
  assert.strictEqual(respBody.source, 'manual', 'source is manual');
  assert.deepStrictEqual(respBody.detectorMeta.hrOverride, { amount: 750 },
    'controller round-trips the HR override onto the incident');

  // Now promote + apply.  Executor should use the override.
  const promoted = await compliance.incidentService.promoteToActive(respBody._id, { now: new Date() });
  assert.ok(promoted, 'incident promoted to active');
  await compliance.actionEngine.apply({ incident: promoted });
  const finLedgerE2E = _stub.rows(FinancialLedger);
  assert.strictEqual(finLedgerE2E[0].quantity, 750,
    'end-to-end: modal payload -> controller -> incident -> executor uses 750');
  console.log('  ok  end-to-end: modal payload flows through controller to executor override');

  _stub.restore();
  console.log('\nmanualIncident: all regression tests passed');
})()
.catch((e) => {
  console.error('manualIncident test crashed:', e && e.stack || e);
  _stub.restore();
  process.exit(1);
});
