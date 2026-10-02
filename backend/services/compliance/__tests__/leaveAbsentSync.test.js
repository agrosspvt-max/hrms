/**
 * leaveAbsentSync.test.js -- Issue #3 (approved leave still Absent).
 *
 *   1  stale manual Absent superseded by approved full-day leave
 *   2  no prior record -> leave attendance created
 *   3  manual Present preserved (deliberate HR override wins)
 *   4  half-day leave over Absent -> half_paid (not full)
 *   5  rejected leave -> no attendance write (Absent stays)
 *   6  pending leave -> no attendance write (Absent stays)
 *   7  revoke after supersede -> leave-linked record removed
 *   8  multi-date leave -> each working day superseded; holiday/weekly-off skipped
 *   9  past-date approval supersedes a past Absent
 *  10  idempotency -- repeated sync: one record, leaveDelta set once
 *  11  ledger/leaveDelta correct on the superseded record
 *  12  unpaid leave over Absent -> full_unpaid, leaveDelta 0
 *  13  manual half_paid preserved (not overwritten by a full-day leave)
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/leaveAbsentSync.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User       = require('../../../models/User');
const Leave      = require('../../../models/Leave');
const Attendance = require('../../../models/Attendance');
const Holiday    = require('../../../models/Holiday');

[User, Leave, Attendance, Holiday].forEach((m) => _stub.install(m));

const { syncAttendanceForLeave, clearAttendanceForLeave } = require('../../leaveAttendance');
const { startOfDay } = require('../../../utils/dateHelpers');

const D = (iso) => new Date(iso + 'T00:00:00Z');
const ISO = (d) => new Date(d).toISOString().slice(0, 10);
const _mkEmp = async (weeklyOff = [0]) => User.create({
  _id: _oid(), name: 'E', employeeId: 'E1', email: 'e@x', password: 'p',
  role: 'employee', status: 'active', weeklyOff,
});
const _lv = async (emp, from, to, { dayType = 'full', paid = true, status = 'approved' } = {}) => Leave.create({
  _id: _oid(), employee: emp._id, leaveType: 'casual', fromDate: D(from), toDate: D(to),
  dayType, paid, status, decidedBy: _oid(),
});
const _att = async (emp, iso, { status = 'absent', source = 'manual' } = {}) => Attendance.create({
  _id: _oid(), employee: emp._id, date: startOfDay(D(iso)), status, source, setBy: _oid(),
});
const _rec = async (emp, iso) => Attendance.findOne({ employee: emp._id, date: startOfDay(D(iso)) });

/* 1 */ (async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _att(emp, '2026-09-28', { status: 'absent', source: 'manual' });
  const lv = await _lv(emp, '2026-09-28', '2026-09-28');
  await syncAttendanceForLeave(lv);
  const r = await _rec(emp, '2026-09-28');
  assert.strictEqual(r.status, 'full_paid', 'stale absent -> full_paid');
  assert.strictEqual(r.source, 'leave');
  assert.strictEqual(String(r.leaveId), String(lv._id));
  assert.strictEqual(_stub.rows(Attendance).length, 1, 'record updated, not duplicated');
  console.log('  ok  1: stale manual Absent superseded by full-day leave');
})()

/* 2 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const lv = await _lv(emp, '2026-09-28', '2026-09-28');
  await syncAttendanceForLeave(lv);
  const r = await _rec(emp, '2026-09-28');
  assert.strictEqual(r.status, 'full_paid');
  assert.strictEqual(r.source, 'leave');
  console.log('  ok  2: no prior record -> leave attendance created');
})

/* 3 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _att(emp, '2026-09-28', { status: 'present', source: 'manual' });
  const lv = await _lv(emp, '2026-09-28', '2026-09-28');
  await syncAttendanceForLeave(lv);
  const r = await _rec(emp, '2026-09-28');
  assert.strictEqual(r.status, 'present', 'manual Present preserved');
  assert.strictEqual(r.source, 'manual', 'source unchanged');
  console.log('  ok  3: manual Present preserved');
})

/* 4 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _att(emp, '2026-09-28', { status: 'absent', source: 'manual' });
  const lv = await _lv(emp, '2026-09-28', '2026-09-28', { dayType: 'half' });
  await syncAttendanceForLeave(lv);
  const r = await _rec(emp, '2026-09-28');
  assert.strictEqual(r.status, 'half_paid', 'half-day leave over absent -> half_paid (not full)');
  assert.strictEqual(r.leaveDelta, 0.5);
  console.log('  ok  4: half-day leave over Absent -> half_paid');
})

/* 5 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _att(emp, '2026-09-28', { status: 'absent', source: 'manual' });
  const lv = await _lv(emp, '2026-09-28', '2026-09-28', { status: 'rejected' });
  await syncAttendanceForLeave(lv);
  const r = await _rec(emp, '2026-09-28');
  assert.strictEqual(r.status, 'absent', 'rejected leave does not touch attendance');
  console.log('  ok  5: rejected leave -> Absent stays');
})

/* 6 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _att(emp, '2026-09-28', { status: 'absent', source: 'manual' });
  const lv = await _lv(emp, '2026-09-28', '2026-09-28', { status: 'pending' });
  await syncAttendanceForLeave(lv);
  const r = await _rec(emp, '2026-09-28');
  assert.strictEqual(r.status, 'absent', 'pending leave does not override');
  console.log('  ok  6: pending leave -> Absent stays');
})

/* 7 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _att(emp, '2026-09-28', { status: 'absent', source: 'manual' });
  const lv = await _lv(emp, '2026-09-28', '2026-09-28');
  await syncAttendanceForLeave(lv);
  assert.strictEqual((await _rec(emp, '2026-09-28')).source, 'leave');
  await clearAttendanceForLeave(lv._id);
  assert.strictEqual((await _rec(emp, '2026-09-28')), null, 'leave-linked record removed on revoke');
  console.log('  ok  7: revoke removes the leave-linked record');
})

/* 8 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp([0]);           // Sunday weekly-off
  await _att(emp, '2026-09-28', { status: 'absent', source: 'manual' }); // Mon
  await Holiday.create({ _id: _oid(), date: startOfDay(D('2026-09-30')), name: 'H', type: 'company' }); // Wed holiday
  const lv = await _lv(emp, '2026-09-28', '2026-10-04'); // Mon..Sun
  await syncAttendanceForLeave(lv);
  assert.strictEqual((await _rec(emp, '2026-09-28')).status, 'full_paid', 'Mon superseded');
  assert.strictEqual((await _rec(emp, '2026-09-30')), null, 'holiday day NOT given leave attendance');
  assert.strictEqual((await _rec(emp, '2026-10-04')), null, 'Sunday weekly-off NOT given leave attendance');
  console.log('  ok  8: multi-date supersedes working days; skips holiday + weekly-off');
})

/* 9 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _att(emp, '2026-09-01', { status: 'absent', source: 'manual' }); // past date
  const lv = await _lv(emp, '2026-09-01', '2026-09-01');
  await syncAttendanceForLeave(lv);
  assert.strictEqual((await _rec(emp, '2026-09-01')).status, 'full_paid', 'past absent superseded');
  console.log('  ok  9: past-date approval supersedes past Absent');
})

/* 10 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _att(emp, '2026-09-28', { status: 'absent', source: 'manual' });
  const lv = await _lv(emp, '2026-09-28', '2026-09-28');
  await syncAttendanceForLeave(lv);
  await syncAttendanceForLeave(lv);
  await syncAttendanceForLeave(lv);
  assert.strictEqual(_stub.rows(Attendance).length, 1, '3 syncs -> 1 record');
  const r = await _rec(emp, '2026-09-28');
  assert.strictEqual(r.leaveDelta, 1, 'leaveDelta set once, stable');
  console.log('  ok  10: idempotent (no duplicate records / delta stable)');
})

/* 11 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _att(emp, '2026-09-28', { status: 'absent', source: 'manual' });
  const lv = await _lv(emp, '2026-09-28', '2026-09-28');
  await syncAttendanceForLeave(lv);
  const r = await _rec(emp, '2026-09-28');
  assert.strictEqual(r.leaveDelta, 1, 'paid full-day leaveDelta = 1');
  console.log('  ok  11: leaveDelta correct on superseded record');
})

/* 12 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _att(emp, '2026-09-28', { status: 'absent', source: 'manual' });
  const lv = await _lv(emp, '2026-09-28', '2026-09-28', { paid: false });
  await syncAttendanceForLeave(lv);
  const r = await _rec(emp, '2026-09-28');
  assert.strictEqual(r.status, 'full_unpaid');
  assert.strictEqual(r.leaveDelta, 0, 'unpaid leave consumes 0 paid units');
  console.log('  ok  12: unpaid leave over Absent -> full_unpaid, delta 0');
})

/* 13 */ .then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  await _att(emp, '2026-09-28', { status: 'half_paid', source: 'manual' });
  const lv = await _lv(emp, '2026-09-28', '2026-09-28');
  await syncAttendanceForLeave(lv);
  const r = await _rec(emp, '2026-09-28');
  assert.strictEqual(r.status, 'half_paid', 'deliberate manual half_paid preserved');
  assert.strictEqual(r.source, 'manual');
  console.log('  ok  13: manual half_paid preserved (not overwritten)');
})

.then(() => { console.log('\nleaveAbsentSync: all regression tests passed'); process.exit(0); })
.catch((e) => { console.error('leaveAbsentSync test crashed:', e && e.stack || e); process.exit(1); });
