/**
 * diagnoseLeaveAttendance.js -- READ-ONLY report of approved leaves whose
 * attendance records do not match the leave's current classification.
 *
 *   node scripts/diagnoseLeaveAttendance.js [--json]
 *
 * Uses the native driver with find() only (no writes, no index builds) and the
 * very same helpers the live sync uses (statusForLeave / unitsForLeave /
 * manualSupersession), so "proposed correction" is exactly what an explicit
 * sync of that leave would do.  Nothing is changed; repairing is a separate,
 * reviewed step.
 *
 * Categories
 *   STALE_OWN_ROW                  leave-linked row with an obsolete status / units
 *   MANUAL_SUPERSEDED_BY_NEW_RULE  manual unpaid mark made BEFORE the approval (a sync would replace it)
 *   MANUAL_KEPT_DIFFERS            manual record that differs but is a deliberate HR override (kept)
 *   AUTO_ROW                       auto half-day row under a leave (a sync would adopt it)
 *   NO_RECORD                      leave day with no record (full-day leaves still derive correctly)
 *   PAID_FLAG_VS_TYPE              Leave.paid disagrees with its leaveType
 *   ORPHAN_LEAVE_ROW / ROW_OUTSIDE_LEAVE_WINDOW   leave-linked row that no longer belongs to an approved leave
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');
const la = require('../services/leaveAttendance');

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');

(async () => {
  if (!process.env.MONGO_URI) { console.error('MONGO_URI is not set.'); process.exit(1); }
  const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db();
  const all = (n) => db.collection(n).find({}).toArray();
  const [users, leaves, att, hol] = await Promise.all(['users', 'leaves', 'attendances', 'holidays'].map(all));
  const uBy = new Map(users.map((u) => [String(u._id), u]));
  const holSet = new Set(hol.map((h) => day(h.date)));
  const attBy = new Map(att.map((a) => [`${a.employee}|${day(a.date)}`, a]));
  const rows = []; let consistent = 0;
  const add = (cat, l, d, a, expected, fix) => rows.push({
    category: cat, employee: (uBy.get(String(l.employee)) || {}).employeeId, date: d, leave: String(l._id),
    leaveType: l.leaveType, paid: l.paid, dayType: l.dayType, currentAttendance: a ? `${a.status}/${a.source}` : '(no record)', expected, proposed: fix,
  });
  const approved = leaves.filter((l) => l.status === 'approved'); const owned = new Set();
  for (const l of approved) {
    const u = uBy.get(String(l.employee));
    const wo = (u && Array.isArray(u.weeklyOff) && u.weeklyOff.length) ? u.weeklyOff : [0];
    const exp = la.statusForLeave(l); const eDelta = la.unitsForLeave(l);
    if (l.paid !== (l.leaveType !== 'unpaid')) add('PAID_FLAG_VS_TYPE', l, day(l.fromDate), null, `paid=${l.leaveType !== 'unpaid'}`, 'review: Leave.paid disagrees with its leaveType');
    for (let t = +new Date(day(l.fromDate)); t <= +new Date(day(l.toDate)); t += 86400000) {
      const d = new Date(t); const ds = day(d);
      if (wo.includes(d.getUTCDay()) || holSet.has(ds)) continue;
      owned.add(`${l.employee}|${ds}`);
      const a = attBy.get(`${l.employee}|${ds}`);
      if (!a) { add('NO_RECORD', l, ds, null, `${exp}/leave`, 'create the leave-linked record'); continue; }
      if (a.source === 'leave' && String(a.leaveId) === String(l._id)) {
        if (a.status === exp && (a.leaveDelta || 0) === eDelta) consistent += 1; else add('STALE_OWN_ROW', l, ds, a, exp, 'refresh status / leaveDelta in place');
        continue;
      }
      if (a.source === 'leave') { add('OTHER_LEAVES_ROW', l, ds, a, exp, 'review (two approved leaves on one day?)'); continue; }
      if (a.source === 'manual') {
        const why = la.manualSupersession(a, l);
        if (why) add('MANUAL_SUPERSEDED_BY_NEW_RULE', l, ds, a, `${exp}/leave`, `replace the mark (${why}); original is parked and restored on revoke`);
        else if (a.status === exp) consistent += 1;
        else add('MANUAL_KEPT_DIFFERS', l, ds, a, exp, 'kept: deliberate manual override -- confirm intent');
        continue;
      }
      add('AUTO_ROW', l, ds, a, exp, 'adopt the auto row into the leave');
    }
  }
  const lvBy = new Map(leaves.map((l) => [String(l._id), l]));
  for (const a of att.filter((x) => x.source === 'leave')) {
    const l = lvBy.get(String(a.leaveId));
    if (!l || l.status !== 'approved') rows.push({ category: 'ORPHAN_LEAVE_ROW', employee: (uBy.get(String(a.employee)) || {}).employeeId, date: day(a.date), leave: String(a.leaveId), currentAttendance: `${a.status}/leave`, expected: `(leave is ${l ? l.status : 'missing'})`, proposed: 'release the row' });
    else if (!owned.has(`${l.employee}|${day(a.date)}`)) rows.push({ category: 'ROW_OUTSIDE_LEAVE_WINDOW', employee: (uBy.get(String(l.employee)) || {}).employeeId, date: day(a.date), leave: String(l._id), currentAttendance: `${a.status}/leave`, expected: '(not a leave day)', proposed: 'release the row' });
  }
  await client.close();
  const by = {}; rows.forEach((r) => { by[r.category] = (by[r.category] || 0) + 1; });
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ approvedLeaves: approved.length, consistentDays: consistent, byCategory: by, findings: rows }, null, 1)); return; }
  console.log(`approved leaves ${approved.length} | consistent days ${consistent} | findings ${rows.length}`, JSON.stringify(by));
  for (const r of rows) console.log(' ', [r.category, r.employee, r.date, `leave …${String(r.leave).slice(-6)}`, `now=${r.currentAttendance}`, `want=${r.expected}`, `=> ${r.proposed}`].join(' | '));
})().catch((e) => { console.error(e.message); process.exit(1); });
