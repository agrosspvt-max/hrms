/**
 * stabilization.test.js -- regression tests for the Priority-1
 * critical bugs found in the production readiness review.
 *
 *   C1 -- recurring-only apply
 *   C3 -- atomic promoteToActive
 *   C5 -- departmentAvg wires through employee.department fallback
 *   C6 -- criticalTask flag is stamped by detectors
 *   C7 -- detector loop preloads employees + parallel fan-out
 *
 *   cd backend && node services/compliance/__tests__/stabilization.test.js
 */

process.env.NODE_ENV = 'test';
process.env.MISSED_SUBMISSION_EFFECTIVE_FROM = '2020-01-01';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User = require('../../../models/User');
const Submission = require('../../../models/Submission');
const Attendance = require('../../../models/Attendance');
const DependencyTask = require('../../../models/DependencyTask');
const Template = require('../../../models/Template');
const Penalty = require('../../../models/Penalty');
const ComplianceRule = require('../../../models/ComplianceRule');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const ComplianceEvent = require('../../../models/ComplianceEvent');
const MarksLedger = require('../../../models/MarksLedger');
const FinancialLedger = require('../../../models/FinancialLedger');
const PercentageLedger = require('../../../models/PercentageLedger');
const AttendanceLedger = require('../../../models/AttendanceLedger');
const AuditLog = require('../../../models/AuditLog');

_stub.install(User);
_stub.install(Submission);
_stub.install(Attendance);
_stub.install(DependencyTask);
_stub.install(Template);
_stub.install(Penalty);
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

const compliance = require('../../compliance');
const incidentService = compliance.incidentService;
const actionEngine = compliance.actionEngine;
const strategies = require('../marks/strategies');
const missedDetector = require('../detectors/missedSubmissionDetector');
const dependencyDetector = require('../detectors/dependencyDetector');
const lockDetector = require('../detectors/performanceLockDetector');

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
const _seedRule = async (over = {}) => await ComplianceRule.create({
  code: over.code || 'r_seed',
  name: 'r', category: 'submission',
  detector: over.detector || 'built_in.missed_submission',
  enabled: true, severity: 'medium', version: 1,
  trigger: over.trigger || {},
  scope: {},
  actions: over.actions || [],
  notifications: {}, recovery: {}, waiver: {},
});

const _seedIncident = async (rule, over = {}) => await ComplianceIncident.create({
  ruleId: rule._id, ruleVersion: rule.version, ruleCode: rule.code,
  employee: over.employee || _oid(), severity: 'medium',
  incidentDate: over.incidentDate || new Date('2026-07-16T00:00:00Z'),
  effectiveDate: over.effectiveDate || new Date('2026-07-17T00:00:00Z'),
  status: over.status || 'active',
  naturalKey: over.naturalKey || `nk-${_oid()}`,
  context: over.context || {}, source: 'automatic',
  detectorMeta: over.detectorMeta || {},
});

// ---------------------------------------------------------------
// C1 -- recurring-only apply
// ---------------------------------------------------------------
(async () => {
  _stub.reset();
  const raidOneShot   = _oid();
  const raidRecurring = _oid();
  const rule = await _seedRule({
    code: 'c1_test',
    actions: [
      { _id: raidOneShot,   type: 'zero_daily_marks', enabled: true,
        config: { marksStrategy: 'admin_defined', marks: 10 /* no recurring flag */ } },
      { _id: raidRecurring, type: 'financial_fine',   enabled: true,
        config: { amount: 200, recurring: true } },
    ],
  });
  const inc = await _seedIncident(rule);

  // Day 1: full apply -- both fire.
  const day1 = await actionEngine.apply({ incident: inc, day: new Date('2026-07-17T00:00:00Z') });
  assert.strictEqual(day1.effects.length, 2, 'day 1: both actions apply');

  // Day 2: recurringOnly -- only recurring fires.
  const day2 = await actionEngine.apply({
    incident: inc, day: new Date('2026-07-18T00:00:00Z'), recurringOnly: true,
  });
  assert.strictEqual(day2.effects.length, 1, 'day 2 recurring-only: only 1 effect');
  assert.strictEqual(day2.effects[0].effect.actionType, 'financial_fine',
    'day 2: only the recurring action fires');

  // Ledger tallies: financial has 2 rows (day 1 + day 2), marks has 1.
  const finRows = _stub.rows(FinancialLedger).filter((r) => r.type === 'action');
  const marksRows = _stub.rows(MarksLedger).filter((r) => r.type === 'action');
  assert.strictEqual(finRows.length, 2, 'financial fired twice (recurring)');
  assert.strictEqual(marksRows.length, 1, 'marks fired ONCE (one-shot)');
  console.log('  ok  C1: recurring-only apply skips one-shot actions on subsequent ticks');
})()

// ---------------------------------------------------------------
// C3 -- promoteToActive is atomic (concurrent callers)
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const rule = await _seedRule({ code: 'c3_test' });
  const inc  = await _seedIncident(rule, { status: 'candidate' });
  // Two concurrent promotion attempts.
  const [a, b] = await Promise.all([
    incidentService.promoteToActive(inc._id, { now: new Date('2026-07-17T00:00:00Z') }),
    incidentService.promoteToActive(inc._id, { now: new Date('2026-07-17T00:00:00Z') }),
  ]);
  // Exactly one non-null result (the winner) + one null (the loser).
  const wins = [a, b].filter(Boolean).length;
  const losses = [a, b].filter((x) => x === null).length;
  assert.strictEqual(wins, 1, 'exactly one promoteToActive returns the doc');
  assert.strictEqual(losses, 1, 'the other returns null');

  // And exactly one incident_effective event was emitted.
  const events = _stub.rows(ComplianceEvent).filter((e) => e.kind === 'incident_effective');
  assert.strictEqual(events.length, 1,
    'exactly one incident_effective event under concurrent promotion');
  console.log('  ok  C3: promoteToActive is atomic under concurrent callers');
})

// ---------------------------------------------------------------
// C5 -- departmentAvg falls back to User lookup when
// employee.department is missing.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const deptId = _oid();
  const empId = _oid();
  await User.create({ _id: empId, name: 'A', employeeId: 'A1', email: 'a', password: 'x',
    role: 'employee', status: 'active', attendanceMode: 'submission_based',
    department: deptId });
  const peerA = _oid();
  await User.create({ _id: peerA, name: 'B', employeeId: 'B1', email: 'b', password: 'x',
    role: 'employee', status: 'active', attendanceMode: 'submission_based',
    department: deptId });
  await Submission.create({ employee: peerA, template: _oid(), submitted: true,
    deleted: false, isTestData: false,
    date: new Date('2026-07-15T00:00:00Z'), earnedPoints: 20 });
  await Submission.create({ employee: peerA, template: _oid(), submitted: true,
    deleted: false, isTestData: false,
    date: new Date('2026-07-14T00:00:00Z'), earnedPoints: 30 });

  // Call the strategy WITHOUT department in the ctx -- previously this
  // returned 0 silently.  Now it should hit User.findById and return 25.
  const v = await strategies.departmentAvg({
    employee: { _id: empId /* NO department */ },
    day: new Date('2026-07-16T00:00:00Z'),
    config: { windowDays: 30 },
  });
  assert.strictEqual(v, 25, 'strategy computed peer avg via User fallback');
  console.log('  ok  C5: departmentAvg falls back to User.department lookup');
})

// ---------------------------------------------------------------
// C5+C6 -- detectors populate context.departmentId +
// detectorMeta.criticalTask
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const deptId = _oid();
  const desigId = _oid();
  const emp = await User.create({
    name: 'x', employeeId: 'X1', email: 'x', password: 'x',
    role: 'employee', status: 'active', attendanceMode: 'submission_based',
    department: deptId, designation: desigId, weeklyOff: [0],
  });
  const rule = await _seedRule({
    code: 'c5_missed', detector: 'built_in.missed_submission',
    trigger: { evaluationDelayDays: 1 },
  });

  const workDay = new Date('2026-07-16T00:00:00Z');
  await Attendance.create({ employee: emp._id, date: workDay, status: 'present' });
  await Submission.create({ employee: emp._id, template: _oid(), templateType: 'task',
    date: workDay, submitted: false, deleted: false, isTestData: false });

  const cands = await missedDetector.detect({
    rule, employee: emp, day: new Date('2026-07-17T00:00:00Z'),
  });
  assert.strictEqual(cands.length, 1);
  assert.strictEqual(String(cands[0].context.departmentId), String(deptId),
    'missed detector populates context.departmentId');
  assert.strictEqual(String(cands[0].context.designationId), String(desigId),
    'missed detector populates context.designationId');
  console.log('  ok  C5: missedSubmissionDetector stamps departmentId + designationId');

  // Dependency detector critical flag.
  //
  // "Critical Task" standardisation: the flag is now per-task.  A
  // DependencyTask is critical IFF its `sourceTaskId` points at a
  // template task (or custom field) whose `isCritical === true`.  A
  // dep without `sourceTaskId` (HR-created / legacy) is never
  // critical -- fail-closed.
  _stub.reset();
  const critical = require('../critical');
  critical.clearCache();
  const depRule = await _seedRule({
    code: 'c6_dep', category: 'dependency',
    detector: 'built_in.dependency_pending',
    trigger: { thresholdDays: 3 },
  });
  const emp2 = await User.create({ name: 'y', employeeId: 'Y1', email: 'y', password: 'x',
    role: 'employee', status: 'active', department: deptId });
  // Snapshot the flag on the submission task so the detector picks it
  // up without an extra template lookup (the primary path).
  const critFieldId = _oid();
  const tplCritDep = _oid();
  await Template.create({
    _id: tplCritDep, title: 'CritDepTpl', templateType: 'custom',
    customFields: [{ _id: critFieldId, key: 'x', label: 'X', fieldType: 'text', isCritical: true }],
  });
  const critTaskSnapshotId = _oid();
  const sourceSub = await Submission.create({
    employee: emp2._id, template: tplCritDep, templateType: 'custom',
    date: new Date('2026-07-12T00:00:00Z'), submitted: false,
    deleted: false, isTestData: false,
    tasks: [{
      _id: critTaskSnapshotId,
      taskId: critFieldId, title: 'X', points: 0,
      isCritical: true, status: 'pending',
    }],
  });
  await DependencyTask.create({
    assignedTo: emp2._id, status: 'pending',
    assignedAt: new Date('2026-07-13T00:00:00Z'),
    sourceSubmissionId: sourceSub._id,
    sourceTaskId: String(critFieldId),
  });
  const depCands = await dependencyDetector.detect({
    rule: depRule, employee: emp2, day: new Date('2026-07-17T00:00:00Z'),
  });
  assert.strictEqual(depCands.length, 1);
  assert.strictEqual(depCands[0].detectorMeta.criticalTask, true,
    'dependencyDetector stamps criticalTask=true when the specific sourceTaskId is flagged');
  console.log('  ok  C6: dependencyDetector stamps criticalTask flag via per-task snapshot');
})

// ---------------------------------------------------------------
// C6 -- financialFine executor honours criticalAmount when
// criticalTask is set.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const executors = require('../actions/executors');
  const rule = await _seedRule({
    code: 'c6_exec',
    actions: [{ _id: _oid(), type: 'financial_fine', enabled: true,
      config: { amount: 200, criticalAmount: 500 } }],
  });
  const inc = await _seedIncident(rule, {
    detectorMeta: { criticalTask: true },
  });
  const out = await executors._ALL.financial_fine({
    rule, actionConfig: rule.actions[0], incident: inc,
  });
  assert.strictEqual(out.effectDoc.amount, 500,
    'critical incident picks criticalAmount');

  const inc2 = await _seedIncident(rule, {
    detectorMeta: { criticalTask: false },
  });
  const out2 = await executors._ALL.financial_fine({
    rule, actionConfig: rule.actions[0], incident: inc2,
  });
  assert.strictEqual(out2.effectDoc.amount, 200,
    'non-critical incident picks base amount');
  console.log('  ok  C6: financialFine.criticalAmount honoured');
})

// ---------------------------------------------------------------
// C7 -- detection loop preloads employees + fans out in parallel
// (functional check: still produces one incident per matching employee)
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  process.env.COMPLIANCE_RULES = 'true';
  process.env.COMPLIANCE_NEW_ENGINE = 'true';
  const featureFlags = require('../../../config/featureFlags');
  featureFlags._resetForTest();

  const rule = await _seedRule({
    code: 'c7_missed', detector: 'built_in.missed_submission',
    trigger: { evaluationDelayDays: 1 },
  });
  const workDay = new Date('2026-07-16T00:00:00Z');
  const empIds = [];
  for (let i = 0; i < 5; i += 1) {
    const e = await User.create({
      name: `emp-${i}`, employeeId: `E${i}`,
      email: `e${i}`, password: 'x', role: 'employee', status: 'active',
      attendanceMode: 'submission_based', department: _oid(), weeklyOff: [0],
    });
    empIds.push(e._id);
    await Attendance.create({ employee: e._id, date: workDay, status: 'present' });
    await Submission.create({ employee: e._id, template: _oid(), templateType: 'task',
      date: workDay, submitted: false, deleted: false, isTestData: false });
  }
  const { tick } = compliance.ruleEvaluationScheduler;
  const r = await tick({ day: new Date('2026-07-17T00:00:00Z') });
  assert.strictEqual(r.detected.candidates, 5, 'one candidate per employee');
  assert.strictEqual(r.detected.created,    5, 'five incidents created');
  assert.strictEqual(r.detected.errors,     0);
  delete process.env.COMPLIANCE_RULES;
  delete process.env.COMPLIANCE_NEW_ENGINE;
  featureFlags._resetForTest();
  console.log('  ok  C7: parallel detection loop processes all employees');
})

.then(() => {
  _stub.restore();
  console.log('\nstabilization: all regression tests passed');
})
.catch((e) => {
  console.error('stabilization test crashed:', e && e.stack || e);
  _stub.restore();
  process.exit(1);
});
