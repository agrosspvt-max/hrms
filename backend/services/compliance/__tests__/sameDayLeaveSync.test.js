/**
 * sameDayLeaveSync.test.js
 *
 * Verifies the two directions of same-day Leave <-> Submission sync
 * that the frontend realtime fix depends on:
 *
 *   Scenario 1 -- leave revoked TODAY:
 *       full-day leave (no submission) -> revoke -> businessStateSync
 *       materialises today's submission immediately + fires the
 *       'working_day:changed' realtime nudge.
 *
 *   Scenario 2 -- leave approved TODAY with a submission already present:
 *       submission exists (no employee work) -> approve full-day leave
 *       -> businessStateSync hides the submission (never deletes) +
 *       fires the nudge.
 *
 *   getToday guard -- a hidden submission is excluded by the exact
 *       getToday query shape { employee, date: today, hidden: {$ne:true} }.
 *
 *   Conflict path -- submission WITH employee work is not hidden on a
 *       same-day full-day approval (returns conflict, reuses existing
 *       businessStateSync behaviour).
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/sameDayLeaveSync.test.js
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
_stub.install(ComplianceIncident, { uniqueBy: [{ keys: ['naturalKey'], filter: { source: 'automatic' } }] });
_stub.install(ComplianceEvent);
_stub.install(ComplianceActionEffect);
_stub.install(MarksLedger);
_stub.install(FinancialLedger);
_stub.install(PercentageLedger);
_stub.install(AttendanceLedger);
_stub.install(AuditLog);

// Capture realtime nudges without a live SSE layer.
const realtime = require('../../realtime');
const _nudges = [];
realtime.publish = (userId, event, data) => { _nudges.push({ userId: String(userId), event, data }); };

const bss = require('../../businessStateSync');
const { startOfDay } = require('../../../utils/dateHelpers');

const TODAY = startOfDay(new Date());
const _mkEmp = async () => User.create({
  _id: _oid(), name: 'Anoop', employeeId: 'AMI0047', email: 'a@x', password: 'p',
  role: 'employee', status: 'active', weeklyOff: [0],
});
const _mkTplAssign = async (emp) => {
  const tpl = await Template.create({
    _id: _oid(), title: 'Daily Report', templateType: 'task',
    tasks: [{ _id: _oid(), title: 'Send DR', points: 10 }], isActive: true,
  });
  await Assignment.create({
    _id: _oid(), template: tpl, targetType: 'employee', targetRef: emp._id,
    active: true, frequency: 'daily',
    startDate: startOfDay(new Date(TODAY.getTime() - 30 * 86400000)),
    holidayOverride: false, subTemplateIds: [],
  });
  return tpl;
};
const _approveFullDay = async (emp) => Leave.create({
  _id: _oid(), employee: emp._id, leaveType: 'casual',
  fromDate: TODAY, toDate: TODAY, days: 1, dayType: 'full',
  status: 'approved', paid: true,
});

// getToday query shape (mirrors submissionController.getToday exactly).
const getTodayVisible = async (empId) =>
  Submission.find({ employee: empId, date: TODAY, hidden: { $ne: true } });

/* ================================================================== */
/* Scenario 1 -- leave revoked TODAY -> submission appears immediately */
/* ================================================================== */
(async () => {
  _stub.reset(); _nudges.length = 0;
  const emp = await _mkEmp();
  await _mkTplAssign(emp);
  // Full-day leave approved -> sync -> no submission.
  const lv = await _approveFullDay(emp);
  await bss.syncForLeave(lv, { trigger: 'leave_changed' });
  assert.strictEqual((await getTodayVisible(emp._id)).length, 0, 'full-day leave -> no visible submission');

  // HR revokes TODAY.
  _stub.rows(Leave)[0].status = 'revoked';
  _nudges.length = 0;
  const r = await bss.syncForLeave(lv, { trigger: 'leave_changed' });

  const visible = await getTodayVisible(emp._id);
  assert.strictEqual(visible.length, 1, 'revoke today -> submission generated immediately');
  const nudged = _nudges.some((n) => n.event === 'working_day:changed' && n.userId === String(emp._id));
  assert.ok(nudged, "working_day:changed nudge fired to the employee");
  console.log('  ok  Scenario 1: revoke today materialises submission + realtime nudge');
})()

/* ================================================================== */
/* Scenario 2 -- leave approved TODAY, submission already exists       */
/* ================================================================== */
.then(async () => {
  _stub.reset(); _nudges.length = 0;
  const emp = await _mkEmp();
  const tpl = await _mkTplAssign(emp);
  // Day starts with NO leave -> submission generated.
  await bss.syncEmployeeDay({ employeeId: emp._id, date: TODAY, trigger: 'manual' });
  let visible = await getTodayVisible(emp._id);
  assert.strictEqual(visible.length, 1, 'no leave -> submission exists');

  // Employee has NOT started work.  HR approves full-day leave today.
  _nudges.length = 0;
  const lv = await _approveFullDay(emp);
  const r = await bss.syncForLeave(lv, { trigger: 'leave_changed' });

  // Submission is hidden (not deleted) and no longer visible to getToday.
  const all = _stub.rows(Submission);
  assert.strictEqual(all.length, 1, 'submission preserved (not deleted)');
  assert.strictEqual(all[0].hidden, true, 'submission hidden');
  visible = await getTodayVisible(emp._id);
  assert.strictEqual(visible.length, 0, 'getToday no longer surfaces the hidden submission');
  const nudged = _nudges.some((n) => n.event === 'working_day:changed' && n.userId === String(emp._id));
  assert.ok(nudged, 'working_day:changed nudge fired');
  console.log('  ok  Scenario 2: approve today hides submission (no delete) + nudge');
})

/* ================================================================== */
/* Scenario 2b -- submission WITH employee work -> conflict, no hide   */
/* ================================================================== */
.then(async () => {
  _stub.reset(); _nudges.length = 0;
  const emp = await _mkEmp();
  await _mkTplAssign(emp);
  await bss.syncEmployeeDay({ employeeId: emp._id, date: TODAY, trigger: 'manual' });
  // Employee starts work.
  const sub = _stub.rows(Submission)[0];
  sub.tasks[0].status = 'done';

  const lv = await _approveFullDay(emp);
  const r = await bss.syncForLeave(lv, { trigger: 'leave_changed' });

  const conflict = r.conflicts.find((c) => c.code === 'submission_has_work');
  assert.ok(conflict, 'conflict returned when employee has started work');
  assert.notStrictEqual(_stub.rows(Submission)[0].hidden, true, 'submission NOT hidden without HR force');
  // getToday still shows it (work not silently destroyed).
  assert.strictEqual((await getTodayVisible(emp._id)).length, 1, 'started-work submission stays visible');
  console.log('  ok  Scenario 2b: started work -> conflict, nothing hidden or destroyed');
})

/* ================================================================== */
/* Idempotency -- repeated revoke syncs never duplicate the submission */
/* ================================================================== */
.then(async () => {
  _stub.reset(); _nudges.length = 0;
  const emp = await _mkEmp();
  await _mkTplAssign(emp);
  const lv = await _approveFullDay(emp);
  await bss.syncForLeave(lv, { trigger: 'leave_changed' });
  _stub.rows(Leave)[0].status = 'revoked';
  for (let i = 0; i < 4; i += 1) {
    await bss.syncForLeave(lv, { trigger: 'leave_changed' });
  }
  assert.strictEqual(_stub.rows(Submission).length, 1, '4 revoke syncs -> 1 submission');
  console.log('  ok  Idempotent: repeated revoke syncs never duplicate submission');
})

.then(() => { console.log('\nsameDayLeaveSync: all regression tests passed'); process.exit(0); })
.catch((e) => { console.error('sameDayLeaveSync test crashed:', e && e.stack || e); process.exit(1); });
