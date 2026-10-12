/**
 * leaveAttendancePaidSync.test.js -- an approved leave's CURRENT classification
 * (paid / unpaid, half / full, dates) must be what Attendance shows.
 *
 * Regression for: leave "Paid, Approved" while Attendance still said "Half Day
 * (Unpaid)".  Root cause (from the live records): a manual half_unpaid mark written
 * by Attendance Review BEFORE the leave was approved was treated as a deliberate
 * override and never replaced; separately, leave edits that changed only the leave
 * type left Leave.paid stale, and a stale leave-linked row was "kept" forever.
 *
 *   cd backend && node services/compliance/__tests__/leaveAttendancePaidSync.test.js
 *   (also run under TZ=Asia/Kolkata / America/Los_Angeles by the last check)
 */
process.env.NODE_ENV = 'test';
const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const oid = () => new mongoose.Types.ObjectId();
const M = (n) => require(`../../../models/${n}`);
const names = ['User', 'Leave', 'Submission', 'Attendance', 'Holiday', 'Template', 'Assignment', 'DependencyTask', 'Penalty', 'Notification',
  'ComplianceRule', 'ComplianceIncident', 'ComplianceEvent', 'ComplianceActionEffect', 'MarksLedger', 'FinancialLedger', 'PercentageLedger',
  'AttendanceLedger', 'AuditLog', 'Event'];
const [User, Leave, Submission, Attendance, Holiday, Template, Assignment, Dep, Penalty, Notif, Rule, Inc, Ev, Eff, Marks, Fin, Pct, Att, Audit, Event] = names.map(M);
[User, Leave, Submission, Attendance, Holiday, Template, Assignment, Dep, Penalty, Notif, Rule, Ev, Eff, Marks, Fin, Pct, Att, Audit, Event].forEach((m) => _stub.install(m));
_stub.install(Inc, { uniqueBy: [{ keys: ['naturalKey'], filter: { source: 'automatic' } }] });

const lc = require('../../../controllers/leaveController');
const la = require('../../leaveAttendance');
const { deriveAttendance } = require('../../dailyEngine');
const D = (s) => new Date(`${s}T00:00:00Z`);
const DAY = 86400e3;
let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };

const mkRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const run = async (h, body, id, user) => { const res = mkRes(); await h({ body, params: { id: String(id) }, user, ip: '1', get: () => '', query: {} }, res, (e) => { if (e) throw e; }); return res; };
const hr = async () => User.create({ _id: oid(), name: 'HR', employeeId: `HR${oid()}`.slice(0, 8), email: `h${oid()}@x`, password: 'p', role: 'hr', status: 'active' });
const emp = async (extra = {}) => User.create({ _id: oid(), name: 'Emp', employeeId: `E${oid()}`.slice(0, 8), email: `e${oid()}@x`, password: 'p', role: 'employee', status: 'active', weeklyOff: [0],
  leaveBalance: { yearlyAllowance: 20, monthlyAllowance: 2, used: 0 }, ...extra });
const pending = (e, over = {}) => Leave.create({ _id: oid(), employee: e._id, leaveType: 'casual', fromDate: D('2026-10-05'), toDate: D('2026-10-05'),
  days: 0.5, dayType: 'half', status: 'pending', paid: true, ...over });
const rows = (e, from, to) => _stub.rows(Attendance).filter((r) => String(r.employee) === String(e._id) && (!from || r.date >= D(from)) && (!to || r.date <= D(to)))
  .sort((a, b) => a.date - b.date);
const one = (e, day) => _stub.rows(Attendance).filter((r) => String(r.employee) === String(e._id) && r.date.getTime() === D(day).getTime());
const used = async (e) => (await User.findById(e._id)).leaveBalance.used;

(async () => {
  /* 1-2: new approvals */
  _stub.reset(); let H = await hr(); let E = await emp();
  let lv = await pending(E); await run(lc.decide, { decision: 'approved' }, lv._id, H);
  let r = one(E, '2026-10-05');
  assert.deepStrictEqual([r.length, r[0].status, r[0].source, r[0].leaveDelta, String(r[0].leaveId)], [1, 'half_paid', 'leave', 0.5, String(lv._id)]);
  ok('1  new approved PAID half-day leave -> Half Day (Paid), leave-linked, 0.5 unit');
  const E2 = await emp(); const lv2 = await pending(E2, { leaveType: 'unpaid' }); await run(lc.decide, { decision: 'approved' }, lv2._id, H);
  r = one(E2, '2026-10-05'); assert.deepStrictEqual([r[0].status, r[0].leaveDelta], ['half_unpaid', 0]); assert.strictEqual(await used(E2), 0);
  ok('2  new approved UNPAID half-day leave -> Half Day (Unpaid), no balance used');

  /* 3: unpaid -> paid after approval (type change only: the old code left paid=false) */
  await run(lc.edit, { leaveType: 'casual' }, lv2._id, H);
  const lv2b = await Leave.findById(lv2._id); r = one(E2, '2026-10-05');
  assert.deepStrictEqual([lv2b.paid, r.length, r[0].status, r[0].leaveDelta, await used(E2)], [true, 1, 'half_paid', 0.5, 0.5]);
  ok('3  approved UNPAID half-day changed to a paid type -> Leave.paid follows, Attendance = Half Day (Paid), balance debited once, still ONE row');
  await run(lc.edit, { paid: true }, lv2._id, H);
  assert.deepStrictEqual([one(E2, '2026-10-05').length, await used(E2)], [1, 0.5]);

  /* 4: paid -> unpaid */
  await run(lc.edit, { leaveType: 'unpaid' }, lv2._id, H);
  r = one(E2, '2026-10-05'); assert.deepStrictEqual([(await Leave.findById(lv2._id)).paid, r[0].status, r[0].leaveDelta, await used(E2)], [false, 'half_unpaid', 0, 0]);
  ok('4  paid -> unpaid after approval -> Half Day (Unpaid), balance refunded');

  /* 5: full day unpaid -> paid */
  const E3 = await emp(); const lv3 = await pending(E3, { leaveType: 'unpaid', dayType: 'full', days: 1 }); await run(lc.decide, { decision: 'approved' }, lv3._id, H);
  assert.strictEqual(one(E3, '2026-10-05')[0].status, 'full_unpaid');
  await run(lc.edit, { leaveType: 'sick' }, lv3._id, H);
  r = one(E3, '2026-10-05'); assert.deepStrictEqual([r.length, r[0].status, r[0].leaveDelta, await used(E3)], [1, 'full_paid', 1, 1]);
  ok('5  full-day unpaid -> paid: Full Leave (Unpaid) becomes Full Leave (Paid)');

  /* 6: date change, with an unrelated manual record that must survive */
  const E4 = await emp(); const lv4 = await pending(E4, { dayType: 'full', days: 1 }); await run(lc.decide, { decision: 'approved' }, lv4._id, H);
  await Attendance.create({ employee: E4._id, date: D('2026-10-09'), status: 'present', source: 'manual', note: 'HR mark', leaveDelta: 0 });
  await run(lc.edit, { fromDate: '2026-10-07', toDate: '2026-10-07' }, lv4._id, H);
  assert.strictEqual(one(E4, '2026-10-05').length, 0); assert.strictEqual(one(E4, '2026-10-07')[0].status, 'full_paid');
  assert.deepStrictEqual([one(E4, '2026-10-09')[0].status, one(E4, '2026-10-09')[0].source], ['present', 'manual']);
  ok('6  approved leave moved to another date: old day released, new day created, an unrelated manual record untouched');

  /* 7: half -> full */
  const E5 = await emp(); const lv5 = await pending(E5); await run(lc.decide, { decision: 'approved' }, lv5._id, H);
  await run(lc.edit, { dayType: 'full' }, lv5._id, H);
  r = one(E5, '2026-10-05'); assert.deepStrictEqual([r.length, r[0].status, r[0].leaveDelta, await used(E5)], [1, 'full_paid', 1, 1]);
  ok('7  half-day -> full-day: Half Day (Paid) becomes Full Leave (Paid), balance 0.5 -> 1');

  /* 8: revoke */
  const E6 = await emp(); const lv6 = await pending(E6); await run(lc.decide, { decision: 'approved' }, lv6._id, H);
  await run(lc.revoke, { reason: 'x' }, lv6._id, H);
  assert.deepStrictEqual([one(E6, '2026-10-05').length, await used(E6), (await Leave.findById(lv6._id)).status], [0, 0, 'revoked']);
  ok('8  leave revoked after attendance sync: leave-linked row removed, balance restored');

  /* 9: repeated identical updates are idempotent */
  const E7 = await emp(); const lv7 = await pending(E7, { leaveType: 'unpaid' }); await run(lc.decide, { decision: 'approved' }, lv7._id, H);
  const before = JSON.stringify(one(E7, '2026-10-05'));
  const lvd = await Leave.findById(lv7._id);
  const s1 = await la.syncAttendanceForLeave(lvd); const s2 = await la.syncAttendanceForLeave(lvd);
  assert.deepStrictEqual([s1.created, s1.updated, s2.created, s2.updated], [0, 0, 0, 0]); assert.strictEqual(JSON.stringify(one(E7, '2026-10-05')), before);
  await run(lc.edit, { leaveType: 'casual' }, lv7._id, H); const bal = await used(E7); const snap = JSON.stringify(one(E7, '2026-10-05'));
  await run(lc.edit, { leaveType: 'casual' }, lv7._id, H); await run(lc.edit, { leaveType: 'casual' }, lv7._id, H);
  assert.deepStrictEqual([await used(E7), JSON.stringify(one(E7, '2026-10-05')), one(E7, '2026-10-05').length], [bal, snap, 1]);
  ok('9  repeating the same sync / the same edit three times: no duplicate rows, no balance drift, identical record');

  /* 10: manual overrides */
  const manual = async (e, day, status, over = {}) => Attendance.create({ employee: e._id, date: D(day), status, source: 'manual', note: 'Attendance Review: x', setBy: H._id, leaveDelta: 0,
    createdAt: new Date(Date.now() - 3 * DAY), updatedAt: new Date(Date.now() - 3 * DAY), ...over });
  // 10a the production case: review mark BEFORE the approval is superseded
  const P = await emp(); await manual(P, '2026-10-05', 'half_unpaid', { note: 'Attendance Review: mark_half_unpaid' });
  const lvP = await pending(P); await run(lc.decide, { decision: 'approved' }, lvP._id, H);
  r = one(P, '2026-10-05'); assert.deepStrictEqual([r.length, r[0].status, r[0].source, String(r[0].leaveId)], [1, 'half_paid', 'leave', String(lvP._id)]);
  assert.strictEqual(r[0].supersededManual.status, 'half_unpaid');
  assert.ok(_stub.rows(Audit).some((a) => a.action === 'attendance.leave_superseded_manual' && String(a.meta.leaveId) === String(lvP._id)));
  ok('10a PRODUCTION CASE: a manual Half Day (Unpaid) review mark made BEFORE the paid half-day leave was approved -> Attendance becomes Half Day (Paid); the old mark is parked + audited');
  // 10b revoke gives the manual mark back, with its original timestamp
  const tsBefore = r[0].supersededManual.updatedAt.getTime();
  await run(lc.revoke, { reason: 'x' }, lvP._id, H);
  r = one(P, '2026-10-05'); assert.deepStrictEqual([r.length, r[0].status, r[0].source, r[0].leaveId == null], [1, 'half_unpaid', 'manual', true]);
  assert.strictEqual(r[0].updatedAt.getTime(), tsBefore);
  ok('10b revoking that leave restores the original manual Half Day (Unpaid) record (same timestamp)');
  // 10c a mark made AFTER the approval wins
  const Q = await emp(); const lvQ = await pending(Q); await run(lc.decide, { decision: 'approved' }, lvQ._id, H);
  await Attendance.updateOne({ employee: Q._id, date: D('2026-10-05') }, { $set: { status: 'half_unpaid', source: 'manual', leaveId: null, leaveDelta: 0, updatedAt: new Date(Date.now() + 60000), note: 'HR decided: unpaid' } });
  await la.syncAttendanceForLeave(await Leave.findById(lvQ._id));
  assert.deepStrictEqual([one(Q, '2026-10-05')[0].status, one(Q, '2026-10-05')[0].source], ['half_unpaid', 'manual']);
  ok('10c a manual mark made AFTER the approval is a deliberate override: kept');
  // 10d positive manual statuses and stale absent
  for (const st of ['present', 'half_paid', 'full_paid', 'weekly_off']) {
    const X = await emp(); await manual(X, '2026-10-05', st); const l = await pending(X); await run(lc.decide, { decision: 'approved' }, l._id, H);
    assert.deepStrictEqual([one(X, '2026-10-05')[0].status, one(X, '2026-10-05')[0].source], [st, 'manual'], st);
  }
  const AB = await emp(); await manual(AB, '2026-10-05', 'absent'); const lAB = await pending(AB); await run(lc.decide, { decision: 'approved' }, lAB._id, H);
  assert.deepStrictEqual([one(AB, '2026-10-05')[0].status, one(AB, '2026-10-05')[0].source], ['half_paid', 'leave']);
  const LD = await emp(); await manual(LD, '2026-10-05', 'half_unpaid', { leaveDelta: 0.5 }); const lLD = await pending(LD); await run(lc.decide, { decision: 'approved' }, lLD._id, H);
  assert.strictEqual(one(LD, '2026-10-05')[0].source, 'manual');
  ok('10d positive manual statuses (present / paid / weekly off) are preserved; stale Absent is still superseded; a manual row carrying leave accounting is never touched');

  /* 11: two employees, same date */
  const A1 = await emp(), A2 = await emp(); const l1 = await pending(A1, { leaveType: 'unpaid' }), l2 = await pending(A2);
  await run(lc.decide, { decision: 'approved' }, l1._id, H); await run(lc.decide, { decision: 'approved' }, l2._id, H);
  await run(lc.edit, { leaveType: 'casual' }, l1._id, H);
  assert.deepStrictEqual([one(A1, '2026-10-05')[0].status, one(A2, '2026-10-05')[0].status, await used(A1), await used(A2)], ['half_paid', 'half_paid', 0.5, 0.5]);
  const l1b = await pending(A1, { leaveType: 'unpaid', fromDate: D('2026-10-14'), toDate: D('2026-10-14') }); await run(lc.decide, { decision: 'approved' }, l1b._id, H);
  await run(lc.edit, { leaveType: 'casual' }, l1b._id, H);
  assert.strictEqual(one(A2, '2026-10-14').length, 0);
  ok('11 two employees on the same date are independent; editing one never touches the other');

  /* 12: two leaves, different dates */
  const T = await emp(); const t1 = await pending(T, { leaveType: 'unpaid' }), t2 = await pending(T, { leaveType: 'unpaid', fromDate: D('2026-10-08'), toDate: D('2026-10-08') });
  await run(lc.decide, { decision: 'approved' }, t1._id, H); await run(lc.decide, { decision: 'approved' }, t2._id, H);
  await run(lc.edit, { leaveType: 'sick' }, t1._id, H);
  assert.deepStrictEqual([one(T, '2026-10-05')[0].status, one(T, '2026-10-08')[0].status], ['half_paid', 'half_unpaid']);
  ok('12 two separate leaves on different dates: only the edited one changes');

  /* 13: month boundary + weekly off */
  const B = await emp(); const lb = await pending(B, { leaveType: 'unpaid', fromDate: D('2026-09-30'), toDate: D('2026-10-01'), dayType: 'full', days: 2 });
  await run(lc.decide, { decision: 'approved' }, lb._id, H);
  assert.deepStrictEqual(rows(B).map((x) => [x.date.toISOString().slice(0, 10), x.status]), [['2026-09-30', 'full_unpaid'], ['2026-10-01', 'full_unpaid']]);
  await run(lc.edit, { leaveType: 'casual' }, lb._id, H);
  assert.deepStrictEqual(rows(B).map((x) => x.status), ['full_paid', 'full_paid']);
  const sepB = await deriveAttendance(B, D('2026-09-01'), D('2026-10-01')); const octB = await deriveAttendance(B, D('2026-10-01'), D('2026-11-01'));
  assert.deepStrictEqual([sepB.paidLeaves, sepB.unpaidLeaves, octB.paidLeaves, octB.unpaidLeaves], [1, 0, 1, 0]);
  const W = await emp(); const lw = await pending(W, { fromDate: D('2026-10-30'), toDate: D('2026-11-02'), dayType: 'full', days: 3 });   // Fri Sat Sun Mon; Sunday is the weekly off
  await run(lc.decide, { decision: 'approved' }, lw._id, H);
  assert.deepStrictEqual(rows(W).map((x) => x.date.toISOString().slice(0, 10)), ['2026-10-30', '2026-10-31', '2026-11-02']);
  ok('13 month boundary (30 Sep - 1 Oct) splits correctly in each month; a leave crossing a weekly off skips it');

  /* 14: monthly totals move with the correction */
  const Z = await emp(); await manual(Z, '2026-10-05', 'half_unpaid');
  let t = await deriveAttendance(Z, D('2026-10-01'), D('2026-11-01'));
  const pre = { halfUnpaid: t.halfUnpaidDays, halfPaid: t.halfPaidDays, payable: t.payableDays, working: t.workingDays, absent: t.absentDays, present: t.presentDays };
  const lz = await pending(Z); await run(lc.decide, { decision: 'approved' }, lz._id, H);
  t = await deriveAttendance(Z, D('2026-10-01'), D('2026-11-01'));
  assert.deepStrictEqual([t.halfUnpaidDays, t.halfPaidDays, t.payableDays, t.workingDays, t.absentDays, t.presentDays],
    [pre.halfUnpaid - 1, pre.halfPaid + 1, pre.payable + 0.5, pre.working, pre.absent, pre.present]);
  const day = t.perDay.find((x) => x.date.getTime() === D('2026-10-05').getTime()); assert.strictEqual(day.status, 'half_paid');
  ok('14 monthly totals after the correction: half-unpaid -1, half-paid +1, payable days +0.5; working / present / absent unchanged; the day card status is half_paid');

  /* the boot-time re-sync never rewrites history; an explicit (live) sync repairs */
  const R = await emp(); const lr = await pending(R); await run(lc.decide, { decision: 'approved' }, lr._id, H);
  await Attendance.updateOne({ employee: R._id, date: D('2026-10-05') }, { $set: { status: 'half_unpaid', leaveDelta: 0 } });  // simulate the stale state
  const S = await emp(); await manual(S, '2026-10-05', 'half_unpaid'); await Leave.create({ _id: oid(), employee: S._id, leaveType: 'casual', fromDate: D('2026-10-05'), toDate: D('2026-10-05'),
    days: 0.5, dayType: 'half', status: 'approved', paid: true, decidedAt: new Date() });
  const snapBoot = JSON.stringify(_stub.rows(Attendance).map((x) => [String(x._id), x.status, x.source]));
  const mig = await la.migrateApprovedLeaves();
  assert.strictEqual(JSON.stringify(_stub.rows(Attendance).map((x) => [String(x._id), x.status, x.source])), snapBoot, 'boot re-sync changed no existing record');
  assert.ok(mig.totalLeaves >= 1);
  assert.strictEqual(one(R, '2026-10-05')[0].status, 'half_unpaid');
  await la.syncAttendanceForLeave(await Leave.findById(lr._id));                     // live / explicit repair
  assert.strictEqual(one(R, '2026-10-05')[0].status, 'half_paid');
  ok('15 the boot-time re-sync leaves every existing record exactly as it is (deploy never rewrites history); an explicit sync repairs a stale own row');

  console.log(`\n  ${n} paid/unpaid leave-attendance sync checks passed (TZ=${process.env.TZ || 'default'})`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
