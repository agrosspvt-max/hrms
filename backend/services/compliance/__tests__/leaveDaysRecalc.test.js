/**
 * leaveDaysRecalc.test.js -- Phase 78 regression suite.
 *
 * Verifies that Days becomes a derived field of the (edited) date
 * range and stays consistent across every module.
 *
 *   1. Date SHORTENED -> Days decrease correctly.
 *   2. Date EXTENDED  -> Days increase correctly.
 *   3. Leave balance matches APPROVED days, not requested days.
 *   4. Attendance rows written only for the APPROVED date range.
 *   5. businessStateSync fires for APPROVED dates only (dropped days
 *      cleared through the ranged sync helper).
 *   6. Employee Leave History carries both `days` (approved) and
 *      `originalRequest.days` (original) so the UI can show both.
 *   7. AuditLog stores originalDays + approvedDays.
 *   8. Unchanged approval flow (no date edit) leaves days as-is.
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/leaveDaysRecalc.test.js
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

// Choose a mid-week window (Tue..Fri) so weekly-off (Sun) never
// depresses the effective-day count in these tests.
const D = (iso) => new Date(iso + 'T00:00:00Z');
const _mkHR   = async () => User.create({ _id: _oid(), name: 'HR', employeeId: 'H1', email: 'h@x', password: 'p', role: 'hr', status: 'active' });
const _mkEmp  = async () => User.create({
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
/* 1 -- Date SHORTENED -> Days decrease.                               */
/* ================================================================== */
(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  // Tue 25 Aug 2026 -> Fri 28 Aug 2026 = 4 days.
  const lv = await _pending({ employee: emp, fromDate: D('2026-08-25'), toDate: D('2026-08-28') });
  assert.strictEqual(lv.days, 4);
  await _run(leaveController.decide, _mkReq({
    decision: 'approved', toDate: '2026-08-27',   // trim to 3 days.
  }, { id: String(lv._id) }, hr));

  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.days, 3, 'shortened range -> 3 days');
  assert.strictEqual(after.originalRequest.days, 4, 'original preserved');
  console.log('  ok  1: date shortened -> days recalculated to 3');
})()

/* ================================================================== */
/* 2 -- Date EXTENDED -> Days increase.                                */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  // Tue 25 Aug half day = 0.5.
  const lv = await _pending({ employee: emp, fromDate: D('2026-08-25'), toDate: D('2026-08-25'), dayType: 'half' });
  assert.strictEqual(lv.days, 0.5);
  await _run(leaveController.decide, _mkReq({
    decision: 'approved', toDate: '2026-08-27',   // widen to 3 days (Tue..Thu).
  }, { id: String(lv._id) }, hr));

  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.dayType, 'full', 'auto-flip to full');
  assert.strictEqual(after.days, 3, 'extended range -> 3 days');
  assert.strictEqual(after.originalRequest.days, 0.5, 'original 0.5 preserved');
  console.log('  ok  2: date extended -> days recalculated to 3');
})

/* ================================================================== */
/* 3 -- Leave balance matches APPROVED days.                           */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({ employee: emp, fromDate: D('2026-08-25'), toDate: D('2026-08-28') }); // 4d
  await _run(leaveController.decide, _mkReq({
    decision: 'approved', toDate: '2026-08-27',   // 3d
  }, { id: String(lv._id) }, hr));
  const user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 3, 'balance = approved 3 days, not requested 4');
  console.log('  ok  3: leave balance uses approved days');
})

/* ================================================================== */
/* 4 -- Attendance rows written only for APPROVED range.               */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({ employee: emp, fromDate: D('2026-08-25'), toDate: D('2026-08-28') }); // 4d
  await _run(leaveController.decide, _mkReq({
    decision: 'approved', toDate: '2026-08-27',   // 3d
  }, { id: String(lv._id) }, hr));
  const rows = _stub.rows(Attendance).filter((a) => String(a.leaveId) === String(lv._id));
  assert.strictEqual(rows.length, 3, 'exactly 3 attendance rows for the approved range');
  const dates = rows.map((r) => new Date(r.date).toISOString().slice(0, 10)).sort();
  assert.deepStrictEqual(dates, ['2026-08-25', '2026-08-26', '2026-08-27']);
  console.log('  ok  4: attendance only for approved dates');
})

/* ================================================================== */
/* 5 -- businessStateSync fires for the approved range.                */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({ employee: emp, fromDate: D('2026-08-25'), toDate: D('2026-08-28') });
  const res = await _run(leaveController.decide, _mkReq({
    decision: 'approved', toDate: '2026-08-27',
  }, { id: String(lv._id) }, hr));
  const days = (res.body?.sync?.days || []);
  // syncForLeave walks the UNION of previous + new range = 4 days.
  // Every day in that union must have been synced.
  const uniqueSyncedDays = new Set(days.map((d) => d.date));
  assert.ok(uniqueSyncedDays.has('2026-08-25'));
  assert.ok(uniqueSyncedDays.has('2026-08-28'), 'dropped day is also synced (to remove leave-linked attendance)');
  console.log('  ok  5: businessStateSync covers union of previous + approved range');
})

/* ================================================================== */
/* 6 -- Employee view carries original + approved days.                */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({ employee: emp, fromDate: D('2026-08-25'), toDate: D('2026-08-28') });
  await _run(leaveController.decide, _mkReq({
    decision: 'approved', toDate: '2026-08-27',
  }, { id: String(lv._id) }, hr));
  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.days, 3, 'approved days = 3');
  assert.strictEqual(after.originalRequest.days, 4, 'original days = 4');
  assert.ok(after.modifiedOnApproval, 'modification flag set');
  console.log('  ok  6: employee view has both original + approved days');
})

/* ================================================================== */
/* 7 -- AuditLog captures the days delta.                              */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({ employee: emp, fromDate: D('2026-08-25'), toDate: D('2026-08-28') });
  await _run(leaveController.decide, _mkReq({
    decision: 'approved', toDate: '2026-08-27', modificationNote: 'trim',
  }, { id: String(lv._id) }, hr));
  const audits = _stub.rows(AuditLog).filter((a) =>
    a.targetType === 'Leave' && String(a.targetId) === String(lv._id) && a.action?.startsWith('leave.decide'));
  assert.ok(audits.length >= 1, 'audit row exists');
  const meta = audits[audits.length - 1].meta || {};
  assert.strictEqual(meta.modifiedOnApproval, true);
  assert.strictEqual(meta.originalRequest.days, 4);
  const daysMod = (meta.modifications || []).find((m) => m.field === 'days');
  assert.ok(daysMod, 'days field appears in modifications diff');
  assert.strictEqual(daysMod.from, 4);
  assert.strictEqual(daysMod.to, 3);
  console.log('  ok  7: audit stores original + approved days');
})

/* ================================================================== */
/* 8 -- Unchanged approval leaves days as-is (BC).                     */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const lv = await _pending({ employee: emp, fromDate: D('2026-08-25'), toDate: D('2026-08-28') });
  await _run(leaveController.decide, _mkReq({ decision: 'approved' }, { id: String(lv._id) }, hr));
  const after = await Leave.findById(lv._id);
  assert.strictEqual(after.days, 4, 'days unchanged when nothing edited');
  assert.ok(!after.modifiedOnApproval);
  const user = await User.findById(emp._id);
  assert.strictEqual(user.leaveBalance.used, 4, 'balance = 4 (no edits)');
  console.log('  ok  8: unchanged approval leaves days as-is');
})

.then(() => { console.log('\nleaveDaysRecalc: all regression tests passed'); process.exit(0); })
.catch((e) => { console.error('leaveDaysRecalc test crashed:', e && e.stack || e); process.exit(1); });
