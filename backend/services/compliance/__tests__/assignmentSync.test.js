/**
 * assignmentSync.test.js
 *
 * Assignment <-> today's Submission synchronization via the existing
 * businessStateSync architecture.
 *
 *   1  new assignment today          -> submission materialised
 *   2  created after engine ran      -> submission still materialised
 *   3  reactivate/effective today    -> submission materialised
 *   4  revoke (no work)              -> submission HIDDEN, not deleted
 *   5  revoke (work started)         -> conflict, nothing hidden
 *   6  revoke force (work started)   -> hidden with reason, preserved
 *   7  full-day leave + assignment   -> no visible work
 *   8  multiple assignments          -> all materialise exactly once
 *   9  idempotent sync               -> one submission per emp+tpl+date
 *  10  leave change does NOT un-hide an assignment-suppressed sub
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/assignmentSync.test.js
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

[Event, User, Leave, Submission, Attendance, Holiday, Template, Assignment,
 DependencyTask, Penalty, ComplianceRule, ComplianceEvent, ComplianceActionEffect,
 MarksLedger, FinancialLedger, PercentageLedger, AttendanceLedger, AuditLog]
  .forEach((m) => _stub.install(m));
_stub.install(ComplianceIncident, { uniqueBy: [{ keys: ['naturalKey'], filter: { source: 'automatic' } }] });

const realtime = require('../../realtime');
const _nudges = [];
realtime.publish = (userId, event) => { _nudges.push({ userId: String(userId), event }); };

const bss = require('../../businessStateSync');
const { startOfDay } = require('../../../utils/dateHelpers');

const TODAY = startOfDay(new Date());
const _mkEmp = async () => User.create({ _id: _oid(), name: 'Tuhina', employeeId: 'T1', email: 't@x', password: 'p', role: 'employee', status: 'active', weeklyOff: [0] });
const _mkTplAssign = async (emp, title = 'Tuhina_Sales') => {
  const tpl = await Template.create({ _id: _oid(), title, templateType: 'task', isActive: true, tasks: [{ _id: _oid(), title: 'Sell', points: 10 }] });
  const a = await Assignment.create({
    _id: _oid(), template: tpl, targetType: 'employee', targetRef: emp._id,
    active: true, frequency: 'daily', startDate: TODAY, holidayOverride: false, subTemplateIds: [],
  });
  return { tpl, a };
};
const getTodayVisible = async (empId) => Submission.find({ employee: empId, date: TODAY, hidden: { $ne: true }, deleted: { $ne: true } });

/* 1 -- new assignment today materialises submission. */
(async () => {
  _stub.reset(); _nudges.length = 0;
  const emp = await _mkEmp(); await _mkTplAssign(emp);
  await bss.syncForAssignment({ employeeIds: [emp._id], date: TODAY, trigger: 'assignment_changed' });
  assert.strictEqual((await getTodayVisible(emp._id)).length, 1, 'submission materialised');
  assert.ok(_nudges.some((n) => n.event === 'working_day:changed'), 'nudge fired');
  console.log('  ok  1: new assignment today materialises submission + nudge');
})()

/* 2 -- assignment created AFTER the engine already ran (no sub yet). */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  // Engine "ran" earlier with no assignment -> no submission.
  const dailyEngine = require('../../dailyEngine');
  await dailyEngine.ensureDailySubmissions(await User.findById(emp._id), TODAY);
  assert.strictEqual((await getTodayVisible(emp._id)).length, 0, 'no sub before assignment');
  // HR creates the assignment now -> sync.
  await _mkTplAssign(emp);
  await bss.syncForAssignment({ employeeIds: [emp._id], date: TODAY, trigger: 'assignment_changed' });
  assert.strictEqual((await getTodayVisible(emp._id)).length, 1, 'sub appears after same-day create');
  console.log('  ok  2: assignment created after engine ran still materialises');
})

/* 3 -- reactivate: assignment made effective today -> materialise. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const { a } = await _mkTplAssign(emp);
  a.active = false; a.startDate = startOfDay(new Date(TODAY.getTime() - 10 * 86400000));
  // Reactivate for today.
  a.active = true; a.startDate = TODAY;
  await bss.syncForAssignment({ employeeIds: [emp._id], date: TODAY, trigger: 'assignment_changed' });
  assert.strictEqual((await getTodayVisible(emp._id)).length, 1, 'reactivated assignment materialises');
  console.log('  ok  3: reactivated assignment materialises today');
})

/* 4 -- revoke with no employee work -> hidden, not deleted. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp(); const { a } = await _mkTplAssign(emp);
  await bss.syncForAssignment({ employeeIds: [emp._id], date: TODAY, trigger: 'assignment_changed' });
  assert.strictEqual((await getTodayVisible(emp._id)).length, 1);
  const r = await bss.suppressAssignmentSubmissions({ assignmentId: a._id, fromDate: null, actor: emp._id, reason: 'revoked' });
  assert.strictEqual(r.hidden.length, 1, 'one row hidden');
  assert.strictEqual(r.conflicts.length, 0);
  assert.strictEqual(_stub.rows(Submission).length, 1, 'row preserved, not deleted');
  assert.strictEqual(_stub.rows(Submission)[0].hidden, true, 'row hidden');
  assert.strictEqual(_stub.rows(Submission)[0].hiddenSource, 'assignment');
  assert.strictEqual((await getTodayVisible(emp._id)).length, 0, 'not visible to getToday');
  console.log('  ok  4: revoke hides work-free submission (no delete)');
})

/* 5 -- revoke with started work -> conflict, nothing hidden. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp(); const { a } = await _mkTplAssign(emp);
  await bss.syncForAssignment({ employeeIds: [emp._id], date: TODAY, trigger: 'assignment_changed' });
  const sub = _stub.rows(Submission)[0];
  sub.tasks[0].status = 'done';   // employee started
  const r = await bss.suppressAssignmentSubmissions({ assignmentId: a._id, fromDate: null, actor: emp._id, reason: 'revoked' });
  assert.strictEqual(r.conflicts.length, 1, 'conflict reported');
  assert.strictEqual(r.hidden.length, 0, 'nothing hidden without force');
  assert.notStrictEqual(_stub.rows(Submission)[0].hidden, true, 'started work stays visible');
  console.log('  ok  5: revoke with started work -> conflict, nothing destroyed');
})

/* 6 -- revoke force over started work -> hidden (preserved). */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp(); const { a } = await _mkTplAssign(emp);
  await bss.syncForAssignment({ employeeIds: [emp._id], date: TODAY, trigger: 'assignment_changed' });
  _stub.rows(Submission)[0].tasks[0].status = 'done';
  const r = await bss.suppressAssignmentSubmissions({ assignmentId: a._id, fromDate: null, force: true, actor: emp._id, reason: 'HR override' });
  assert.strictEqual(r.hidden.length, 1, 'forced hide');
  assert.strictEqual(_stub.rows(Submission).length, 1, 'preserved, not deleted');
  assert.strictEqual(_stub.rows(Submission)[0].hidden, true);
  console.log('  ok  6: revoke force hides started work (preserved, not deleted)');
})

/* 7 -- full-day leave + assignment -> no visible work. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp(); await _mkTplAssign(emp);
  await Leave.create({ _id: _oid(), employee: emp._id, leaveType: 'casual', fromDate: TODAY, toDate: TODAY, days: 1, dayType: 'full', status: 'approved', paid: true });
  await bss.syncForAssignment({ employeeIds: [emp._id], date: TODAY, trigger: 'assignment_changed' });
  assert.strictEqual((await getTodayVisible(emp._id)).length, 0, 'full-day leave suppresses assignment work');
  console.log('  ok  7: full-day leave + assignment -> no visible work');
})

/* 8 -- multiple assignments materialise exactly once each. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _mkTplAssign(emp, 'A'); await _mkTplAssign(emp, 'B'); await _mkTplAssign(emp, 'C');
  await bss.syncForAssignment({ employeeIds: [emp._id], date: TODAY, trigger: 'assignment_changed' });
  assert.strictEqual((await getTodayVisible(emp._id)).length, 3, 'all three assignments materialised');
  console.log('  ok  8: multiple assignments all materialise');
})

/* 9 -- idempotent: repeated sync -> one submission per emp+tpl+date. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp(); await _mkTplAssign(emp);
  for (let i = 0; i < 5; i += 1) {
    await bss.syncForAssignment({ employeeIds: [emp._id], date: TODAY, trigger: 'assignment_changed' });
  }
  assert.strictEqual(_stub.rows(Submission).length, 1, '5 syncs -> 1 submission');
  console.log('  ok  9: idempotent (no duplicate submissions)');
})

/* 10 -- leave change must NOT un-hide an assignment-suppressed sub. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp(); const { a } = await _mkTplAssign(emp);
  await bss.syncForAssignment({ employeeIds: [emp._id], date: TODAY, trigger: 'assignment_changed' });
  // Revoke -> assignment-source hide.
  await bss.suppressAssignmentSubmissions({ assignmentId: a._id, fromDate: null, actor: emp._id, reason: 'revoked' });
  assert.strictEqual(_stub.rows(Submission)[0].hidden, true);
  // A subsequent leave-driven syncEmployeeDay (e.g. leave revoked) must
  // NOT un-hide the assignment-suppressed submission.
  await bss.syncEmployeeDay({ employeeId: emp._id, date: TODAY, trigger: 'leave_changed' });
  assert.strictEqual(_stub.rows(Submission)[0].hidden, true, 'assignment-hidden row stays hidden after leave sync');
  assert.strictEqual((await getTodayVisible(emp._id)).length, 0, 'still not visible');
  console.log('  ok  10: leave sync does not un-hide assignment-suppressed submission');
})

.then(() => { console.log('\nassignmentSync: all regression tests passed'); process.exit(0); })
.catch((e) => { console.error('assignmentSync test crashed:', e && e.stack || e); process.exit(1); });
