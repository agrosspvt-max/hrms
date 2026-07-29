/**
 * leaveSync.test.js -- regression suite for the businessStateSync
 * orchestrator + Leave lifecycle.  Verifies every leave-state
 * transition brings Attendance, Submission, and Compliance back to a
 * consistent view without duplicates and without silently destroying
 * employee work.
 *
 *   Scenario 1  no leave      -> half day    :  submission generated
 *   Scenario 2  no leave      -> full day    :  submission suppressed
 *   Scenario 3  full day      -> half day    :  submission generated
 *   Scenario 4  full day      -> no leave    :  submission generated
 *   Scenario 5  half (no work)-> full day    :  submission suppressed (soft)
 *   Scenario 6  half (has work)-> full day   :  CONFLICT returned
 *   Scenario 7  idempotency               :  no duplicates on re-run
 *   Scenario 8  compliance re-eval        :  stale incidents auto-resolve
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/leaveSync.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User             = require('../../../models/User');
const Leave            = require('../../../models/Leave');
const Submission       = require('../../../models/Submission');
const Attendance       = require('../../../models/Attendance');
const Holiday          = require('../../../models/Holiday');
const Template         = require('../../../models/Template');
const Assignment       = require('../../../models/Assignment');
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
const Event            = require('../../../models/Event');

_stub.install(Event);
_stub.install(User);
_stub.install(Leave);
_stub.install(Submission);
_stub.install(Attendance);
_stub.install(Holiday);
_stub.install(Template);
_stub.install(Assignment);
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

const bss = require('../../businessStateSync');
const incidentService = require('../incidents/incidentService');

const startOfDay = (d) => { const x = new Date(d); x.setUTCHours(0,0,0,0); return x; };
const today = startOfDay(new Date('2026-07-28T12:00:00Z'));

const _mkEmp = async () => User.create({
  _id: _oid(), name: 'Anoop', employeeId: 'AMI0047', email: 'a@x', password: 'p',
  role: 'employee', status: 'active', weeklyOff: [0],
});
const _mkTemplateAndAssignment = async (emp) => {
  const tplId = _oid();
  const tplDoc = await Template.create({
    _id: tplId, title: 'Daily Report', templateType: 'task',
    tasks: [{ _id: _oid(), title: 'Send DR', points: 10, isCritical: false }],
    isActive: true,
  });
  // stub-mongo's `.populate()` is a no-op, so we pre-inject the full
  // template doc onto the assignment row so `a.template.tasks` in
  // dailyEngine resolves without an extra query.
  await Assignment.create({
    _id: _oid(), template: tplDoc, targetType: 'employee', targetRef: emp._id,
    active: true, frequency: 'daily', startDate: startOfDay(new Date('2026-07-01T00:00:00Z')),
    holidayOverride: false, subTemplateIds: [],
  });
  return tplId;
};
const _approve = async (empId, dayType, date = today) => Leave.create({
  _id: _oid(), employee: empId, leaveType: 'casual',
  fromDate: date, toDate: date, days: dayType === 'half' ? 0.5 : 1,
  dayType, status: 'approved', paid: true,
});

// ---------------------------------------------------------------
// Scenario 1: no leave -> half day.  Submission should be generated.
// ---------------------------------------------------------------
(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _mkTemplateAndAssignment(emp);
  const lv = await _approve(emp._id, 'half');
  const r = await bss.syncForLeave(lv, { trigger: 'leave_changed' });
  assert.strictEqual(r.days.length, 1);
  const created = r.days[0].submissions.find((s) => s.action === 'created');
  assert.ok(created, 'submission generated on half-day approval');
  const dbSubs = _stub.rows(Submission);
  assert.strictEqual(dbSubs.length, 1, 'exactly one submission in DB');
  console.log('  ok  Scenario 1: no leave -> half day generates submission');
})()

// ---------------------------------------------------------------
// Scenario 2: no leave -> full day.  No submission created.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _mkTemplateAndAssignment(emp);
  const lv = await _approve(emp._id, 'full');
  const r = await bss.syncForLeave(lv, { trigger: 'leave_changed' });
  assert.strictEqual(r.days.length, 1);
  const dbSubs = _stub.rows(Submission);
  assert.strictEqual(dbSubs.length, 0, 'no submission created for full-day leave');
  console.log('  ok  Scenario 2: no leave -> full day generates no submission');
})

// ---------------------------------------------------------------
// Scenario 3: full day -> half day.  Submission generated on transition.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _mkTemplateAndAssignment(emp);
  // Start full day.
  const lvFull = await _approve(emp._id, 'full');
  await bss.syncForLeave(lvFull, { trigger: 'leave_changed' });
  assert.strictEqual(_stub.rows(Submission).length, 0, 'full day -> no sub');
  // HR edits: revoke + re-approve as half-day.
  const lvFullRow = _stub.rows(Leave)[0];
  lvFullRow.status = 'revoked';
  const lvHalf = await _approve(emp._id, 'half');
  const r = await bss.syncForLeave(lvHalf, { trigger: 'leave_changed' });
  const created = r.days[0].submissions.find((s) => s.action === 'created');
  assert.ok(created, 'submission created when transitioning full -> half');
  console.log('  ok  Scenario 3: full day -> half day generates submission');
})

// ---------------------------------------------------------------
// Scenario 4: full day -> no leave.  Submission generated.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _mkTemplateAndAssignment(emp);
  const lvFull = await _approve(emp._id, 'full');
  await bss.syncForLeave(lvFull, { trigger: 'leave_changed' });
  assert.strictEqual(_stub.rows(Submission).length, 0);
  // Revoke.
  const lvRow = _stub.rows(Leave)[0];
  lvRow.status = 'revoked';
  const r = await bss.syncEmployeeDay({
    employeeId: emp._id, date: today, trigger: 'leave_changed',
  });
  const created = r.submissions.find((s) => s.action === 'created');
  assert.ok(created, 'submission created after leave revoked');
  console.log('  ok  Scenario 4: full day -> no leave generates submission');
})

// ---------------------------------------------------------------
// Scenario 5: half day -> full day, employee has NOT started work.
// Submission should be safely suppressed (hidden=true), NOT deleted.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _mkTemplateAndAssignment(emp);
  const lvHalf = await _approve(emp._id, 'half');
  await bss.syncForLeave(lvHalf, { trigger: 'leave_changed' });
  assert.strictEqual(_stub.rows(Submission).length, 1, 'half day -> 1 sub');
  // Employee has not touched it.  Revoke + full-day approve.
  const lvHalfRow = _stub.rows(Leave)[0];
  lvHalfRow.status = 'revoked';
  const lvFull = await _approve(emp._id, 'full');
  const r = await bss.syncForLeave(lvFull, { trigger: 'leave_changed' });
  // Submission still in DB but hidden=true.
  const sub = _stub.rows(Submission)[0];
  assert.strictEqual(sub.hidden, true, 'submission soft-suppressed');
  assert.strictEqual(_stub.rows(Submission).length, 1, 'never deleted');
  const suppressed = r.days.some((d) => d.submissions.some((s) => s.action === 'suppressed'));
  assert.ok(suppressed, 'sync reported suppression');
  console.log('  ok  Scenario 5: half -> full (no work) safely suppresses');
})

// ---------------------------------------------------------------
// Scenario 6: half day -> full day, employee HAS started work.
// Conflict returned; nothing hidden without HR force.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _mkTemplateAndAssignment(emp);
  const lvHalf = await _approve(emp._id, 'half');
  await bss.syncForLeave(lvHalf, { trigger: 'leave_changed' });
  // Employee "starts work": flip a task to 'done'.
  const sub = _stub.rows(Submission)[0];
  sub.tasks[0].status = 'done';
  // Revoke half; approve full.
  _stub.rows(Leave)[0].status = 'revoked';
  const lvFull = await _approve(emp._id, 'full');
  const r = await bss.syncForLeave(lvFull, { trigger: 'leave_changed' });
  const conflict = r.conflicts.find((c) => c.code === 'submission_has_work');
  assert.ok(conflict, 'conflict reported');
  const stillVisible = _stub.rows(Submission)[0];
  assert.notStrictEqual(stillVisible.hidden, true, 'submission NOT hidden without force');
  // HR force: re-run with force:true.
  const r2 = await bss.syncForLeave(lvFull, {
    trigger: 'leave_changed', force: true, reason: 'HR override with reason',
  });
  assert.strictEqual(_stub.rows(Submission)[0].hidden, true, 'force hides after HR ack');
  const forced = r2.days[0].submissions.find((s) => s.action === 'force_suppressed');
  assert.ok(forced, 'force suppression recorded');
  console.log('  ok  Scenario 6: half -> full (with work) requires HR force');
})

// ---------------------------------------------------------------
// Scenario 7: idempotency.  Multiple sync runs produce no duplicates.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _mkTemplateAndAssignment(emp);
  const lvHalf = await _approve(emp._id, 'half');
  for (let i = 0; i < 5; i += 1) {
    await bss.syncForLeave(lvHalf, { trigger: 'leave_changed' });
  }
  assert.strictEqual(_stub.rows(Submission).length, 1, '5 syncs -> 1 submission');
  assert.strictEqual(_stub.rows(Attendance).length, 1, '5 syncs -> 1 attendance row');
  console.log('  ok  Scenario 7: idempotent (5 syncs = 1 sub, 1 attendance)');
})

// ---------------------------------------------------------------
// Scenario 8: compliance re-eval.  After the pending state clears
// (leave suppression + sub hide), no open performance_lock incident
// remains for this employee -> resolvePerformanceLockIncidents runs.
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const tplId = await _mkTemplateAndAssignment(emp);
  // Seed an "open" performance_lock incident that predates the leave.
  const rule = await ComplianceRule.create({
    _id: _oid(), code: 'performance_lock_v2', version: 1, severity: 'medium',
    detector: 'built_in.performance_lock', enabled: true,
  });
  const natKey = 'performance_lock_v2|' + String(emp._id) + '|2026-07-28';
  await incidentService.recordIncident({
    rule, employeeId: emp._id, naturalKey: natKey,
    incidentDate: today, effectiveDate: today,
    context: { workDate: today }, detectorMeta: {},
    source: 'automatic',
  });
  const before = _stub.rows(ComplianceIncident).filter((i) =>
    i.ruleCode === 'performance_lock_v2' && ['candidate', 'active'].includes(i.status));
  assert.strictEqual(before.length, 1);

  // HR now approves a full-day leave for today.  Since no overdue
  // pending exists (there was never a task), sync must close the
  // stale incident.
  const lvFull = await _approve(emp._id, 'full');
  const r = await bss.syncForLeave(lvFull, { trigger: 'leave_changed' });
  const closed = r.days[0].compliance.performanceLockResolved;
  assert.ok(closed >= 1, 'stale performance_lock incident closed');
  const after = _stub.rows(ComplianceIncident).filter((i) =>
    i.ruleCode === 'performance_lock_v2' && ['candidate', 'active'].includes(i.status));
  assert.strictEqual(after.length, 0, 'no open performance_lock incidents remain');
  console.log('  ok  Scenario 8: compliance auto-resolves stale incidents');
})

.then(() => { console.log('\nleaveSync: all regression tests passed'); process.exit(0); })
.catch((e) => { console.error('leaveSync test crashed:', e && e.stack || e); process.exit(1); });
