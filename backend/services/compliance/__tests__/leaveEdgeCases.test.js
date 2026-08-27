/**
 * leaveEdgeCases.test.js -- Phase 79 verification of three edge cases:
 *
 *   1. Full <-> Half toggle at approval correctly recalculates Days
 *      (1 <-> 0.5) and snapshots the original dayType.
 *   2. Employee notification content includes the Days change line
 *      whenever the derived days value differs from the request.
 *   3. Leave balance is deducted EXACTLY ONCE per approve and can
 *      never be double-deducted on:
 *        a) HR approving the same request twice (guarded by status
 *           transition -- the second call refuses).
 *        b) Approve + post-approval edit chain (delta = new - old).
 *        c) Approve + revoke -> full refund; second revoke rejected.
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/leaveEdgeCases.test.js
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
const Notification     = require('../../../models/Notification');
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
_stub.install(Notification);
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

const leaveController = require('../../../controllers/leaveController');

const _mkReq = (body, params, user) => ({ body, params, user, ip: '127.0.0.1', get: () => '' });
const _mkRes = () => {
  const res = { statusCode: 200 };
  res.status = (n) => { res.statusCode = n; return res; };
  res.json   = (v) => { res.body = v; return res; };
  return res;
};
const _run = async (h, req) => { const res = _mkRes(); await h(req, res, (e) => { if (e) throw e; }); return res; };

const D = (iso) => new Date(iso + 'T00:00:00Z');
const _mkHR  = async () => User.create({ _id: _oid(), name: 'HR', employeeId: 'H1', email: 'h@x', password: 'p', role: 'hr', status: 'active' });
const _mkEmp = async () => User.create({
  _id: _oid(), name: 'Anoop', employeeId: 'AMI0047', email: 'a@x', password: 'p',
  role: 'employee', status: 'active', weeklyOff: [0],
  leaveBalance: { yearlyAllowance: 30, monthlyAllowance: 3, used: 0 },
});
const _pending = async ({ employee, fromDate, toDate, dayType = 'full', leaveType = 'casual' }) => Leave.create({
  _id: _oid(), employee: employee._id, leaveType,
  fromDate, toDate,
  days: dayType === 'half' ? 0.5 : Math.max(1, Math.round((toDate - fromDate) / 86400000) + 1),
  dayType, status: 'pending', paid: true,
});

/* ================================================================== */
/* 1a -- Full -> Half via dayType override recomputes to 0.5 days.     */
/* ================================================================== */
(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({
    employee: emp,
    fromDate: D('2026-08-25'), toDate: D('2026-08-25'),  // single day, full = 1 day
  });
  assert.strictEqual(lv.days, 1);
  await _run(leaveController.decide, _mkReq({
    decision: 'approved', dayType: 'half',
  }, { id: String(lv._id) }, hr));
  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.dayType, 'half');
  assert.strictEqual(after.days, 0.5, 'Full -> Half recomputes to 0.5');
  assert.strictEqual(after.originalRequest.dayType, 'full', 'original dayType preserved');
  assert.strictEqual(after.originalRequest.days, 1);
  const user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 0.5, 'balance = 0.5, not 1');
  console.log('  ok  1a: Full -> Half recomputes days to 0.5');
})()

/* ================================================================== */
/* 1b -- Half -> Full via dayType override recomputes to 1 day.        */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({
    employee: emp,
    fromDate: D('2026-08-25'), toDate: D('2026-08-25'), dayType: 'half',
  });
  assert.strictEqual(lv.days, 0.5);
  await _run(leaveController.decide, _mkReq({
    decision: 'approved', dayType: 'full',
  }, { id: String(lv._id) }, hr));
  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.dayType, 'full');
  assert.strictEqual(after.days, 1, 'Half -> Full recomputes to 1');
  assert.strictEqual(after.originalRequest.dayType, 'half');
  assert.strictEqual(after.originalRequest.days, 0.5);
  const user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 1, 'balance = 1, not 0.5');
  console.log('  ok  1b: Half -> Full recomputes days to 1');
})

/* ================================================================== */
/* 1c -- Half toggle rejected when the range spans multiple days.      */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({
    employee: emp,
    fromDate: D('2026-08-25'), toDate: D('2026-08-27'),
  });
  let threw = false;
  try {
    await _run(leaveController.decide, _mkReq({
      decision: 'approved', dayType: 'half',
    }, { id: String(lv._id) }, hr));
  } catch (e) {
    threw = /Half-day leave is only allowed/.test(e.message);
  }
  assert.ok(threw, 'expected validation error');
  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.status, 'pending', 'leave untouched on validation error');
  console.log('  ok  1c: Half toggle rejected on multi-day range');
})

/* ================================================================== */
/* 2 -- Employee notification body includes the Days change.           */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({
    employee: emp,
    fromDate: D('2026-08-25'), toDate: D('2026-08-28'),   // 4 mid-week days
  });
  await _run(leaveController.decide, _mkReq({
    decision: 'approved', toDate: '2026-08-27',   // trim to 3
  }, { id: String(lv._id) }, hr));
  const notif = _stub.rows(Notification).find((n) => String(n.recipient) === String(emp._id));
  assert.ok(notif, 'notification created');
  assert.ok(/Days:\s*4\s*→\s*3/.test(notif.message), `notification message must include days change; got: ${notif.message}`);
  assert.ok(/End Date/.test(notif.message), 'includes end-date change too');
  console.log('  ok  2: notification includes the Days change');
})

/* ================================================================== */
/* 3a -- Balance deducted exactly once per approve.                    */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({
    employee: emp,
    fromDate: D('2026-08-25'), toDate: D('2026-08-27'),
  });
  await _run(leaveController.decide, _mkReq({ decision: 'approved' }, { id: String(lv._id) }, hr));
  let user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 3, 'first approve deducts 3');

  // Second decision call should refuse (already-decided).
  let threw = false;
  try {
    await _run(leaveController.decide, _mkReq({ decision: 'approved' }, { id: String(lv._id) }, hr));
  } catch (e) { threw = /Leave already decided/.test(e.message); }
  assert.ok(threw, 'second approval refused');

  user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 3, 'balance still 3 (no double-deduct)');
  console.log('  ok  3a: balance deducted exactly once per approve');
})

/* ================================================================== */
/* 3b -- Approve then post-approval edit applies (new - old) delta.    */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({
    employee: emp,
    fromDate: D('2026-08-25'), toDate: D('2026-08-27'),   // 3 days
  });
  await _run(leaveController.decide, _mkReq({ decision: 'approved' }, { id: String(lv._id) }, hr));
  let user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 3, 'after approve');

  // Post-approval edit: widen to 4 days (Tue..Fri).
  await _run(leaveController.edit, _mkReq({ toDate: '2026-08-28' }, { id: String(lv._id) }, hr));
  user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 4, 'edit delta +1 applied once');

  // Shrink back to 2 days -> delta -2.
  await _run(leaveController.edit, _mkReq({ toDate: '2026-08-26' }, { id: String(lv._id) }, hr));
  user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 2, 'edit delta -2 applied once');
  console.log('  ok  3b: post-approval edits apply (new-old) delta, never double');
})

/* ================================================================== */
/* 3c -- Approve + revoke restores balance; second revoke refused.     */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({
    employee: emp,
    fromDate: D('2026-08-25'), toDate: D('2026-08-27'),
  });
  await _run(leaveController.decide, _mkReq({ decision: 'approved' }, { id: String(lv._id) }, hr));
  let user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 3);

  await _run(leaveController.revoke, _mkReq({ reason: 'oops' }, { id: String(lv._id) }, hr));
  user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 0, 'revoke restores full 3 days');

  let threw = false;
  try {
    await _run(leaveController.revoke, _mkReq({ reason: 'again' }, { id: String(lv._id) }, hr));
  } catch (e) { threw = /Only an approved leave can be revoked/.test(e.message); }
  assert.ok(threw, 'second revoke refused');
  user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 0, 'no additional refund');
  console.log('  ok  3c: approve+revoke refunds once; second revoke refused');
})

.then(() => { console.log('\nleaveEdgeCases: all edge-case checks passed'); process.exit(0); })
.catch((e) => { console.error('leaveEdgeCases test crashed:', e && e.stack || e); process.exit(1); });
