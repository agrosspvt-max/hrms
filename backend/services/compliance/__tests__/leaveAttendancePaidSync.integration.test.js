/**
 * leaveAttendancePaidSync.integration.test.js -- REAL MongoDB (disposable) check of the
 * leave -> attendance reconcile: real timestamps, the unique (employee,date) index,
 * parked-manual restore keeping its original updatedAt, concurrent syncs.
 *
 *   cd backend && MONGOMS_SYSTEM_BINARY=$(which mongod) node services/compliance/__tests__/leaveAttendancePaidSync.integration.test.js
 */
process.env.NODE_ENV = 'test';
const assert = require('assert');
const mongoose = require('mongoose');
const oid = () => new mongoose.Types.ObjectId();
const D = (s) => new Date(`${s}T00:00:00Z`);
let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };

(async () => {
  let Server;
  try { ({ MongoMemoryServer: Server } = require('mongodb-memory-server')); } catch (e) { console.log('SKIPPED: mongodb-memory-server is not installed.'); return; }
  let srv;
  try { srv = await Server.create(); } catch (e) { console.log(`SKIPPED: could not start a disposable mongod (${String(e.message).split('\n')[0]}).`); return; }
  try {
    require('../../../config/runtimeSafety').assertLocalOnly(srv.getUri(), 'integration test');
    await mongoose.connect(srv.getUri(), { autoIndex: true });
    const Attendance = require('../../../models/Attendance'), Leave = require('../../../models/Leave'), User = require('../../../models/User');
    await Attendance.syncIndexes();
    const la = require('../../leaveAttendance');
    const emp = await User.create({ name: 'E', employeeId: 'E1', email: 'e@x.test', password: 'secret1', role: 'employee', status: 'active', weeklyOff: [0] });
    const old = new Date(Date.now() - 3 * 86400e3);
    await Attendance.collection.insertOne({ employee: emp._id, date: D('2026-10-05'), status: 'half_unpaid', source: 'manual', note: 'Attendance Review: mark_half_unpaid',
      leaveDelta: 0, createdAt: old, updatedAt: old });
    const lv = await Leave.create({ employee: emp._id, leaveType: 'casual', fromDate: D('2026-10-05'), toDate: D('2026-10-05'), days: 0.5, dayType: 'half',
      status: 'approved', paid: true, decidedAt: new Date(), decidedBy: oid() });

    // concurrent syncs converge on ONE row
    await Promise.all(Array.from({ length: 6 }, () => la.syncAttendanceForLeave(lv)));
    let rows = await Attendance.find({ employee: emp._id }).lean();
    assert.deepStrictEqual([rows.length, rows[0].status, rows[0].source], [1, 'half_paid', 'leave']);
    assert.strictEqual(rows[0].supersededManual.status, 'half_unpaid');
    ok('6 concurrent syncs: ONE record, Half Day (Paid), the review mark parked');

    // unpaid -> paid -> unpaid on the same leave; refresh in place, still one row
    lv.paid = false; await lv.save(); await la.syncAttendanceForLeave(lv);
    rows = await Attendance.find({ employee: emp._id }).lean(); assert.deepStrictEqual([rows.length, rows[0].status, rows[0].leaveDelta], [1, 'half_unpaid', 0]);
    lv.paid = true; await lv.save(); await la.syncAttendanceForLeave(lv);
    rows = await Attendance.find({ employee: emp._id }).lean(); assert.deepStrictEqual([rows.length, rows[0].status, rows[0].leaveDelta], [1, 'half_paid', 0.5]);
    ok('paid <-> unpaid on the same leave refreshes the existing record in place');

    // release gives the original manual mark back with its ORIGINAL updatedAt
    const r = await la.clearAttendanceForLeave(lv._id);
    rows = await Attendance.find({ employee: emp._id }).lean();
    assert.deepStrictEqual([r.restored, rows.length, rows[0].status, rows[0].source], [1, 1, 'half_unpaid', 'manual']);
    assert.strictEqual(new Date(rows[0].updatedAt).getTime(), old.getTime());
    await la.syncAttendanceForLeave(lv);                                   // still predates the approval -> superseded again
    rows = await Attendance.find({ employee: emp._id }).lean(); assert.strictEqual(rows[0].status, 'half_paid');
    ok('revoke restores the manual mark with its original timestamp, so a later re-approval supersedes it again');

    // a mark made after the approval is kept
    await Attendance.updateOne({ employee: emp._id, date: D('2026-10-05') }, { $set: { status: 'half_unpaid', source: 'manual', leaveId: null, supersededManual: null } });
    await la.syncAttendanceForLeave(lv);
    rows = await Attendance.find({ employee: emp._id }).lean(); assert.deepStrictEqual([rows[0].status, rows[0].source], ['half_unpaid', 'manual']);
    ok('a manual mark updated after the approval (real timestamps) is a deliberate override: kept');

    await mongoose.connection.db.dropDatabase(); await mongoose.disconnect();
    console.log(`\n${n} real-MongoDB leave/attendance checks passed`);
  } finally { try { await srv.stop(); } catch (_) { /* */ } }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
