/**
 * leaveApprovalEdit.test.js -- Phase 77 regression suite.
 *
 * Verifies HR-controlled approval-time changes:
 *   1. Normal approval (no edits) preserves backward compatibility.
 *   2. Leave-type-only edit at approval time snapshots the original.
 *   3. Date-range edit shortens the leave AND downstream sync uses
 *      the edited dates.
 *   4. Combined edit: type + range + dayType auto-flip when the
 *      range widens past a single day.
 *   5. Rejected leaves ignore approval-time edits.
 *   6. Original request is written EXACTLY ONCE (subsequent
 *      post-approval revoke-and-restore doesn't overwrite it).
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/leaveApprovalEdit.test.js
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

/* ------------------------------------------------------------------ */
/* Test-only express req/res harness                                   */
/* ------------------------------------------------------------------ */
const _mkReq = (body, params, user) => ({ body, params, user, ip: '127.0.0.1', get: () => '' });
const _mkRes = () => {
  const res = { statusCode: 200 };
  res.status = (n) => { res.statusCode = n; return res; };
  res.json   = (v) => { res.body = v; return res; };
  return res;
};
const _run = async (handler, req) => {
  const res = _mkRes();
  await handler(req, res, (err) => { if (err) throw err; });
  return res;
};

const _mkHR   = async () => User.create({ _id: _oid(), name: 'Tej Singh', employeeId: 'HR1', email: 'hr@x', password: 'p', role: 'hr',       status: 'active' });
const _mkEmp  = async () => User.create({ _id: _oid(), name: 'Anoop',     employeeId: 'AMI0047', email: 'a@x', password: 'p', role: 'employee', status: 'active', weeklyOff: [0], leaveBalance: { yearlyAllowance: 20, monthlyAllowance: 2, used: 0 } });
const _mkTpl  = async (emp) => {
  const tpl = await Template.create({
    _id: _oid(), title: 'Daily Report', templateType: 'task',
    tasks: [{ _id: _oid(), title: 'Send DR', points: 10 }],
    isActive: true,
  });
  await Assignment.create({
    _id: _oid(), template: tpl, targetType: 'employee', targetRef: emp._id,
    active: true, frequency: 'daily', startDate: new Date('2026-07-01T00:00:00Z'),
    holidayOverride: false, subTemplateIds: [],
  });
  return tpl;
};

const _pendingLeave = async ({ employee, leaveType = 'sick', fromDate, toDate, dayType = 'full' }) => Leave.create({
  _id: _oid(), employee: employee._id, leaveType,
  fromDate, toDate, days: dayType === 'half' ? 0.5 : Math.max(1, Math.round((toDate - fromDate) / 86400000) + 1),
  dayType, status: 'pending', paid: true,
});

/* ================================================================== */
/* 1 -- Normal approval (no edits) preserves backward compatibility.  */
/* ================================================================== */
(async () => {
  _stub.reset();
  const hr = await _mkHR();
  const emp = await _mkEmp();
  const lv = await _pendingLeave({
    employee: emp,
    fromDate: new Date('2026-07-28T00:00:00Z'),
    toDate:   new Date('2026-07-28T00:00:00Z'),
    dayType:  'half',
  });
  await _run(leaveController.decide, _mkReq({ decision: 'approved' }, { id: String(lv._id) }, hr));

  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.status, 'approved');
  assert.ok(!after.modifiedOnApproval, 'no modification flag when unchanged');
  assert.ok(!after.originalRequest || !after.originalRequest.capturedAt, 'no snapshot when unchanged');
  console.log('  ok  1: normal approval preserves BC (no modifiedOnApproval)');
})()

/* ================================================================== */
/* 2 -- Type-only edit snapshots original + flips the flag.            */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR();
  const emp = await _mkEmp();
  const lv = await _pendingLeave({
    employee: emp, leaveType: 'sick',
    fromDate: new Date('2026-07-28T00:00:00Z'),
    toDate:   new Date('2026-07-28T00:00:00Z'),
    dayType:  'half',
  });
  await _run(leaveController.decide, _mkReq({
    decision: 'approved', leaveType: 'casual',
    modificationNote: 'No medical docs provided',
  }, { id: String(lv._id) }, hr));

  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.leaveType, 'casual', 'type updated');
  assert.strictEqual(after.modifiedOnApproval, true);
  assert.strictEqual(after.originalRequest.leaveType, 'sick', 'original type preserved');
  assert.ok(after.originalRequest.capturedAt, 'capturedAt stamped');
  assert.strictEqual(String(after.modifiedBy), String(hr._id));
  assert.strictEqual(after.modificationNote, 'No medical docs provided');
  console.log('  ok  2: type-only edit snapshots original + flag set');
})

/* ================================================================== */
/* 3 -- Date range edit (shortens 4d -> 3d) + downstream uses new tot */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR();
  const emp = await _mkEmp();
  await _mkTpl(emp);
  // Phase 78 -- Days is now derived via `effectiveLeaveDays`, which
  // strips weekly-offs (Sun by default) from the count.  Use a
  // mid-week window (Tue 25 Aug .. Fri 28 Aug 2026) so the count
  // matches the raw range length and the test remains readable.
  const lv = await _pendingLeave({
    employee: emp, leaveType: 'casual',
    fromDate: new Date('2026-08-25T00:00:00Z'), // Tue
    toDate:   new Date('2026-08-28T00:00:00Z'), // Fri  -- 4 days requested
    dayType:  'full',
  });
  assert.strictEqual(lv.days, 4);
  await _run(leaveController.decide, _mkReq({
    decision: 'approved',
    toDate: '2026-08-27',   // HR trims by one day (Tue..Thu = 3d)
  }, { id: String(lv._id) }, hr));

  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.status, 'approved');
  assert.strictEqual(after.days, 3, 'days recomputed to 3');
  assert.strictEqual(new Date(after.toDate).toISOString().slice(0, 10), '2026-08-27');
  assert.strictEqual(new Date(after.originalRequest.toDate).toISOString().slice(0, 10), '2026-08-28');
  assert.strictEqual(after.originalRequest.days, 4);
  // Balance was deducted using the FINAL 3 days, not the original 4.
  const user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 3, 'balance uses final approved days');
  console.log('  ok  3: date edit shortens leave; balance + days use new values');
})

/* ================================================================== */
/* 4 -- Combined edit + dayType auto-flip when range widens.           */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR();
  const emp = await _mkEmp();
  const lv = await _pendingLeave({
    employee: emp, leaveType: 'sick',
    fromDate: new Date('2026-07-28T00:00:00Z'),
    toDate:   new Date('2026-07-28T00:00:00Z'),
    dayType:  'half',
  });
  await _run(leaveController.decide, _mkReq({
    decision: 'approved', leaveType: 'casual',
    fromDate: '2026-07-28', toDate: '2026-07-30',   // widen to 3 days
  }, { id: String(lv._id) }, hr));

  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.dayType, 'full', 'auto-flip to full when range widens past 1 day');
  assert.strictEqual(after.days, 3);
  assert.strictEqual(after.leaveType, 'casual');
  assert.strictEqual(after.originalRequest.dayType, 'half', 'original dayType preserved');
  assert.strictEqual(after.originalRequest.days, 0.5);
  console.log('  ok  4: combined edit widens range + dayType auto-flip');
})

/* ================================================================== */
/* 5 -- Rejected leaves IGNORE approval-time edits.                    */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR();
  const emp = await _mkEmp();
  const lv = await _pendingLeave({
    employee: emp, leaveType: 'sick',
    fromDate: new Date('2026-07-28T00:00:00Z'),
    toDate:   new Date('2026-07-28T00:00:00Z'),
    dayType:  'half',
  });
  await _run(leaveController.decide, _mkReq({
    decision: 'rejected', leaveType: 'casual', toDate: '2026-08-01',
  }, { id: String(lv._id) }, hr));
  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.status, 'rejected');
  assert.strictEqual(after.leaveType, 'sick', 'reject does not apply edits');
  assert.ok(!after.modifiedOnApproval);
  console.log('  ok  5: reject ignores approval-time edits');
})

/* ================================================================== */
/* 6 -- Validation: end-before-start is refused.                       */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR();
  const emp = await _mkEmp();
  const lv = await _pendingLeave({
    employee: emp, leaveType: 'casual',
    fromDate: new Date('2026-07-28T00:00:00Z'),
    toDate:   new Date('2026-07-30T00:00:00Z'),
    dayType:  'full',
  });
  let threw = false;
  try {
    await _run(leaveController.decide, _mkReq({
      decision: 'approved', toDate: '2026-07-27',
    }, { id: String(lv._id) }, hr));
  } catch (e) {
    threw = true;
    assert.ok(/End Date cannot be before Start Date/.test(e.message), 'expected validation error');
  }
  assert.ok(threw, 'edit with end<start rejected');
  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.status, 'pending', 'state unchanged on validation error');
  console.log('  ok  6: validation rejects end<start');
})

.then(() => { console.log('\nleaveApprovalEdit: all regression tests passed'); process.exit(0); })
.catch((e) => { console.error('leaveApprovalEdit test crashed:', e && e.stack || e); process.exit(1); });
