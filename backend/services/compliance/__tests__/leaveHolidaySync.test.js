/**
 * leaveHolidaySync.test.js -- Issue #2 (holidays vs leave days).
 *
 *   1  effectiveLeaveDays excludes a holiday inside the range
 *   2  multiple holidays excluded
 *   3  holiday + weekly-off not double-counted
 *   4  edit() recomputes days holiday-aware (no raw formula)
 *   5  half-day stays 0.5 (holiday logic can't inflate it)
 *   6  recalc: balance decreases by exactly the delta (holiday added)
 *   7  recalc: balance increases by exactly the delta (holiday removed)
 *   8  recalc: same value -> no balance change
 *   9  holiday added after approval -> 5 -> 4 days + refund
 *  10  holiday removed after approval -> 4 -> 5 days + deduct
 *  11  idempotency: recalc twice -> days + balance change once
 *  12  multiple employees: only the intersecting leave changes
 *  13  attendance: no leave-attendance row on the now-holiday day
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/leaveHolidaySync.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User            = require('../../../models/User');
const Leave           = require('../../../models/Leave');
const Holiday         = require('../../../models/Holiday');
const Event           = require('../../../models/Event');
const Submission      = require('../../../models/Submission');
const Attendance      = require('../../../models/Attendance');
const Template        = require('../../../models/Template');
const Assignment      = require('../../../models/Assignment');
const DependencyTask  = require('../../../models/DependencyTask');
const Penalty         = require('../../../models/Penalty');
const ComplianceRule  = require('../../../models/ComplianceRule');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceEvent = require('../../../models/ComplianceEvent');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const MarksLedger     = require('../../../models/MarksLedger');
const FinancialLedger = require('../../../models/FinancialLedger');
const PercentageLedger = require('../../../models/PercentageLedger');
const AttendanceLedger = require('../../../models/AttendanceLedger');
const AuditLog        = require('../../../models/AuditLog');

[User, Leave, Holiday, Event, Submission, Attendance, Template, Assignment,
 DependencyTask, Penalty, ComplianceRule, ComplianceEvent, ComplianceActionEffect,
 MarksLedger, FinancialLedger, PercentageLedger, AttendanceLedger, AuditLog]
  .forEach((m) => _stub.install(m));
_stub.install(ComplianceIncident, { uniqueBy: [{ keys: ['naturalKey'], filter: { source: 'automatic' } }] });

const { effectiveLeaveDays, startOfDay } = require('../../../utils/dateHelpers');
const { holidayDaySet } = require('../../eventOccurrences');
const leaveHolidaySync = require('../../leaveHolidaySync');
const leaveController = require('../../../controllers/leaveController');

const D = (iso) => new Date(iso + 'T00:00:00Z');
const ISO = (d) => new Date(d).toISOString().slice(0, 10);
const _mkEmp = async (used = 0) => User.create({
  _id: _oid(), name: 'E', employeeId: 'E1', email: 'e@x', password: 'p', role: 'employee',
  status: 'active', weeklyOff: [0], leaveBalance: { yearlyAllowance: 30, monthlyAllowance: 3, used },
});
const _approved = async (emp, from, to, dayType = 'full', days) => Leave.create({
  _id: _oid(), employee: emp._id, leaveType: 'casual', fromDate: D(from), toDate: D(to),
  dayType, days, status: 'approved', paid: true,
});
const _holiday = async (iso) => Holiday.create({ _id: _oid(), date: startOfDay(D(iso)), name: 'H', type: 'company' });

// express harness for edit()
const _mkReq = (body, params, user) => ({ body: body || {}, params: params || {}, query: {}, user, ip: '127.0.0.1', get: () => '' });
const _mkRes = () => { const r = { statusCode: 200 }; r.status = (n) => { r.statusCode = n; return r; }; r.json = (v) => { r.body = v; return r; }; return r; };
const _run = async (h, req) => { const res = _mkRes(); let thrown = null; await h(req, res, (e) => { if (e) thrown = e; }); return { res, thrown }; };

/* 1 */ (async () => {
  const days = effectiveLeaveDays({ from: D('2026-09-01'), to: D('2026-09-05'), weeklyOff: [0], dayType: 'full', holidaySet: new Set(['2026-09-03']) });
  assert.strictEqual(days, 4, '1 Sept–5 Sept minus 3 Sept holiday = 4');
  console.log('  ok  1: effectiveLeaveDays excludes holiday');
})()

/* 2 */ .then(async () => {
  const days = effectiveLeaveDays({ from: D('2026-09-01'), to: D('2026-09-10'), weeklyOff: [0], dayType: 'full', holidaySet: new Set(['2026-09-03', '2026-09-07']) });
  // Sept 2026: 6 & 8 are Sundays? 1=Tue..6=Sun,7=Mon,8=Tue,9=Wed,10=Thu.
  // Working span 1-10 excludes Sun(6) -> 9 days; minus 2 holidays (3,7) -> 7.
  assert.strictEqual(days, 7, 'two holidays + one Sunday excluded');
  console.log('  ok  2: multiple holidays excluded');
})

/* 3 */ .then(async () => {
  // Holiday that falls ON a Sunday must not be double-subtracted.
  const days = effectiveLeaveDays({ from: D('2026-09-01'), to: D('2026-09-07'), weeklyOff: [0], dayType: 'full', holidaySet: new Set(['2026-09-06']) });
  // 1-7 minus Sun(6). Holiday also on 6 -> still just one exclusion. 1,2,3,4,5,7 = 6.
  assert.strictEqual(days, 6, 'holiday on weekly-off counted once');
  console.log('  ok  3: holiday+weekly-off not double-counted');
})

/* 4 */ .then(async () => {
  _stub.reset();
  const hr = await User.create({ _id: _oid(), name: 'HR', employeeId: 'H', email: 'h@x', password: 'p', role: 'hr', status: 'active' });
  const emp = await _mkEmp();
  await _holiday('2026-09-03');
  // pending leave 1-2 Sept (2 days); HR edits to 1-5 Sept -> effective 4 (excl holiday 3).
  const lv = await Leave.create({ _id: _oid(), employee: emp._id, leaveType: 'casual', fromDate: D('2026-09-01'), toDate: D('2026-09-02'), dayType: 'full', days: 2, status: 'approved', paid: true });
  await _run(leaveController.edit, _mkReq({ toDate: '2026-09-05' }, { id: String(lv._id) }, hr));
  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.days, 4, 'edit recomputes holiday-aware (5 span - 1 holiday = 4)');
  console.log('  ok  4: edit() is holiday-aware (no raw formula)');
})

/* 5 */ .then(async () => {
  const half = effectiveLeaveDays({ from: D('2026-09-02'), to: D('2026-09-02'), weeklyOff: [0], dayType: 'half', holidaySet: new Set() });
  assert.strictEqual(half, 0.5, 'half-day = 0.5');
  const halfOnHoliday = effectiveLeaveDays({ from: D('2026-09-03'), to: D('2026-09-03'), weeklyOff: [0], dayType: 'half', holidaySet: new Set(['2026-09-03']) });
  assert.strictEqual(halfOnHoliday, 0, 'half-day on a holiday = 0 (never inflated)');
  console.log('  ok  5: half-day stays 0.5 / 0 on holiday');
})

/* 6, 9 -- holiday added after approval: 5 -> 4 + refund. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp(5);   // 5 days already consumed
  await _approved(emp, '2026-09-01', '2026-09-05', 'full', 5);   // stored 5
  await _holiday('2026-09-03');
  const r = await leaveHolidaySync.recalcApprovedLeavesForDates({ dates: [D('2026-09-03')], reason: 'test' });
  assert.strictEqual(r.recalculated.length, 1);
  assert.strictEqual(r.recalculated[0].newDays, 4);
  assert.strictEqual((await Leave.findOne({ employee: emp._id })).days, 4, 'days 5 -> 4');
  assert.strictEqual((await User.findById(emp._id)).leaveBalance.used, 4, 'balance refunded by 1 (5 -> 4)');
  console.log('  ok  6/9: holiday added after approval -> 4 days + 1 refunded');
})

/* 7, 10 -- holiday removed after approval: 4 -> 5 + deduct. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp(4);   // was 4 (holiday had reduced it)
  await _approved(emp, '2026-09-01', '2026-09-05', 'full', 4);   // stored 4
  // No holiday now (removed) -> recalc over the (former holiday) date.
  const r = await leaveHolidaySync.recalcApprovedLeavesForDates({ dates: [D('2026-09-03')], reason: 'test' });
  assert.strictEqual(r.recalculated[0].newDays, 5, 'days 4 -> 5 after holiday removed');
  assert.strictEqual((await User.findById(emp._id)).leaveBalance.used, 5, 'balance deducted by 1 (4 -> 5)');
  console.log('  ok  7/10: holiday removed -> 5 days + 1 deducted');
})

/* 8 -- same value: no balance change. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp(5);
  await _approved(emp, '2026-09-01', '2026-09-05', 'full', 5);   // already correct (no holiday)
  const r = await leaveHolidaySync.recalcApprovedLeavesForDates({ dates: [D('2026-09-03')], reason: 'test' });
  assert.strictEqual(r.recalculated.length, 0, 'nothing recalculated');
  assert.strictEqual(r.unchanged, 1);
  assert.strictEqual((await User.findById(emp._id)).leaveBalance.used, 5, 'balance unchanged');
  console.log('  ok  8: same value -> no balance change');
})

/* 11 -- idempotency. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp(5);
  await _approved(emp, '2026-09-01', '2026-09-05', 'full', 5);
  await _holiday('2026-09-03');
  await leaveHolidaySync.recalcApprovedLeavesForDates({ dates: [D('2026-09-03')], reason: 'r1' });
  await leaveHolidaySync.recalcApprovedLeavesForDates({ dates: [D('2026-09-03')], reason: 'r2' });
  await leaveHolidaySync.recalcApprovedLeavesForDates({ dates: [D('2026-09-03')], reason: 'r3' });
  assert.strictEqual((await Leave.findOne({ employee: emp._id })).days, 4, 'days changed once');
  assert.strictEqual((await User.findById(emp._id)).leaveBalance.used, 4, 'balance changed once (not 3, not 2)');
  console.log('  ok  11: idempotent (days + balance change once)');
})

/* 12 -- multiple employees: only the intersecting leave changes. */
.then(async () => {
  _stub.reset();
  const a = await _mkEmp(5); const b = await _mkEmp(3);
  await _approved(a, '2026-09-01', '2026-09-05', 'full', 5);   // covers 3 Sept
  await _approved(b, '2026-09-10', '2026-09-12', 'full', 3);   // does NOT cover 3 Sept
  await _holiday('2026-09-03');
  await leaveHolidaySync.recalcApprovedLeavesForDates({ dates: [D('2026-09-03')], reason: 'test' });
  assert.strictEqual((await Leave.findOne({ employee: a._id })).days, 4, 'A recalculated');
  assert.strictEqual((await Leave.findOne({ employee: b._id })).days, 3, 'B untouched');
  assert.strictEqual((await User.findById(b._id)).leaveBalance.used, 3, 'B balance untouched');
  console.log('  ok  12: only intersecting employee changes');
})

/* 13 -- attendance: no leave-attendance on the now-holiday day. */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp(5);
  await _approved(emp, '2026-09-01', '2026-09-05', 'full', 5);
  await _holiday('2026-09-03');
  await leaveHolidaySync.recalcApprovedLeavesForDates({ dates: [D('2026-09-03')], reason: 'test' });
  const leaveRows = _stub.rows(Attendance).filter((r) => r.source === 'leave');
  const onHoliday = leaveRows.find((r) => ISO(r.date) === '2026-09-03');
  assert.ok(!onHoliday, 'no leave-attendance row on the holiday day');
  assert.ok(leaveRows.length >= 1, 'leave attendance still created for working days');
  console.log('  ok  13: attendance excludes the holiday day');
})

.then(() => { console.log('\nleaveHolidaySync: all regression tests passed'); process.exit(0); })
.catch((e) => { console.error('leaveHolidaySync test crashed:', e && e.stack || e); process.exit(1); });
