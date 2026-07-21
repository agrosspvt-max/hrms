/**
 * batch1.test.js -- regression suite for the six Batch-1 correctness
 * fixes.  Uses the shared stub-mongo harness so the whole suite
 * runs without a live DB.
 *
 *   #6 -- performance_lock recurring
 *   #4 -- fresh-hire marks fallback
 *   #1 -- IncidentService auto-resolution wiring
 *   #3 -- legacy Penalty synchronization on waiver + recovery
 *   #5 -- notification executor dispatches real notifications
 *   #2 -- critical-task lookup via Template (Option A)
 *
 *   cd backend && node services/compliance/__tests__/batch1.test.js
 */

process.env.NODE_ENV = 'test';
process.env.MISSED_SUBMISSION_EFFECTIVE_FROM = '2020-01-01';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

// Bring the models in first so the stub can install onto them.
const User                    = require('../../../models/User');
const Submission              = require('../../../models/Submission');
const Attendance              = require('../../../models/Attendance');
const DependencyTask          = require('../../../models/DependencyTask');
const Template                = require('../../../models/Template');
const Penalty                 = require('../../../models/Penalty');
const Notification            = require('../../../models/Notification');
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
_stub.install(Penalty);
_stub.install(Notification);
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
const ruleSeed = require('../rules/ruleSeed');
const executors = require('../actions/executors');
const strategies = require('../marks/strategies');
const notifyCompliance = require('../notifications/notifyCompliance');
const critical = require('../critical');
const actionEngine = compliance.actionEngine;
const incidentService = compliance.incidentService;
const waiverService = compliance.waiverService;
const recoveryService = compliance.recoveryService;
const penaltyEngine = require('../../penaltyEngine');
const featureFlags = require('../../../config/featureFlags');

const _mkEmp = async (over = {}) => await User.create({
  name: 'Emp', employeeId: 'AMI-B1', email: 'e@x', password: 'x',
  role: 'employee', status: 'active', attendanceMode: 'submission_based',
  department: _oid(), weeklyOff: [0], ...over,
});

// ---------------------------------------------------------------
// #6 -- performance_lock recurring
// ---------------------------------------------------------------
(async () => {
  _stub.reset();
  critical.clearCache();
  process.env.COMPLIANCE_RULES = 'true';
  featureFlags._resetForTest();

  const r = await ruleSeed.run();
  assert.strictEqual(r.total, 7, 'seed spec unchanged');
  const rule = _stub.rows(ComplianceRule).find((x) => x.code === 'performance_lock_v2');
  assert.ok(rule, 'performance_lock_v2 seeded');
  const lockAction = rule.actions.find((a) => a.type === 'performance_lock');
  assert.strictEqual(lockAction.config.recurring, true,
    'seeded performance_lock action carries recurring:true');
  assert.strictEqual(lockAction.config.recurringCadence, 'daily');
  assert.strictEqual(actionEngine.hasRecurring(rule), true,
    'hasRecurring returns true for the seeded rule');
  console.log('  ok  #6: performance_lock is recurring in the seed');

  // Patcher idempotency: mutate the rule back to non-recurring, run
  // the patcher, verify it fixes the config, and running again does
  // nothing.
  lockAction.config = {};
  const patchedFirst = await ruleSeed.run();
  assert.strictEqual(patchedFirst.patched >= 1, true, 'patcher fires once');
  const patchedAgain = await ruleSeed.run();
  assert.strictEqual(patchedAgain.patched, 0, 'patcher is idempotent');
  console.log('  ok  #6: patcher restores recurring flag on existing rules');
  delete process.env.COMPLIANCE_RULES;
  featureFlags._resetForTest();
})()

// ---------------------------------------------------------------
// #4 -- fresh-hire marks fallback
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  critical.clearCache();
  strategies.registerAll();

  // Fresh employee with NO submission history.  Strategy chain
  // used to return 0; after the patch it falls through to
  // adminDefined and returns 5.
  const emp = { _id: _oid(), department: _oid() };
  const day = new Date('2026-07-16T00:00:00Z');
  const v = await strategies.compute({
    strategy: 'last_n_avg',
    config: { N: 7, marks: 5 },      // seeded config carries the floor
    employee: emp, day,
  });
  assert.strictEqual(v, 5, 'fresh-hire chain resolves to 5');
  console.log('  ok  #4: strategy chain returns fresh-hire floor');

  // Employee with real history overrides the floor.
  await Submission.create({ employee: emp._id, template: _oid(),
    submitted: true, date: new Date('2026-07-15T00:00:00Z'),
    earnedPoints: 12, deleted: false, isTestData: false });
  const v2 = await strategies.compute({
    strategy: 'last_n_avg',
    config: { N: 7, marks: 5 },
    employee: emp, day,
  });
  assert.strictEqual(v2, 12, 'last_n_avg wins over floor when history exists');
  console.log('  ok  #4: history overrides the fresh-hire floor');
})

// ---------------------------------------------------------------
// #1 -- IncidentService auto-resolution wiring
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  critical.clearCache();
  process.env.COMPLIANCE_NEW_ENGINE = 'true';
  featureFlags._resetForTest();

  const empId = _oid();
  const subId = _oid();
  const rule = await ComplianceRule.create({
    code: 'missed_submission_v2', name: 'x', category: 'submission',
    detector: 'built_in.missed_submission', enabled: true,
    severity: 'medium', version: 1,
    trigger: {}, scope: {}, actions: [],
    notifications: {}, recovery: {}, waiver: {},
  });
  await ComplianceIncident.create({
    ruleId: rule._id, ruleVersion: 1, ruleCode: 'missed_submission_v2',
    employee: empId, severity: 'medium',
    incidentDate: new Date('2026-07-16T00:00:00Z'),
    effectiveDate: new Date('2026-07-17T00:00:00Z'),
    status: 'active', naturalKey: 'nk-1', source: 'automatic',
    context: { submissionId: subId },
  });

  await penaltyEngine.resolveAbsentSubmissionOnSubmit({ submissionId: subId });
  const inc = _stub.rows(ComplianceIncident)[0];
  assert.strictEqual(inc.status, 'resolved',
    'v2 incident resolved when legacy submit hook fires');
  console.log('  ok  #1: resolveAbsentSubmissionOnSubmit resolves v2 incident');

  // Dependency auto-resolve
  _stub.reset();
  const rule2 = await ComplianceRule.create({
    code: 'dependency_pending_v2', name: 'x', category: 'dependency',
    detector: 'built_in.dependency_pending', enabled: true,
    severity: 'medium', version: 1,
    trigger: {}, scope: {}, actions: [],
    notifications: {}, recovery: {}, waiver: {},
  });
  const empId2 = _oid();
  await ComplianceIncident.create({
    ruleId: rule2._id, ruleVersion: 1, ruleCode: 'dependency_pending_v2',
    employee: empId2, severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'nk-dep', source: 'automatic', context: {},
  });
  // Zero open deps -- onDependencyResolved should resolve incident.
  await penaltyEngine.onDependencyResolved({ employeeId: empId2, dependencyId: _oid() });
  const depInc = _stub.rows(ComplianceIncident).find((i) => i.employee === empId2);
  assert.strictEqual(depInc.status, 'resolved',
    'v2 dependency incident resolved when last dep clears');
  console.log('  ok  #1: onDependencyResolved resolves v2 incident');

  // Performance lock auto-resolve
  _stub.reset();
  const rule3 = await ComplianceRule.create({
    code: 'performance_lock_v2', name: 'x', category: 'submission',
    detector: 'built_in.performance_lock', enabled: true,
    severity: 'high', version: 1,
    trigger: {}, scope: {}, actions: [],
    notifications: {}, recovery: {}, waiver: {},
  });
  const empId3 = _oid();
  await ComplianceIncident.create({
    ruleId: rule3._id, ruleVersion: 1, ruleCode: 'performance_lock_v2',
    employee: empId3, severity: 'high',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'nk-lock', source: 'automatic', context: {},
  });
  // No overdue tasks -- onPendingTaskResolved should resolve incident.
  await penaltyEngine.onPendingTaskResolved({ employeeId: empId3, day: new Date() });
  const lockInc = _stub.rows(ComplianceIncident).find((i) => i.employee === empId3);
  assert.strictEqual(lockInc.status, 'resolved',
    'v2 performance_lock incident resolved when overdue cleared');
  console.log('  ok  #1: onPendingTaskResolved resolves v2 incident');

  // Flag OFF -> hooks are no-ops.
  delete process.env.COMPLIANCE_NEW_ENGINE;
  featureFlags._resetForTest();
  _stub.reset();
  await ComplianceRule.create({
    code: 'missed_submission_v2', name: 'x', category: 'submission',
    detector: 'built_in.missed_submission', enabled: true,
    severity: 'medium', version: 1,
    trigger: {}, scope: {}, actions: [],
    notifications: {}, recovery: {}, waiver: {},
  });
  const subId2 = _oid();
  await ComplianceIncident.create({
    ruleId: _oid(), ruleVersion: 1, ruleCode: 'missed_submission_v2',
    employee: _oid(), severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'nk-off', source: 'automatic',
    context: { submissionId: subId2 },
  });
  await penaltyEngine.resolveAbsentSubmissionOnSubmit({ submissionId: subId2 });
  const incOff = _stub.rows(ComplianceIncident).find((i) => i.context.submissionId === subId2);
  assert.strictEqual(incOff.status, 'active',
    'flag off -> v2 incident untouched (BC preserved)');
  console.log('  ok  #1: flag OFF preserves backward compatibility');
})

// ---------------------------------------------------------------
// #3 -- Legacy Penalty synchronization on waiver + recovery
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  critical.clearCache();
  featureFlags._resetForTest();

  const empId = _oid();
  const rule = await ComplianceRule.create({
    code: 'r_sync', name: 'x', category: 'submission',
    detector: 'built_in.missed_submission', enabled: true,
    severity: 'medium', version: 1,
    trigger: {}, scope: {},
    actions: [{ _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 100 } }],
    notifications: {}, recovery: { allowed: true }, waiver: { allowed: true, partialAllowed: true },
  });
  const inc = await ComplianceIncident.create({
    ruleId: rule._id, ruleVersion: 1, ruleCode: 'r_sync',
    employee: empId, severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'sync-nk', source: 'automatic',
    context: {},
  });
  // Create an effect + a mirror Penalty by hand (mirrors what
  // actionEngine.performance_lock BC shim writes).
  const penId = _oid();
  await Penalty.create({
    _id: penId, employee: empId, category: 'performance_lock',
    source: 'automatic', probable: false, status: 'active',
    penaltyMarks: 0, targetDate: new Date(),
    incidentId: inc._id,
  });
  const effId = _oid();
  await ComplianceActionEffect.create({
    _id: effId, incidentId: inc._id, ruleId: rule._id,
    ruleActionId: rule.actions[0]._id, actionType: 'financial_fine',
    employee: empId, status: 'active',
    effectiveDate: new Date(), amount: 100, penaltyId: penId,
  });

  // Waive -> Penalty should flip to cancelled.
  const w = await waiverService.request({
    incidentId: inc._id, scope: 'partial', effectIds: [effId],
    reason: 'sync test', requestedBy: empId,
  });
  await waiverService.decide({
    waiverId: w._id, decision: 'approved', decidedBy: _oid(),
  });
  const pen = _stub.rows(Penalty).find((p) => String(p._id) === String(penId));
  assert.strictEqual(pen.status, 'cancelled',
    'waiver approval cancels mirrored Penalty');
  console.log('  ok  #3: waiver approval cancels mirrored Penalty');

  // Recovery -> Penalty should flip to resolved.
  _stub.reset();
  const rule2 = await ComplianceRule.create({
    code: 'r_recover_sync', name: 'x', category: 'submission',
    detector: 'built_in.missed_submission', enabled: true,
    severity: 'medium', version: 1,
    trigger: {}, scope: {},
    actions: [{ _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 50 } }],
    notifications: {}, recovery: { allowed: true }, waiver: {},
  });
  const inc2 = await ComplianceIncident.create({
    ruleId: rule2._id, ruleVersion: 1, ruleCode: 'r_recover_sync',
    employee: empId, severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'rec-nk', source: 'automatic',
    context: {},
  });
  const penId2 = _oid();
  await Penalty.create({
    _id: penId2, employee: empId, category: 'performance_lock',
    source: 'automatic', probable: false, status: 'active',
    penaltyMarks: 0, targetDate: new Date(), incidentId: inc2._id,
  });
  const effId2 = _oid();
  await ComplianceActionEffect.create({
    _id: effId2, incidentId: inc2._id, ruleId: rule2._id,
    ruleActionId: rule2.actions[0]._id, actionType: 'financial_fine',
    employee: empId, status: 'active',
    effectiveDate: new Date(), amount: 50, penaltyId: penId2,
  });
  await recoveryService.apply({
    incidentId: inc2._id, mode: 'restore', reason: 'sync test', actor: _oid(),
  });
  const pen2 = _stub.rows(Penalty).find((p) => String(p._id) === String(penId2));
  assert.strictEqual(pen2.status, 'resolved',
    'recovery flips mirrored Penalty to resolved');
  console.log('  ok  #3: recovery apply resolves mirrored Penalty');
})

// ---------------------------------------------------------------
// #5 -- Notification executor + helper
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  critical.clearCache();
  // Spy on the underlying notify.notifyPenalty
  const notifyEvents = require('../../notifyEvents');
  const calls = [];
  const orig = notifyEvents.notifyPenalty;
  notifyEvents.notifyPenalty = (args) => { calls.push(args); };

  const executorOut = await executors._ALL.notification({
    rule: { code: 'r_note', name: 'Note Rule' },
    actionConfig: { config: { template: 'Custom notification body' } },
    incident: { employee: _oid(), ruleCode: 'r_note',
      effectiveDate: new Date('2026-07-17T00:00:00Z') },
  });
  assert.strictEqual(executorOut.notifications.length, 1);
  assert.strictEqual(executorOut.notifications[0].message, 'Custom notification body');
  assert.strictEqual(executorOut.notifications[0].audience, 'employee');
  console.log('  ok  #5: notification executor returns notifications intent');

  // End-to-end: engine dispatches notifications after commit.
  const empId = _oid();
  const rule = await ComplianceRule.create({
    code: 'note_rule_v2', name: 'Note', category: 'submission',
    detector: 'built_in.missed_submission', enabled: true,
    severity: 'medium', version: 1,
    trigger: {}, scope: {},
    actions: [{ _id: _oid(), type: 'notification', enabled: true, config: { template: 'You got a notification' } }],
    notifications: {}, recovery: {}, waiver: {},
  });
  const inc = await ComplianceIncident.create({
    ruleId: rule._id, ruleVersion: 1, ruleCode: 'note_rule_v2',
    employee: empId, severity: 'medium',
    incidentDate: new Date('2026-07-16T00:00:00Z'),
    effectiveDate: new Date('2026-07-17T00:00:00Z'),
    status: 'active', naturalKey: 'note-nk', source: 'automatic',
    context: {},
  });
  const before = calls.length;
  await actionEngine.apply({ incident: inc });
  assert.ok(calls.length > before, 'engine fires notifyPenalty via helper');
  const last = calls[calls.length - 1];
  assert.strictEqual(String(last.employeeId), String(empId));
  assert.strictEqual(last.penalty.category, 'note_rule_v2');
  assert.strictEqual(last.penalty.employeeMessage, 'You got a notification');
  assert.ok(last.penalty.targetDate, 'adapter fills targetDate');
  assert.strictEqual(last.penalty.probable, false);
  console.log('  ok  #5: engine dispatches notification with correct adapter shape');

  notifyEvents.notifyPenalty = orig;
})

// ---------------------------------------------------------------
// #2 -- Critical-task lookup via Template (Option A)
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  critical.clearCache();

  // Template with a critical customField.
  const tplId = _oid();
  await Template.create({
    _id: tplId, title: 'Crit', templateType: 'custom',
    customFields: [
      { key: 'a', label: 'A', fieldType: 'text', isCritical: false },
      { key: 'b', label: 'B', fieldType: 'text', isCritical: true },
    ],
  });
  const t1 = await critical.resolveCriticalByTemplateId(tplId);
  assert.strictEqual(t1, true, 'Template with any isCritical=true resolves true');

  // Non-critical template.
  const tplId2 = _oid();
  await Template.create({
    _id: tplId2, title: 'Plain', templateType: 'custom',
    customFields: [{ key: 'c', label: 'C', fieldType: 'text', isCritical: false }],
  });
  const t2 = await critical.resolveCriticalByTemplateId(tplId2);
  assert.strictEqual(t2, false, 'Template with no critical field resolves false');

  // Missing template id -> false (fail-closed).
  const t3 = await critical.resolveCriticalByTemplateId(_oid());
  assert.strictEqual(t3, false, 'Missing template fails closed');

  console.log('  ok  #2: critical.resolveCriticalByTemplateId honours Template.customFields');

  // Detector plumbs criticalTask via the template lookup.
  const missedDetector = require('../detectors/missedSubmissionDetector');
  _stub.reset();
  critical.clearCache();
  const emp = await _mkEmp();
  const rule = { code: 'missed_submission_v2', trigger: {} };
  const workDay = new Date('2026-07-16T00:00:00Z');
  await Attendance.create({ employee: emp._id, date: workDay, status: 'present' });
  const tplCrit = _oid();
  await Template.create({
    _id: tplCrit, title: 'CritTpl', templateType: 'custom',
    customFields: [{ key: 'x', label: 'X', fieldType: 'text', isCritical: true }],
  });
  await Submission.create({
    employee: emp._id, template: tplCrit, templateType: 'custom',
    date: workDay, submitted: false, deleted: false, isTestData: false,
  });
  const cands = await missedDetector.detect({
    rule, employee: emp, day: new Date('2026-07-17T00:00:00Z'),
  });
  assert.strictEqual(cands.length, 1);
  assert.strictEqual(cands[0].detectorMeta.criticalTask, true,
    'missed detector stamps criticalTask via Template');
  console.log('  ok  #2: missedSubmissionDetector stamps criticalTask via Template lookup');
})

.then(() => {
  _stub.restore();
  console.log('\nbatch1: all regression tests passed');
})
.catch((e) => {
  console.error('batch1 test crashed:', e && e.stack || e);
  _stub.restore();
  process.exit(1);
});
