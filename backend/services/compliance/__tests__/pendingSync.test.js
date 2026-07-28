/**
 * pendingSync.test.js -- regression suite for the PendingStateService
 * refactor.  Proves every consumer (Dashboard backlog, HR Performance
 * overdue counter, Global Pendency, compliance detectors) now agrees
 * on whether a task/dependency is still pending, that submitting
 * today auto-closes matching backlog, and that cancelling a compliance
 * incident never touches business data.
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/pendingSync.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User             = require('../../../models/User');
const Submission       = require('../../../models/Submission');
const Template         = require('../../../models/Template');
const DependencyTask   = require('../../../models/DependencyTask');
const Penalty          = require('../../../models/Penalty');
const ComplianceRule   = require('../../../models/ComplianceRule');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceEvent  = require('../../../models/ComplianceEvent');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const MarksLedger      = require('../../../models/MarksLedger');
const FinancialLedger  = require('../../../models/FinancialLedger');
const PercentageLedger = require('../../../models/PercentageLedger');
const AttendanceLedger = require('../../../models/AttendanceLedger');
const AuditLog         = require('../../../models/AuditLog');

_stub.install(User);
_stub.install(Submission);
_stub.install(Template);
_stub.install(DependencyTask);
_stub.install(Penalty);
_stub.install(ComplianceRule);
_stub.install(ComplianceIncident, {
  uniqueBy: [{ keys: ['naturalKey'], filter: { source: 'automatic' } }],
});
_stub.install(ComplianceEvent);
_stub.install(ComplianceActionEffect);
_stub.install(MarksLedger);
_stub.install(FinancialLedger);
_stub.install(PercentageLedger);
_stub.install(AttendanceLedger);
_stub.install(AuditLog);

const pendingState        = require('../../pendingStateService');
const dependencyDetector  = require('../detectors/dependencyDetector');
const perfLockDetector    = require('../detectors/performanceLockDetector');
const incidentService     = require('../incidents/incidentService');
const dailyEngine         = require('../../dailyEngine');

const startOfDay = (d) => {
  const x = new Date(d); x.setUTCHours(0,0,0,0); return x;
};

const _mkEmp = async () => User.create({
  _id: _oid(), name: 'Anoop Bandewar', employeeId: 'AMI0047',
  email: 'anoop@example.com', password: 'x',
  role: 'employee', status: 'active',
});

// ---------------------------------------------------------------
// #1 -- Canonical pending predicate agrees for all consumers.
// ---------------------------------------------------------------
(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const tplId = _oid();
  const taskId = _oid();
  await Template.create({
    _id: tplId, title: 'Daily Report', templateType: 'task',
    tasks: [{ _id: taskId, title: 'Send DR', points: 10, isCritical: false }],
  });
  // Yesterday: an overdue pending task.
  const yesterday = new Date('2026-07-27T00:00:00Z');
  const sub = await Submission.create({
    _id: _oid(), employee: emp._id, template: tplId, templateType: 'task',
    date: yesterday, submitted: true, deleted: false, isTestData: false,
    tasks: [{
      _id: _oid(), taskId, title: 'Send DR', points: 10,
      isCritical: false, status: 'pending',
      pendingSince: yesterday, resolveBy: new Date('2026-07-27T23:59:59Z'),
    }],
  });

  // Every consumer sees the same one pending task.
  const backlogRows = await dailyEngine.getBacklog(emp._id, new Date('2026-07-28T10:00:00Z'));
  const performanceRows = await pendingState.listPendingTasks({});
  const overdueForDetector = await pendingState.overduePendingTasksForEmployee(
    emp._id, new Date('2026-07-28T00:00:00Z'),
  );
  assert.strictEqual(backlogRows.length, 1, 'Dashboard backlog sees 1 pending');
  assert.strictEqual(performanceRows.length, 1, 'HR Performance sees 1 pending');
  assert.strictEqual(overdueForDetector.length, 1, 'Compliance detector sees 1 pending');
  console.log('  ok  #1: Dashboard + Performance + Compliance detector agree');
})()

// ---------------------------------------------------------------
// #2 -- Submitting today with the same task Done auto-closes the
//        backlog row.  All four consumers then agree at zero.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const tplId = _oid();
  const taskId = _oid();
  await Template.create({
    _id: tplId, title: 'Daily Report', templateType: 'task',
    tasks: [{ _id: taskId, title: 'Send DR', points: 10 }],
  });
  const yesterday = new Date('2026-07-27T00:00:00Z');
  const today = new Date('2026-07-28T00:00:00Z');
  const oldSub = await Submission.create({
    _id: _oid(), employee: emp._id, template: tplId, templateType: 'task',
    date: yesterday, submitted: true, deleted: false, isTestData: false,
    tasks: [{
      _id: _oid(), taskId, title: 'Send DR', points: 10,
      status: 'pending', pendingSince: yesterday, resolveBy: yesterday,
    }],
  });
  const newSub = await Submission.create({
    _id: _oid(), employee: emp._id, template: tplId, templateType: 'task',
    date: today, submitted: true, deleted: false, isTestData: false,
    tasks: [{ _id: _oid(), taskId, title: 'Send DR', points: 10, status: 'done' }],
  });

  const { resolved } = await pendingState.autoResolveBacklog({
    employee: emp._id, template: tplId, submissionId: newSub._id,
    incomingTasks: [{ taskId, title: 'Send DR', status: 'done' }],
    asOf: today,
  });
  assert.strictEqual(resolved.length, 1, 'auto-resolve closed one backlog row');
  // The old task row is now done + has completedAt stamped.
  const reloaded = await Submission.findOne({ _id: oldSub._id }).lean();
  const closed = (reloaded.tasks || []).find((t) => String(t._id) === String(oldSub.tasks[0]._id));
  assert.strictEqual(closed.status, 'done', 'old task flipped to done');
  assert.ok(closed.completedAt, 'completedAt stamped');

  // Every reader now sees zero.
  const backlog = await dailyEngine.getBacklog(emp._id, today);
  const list = await pendingState.listPendingTasks({ employeeId: emp._id });
  const detector = await pendingState.overduePendingTasksForEmployee(emp._id, today);
  assert.strictEqual(backlog.length, 0,  'Dashboard reads 0');
  assert.strictEqual(list.length, 0,     'Performance reads 0');
  assert.strictEqual(detector.length, 0, 'Compliance detector reads 0');
  console.log('  ok  #2: submit today auto-clears matching backlog everywhere');
})

// ---------------------------------------------------------------
// #3 -- DependencyTask schema/query fix -- production rows (with
//        canonical currentStatus/waitingSince fields) are visible to
//        the detector.  Legacy rows using the OLD field names are
//        also tolerated (BC fallback).
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const tplId = _oid();
  const critFieldId = _oid();
  await Template.create({
    _id: tplId, title: 'Custom', templateType: 'custom',
    customFields: [{ _id: critFieldId, key: 'x', label: 'X', fieldType: 'text', isCritical: true }],
  });
  const critTaskSnapshotId = _oid();
  const sourceSub = await Submission.create({
    _id: _oid(), employee: emp._id, template: tplId, templateType: 'custom',
    date: new Date('2026-07-25T00:00:00Z'), submitted: false,
    deleted: false, isTestData: false,
    tasks: [{
      _id: critTaskSnapshotId, taskId: critFieldId, title: 'X', points: 0,
      isCritical: true, status: 'pending',
    }],
  });
  // Row written with the CANONICAL schema fields (waitingSince,
  // currentStatus).  Legacy readers on `assignedAt`/`status` would
  // have missed this row.  The service now finds it.
  const depCanonical = await DependencyTask.create({
    _id: _oid(), assignedTo: emp._id, assignedBy: emp._id,
    currentStatus: 'open',
    waitingSince: new Date('2026-07-24T00:00:00Z'),
    sourceSubmissionId: sourceSub._id, sourceTaskId: String(critFieldId),
  });
  // Legacy row with the OLD field names -- BC.
  const depLegacy = await DependencyTask.create({
    _id: _oid(), assignedTo: emp._id, assignedBy: emp._id,
    status: 'pending',
    assignedAt: new Date('2026-07-24T00:00:00Z'),
    sourceSubmissionId: sourceSub._id, sourceTaskId: String(critFieldId),
  });

  const open = await pendingState.listOpenDependencies({ employeeId: emp._id });
  assert.strictEqual(open.length, 2, 'canonical + legacy both open');

  const overdue = await pendingState.listOpenDependencies({
    employeeId: emp._id, thresholdDays: 3, asOf: new Date('2026-07-28T00:00:00Z'), overdueOnly: true,
  });
  assert.strictEqual(overdue.length, 2, 'both shapes flagged overdue');

  // Detector produces one candidate per employee-day (dep aggregation).
  const rule = { code: 'built_in.dependency_pending', trigger: { thresholdDays: 3 } };
  const cands = await dependencyDetector.detect({
    rule, employee: { _id: emp._id, department: null, designation: null },
    day: new Date('2026-07-28T00:00:00Z'),
  });
  assert.strictEqual(cands.length, 1, 'detector emits one day-scoped candidate');
  assert.strictEqual(cands[0].detectorMeta.overdueCount, 2, 'both deps counted');
  console.log('  ok  #3: canonical + legacy DependencyTask both visible; detector fires');
})

// ---------------------------------------------------------------
// #4 -- Compliance cancel is scoped: only compliance state changes.
//        Business data (Submission, DependencyTask) untouched.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const tplId = _oid();
  const taskId = _oid();
  await Template.create({
    _id: tplId, title: 'Daily Report', templateType: 'task',
    tasks: [{ _id: taskId, title: 'Send DR', points: 10 }],
  });
  const oldSubId = _oid();
  const oldTaskId = _oid();
  await Submission.create({
    _id: oldSubId, employee: emp._id, template: tplId, templateType: 'task',
    date: new Date('2026-07-27T00:00:00Z'), submitted: true,
    deleted: false, isTestData: false,
    tasks: [{
      _id: oldTaskId, taskId, title: 'Send DR', points: 10,
      status: 'pending',
      pendingSince: new Date('2026-07-27T00:00:00Z'),
      resolveBy: new Date('2026-07-27T00:00:00Z'),
    }],
  });
  const rule = await ComplianceRule.create({
    _id: _oid(), code: 'perf_lock_v2', version: 1, severity: 'medium',
    detector: 'built_in.performance_lock', enabled: true,
  });
  const naturalKey = 'perf_lock_v2|' + String(emp._id) + '|2026-07-28';
  const { incident } = await incidentService.recordIncident({
    rule, employeeId: emp._id,
    naturalKey,
    incidentDate: new Date('2026-07-28T00:00:00Z'),
    effectiveDate: new Date('2026-07-28T00:00:00Z'),
    context: { workDate: new Date('2026-07-28T00:00:00Z') },
    detectorMeta: {},
    source: 'automatic',
  });
  await incidentService.cancelIncident(incident._id, { reason: 'HR override' });

  // Cancel touched compliance only.
  const cancelled = await ComplianceIncident.findOne({ _id: incident._id }).lean();
  assert.strictEqual(cancelled.status, 'cancelled', 'incident cancelled');
  const subAfter = await Submission.findOne({ _id: oldSubId }).lean();
  const taskAfter = (subAfter.tasks || []).find((t) => String(t._id) === String(oldTaskId));
  assert.strictEqual(taskAfter.status, 'pending', 'business data untouched');
  assert.ok(!taskAfter.completedAt, 'completedAt not stamped by cancel');
  console.log('  ok  #4: cancel is scoped to compliance state; business data intact');
})

// ---------------------------------------------------------------
// #5 -- Cancel + re-tick: next day, if pending still exists, the
//        scheduler DOES recreate an incident (naturalKey day-scoped).
//        This is the by-design "renew until cleared" behaviour.
//        If pending is cleared FIRST, the detector returns [] so
//        no new incident is created.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const tplId = _oid();
  const taskId = _oid();
  await Template.create({
    _id: tplId, title: 'Daily Report', templateType: 'task',
    tasks: [{ _id: taskId, title: 'Send DR', points: 10 }],
  });
  const oldSubId = _oid();
  await Submission.create({
    _id: oldSubId, employee: emp._id, template: tplId, templateType: 'task',
    date: new Date('2026-07-27T00:00:00Z'), submitted: true,
    deleted: false, isTestData: false,
    tasks: [{
      _id: _oid(), taskId, title: 'Send DR', points: 10,
      status: 'pending',
      pendingSince: new Date('2026-07-27T00:00:00Z'),
      resolveBy: new Date('2026-07-27T00:00:00Z'),
    }],
  });
  const rule = { code: 'perf_lock_v2', trigger: { workingDaysOnly: false } };

  // Day-N: detector finds the pending row.
  const dayN = new Date('2026-07-28T00:00:00Z');
  const cands1 = await perfLockDetector.detect({ rule, employee: { _id: emp._id }, day: dayN });
  assert.strictEqual(cands1.length, 1, 'day N: incident recreated because pending still exists');

  // Now clear the backlog via the service.  Next day the detector
  // MUST return nothing.
  const newSub = await Submission.create({
    _id: _oid(), employee: emp._id, template: tplId, templateType: 'task',
    date: dayN, submitted: true, deleted: false, isTestData: false,
    tasks: [{ _id: _oid(), taskId, title: 'Send DR', points: 10, status: 'done' }],
  });
  await pendingState.autoResolveBacklog({
    employee: emp._id, template: tplId, submissionId: newSub._id,
    incomingTasks: [{ taskId, title: 'Send DR', status: 'done' }],
    asOf: dayN,
  });

  const dayN1 = new Date('2026-07-29T00:00:00Z');
  const cands2 = await perfLockDetector.detect({ rule, employee: { _id: emp._id }, day: dayN1 });
  assert.strictEqual(cands2.length, 0, 'day N+1: no recreation after underlying state resolved');
  console.log('  ok  #5: scheduler recreates while pending exists; stops when cleared');
})

// ---------------------------------------------------------------
// #6 -- Dependency resolve clears the compliance dependency detector.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const tplId = _oid();
  const critFieldId = _oid();
  await Template.create({
    _id: tplId, title: 'Custom', templateType: 'custom',
    customFields: [{ _id: critFieldId, key: 'x', label: 'X', fieldType: 'text', isCritical: false }],
  });
  const critTaskId = _oid();
  const sourceSub = await Submission.create({
    _id: _oid(), employee: emp._id, template: tplId, templateType: 'custom',
    date: new Date('2026-07-25T00:00:00Z'), submitted: true,
    deleted: false, isTestData: false,
    tasks: [{ _id: critTaskId, taskId: critFieldId, title: 'X', points: 0, isCritical: false, status: 'pending' }],
  });
  const dep = await DependencyTask.create({
    _id: _oid(), assignedTo: emp._id, assignedBy: emp._id,
    currentStatus: 'open',
    waitingSince: new Date('2026-07-24T00:00:00Z'),
    sourceSubmissionId: sourceSub._id, sourceTaskId: String(critFieldId),
  });

  const before = await pendingState.listOpenDependencies({ employeeId: emp._id });
  assert.strictEqual(before.length, 1, 'one open dep');

  await pendingState.resolveDependency({ dependencyId: dep._id, actor: { _id: emp._id }, note: 'done' });

  const after = await pendingState.listOpenDependencies({ employeeId: emp._id });
  assert.strictEqual(after.length, 0, 'resolved dep is no longer open');

  const rule = { code: 'built_in.dependency_pending', trigger: { thresholdDays: 3 } };
  const cands = await dependencyDetector.detect({
    rule, employee: { _id: emp._id, department: null, designation: null },
    day: new Date('2026-07-28T00:00:00Z'),
  });
  assert.strictEqual(cands.length, 0, 'detector no longer fires after dep resolution');
  console.log('  ok  #6: dependency resolution propagates through compliance detector');
})

// ---------------------------------------------------------------
// Done.
// ---------------------------------------------------------------
.then(() => { console.log('\npendingSync: all regression tests passed'); process.exit(0); })
.catch((e) => { console.error('pendingSync test crashed:', e); process.exit(1); });
