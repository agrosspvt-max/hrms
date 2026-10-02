/**
 * assignmentTodayVisibility.test.js -- Issue #4 verification.
 *
 * Confirms (against the CURRENT code) that a same-day assignment
 * materialises a Submission that is actually VISIBLE through the
 * getToday-shaped query, and documents the ONE-TIME date/timezone
 * contract so a future regression is caught.
 *
 *   1  ONE-TIME assignment for today (date-only string) -> Submission
 *      materialised AND visible to the getToday-shaped query.
 *   2  DAILY assignment for today -> visible.
 *   3  getToday-shaped query excludes a hidden (suppressed) submission
 *      but still shows a live one.
 *   4  DOCUMENTS the timezone contract: a date-only value "2026-09-28"
 *      is stored/compared as UTC-midnight of that calendar date, so
 *      isScheduledOn(one-time) is true on that UTC day (no ±1 shift).
 *   5  Boundary demonstration: a startDate carrying a tz OFFSET
 *      timestamp (e.g. IST "28 Sept" = 2026-09-27T18:30Z) resolves to
 *      the PREVIOUS UTC day -- i.e. only a non-date-only serialization
 *      shifts the day.  This pins the known edge so any future change
 *      to the date contract is caught.
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/assignmentTodayVisibility.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User       = require('../../../models/User');
const Assignment = require('../../../models/Assignment');
const Template   = require('../../../models/Template');
const Submission = require('../../../models/Submission');
const Leave      = require('../../../models/Leave');
const Holiday    = require('../../../models/Holiday');
const Event      = require('../../../models/Event');
const DependencyTask = require('../../../models/DependencyTask');
const Penalty    = require('../../../models/Penalty');
const ComplianceRule = require('../../../models/ComplianceRule');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceEvent = require('../../../models/ComplianceEvent');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const MarksLedger = require('../../../models/MarksLedger');
const FinancialLedger = require('../../../models/FinancialLedger');
const PercentageLedger = require('../../../models/PercentageLedger');
const AttendanceLedger = require('../../../models/AttendanceLedger');
const Attendance = require('../../../models/Attendance');
const AuditLog   = require('../../../models/AuditLog');

[User, Assignment, Template, Submission, Leave, Holiday, Event, DependencyTask, Penalty,
 ComplianceRule, ComplianceEvent, ComplianceActionEffect, MarksLedger, FinancialLedger,
 PercentageLedger, AttendanceLedger, Attendance, AuditLog].forEach((m) => _stub.install(m));
_stub.install(ComplianceIncident, { uniqueBy: [{ keys: ['naturalKey'], filter: { source: 'automatic' } }] });

const bss = require('../../businessStateSync');
const { startOfDay } = require('../../../utils/dateHelpers');
const { isScheduledOn } = require('../../../utils/scheduleHelpers');

const TODAY = startOfDay(new Date());
const TODAY_ISO = TODAY.toISOString().slice(0, 10);
const _mkEmp = async () => User.create({ _id: _oid(), name: 'T', employeeId: 'T1', email: 't@x', password: 'p', role: 'employee', status: 'active', weeklyOff: [0] });
const _mkTpl = async () => Template.create({ _id: _oid(), title: 'Tpl', templateType: 'task', isActive: true, tasks: [{ _id: _oid(), title: 'Do', points: 5 }] });
const _assign = async (emp, tpl, over = {}) => Assignment.create({
  _id: _oid(), template: tpl, targetType: 'employee', targetRef: emp._id,
  active: true, frequency: 'one-time', startDate: new Date(TODAY_ISO), subTemplateIds: [], ...over,
});
// Mirror submissionController.getToday's visible-submission query shape.
const getTodayVisible = async (empId) => Submission.find({ employee: empId, date: TODAY, hidden: { $ne: true }, deleted: { $ne: true } });

/* 1 */ (async () => {
  _stub.reset();
  const emp = await _mkEmp(); const tpl = await _mkTpl();
  await _assign(emp, tpl);   // ONE-TIME, startDate = today (date-only cast)
  await bss.syncForAssignment({ employeeIds: [emp._id], date: new Date(), trigger: 'assignment_changed' });
  const visible = await getTodayVisible(emp._id);
  assert.strictEqual(visible.length, 1, 'ONE-TIME today -> one visible submission');
  console.log('  ok  1: ONE-TIME assignment today is visible via getToday shape');
})()

/* 2 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp(); const tpl = await _mkTpl();
  await _assign(emp, tpl, { frequency: 'daily' });
  await bss.syncForAssignment({ employeeIds: [emp._id], date: new Date(), trigger: 'assignment_changed' });
  assert.strictEqual((await getTodayVisible(emp._id)).length, 1, 'DAILY today visible');
  console.log('  ok  2: DAILY assignment today is visible');
})

/* 3 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp(); const tpl = await _mkTpl();
  const a = await _assign(emp, tpl);
  await bss.syncForAssignment({ employeeIds: [emp._id], date: new Date(), trigger: 'assignment_changed' });
  assert.strictEqual((await getTodayVisible(emp._id)).length, 1);
  // Revoke -> suppression hides it; getToday-shaped query must drop it.
  await bss.suppressAssignmentSubmissions({ assignmentId: a._id, fromDate: null, actor: emp._id, reason: 'revoked' });
  assert.strictEqual((await getTodayVisible(emp._id)).length, 0, 'hidden submission excluded');
  assert.strictEqual(_stub.rows(Submission).length, 1, 'row preserved (not deleted)');
  console.log('  ok  3: getToday excludes hidden, shows live');
})

/* 4 -- date-only contract: no ±1 shift on the correct UTC day. */
.then(async () => {
  const a = { frequency: 'one-time', startDate: new Date(TODAY_ISO) };
  assert.strictEqual(isScheduledOn(a, TODAY), true, 'date-only startDate is effective on its UTC day');
  console.log('  ok  4: date-only startDate -> effective today (no shift)');
})

/* 5 -- boundary demonstration: a tz-OFFSET timestamp shifts the day. */
.then(async () => {
  // IST "28 Sept" serialized WITH offset = 27 Sept 18:30Z.  Only this
  // (non-date-only) shape shifts; the app's <input type=date> sends a
  // date-only string, which does NOT.  This test pins the contract.
  const istOffsetForToday = new Date(new Date(TODAY_ISO).getTime() - (5 * 60 + 30) * 60000); // prev-day 18:30Z
  const a = { frequency: 'one-time', startDate: istOffsetForToday };
  assert.strictEqual(isScheduledOn(a, TODAY), false, 'tz-offset timestamp resolves to the PREVIOUS UTC day');
  // ...and the date-only string for the same intended date does NOT shift:
  const b = { frequency: 'one-time', startDate: new Date(TODAY_ISO) };
  assert.strictEqual(isScheduledOn(b, TODAY), true, 'date-only string is stable');
  console.log('  ok  5: boundary — only a tz-offset timestamp shifts; date-only is stable');
})

.then(() => { console.log('\nassignmentTodayVisibility: all checks passed'); process.exit(0); })
.catch((e) => { console.error('assignmentTodayVisibility crashed:', e && e.stack || e); process.exit(1); });
