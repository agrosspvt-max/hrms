/**
 * phase3bLedger.integration.test.js -- REAL MongoDB checks for the Phase 3B
 * ledger-balance and dashboard-net-total fixes, on a disposable single-node
 * replica set and a disposable standalone.  Never touches a real database;
 * prints SKIPPED and exits 0 when no mongod can be started.
 *
 *   cd backend && MONGOMS_SYSTEM_BINARY=$(which mongod) node services/compliance/__tests__/phase3bLedger.integration.test.js
 */
process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_DASHBOARD_V2 = 'true';
process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';

const assert = require('assert');
const mongoose = require('mongoose');
const oid = () => new mongoose.Types.ObjectId();
const D = (s) => new Date(`2026-${s}T00:00:00Z`);
const M = (n) => require(`../../../models/${n}`);
let checks = 0; const ok = (m) => { checks += 1; console.log(`  ok  ${checks}: ${m}`); };
const mkRes = () => { const r = { statusCode: 200 }; r.status = (n) => { r.statusCode = n; return r; }; r.json = (v) => { r.body = v; return r; }; return r; };
const call = async (h, req) => { const res = mkRes(); let err = null; await h(req, res, (e) => { err = e; }); assert.ifError(err); return res.body; };

const suite = async (label, uri, expectTxn) => {
  require('../../../config/runtimeSafety').assertLocalOnly(uri, 'integration test');   // never a shared database
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, autoIndex: true });
  const Fin = M('FinancialLedger'), Marks = M('MarksLedger'), Pct = M('PercentageLedger'), Att = M('AttendanceLedger'), User = M('User');
  for (const m of [Fin, Marks, Pct, Att, User, M('ComplianceIncident'), M('ComplianceWaiver')]) await m.syncIndexes();
  require('../txn')._resetForTest();
  const ledgerService = require('../ledger/ledgerService');
  const ledgerController = require('../../../controllers/compliance/ledgerController');
  const dash = require('../../../controllers/compliance/dashboardController');
  const { withComplianceTransaction } = require('../txn');
  assert.strictEqual((await withComplianceTransaction(async () => 1)).mode, expectTxn ? 'transaction' : 'serial');
  const hr = { role: 'hr', _id: oid() };
  const add = (ledger, employee, date, direction, quantity, session = null) => ledgerService.append({
    ledger, employee, date: D(date), direction, quantity, type: direction < 0 ? 'action' : 'recovery', reason: 't', session });
  const view = (ledger, employee, query = {}) => call(ledgerController.get, { params: { name: ledger }, query: { employee: String(employee), ...query }, user: hr });
  const sumOf = async (Model, employee) => (await Model.find({ employee }).lean()).reduce((a, r) => a + r.direction * r.quantity, 0);

  // backdated sequence, per ledger
  for (const [name, Model] of [['financial', Fin], ['marks', Marks], ['percentage', Pct], ['attendance', Att]]) {
    const e = oid();
    for (const d of ['08-28', '08-29', '08-30', '08-26']) await add(name, e, d, -1, 200);
    assert.strictEqual(await ledgerService.balance({ ledger: name, employee: e }), -800);
    assert.strictEqual((await view(name, e)).pop().runningBalance, -800);
    assert.strictEqual((await Model.find({ employee: e }).sort({ createdAt: 1, _id: 1 }).lean()).pop().runningBalance, -800);
  }
  ok(`[${label}] backdated debit inserted last: -800 in balance(), ledger view and stored snapshot (all 4 ledgers)`);

  // credit then backdated debit, reversal after
  const e1 = oid();
  await add('financial', e1, '09-01', -1, 1000); await add('financial', e1, '09-02', +1, 400); await add('financial', e1, '08-20', -1, 100); await add('financial', e1, '08-25', +1, 50);
  assert.strictEqual(await ledgerService.balance({ ledger: 'financial', employee: e1 }), -650);
  ok(`[${label}] debit/credit/backdated debit/backdated credit: -650`);

  // concurrent appends (plain and, on a replica set, inside transactions)
  const e2 = oid();
  await Promise.all(Array.from({ length: 40 }, (_, i) => add('financial', e2, `08-${String(10 + (i % 9)).padStart(2, '0')}`, i % 5 === 0 ? +1 : -1, 10 + i)));
  assert.strictEqual(await Fin.countDocuments({ employee: e2 }), 40);
  assert.strictEqual(await ledgerService.balance({ ledger: 'financial', employee: e2 }), await sumOf(Fin, e2));
  assert.strictEqual((await view('financial', e2)).pop().runningBalance, await sumOf(Fin, e2));
  ok(`[${label}] 40 concurrent appends: 40 rows, balance() = view total = sum (stored snapshots may interleave; they are not authoritative)`);
  if (expectTxn) {
    const e3 = oid();
    await Promise.all(Array.from({ length: 12 }, (_, i) => withComplianceTransaction((session) => add('financial', e3, `09-${String(1 + i).padStart(2, '0')}`, -1, 25, session))));
    assert.strictEqual(await Fin.countDocuments({ employee: e3 }), 12);
    assert.strictEqual(await ledgerService.balance({ ledger: 'financial', employee: e3 }), -300);
    ok(`[${label}] 12 concurrent transactional appends: 12 rows, balance -300`);
  }

  // the Atlas-shaped fixture: 28 debits dated out of order + 21 later credits, then the dashboard
  await Fin.deleteMany({}); await User.deleteMany({});
  const emp = oid();
  await User.create({ _id: emp, name: 'T', employeeId: 'T1', email: 't@x.test', password: 'secret1', role: 'employee', status: 'active' });
  const dates = ['08-26']; for (let d = 27; d <= 31; d++) dates.push(`08-${d}`); dates.push('09-01');
  const plan = []; dates.forEach((d, di) => { for (let k = 0; k <= di; k++) plan.push(d); });   // 1,2,..7 per day => 28
  for (const d of [...plan].reverse()) await add('financial', emp, d, -1, 200);                  // newest date first => heavy backdating
  assert.strictEqual(plan.length, 28);
  for (let i = 0; i < 21; i++) await add('financial', emp, '10-10', +1, 200);
  const S = (q) => call(dash.summary, { user: hr, query: q }).then((r) => r.financialTotal);
  assert.strictEqual(await S({}), 1400);
  assert.strictEqual(await ledgerService.balance({ ledger: 'financial', employee: emp }), -1400);
  assert.strictEqual((await view('financial', emp)).pop().runningBalance, -1400);
  ok(`[${label}] 28 x 200 debits (heavily backdated) - 21 x 200 credits: dashboard 1400, balance -1400, view -1400`);

  // date filters through the real aggregation
  assert.strictEqual(await S({ to: '2026-08-31T23:59:59Z' }), 200 * plan.filter((d) => d <= '08-31').length);
  assert.strictEqual(await S({ from: '2026-09-01T00:00:00Z', to: '2026-09-01T23:59:59Z' }), 1400);
  assert.strictEqual(await S({ from: '2026-08-26T00:00:00Z', to: '2026-09-30T00:00:00Z' }), 5600);
  assert.strictEqual(await S({ from: '2026-10-01T00:00:00Z' }), -4200);
  assert.strictEqual(await S({ from: '2027-01-01T00:00:00Z' }), 0);
  ok(`[${label}] dashboard date filters on the real pipeline (before credits, same-day, debits only, credits only, empty)`);

  // department totals use the same net definition
  const dep = await call(dash.financialTotals, { user: hr, query: {} });
  assert.strictEqual(dep.reduce((a, r) => a + r.total, 0), 1400);
  assert.strictEqual(dep[0].entryCount, 28, 'entryCount still counts debit entries');
  ok(`[${label}] department financial totals = net 1400 (28 debit entries)`);

  // read paths wrote nothing
  assert.strictEqual(await Fin.countDocuments({}), 49);
  ok(`[${label}] dashboard + ledger view are read-only (49 rows before and after)`);

  // NET_OWED_EXPR agrees with -sum(direction*quantity) on every ledger row set
  const agg = await Fin.aggregate([{ $group: { _id: null, t: { $sum: ledgerService.NET_OWED_EXPR } } }]);
  assert.strictEqual(agg[0].t, -(await sumOf(Fin, emp)));
  ok(`[${label}] aggregation expression == -(JS signed sum)`);

  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
};

(async () => {
  let ReplSet, Server;
  try { ({ MongoMemoryReplSet: ReplSet, MongoMemoryServer: Server } = require('mongodb-memory-server')); }
  catch (e) { console.log('SKIPPED: mongodb-memory-server is not installed.'); return; }
  let rs; let sa;
  try {
    rs = await ReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    sa = await Server.create();
  } catch (e) {
    console.log(`SKIPPED: could not start a disposable mongod (${String(e.message).split('\n')[0]}).`);
    console.log('         Set MONGOMS_SYSTEM_BINARY=/path/to/mongod to run these real-MongoDB checks.');
    try { if (rs) await rs.stop(); } catch (_) { /* */ }
    return;
  }
  try {
    await suite('replset', rs.getUri(), true);
    await suite('standalone', sa.getUri(), false);
    console.log(`\n${checks} real-MongoDB Phase 3B checks passed`);
  } finally {
    try { await rs.stop(); } catch (_) { /* */ }
    try { await sa.stop(); } catch (_) { /* */ }
  }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
