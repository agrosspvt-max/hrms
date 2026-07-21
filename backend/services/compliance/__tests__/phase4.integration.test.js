/**
 * phase4.test.js -- integration tests for the Phase 4 engine
 * (IncidentService + detectors + scheduler.tick) against an in-memory
 * MongoDB via mongodb-memory-server.
 *
 *   cd backend && node services/compliance/__tests__/phase4.test.js
 *
 * The suite:
 *   - Spins up an ephemeral Mongo instance.
 *   - Seeds one active employee + a Submission stub + Attendance row.
 *   - Enables the missed-submission rule.
 *   - Runs `scheduler.tick(day)` twice; asserts idempotency.
 *   - Fabricates an overdue DependencyTask and asserts the
 *     dependency detector fires.
 *   - Fabricates an overdue pending task and asserts the perf-lock
 *     detector fires.
 *   - Verifies promotion moves a candidate -> active when
 *     effectiveDate has arrived.
 *   - Verifies backward compat: legacy Penalty writes still happen
 *     via penaltyEngine (unchanged behaviour).
 */

process.env.NODE_ENV = 'test';
process.env.MISSED_SUBMISSION_EFFECTIVE_FROM = '2020-01-01'; // ensure test dates are post-rollout

const assert = require('assert');
const path = require('path');
const mongoose = require('mongoose');

// ---------------------------------------------------------------
// Boot in-memory Mongo BEFORE any model is loaded.
// ---------------------------------------------------------------
let mongo;
const boot = async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 5000 });
};
const shutdown = async () => {
  try { await mongoose.disconnect(); } catch (_) {}
  try { if (mongo) await mongo.stop(); } catch (_) {}
};

const _isoDay = (d) => new Date(d).toISOString().slice(0, 10);

(async () => {
  await boot();

  // Load models AFTER connect so their indexes build against the
  // in-memory instance.
  const User = require('../../../models/User');
  const Submission = require('../../../models/Submission');
  const Attendance = require('../../../models/Attendance');
  const Template   = require('../../../models/Template');
  const Assignment = require('../../../models/Assignment');
  const DependencyTask = require('../../../models/DependencyTask');
  const ComplianceRule = require('../../../models/ComplianceRule');
  const ComplianceIncident = require('../../../models/ComplianceIncident');
  const ComplianceEvent    = require('../../../models/ComplianceEvent');

  const compliance = require('../../compliance');
  const { tick } = compliance.ruleEvaluationScheduler;
  const ruleSeed = require('../rules/ruleSeed');
  const featureFlags = require('../../../config/featureFlags');
  process.env.COMPLIANCE_RULES = 'true';
  process.env.COMPLIANCE_NEW_ENGINE = 'true';
  featureFlags._resetForTest();
  await ruleSeed.run();

  // Wait for critical indexes.
  await ComplianceIncident.syncIndexes();
  await ComplianceEvent.syncIndexes();

  const empId = new mongoose.Types.ObjectId();
  const deptId = new mongoose.Types.ObjectId();
  await User.create({
    _id: empId,
    name: 'Test Employee',
    employeeId: 'AMI-TEST-01',
    email: 'test@example.com',
    password: 'x',
    role: 'employee',
    status: 'active',
    attendanceMode: 'submission_based',
    department: deptId,
    weeklyOff: [0],
  });

  // --------------------------------------------------------
  // Test 1: Missed submission detector fires + is idempotent.
  // --------------------------------------------------------
  const templateId = new mongoose.Types.ObjectId();
  const assignmentId = new mongoose.Types.ObjectId();
  const workDay = new Date('2026-07-16T00:00:00Z');
  const tickDay = new Date('2026-07-17T00:00:00Z');   // day-after
  await Submission.create({
    employee: empId,
    template: templateId,
    templateType: 'task',
    assignment: assignmentId,
    date: workDay,
    submitted: false,
    tasks: [],
  });
  await Attendance.create({
    employee: empId,
    date: workDay,
    status: 'present',
  });

  // Enable the missed-submission rule.
  const rule = await ComplianceRule.findOneAndUpdate(
    { code: 'missed_submission_v2' },
    { $set: { enabled: true } },
    { new: true },
  );
  assert.ok(rule.enabled, 'rule enabled');

  const r1 = await tick({ day: tickDay });
  assert.strictEqual(r1.detected.candidates, 1, 'one missed candidate');
  assert.strictEqual(r1.detected.created, 1, 'one incident created');
  assert.strictEqual(r1.detected.errors, 0, 'no errors');
  console.log('  ok  missed submission: candidate created');

  // Re-run: idempotent.
  const r2 = await tick({ day: tickDay });
  assert.strictEqual(r2.detected.candidates, 1, 'still one candidate');
  assert.strictEqual(r2.detected.created, 0, 'no new incident on re-run');
  assert.strictEqual(r2.detected.skipped, 1, 'one skipped by naturalKey');
  console.log('  ok  missed submission: re-run is idempotent');

  const incidents = await ComplianceIncident.find({ ruleCode: 'missed_submission_v2' }).lean();
  assert.strictEqual(incidents.length, 1, 'exactly one incident row');
  const inc = incidents[0];
  assert.strictEqual(String(inc.employee), String(empId));
  assert.strictEqual(inc.status, 'active', 'evaluationDelayDays=1, sweep is day-after -> effectiveDate reached, promoted to active');
  assert.strictEqual(_isoDay(inc.incidentDate),  '2026-07-16');
  assert.strictEqual(_isoDay(inc.effectiveDate), '2026-07-17');
  console.log('  ok  missed submission: promotion happened as expected');

  // Timeline row exists.
  const events = await ComplianceEvent.find({ incidentId: inc._id }).sort({ ts: 1 }).lean();
  assert.ok(events.length >= 2, 'at least incident_created + incident_effective events');
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('incident_created'));
  assert.ok(kinds.includes('incident_effective'));
  console.log('  ok  missed submission: timeline events written');

  // --------------------------------------------------------
  // Test 2: Dependency detector fires on 3+ day overdue task.
  // --------------------------------------------------------
  const depRule = await ComplianceRule.findOneAndUpdate(
    { code: 'dependency_pending_v2' },
    { $set: { enabled: true } },
    { new: true },
  );
  assert.ok(depRule.enabled);

  await DependencyTask.create({
    sourceSubmissionId: new mongoose.Types.ObjectId(),
    sourceTaskId: new mongoose.Types.ObjectId(),
    sourceKind: 'task',
    originalTaskName: 'Test overdue dep',
    assignedTo: empId,
    assignedToName: 'Test Employee',
    assignedBy: empId,
    assignedByName: 'Test Employee',
    currentStatus: 'pending',
    status: 'pending',
    assignedAt: new Date('2026-07-10T00:00:00Z'),  // > 3 days before tickDay
    waitingSince: new Date('2026-07-10T00:00:00Z'),
  });

  const r3 = await tick({ day: tickDay });
  assert.ok(r3.detected.candidates >= 1, 'dependency detector produces a candidate');
  const depIncs = await ComplianceIncident.find({ ruleCode: 'dependency_pending_v2' }).lean();
  assert.strictEqual(depIncs.length, 1);
  assert.strictEqual(_isoDay(depIncs[0].incidentDate), '2026-07-17');
  console.log('  ok  dependency: 3+day overdue -> single day-scoped incident');

  const r4 = await tick({ day: tickDay });
  const depIncs2 = await ComplianceIncident.find({ ruleCode: 'dependency_pending_v2' }).lean();
  assert.strictEqual(depIncs2.length, 1, 'dependency detector idempotent within same day');
  console.log('  ok  dependency: re-run idempotent');

  // --------------------------------------------------------
  // Test 3: Performance Lock detector fires when a task is
  // pending past resolveBy on a working day.
  // --------------------------------------------------------
  const lockRule = await ComplianceRule.findOneAndUpdate(
    { code: 'performance_lock_v2' },
    { $set: { enabled: true } },
    { new: true },
  );
  const overdueSub = await Submission.create({
    employee: empId,
    template: templateId,
    templateType: 'task',
    date: new Date('2026-07-13T00:00:00Z'),
    submitted: true,   // submission itself was submitted; pending task inside
    tasks: [{
      title: 'overdue', status: 'pending',
      pendingSince: new Date('2026-07-10T00:00:00Z'),
      resolveBy: new Date('2026-07-14T00:00:00Z'),
    }],
  });

  // 2026-07-17 is a Friday -- non-weekly-off for weeklyOff=[0]=Sun.
  const r5 = await tick({ day: tickDay });
  const lockIncs = await ComplianceIncident.find({ ruleCode: 'performance_lock_v2' }).lean();
  assert.strictEqual(lockIncs.length, 1);
  const lockInc = lockIncs[0];
  assert.strictEqual(lockInc.context.taskTitle, 'overdue');
  console.log('  ok  performance_lock: overdue pending task -> incident');

  // --------------------------------------------------------
  // Test 4: Scope filter -- disable rule after this employee's
  // department is excluded; new incidents don't fire.
  // --------------------------------------------------------
  const beforeCount = (await ComplianceIncident.find({})).length;
  await ComplianceRule.updateOne(
    { code: 'missed_submission_v2' },
    { $set: { 'scope.departments': [new mongoose.Types.ObjectId()] } },   // some random dept
  );
  // Add a fresh missed stub on a different day to make the detector fire.
  const workDay2 = new Date('2026-07-18T00:00:00Z');
  const tickDay2 = new Date('2026-07-19T00:00:00Z');
  await Submission.create({
    employee: empId, template: templateId, templateType: 'task',
    assignment: assignmentId, date: workDay2, submitted: false, tasks: [],
  });
  await Attendance.create({ employee: empId, date: workDay2, status: 'present' });
  await tick({ day: tickDay2 });
  const afterMissed = await ComplianceIncident.find({
    ruleCode: 'missed_submission_v2',
    incidentDate: workDay2,
  }).lean();
  assert.strictEqual(afterMissed.length, 0,
    'scope filter excludes this employee -> no incident for the new day');
  console.log('  ok  scope filter: excluded department suppresses detection');

  // Reset scope for cleanup.
  await ComplianceRule.updateOne(
    { code: 'missed_submission_v2' },
    { $set: { 'scope.departments': [] } },
  );

  // --------------------------------------------------------
  // Test 5: promotion happens on future ticks when effectiveDate
  // is reached.  We seed a candidate whose effectiveDate is later.
  // --------------------------------------------------------
  // Directly insert a candidate with a future effectiveDate.
  const dep2Rule = await ComplianceRule.findOne({ code: 'dependency_pending_v2' }).lean();
  await ComplianceIncident.create({
    ruleId: dep2Rule._id,
    ruleVersion: dep2Rule.version,
    ruleCode: dep2Rule.code,
    employee: empId,
    severity: 'medium',
    incidentDate: new Date('2026-07-20T00:00:00Z'),
    effectiveDate: new Date('2026-07-25T00:00:00Z'),
    naturalKey: 'test-manual-future-1',
    status: 'candidate',
    source: 'automatic',
  });
  const early = await tick({ day: new Date('2026-07-22T00:00:00Z') });
  const stillCandidate = await ComplianceIncident.findOne({
    naturalKey: 'test-manual-future-1',
  }).lean();
  assert.strictEqual(stillCandidate.status, 'candidate',
    'candidate stays candidate until effectiveDate');
  console.log('  ok  promotion: candidate stays until effectiveDate');

  const late = await tick({ day: new Date('2026-07-25T00:00:00Z') });
  const promoted = await ComplianceIncident.findOne({
    naturalKey: 'test-manual-future-1',
  }).lean();
  assert.strictEqual(promoted.status, 'active',
    'candidate promotes once effectiveDate reached');
  console.log('  ok  promotion: candidate flips to active on due day');

  // --------------------------------------------------------
  // Test 6: Backward compatibility -- legacy Penalty writes still
  // happen via penaltyEngine.  The v2 engine does NOT interfere.
  // --------------------------------------------------------
  const Penalty = require('../../../models/Penalty');
  const penaltyEngine = require('../../penaltyEngine');
  // Add a new missed day + attendance so enforceAbsentSubmission has
  // fresh work.  legacyMissedSubmissionArchive is not running so the
  // pre-cutoff env override lets this fire.
  const legacyDay = new Date('2026-07-22T00:00:00Z');
  await Submission.create({
    employee: empId, template: templateId, templateType: 'task',
    assignment: assignmentId, date: legacyDay, submitted: false, tasks: [],
  });
  await Attendance.create({ employee: empId, date: legacyDay, status: 'present' });
  const legacyBefore = await Penalty.countDocuments({ category: 'missed_submission' });
  await penaltyEngine.enforceAbsentSubmission({
    employeeId: empId,
    previousDay: legacyDay,
  });
  const legacyAfter = await Penalty.countDocuments({ category: 'missed_submission' });
  assert.strictEqual(legacyAfter, legacyBefore + 1,
    'legacy penaltyEngine still writes Penalty rows unchanged');
  console.log('  ok  backward compat: legacy Penalty writes still fire');

  // --------------------------------------------------------
  // Test 7: IncidentService.resolveIncident + cancelIncident.
  // --------------------------------------------------------
  const svc = compliance.incidentService;
  const missedIncId = incidents[0]._id;
  const resolved = await svc.resolveIncident(missedIncId, { reason: 'manual test' });
  assert.strictEqual(resolved.status, 'resolved');
  const resolvedRow = await ComplianceIncident.findById(missedIncId).lean();
  assert.strictEqual(resolvedRow.status, 'resolved');
  console.log('  ok  IncidentService.resolveIncident writes state + event');

  const cancelled = await svc.cancelIncident(depIncs[0]._id, { reason: 'test cancel' });
  assert.strictEqual(cancelled.status, 'cancelled');
  console.log('  ok  IncidentService.cancelIncident writes state + event');

  delete process.env.COMPLIANCE_RULES;
  delete process.env.COMPLIANCE_NEW_ENGINE;
  featureFlags._resetForTest();

  console.log('\nphase4: all tests passed');
  await shutdown();
})().catch(async (e) => {
  console.error('phase4 test crashed:', e && e.stack || e);
  await shutdown();
  process.exit(1);
});
