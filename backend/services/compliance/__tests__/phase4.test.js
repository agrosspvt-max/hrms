/**
 * phase4.test.js -- unit tests for Phase 4 engine.
 *
 * The full mongodb-memory-server integration suite lives in
 * `phase4.integration.test.js` and requires a downloadable mongod
 * binary (blocked in this sandbox's network allowlist).  These
 * unit tests use a lightweight in-memory stub (`_stubMongo.js`)
 * that replaces the exact Mongoose methods our Phase 4 code uses.
 *
 * They cover:
 *   - Missed submission detector shape
 *   - Dependency detector shape
 *   - Performance-lock detector shape
 *   - IncidentService.recordIncident idempotency via E11000
 *   - IncidentService.promoteToActive state transition
 *   - IncidentService.resolve / cancel
 *   - ruleEvaluationScheduler.tick end-to-end orchestration
 *   - Backward-compat guarantee (legacy penaltyEngine unchanged)
 *
 *   cd backend && node services/compliance/__tests__/phase4.test.js
 */

process.env.NODE_ENV = 'test';
process.env.MISSED_SUBMISSION_EFFECTIVE_FROM = '2020-01-01';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');

const _oid = () => new mongoose.Types.ObjectId();

// ---------------------------------------------------------------
// Install stub adapters BEFORE loading services that require the
// underlying models.
// ---------------------------------------------------------------
const User = require('../../../models/User');
const Submission = require('../../../models/Submission');
const Attendance = require('../../../models/Attendance');
const DependencyTask = require('../../../models/DependencyTask');
const Template = require('../../../models/Template');
const ComplianceRule     = require('../../../models/ComplianceRule');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const ComplianceEvent    = require('../../../models/ComplianceEvent');
const AuditLog           = require('../../../models/AuditLog');
const Penalty            = require('../../../models/Penalty');

_stub.install(User);
_stub.install(Submission);
_stub.install(Attendance);
_stub.install(DependencyTask);
_stub.install(Template);
_stub.install(Penalty);
_stub.install(ComplianceRule, { uniqueBy: [['code']] });
_stub.install(ComplianceIncident, {
  // partial unique on {naturalKey, source:'automatic'} -- our stub
  // treats every uniqueBy entry as a hard match ignoring filter, which
  // is stricter than the DB but perfectly fine for these tests.
  uniqueBy: [['naturalKey', 'source']],
});
// Batch-3 fix #17 -- cancelIncident now reads ComplianceActionEffect
// under a transaction wrapper.  Stub it so this test doesn't wait for
// the 10 s buffer timeout on a disconnected Mongo.
_stub.install(ComplianceActionEffect, {
  uniqueBy: [['incidentId', 'ruleActionId', 'effectiveDate']],
});
_stub.install(ComplianceEvent);
_stub.install(AuditLog);

// Now load Phase 4 services (they cached the models above).
const compliance = require('../../compliance');
const { tick } = compliance.ruleEvaluationScheduler;
const incidentService = compliance.incidentService;
const missedDetector = require('../detectors/missedSubmissionDetector');
const depDetector    = require('../detectors/dependencyDetector');
const lockDetector   = require('../detectors/performanceLockDetector');

// -----------------------------------------------------------
// Helpers to build fixtures
// -----------------------------------------------------------
const _mkRule = async (spec) => await ComplianceRule.create({
  code: spec.code, name: spec.code, category: spec.category || 'submission',
  detector: spec.detector, enabled: !!spec.enabled, severity: 'medium',
  version: 1,
  trigger: spec.trigger || {},
  scope: spec.scope || {},
  actions: spec.actions || [],
  notifications: {}, recovery: {}, waiver: {},
});

const _mkEmp = async (over = {}) => await User.create({
  name: 'Emp', employeeId: 'AMI-TEST', email: 'e@x', password: 'x',
  role: 'employee', status: 'active', attendanceMode: 'submission_based',
  department: _oid(), weeklyOff: [0],
  ...over,
});

// -----------------------------------------------------------
// Test 1 -- Missed submission detector
// -----------------------------------------------------------
(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const rule = await _mkRule({
    code: 'missed_submission_v2',
    detector: 'built_in.missed_submission',
    enabled: true,
    trigger: { evaluationDelayDays: 1 },
  });

  const workDay = new Date('2026-07-16T00:00:00Z');
  await Attendance.create({ employee: emp._id, date: workDay, status: 'present' });
  const sub = await Submission.create({
    employee: emp._id, template: _oid(), templateType: 'task',
    assignment: _oid(), date: workDay, submitted: false, deleted: false, isTestData: false,
  });

  const tickDay = new Date('2026-07-17T00:00:00Z');
  const candidates = await missedDetector.detect({ rule, employee: emp, day: tickDay });
  assert.strictEqual(candidates.length, 1, 'one missed candidate');
  assert.match(candidates[0].naturalKey,
    /^missed_submission_v2\|[a-f0-9]{24}\|2026-07-16\|[a-f0-9]{24}$/,
    'naturalKey shape matches spec');
  assert.strictEqual(new Date(candidates[0].incidentDate).toISOString(),
    '2026-07-16T00:00:00.000Z');
  assert.strictEqual(String(candidates[0].context.submissionId), String(sub._id));
  console.log('  ok  missed detector: one candidate with correct shape');

  // Absent -> no candidate.
  await Attendance.updateMany({ employee: emp._id }, { $set: { status: 'absent' } });
  const none = await missedDetector.detect({ rule, employee: emp, day: tickDay });
  assert.strictEqual(none.length, 0, 'absent employee yields no candidate');
  console.log('  ok  missed detector: absent employee skipped');

  // Restore present + submit -> no candidate.
  await Attendance.updateMany({ employee: emp._id }, { $set: { status: 'present' } });
  await Submission.updateMany({ _id: sub._id }, { $set: { submitted: true } });
  const none2 = await missedDetector.detect({ rule, employee: emp, day: tickDay });
  assert.strictEqual(none2.length, 0, 'submitted stub yields no candidate');
  console.log('  ok  missed detector: submitted stub skipped');
})()
// -----------------------------------------------------------
// Test 2 -- Dependency detector
// -----------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const rule = await _mkRule({
    code: 'dependency_pending_v2',
    detector: 'built_in.dependency_pending',
    enabled: true,
    category: 'dependency',
    trigger: { thresholdDays: 3 },
  });
  const tickDay = new Date('2026-07-17T00:00:00Z');

  // 2-day old dep -> not yet overdue.
  await DependencyTask.create({
    assignedTo: emp._id, status: 'pending',
    assignedAt: new Date('2026-07-15T00:00:00Z'),
  });
  const early = await depDetector.detect({ rule, employee: emp, day: tickDay });
  assert.strictEqual(early.length, 0, 'not yet 3 days old -> no candidate');

  // 4-day old dep -> overdue.
  await DependencyTask.create({
    assignedTo: emp._id, status: 'pending',
    assignedAt: new Date('2026-07-13T00:00:00Z'),
  });
  const late = await depDetector.detect({ rule, employee: emp, day: tickDay });
  assert.strictEqual(late.length, 1, 'overdue dep -> one day-scoped candidate');
  assert.match(late[0].naturalKey,
    /^dependency_pending_v2\|[a-f0-9]{24}\|2026-07-17$/);
  console.log('  ok  dependency detector: threshold + day-scoped naturalKey');
})
// -----------------------------------------------------------
// Test 3 -- Performance lock detector
// -----------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const rule = await _mkRule({
    code: 'performance_lock_v2',
    detector: 'built_in.performance_lock',
    enabled: true,
    trigger: { workingDaysOnly: false }, // skip workingDays helper in stub env
  });
  const tickDay = new Date('2026-07-17T00:00:00Z');

  const sub = await Submission.create({
    employee: emp._id, template: _oid(), templateType: 'task',
    date: new Date('2026-07-13T00:00:00Z'),
    submitted: true, deleted: false, isTestData: false,
    tasks: [
      {
        _id: _oid(), title: 'newer', status: 'pending',
        pendingSince: new Date('2026-07-12T00:00:00Z'),
        resolveBy:    new Date('2026-07-14T00:00:00Z'),
      },
      {
        _id: _oid(), title: 'oldest', status: 'pending',
        pendingSince: new Date('2026-07-10T00:00:00Z'),
        resolveBy:    new Date('2026-07-13T00:00:00Z'),
      },
    ],
  });

  const cands = await lockDetector.detect({ rule, employee: emp, day: tickDay });
  assert.strictEqual(cands.length, 1);
  assert.strictEqual(cands[0].context.taskTitle, 'oldest');
  console.log('  ok  perf-lock detector: oldest overdue task snapshotted');
})
// -----------------------------------------------------------
// Test 4 -- IncidentService idempotency (E11000)
// -----------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const rule = await _mkRule({ code: 'r1', detector: 'built_in.missed_submission' });

  const candidate = {
    rule, employeeId: emp._id,
    naturalKey: 'r1|A|2026-07-16|B',
    incidentDate:  new Date('2026-07-16T00:00:00Z'),
    effectiveDate: new Date('2026-07-17T00:00:00Z'),
    context: {}, detectorMeta: {},
  };
  const a = await incidentService.recordIncident(candidate);
  assert.strictEqual(a.created, true, 'first call inserts');
  const b = await incidentService.recordIncident(candidate);
  assert.strictEqual(b.created, false, 'second call is idempotent');
  assert.strictEqual(String(a.incident._id), String(b.incident._id),
    'both calls resolve to the same incident');
  console.log('  ok  incident service: idempotent recordIncident');
})
// -----------------------------------------------------------
// Test 5 -- promoteToActive
// -----------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const rule = await _mkRule({ code: 'r2', detector: 'built_in.missed_submission' });
  const { incident } = await incidentService.recordIncident({
    rule, employeeId: emp._id,
    naturalKey: 'r2|A|2026-07-16|B',
    incidentDate:  new Date('2026-07-16T00:00:00Z'),
    effectiveDate: new Date('2026-07-17T00:00:00Z'),
    context: {},
  });

  // Before effectiveDate -> no promotion.
  const before = await incidentService.promoteToActive(incident._id,
    { now: new Date('2026-07-16T00:00:00Z') });
  assert.strictEqual(before, null, 'no promotion before effectiveDate');

  // On effectiveDate -> promotion.
  const after = await incidentService.promoteToActive(incident._id,
    { now: new Date('2026-07-17T00:00:00Z') });
  assert.strictEqual(after.status, 'active');
  console.log('  ok  incident service: promoteToActive respects effectiveDate');
})
// -----------------------------------------------------------
// Test 6 -- resolve + cancel
// -----------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const rule = await _mkRule({ code: 'r3', detector: 'built_in.missed_submission' });
  const { incident: incA } = await incidentService.recordIncident({
    rule, employeeId: emp._id, naturalKey: 'r3|A|2026-07-16|X',
    incidentDate: new Date('2026-07-16T00:00:00Z'),
    effectiveDate: new Date('2026-07-17T00:00:00Z'),
    context: {},
  });
  const { incident: incB } = await incidentService.recordIncident({
    rule, employeeId: emp._id, naturalKey: 'r3|A|2026-07-16|Y',
    incidentDate: new Date('2026-07-16T00:00:00Z'),
    effectiveDate: new Date('2026-07-17T00:00:00Z'),
    context: {},
  });

  const resolved = await incidentService.resolveIncident(incA._id, { reason: 'test' });
  assert.strictEqual(resolved.status, 'resolved');
  const cancelled = await incidentService.cancelIncident(incB._id, { reason: 'test' });
  assert.strictEqual(cancelled.status, 'cancelled');
  console.log('  ok  incident service: resolve + cancel');
})
// -----------------------------------------------------------
// Test 7 -- scheduler.tick end-to-end orchestration
// -----------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const rule = await _mkRule({
    code: 'missed_submission_v2',
    detector: 'built_in.missed_submission',
    enabled: true,
    trigger: { evaluationDelayDays: 1 },
  });
  const workDay = new Date('2026-07-16T00:00:00Z');
  const tickDay = new Date('2026-07-17T00:00:00Z');
  await Attendance.create({ employee: emp._id, date: workDay, status: 'present' });
  await Submission.create({
    employee: emp._id, template: _oid(), templateType: 'task',
    date: workDay, submitted: false, deleted: false, isTestData: false,
  });

  const r1 = await tick({ day: tickDay });
  assert.strictEqual(r1.detected.rules, 1, 'one rule executed');
  assert.strictEqual(r1.detected.candidates, 1);
  assert.strictEqual(r1.detected.created, 1);
  assert.strictEqual(r1.detected.errors, 0);
  const incs = _stub.rows(ComplianceIncident);
  assert.strictEqual(incs.length, 1);
  assert.strictEqual(incs[0].status, 'active',
    'immediate promotion when effectiveDate == tickDay');

  // Re-run: idempotent.
  const r2 = await tick({ day: tickDay });
  assert.strictEqual(r2.detected.created, 0);
  assert.strictEqual(r2.detected.skipped, 1);
  const incs2 = _stub.rows(ComplianceIncident);
  assert.strictEqual(incs2.length, 1);
  console.log('  ok  scheduler.tick: single-rule end-to-end + idempotent');
})
// -----------------------------------------------------------
// Test 8 -- scheduler skips rules that are disabled
// -----------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _mkRule({
    code: 'missed_submission_v2',
    detector: 'built_in.missed_submission',
    enabled: false,   // disabled
    trigger: { evaluationDelayDays: 1 },
  });
  await Attendance.create({ employee: emp._id, date: new Date('2026-07-16T00:00:00Z'), status: 'present' });
  await Submission.create({
    employee: emp._id, template: _oid(), templateType: 'task',
    date: new Date('2026-07-16T00:00:00Z'), submitted: false,
    deleted: false, isTestData: false,
  });

  const r = await tick({ day: new Date('2026-07-17T00:00:00Z') });
  assert.strictEqual(r.detected.rules, 0, 'no enabled rules -> no candidates');
  const incs = _stub.rows(ComplianceIncident);
  assert.strictEqual(incs.length, 0);
  console.log('  ok  scheduler.tick: disabled rule is skipped');
})
// -----------------------------------------------------------
// Test 9 -- Backward compat: penaltyEngine still works
//   (we don't run enforceAbsentSubmission here because the stub
//    doesn't cover all its Model methods, but we can prove the
//    require path still loads and did not change).
// -----------------------------------------------------------
.then(async () => {
  const penaltyEngine = require('../../penaltyEngine');
  assert.strictEqual(typeof penaltyEngine.enforceAbsentSubmission, 'function');
  assert.strictEqual(typeof penaltyEngine.runDaily, 'function');
  assert.strictEqual(typeof penaltyEngine.resolveAbsentSubmissionOnSubmit, 'function');
  console.log('  ok  backward compat: legacy penaltyEngine surface intact');
})
.then(() => {
  _stub.restore();
  console.log('\nphase4: all unit tests passed');
})
.catch((e) => {
  console.error('phase4 test crashed:', e && e.stack || e);
  _stub.restore();
  process.exit(1);
});
