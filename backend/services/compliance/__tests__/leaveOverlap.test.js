/**
 * leaveOverlap.test.js -- F1 (P1 data-integrity) regression suite.
 *
 * Root cause fixed: neither apply(), decide(), nor edit() checked for
 * an existing ACTIVE (pending/approved) leave occupying the same dates,
 * so overlapping leaves could be created and each approval independently
 * deducted leaveBalance.used -> cumulative over-deduction.
 *
 * These tests drive the REAL controllers through the express harness and
 * the in-memory Mongo stub, so they exercise the exact production guard
 * (findOverlappingLeaves + the 409 leave_overlap contract).
 *
 * Overlap rule under test:
 *   - active statuses {pending, approved} occupy dates; rejected/revoked
 *     do NOT block.
 *   - raw requested-range intersection at day granularity (dayType
 *     ignored -- no half-day combining exists).
 *   - guard runs BEFORE any mutation: balance / attendance / sync / audit
 *     are untouched on a blocked op.
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/leaveOverlap.test.js
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
const LeaveAttachment  = require('../../../models/LeaveAttachment');

[Event, User, Leave, Submission, Attendance, Holiday, Template, Assignment,
 DependencyTask, Penalty, Notification, ComplianceRule, ComplianceEvent,
 ComplianceActionEffect, MarksLedger, FinancialLedger, PercentageLedger,
 AttendanceLedger, AuditLog, LeaveAttachment].forEach((m) => _stub.install(m));
_stub.install(ComplianceIncident, { uniqueBy: [{ keys: ['naturalKey'], filter: { source: 'automatic' } }] });

const leaveController = require('../../../controllers/leaveController');
const { startOfDay } = require('../../../utils/dateHelpers');

/* express harness */
const _mkReq = (body, params, user) => ({ body: body || {}, params: params || {}, query: {}, user, ip: '127.0.0.1', get: () => '' });
const _mkRes = () => { const r = { statusCode: 200 }; r.status = (n) => { r.statusCode = n; return r; }; r.json = (v) => { r.body = v; return r; }; return r; };
const _run = async (h, req) => {
  const res = _mkRes(); let err = null;
  await h(req, res, (e) => { if (e) err = e; });
  return { res, err };
};

const D = (iso) => new Date(iso + 'T00:00:00Z');
const _mkHR  = async () => User.create({ _id: _oid(), name: 'HR', employeeId: 'HR1', email: 'hr@x', password: 'p', role: 'hr', status: 'active' });
const _mkEmp = async () => User.create({ _id: _oid(), name: 'Emp', employeeId: 'E1', email: 'e@x', password: 'p', role: 'employee', status: 'active', weeklyOff: [0], leaveBalance: { yearlyAllowance: 30, monthlyAllowance: 3, used: 0 } });
const _leave = async (emp, from, to, { status = 'approved', dayType = 'full', leaveType = 'casual', paid = true } = {}) => Leave.create({
  _id: _oid(), employee: emp._id, leaveType, fromDate: D(from), toDate: D(to),
  days: dayType === 'half' ? 0.5 : Math.max(1, Math.round((D(to) - D(from)) / 86400000) + 1),
  dayType, status, paid,
});
const _used = async (empId) => Number((await User.findById(empId)).leaveBalance?.used) || 0;
// Seed nested leaveBalance.used via load+save (the in-memory stub does
// NOT expand dotted `$set` paths the way real Mongo does).
const _setUsed = async (empId, n) => { const u = await User.findById(empId); u.leaveBalance.used = n; await u.save(); };

// Employee self-apply through the real controller.
const _apply = (emp, from, to, extra = {}) =>
  _run(leaveController.apply, _mkReq({ fromDate: from, toDate: to, leaveType: 'casual', ...extra }, {}, emp));
// HR decision through the real controller.
const _decide = (hr, leaveId, body) =>
  _run(leaveController.decide, _mkReq(body, { id: String(leaveId) }, hr));
// HR post-approval edit.
const _edit = (hr, leaveId, body) =>
  _run(leaveController.edit, _mkReq(body, { id: String(leaveId) }, hr));

let passed = 0;
const ok = (n, msg) => { console.log(`  ok  ${n}: ${msg}`); passed += 1; };

/* ==== BASIC OVERLAP (apply) ==== */
/* 1 exact duplicate */ (async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12', { status: 'approved' });
  const { res } = await _apply(emp, '2026-09-10', '2026-09-12');
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.error, 'leave_overlap');
  assert.strictEqual(res.body.conflicts.length, 1);
  ok(1, 'exact duplicate blocked (409 leave_overlap)');
})()
/* 2 partial overlap at start */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12');
  const { res } = await _apply(emp, '2026-09-12', '2026-09-15'); // shares 12th
  assert.strictEqual(res.statusCode, 409); ok(2, 'partial overlap at start blocked');
})
/* 3 partial overlap at end */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-15');
  const { res } = await _apply(emp, '2026-09-08', '2026-09-10'); // shares 10th
  assert.strictEqual(res.statusCode, 409); ok(3, 'partial overlap at end blocked');
})
/* 4 new contains old */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12');
  const { res } = await _apply(emp, '2026-09-08', '2026-09-20');
  assert.strictEqual(res.statusCode, 409); ok(4, 'new range contains old blocked');
})
/* 5 old contains new */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-15');
  const { res } = await _apply(emp, '2026-09-11', '2026-09-12');
  assert.strictEqual(res.statusCode, 409); ok(5, 'old range contains new blocked');
})
/* 6 single day inside multi-day (Fri 11th; 13th is Sunday/weekly-off) */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-15');
  const { res } = await _apply(emp, '2026-09-11', '2026-09-11');
  assert.strictEqual(res.statusCode, 409); ok(6, 'single day inside multi-day blocked');
})
/* 6b adjacent (no shared day) is allowed */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12');
  const { res } = await _apply(emp, '2026-09-14', '2026-09-16'); // 13th free, no touch
  assert.strictEqual(res.statusCode, 201, 'non-overlapping request allowed');
  ok('6b', 'adjacent non-overlapping leave allowed (no false positive)');
})

/* ==== STATUS ==== */
/* 7 approved blocks */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12', { status: 'approved' });
  const { res } = await _apply(emp, '2026-09-11', '2026-09-11');
  assert.strictEqual(res.statusCode, 409); ok(7, 'approved leave blocks overlap');
})
/* 8 pending blocks */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12', { status: 'pending' });
  const { res } = await _apply(emp, '2026-09-11', '2026-09-11');
  assert.strictEqual(res.statusCode, 409); ok(8, 'pending leave blocks overlap');
})
/* 9 rejected does NOT block */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12', { status: 'rejected' });
  const { res } = await _apply(emp, '2026-09-11', '2026-09-11');
  assert.strictEqual(res.statusCode, 201, 'rejected must not block re-request');
  ok(9, 'rejected leave does NOT block');
})
/* 10 revoked does NOT block */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12', { status: 'revoked' });
  const { res } = await _apply(emp, '2026-09-11', '2026-09-11');
  assert.strictEqual(res.statusCode, 201, 'revoked must not block re-request');
  ok(10, 'revoked leave does NOT block');
})

/* ==== HR APPROVAL ==== */
/* 11 pending overlapping leave cannot be approved */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12', { status: 'approved' });
  const b = await _leave(emp, '2026-09-11', '2026-09-15', { status: 'pending' }); // slipped in earlier
  const { res } = await _decide(hr, b._id, { decision: 'approved' });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.error, 'leave_overlap');
  const after = await Leave.findById(b._id);
  assert.strictEqual(after.status, 'pending', 'blocked approval leaves it pending');
  ok(11, 'overlapping pending leave cannot be approved');
})
/* 12 HR date modification cannot create overlap */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12', { status: 'approved' });
  const b = await _leave(emp, '2026-09-20', '2026-09-21', { status: 'pending' }); // no overlap as requested
  // HR tries to approve but shifts dates onto the existing leave.
  const { res } = await _decide(hr, b._id, { decision: 'approved', fromDate: '2026-09-11', toDate: '2026-09-13' });
  assert.strictEqual(res.statusCode, 409, 'HR-modified window overlap blocked');
  const after = await Leave.findById(b._id);
  assert.strictEqual(after.status, 'pending', 'not approved');
  ok(12, 'HR date modification into overlap blocked at approval');
})
/* 13 rejected approval leaves original unchanged (reject never overlaps) */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12', { status: 'approved' });
  const b = await _leave(emp, '2026-09-11', '2026-09-13', { status: 'pending' });
  const { res } = await _decide(hr, b._id, { decision: 'rejected' });
  assert.strictEqual(res.statusCode, 200, 'reject is allowed even when dates overlap');
  assert.strictEqual((await Leave.findById(b._id)).status, 'rejected');
  ok(13, 'overlapping leave can still be rejected');
})

/* ==== POST-APPROVAL EDIT ==== */
/* 14 approved leave cannot be edited into another leave */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  const a = await _leave(emp, '2026-09-10', '2026-09-12', { status: 'approved' });
  const b = await _leave(emp, '2026-09-14', '2026-09-16', { status: 'approved' });
  const { res } = await _edit(hr, a._id, { fromDate: '2026-09-10', toDate: '2026-09-15' }); // now hits B
  assert.strictEqual(res.statusCode, 409);
  const after = await Leave.findById(a._id);
  assert.strictEqual(startOfDay(after.toDate).getTime(), D('2026-09-12').getTime(), 'A dates unchanged');
  ok(14, 'approved leave cannot be edited into another leave window');
})
/* 15 failed edit does not alter balance */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  const a = await _leave(emp, '2026-09-10', '2026-09-12', { status: 'approved' });
  await _leave(emp, '2026-09-14', '2026-09-16', { status: 'approved' });
  await _setUsed(emp._id, 6);
  const before = await _used(emp._id);
  await _edit(hr, a._id, { fromDate: '2026-09-10', toDate: '2026-09-15' });
  assert.strictEqual(await _used(emp._id), before, 'balance unchanged after blocked edit');
  ok(15, 'blocked edit does not alter balance');
})
/* 16 failed edit does not alter attendance */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  const a = await _leave(emp, '2026-09-10', '2026-09-12', { status: 'approved' });
  await _leave(emp, '2026-09-14', '2026-09-16', { status: 'approved' });
  await Attendance.create({ _id: _oid(), employee: emp._id, date: D('2026-09-15'), status: 'present', source: 'manual' });
  const before = _stub.rows(Attendance).length;
  await _edit(hr, a._id, { fromDate: '2026-09-10', toDate: '2026-09-15' });
  assert.strictEqual(_stub.rows(Attendance).length, before, 'no attendance rows written on blocked edit');
  assert.strictEqual((await Attendance.findOne({ employee: emp._id, date: D('2026-09-15') })).status, 'present');
  ok(16, 'blocked edit does not alter attendance');
})
/* 17 failed edit does not trigger businessStateSync (no submission mutation) */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  const a = await _leave(emp, '2026-09-10', '2026-09-12', { status: 'approved' });
  await _leave(emp, '2026-09-14', '2026-09-16', { status: 'approved' });
  const subCountBefore = _stub.rows(Submission).length;
  const { res } = await _edit(hr, a._id, { toDate: '2026-09-15' });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(_stub.rows(Submission).length, subCountBefore, 'no submissions materialised/hidden');
  ok(17, 'blocked edit does not trigger downstream sync');
})

/* ==== HALF-DAY (no combining exists -> any shared day blocks) ==== */
/* 18 full + half same date blocked */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-10', { status: 'approved', dayType: 'full' });
  const { res } = await _apply(emp, '2026-09-10', '2026-09-10', { dayType: 'half' });
  assert.strictEqual(res.statusCode, 409); ok(18, 'full + half on same date blocked');
})
/* 19 half + half same date blocked */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-10', { status: 'approved', dayType: 'half' });
  const { res } = await _apply(emp, '2026-09-10', '2026-09-10', { dayType: 'half' });
  assert.strictEqual(res.statusCode, 409, 'no half+half combining rule exists');
  ok(19, 'half + half on same date blocked (no combine rule)');
})
/* 20 half-day on a different date allowed */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-10', { status: 'approved', dayType: 'half' });
  const { res } = await _apply(emp, '2026-09-11', '2026-09-11', { dayType: 'half' });
  assert.strictEqual(res.statusCode, 201); ok(20, 'half-day on a free date allowed');
})

/* ==== BALANCE INTEGRITY (the core F1 property) ==== */
/* 21 no double deduction: 2nd overlapping approval blocked, used deducts once */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  const a = await _leave(emp, '2026-09-10', '2026-09-12', { status: 'pending' });
  const b = await _leave(emp, '2026-09-11', '2026-09-15', { status: 'pending' }); // overlaps A
  const r1 = await _decide(hr, a._id, { decision: 'approved' });
  assert.strictEqual(r1.res.statusCode, 200, 'A approves');
  const usedAfterA = await _used(emp._id);
  assert.strictEqual(usedAfterA, 3, 'A deducted 3 (10,11,12)');
  const r2 = await _decide(hr, b._id, { decision: 'approved' });
  assert.strictEqual(r2.res.statusCode, 409, 'B blocked by overlap');
  assert.strictEqual(await _used(emp._id), usedAfterA, 'no second deduction -> no 3+5');
  ok(21, 'overlap prevents double balance deduction (P1 fixed)');
})
/* 22 revoke restores correctly (frees the date, allows re-request) */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  const a = await _leave(emp, '2026-09-10', '2026-09-12', { status: 'pending' });
  await _decide(hr, a._id, { decision: 'approved' });
  assert.strictEqual(await _used(emp._id), 3);
  await _run(leaveController.revoke, _mkReq({ reason: 'x' }, { id: String(a._id) }, hr));
  assert.strictEqual(await _used(emp._id), 0, 'revoke restores balance');
  const { res } = await _apply(emp, '2026-09-10', '2026-09-12'); // dates now free
  assert.strictEqual(res.statusCode, 201, 'revoked dates can be re-requested');
  ok(22, 'revoke restores balance and frees dates');
})
/* 23 edit delta still correct on a NON-overlapping widen */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  const a = await _leave(emp, '2026-09-10', '2026-09-11', { status: 'approved' }); // Thu,Fri = 2 eff days
  await _setUsed(emp._id, 2);
  // Widen to 10-14: Thu,Fri,Sat,(Sun off),Mon = 4 effective days (13th is Sunday/weekly-off).
  const { res } = await _edit(hr, a._id, { toDate: '2026-09-14' });
  assert.strictEqual(res.statusCode, 200, 'non-overlapping widen allowed');
  assert.strictEqual(await _used(emp._id), 4, 'used adjusted by +2 delta (2 -> 4)');
  ok(23, 'edit delta correct on a non-overlapping widen');
})
/* 24 reapprove idempotence: re-decide already-approved leave is rejected */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  const a = await _leave(emp, '2026-09-10', '2026-09-12', { status: 'pending' });
  await _decide(hr, a._id, { decision: 'approved' });
  const used1 = await _used(emp._id);
  const { res } = await _decide(hr, a._id, { decision: 'approved' }); // already decided
  assert.strictEqual(res.statusCode, 400, 'already-decided guard prevents re-approve');
  assert.strictEqual(await _used(emp._id), used1, 'no extra deduction on re-approve attempt');
  ok(24, 'reapprove is idempotent (no extra deduction)');
})

/* ==== ATTENDANCE ==== */
/* 25 blocked overlapping approval leaves attendance untouched */ .then(async () => {
  _stub.reset(); const hr = await _mkHR(); const emp = await _mkEmp();
  await _leave(emp, '2026-09-10', '2026-09-12', { status: 'approved' });
  const b = await _leave(emp, '2026-09-11', '2026-09-13', { status: 'pending' });
  const before = _stub.rows(Attendance).length;
  const { res } = await _decide(hr, b._id, { decision: 'approved' });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(_stub.rows(Attendance).length, before, 'no attendance write for blocked leave');
  ok(25, 'blocked approval writes no attendance');
})

/* ==== HOLIDAY / WEEKLY-OFF ==== */
/* 26 zero-effective-day request is rejected by apply BEFORE overlap even matters */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp(); // weeklyOff Sunday
  // 2026-09-13 is a Sunday (weekly off). Single-day request on it -> 0 effective days.
  const { res } = await _apply(emp, '2026-09-13', '2026-09-13');
  assert.strictEqual(res.statusCode, 400, 'no working days -> 400 (existing rule), not created');
  ok(26, 'zero-effective-day request rejected by existing apply guard');
})

/* ==== CONCURRENCY (as feasible in-harness) ==== */
/* 27 two near-simultaneous applies: guard is per-call; the SECOND that
      observes the first still-active row is blocked.  (True parallel
      TOCTOU needs a DB transaction/replica set; documented limitation.
      The decisive safety net is the approval-time guard in #21.) */ .then(async () => {
  _stub.reset(); const emp = await _mkEmp();
  const r1 = await _apply(emp, '2026-09-10', '2026-09-12');
  const r2 = await _apply(emp, '2026-09-11', '2026-09-13');
  assert.strictEqual(r1.res.statusCode, 201, 'first apply succeeds');
  assert.strictEqual(r2.res.statusCode, 409, 'second overlapping apply blocked');
  assert.strictEqual(_stub.rows(Leave).length, 1, 'only one leave persisted');
  ok(27, 'sequential overlapping applies: only one persists');
})

.then(() => { console.log(`\nleaveOverlap: all ${passed} checks passed`); process.exit(0); })
.catch((e) => { console.error('leaveOverlap crashed:', e && e.stack || e); process.exit(1); });
