/**
 * phase3bLedger.test.js -- Phase 3B: ledger balance + dashboard net total.
 *
 * In-memory checks.  The dashboard aggregation is emulated here by a tiny
 * interpreter for exactly the stages the controller uses; the REAL Mongo
 * aggregation is verified in phase3bLedger.integration.test.js.
 *
 *   cd backend && node services/compliance/__tests__/phase3bLedger.test.js
 */
process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_DASHBOARD_V2 = 'true';
process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const oid = () => new mongoose.Types.ObjectId();
const M = (n) => require(`../../../models/${n}`);
const Marks = M('MarksLedger'), Fin = M('FinancialLedger'), Pct = M('PercentageLedger'), Att = M('AttendanceLedger');
const Incident = M('ComplianceIncident'), Waiver = M('ComplianceWaiver');
[Marks, Fin, Pct, Att, Incident, Waiver, M('User')].forEach((m) => _stub.install(m));

const ledgerService = require('../ledger/ledgerService');
const ledgerController = require('../../../controllers/compliance/ledgerController');
const dash = require('../../../controllers/compliance/dashboardController');

// Interpreter for: [{$match:{date?}}, {$group:{_id:null,total:{$sum:NET_OWED_EXPR}}}]
Fin.aggregate = async (pipeline) => {
  let rows = _stub.rows(Fin);
  for (const st of pipeline) {
    if (st.$match) {
      const d = st.$match.date;
      rows = rows.filter((r) => (!d || ((!d.$gte || r.date >= d.$gte) && (!d.$lte || r.date <= d.$lte)))
        && (st.$match.direction === undefined || r.direction === st.$match.direction));
    } else if (st.$group) {
      const expr = st.$group.total.$sum;
      assert.deepStrictEqual(expr, ledgerService.NET_OWED_EXPR, 'controller uses the shared expression');
      const total = rows.reduce((a, r) => a + (-r.direction) * r.quantity, 0);
      return rows.length ? [{ _id: null, total }] : [];
    } else throw new Error('unsupported stage');
  }
  return rows;
};

const D = (s) => new Date(`2026-${s}T00:00:00Z`);
const mkRes = () => { const r = { statusCode: 200 }; r.status = (n) => { r.statusCode = n; return r; }; r.json = (v) => { r.body = v; return r; }; return r; };
const call = async (h, req) => { const res = mkRes(); let err = null; await h(req, res, (e) => { err = e; }); assert.ifError(err); return res.body; };
const hr = { role: 'hr', _id: oid() };
const view = (ledger, employee, query = {}) => call(ledgerController.get, {
  params: { name: ledger }, query: { employee: String(employee), ...query }, user: hr,
});
const add = (ledger, employee, date, direction, quantity, extra = {}) => ledgerService.append({
  ledger, employee, date: D(date), direction, quantity, type: direction < 0 ? 'action' : 'recovery', reason: 't', ...extra,
});
const bal = (ledger, employee) => ledgerService.balance({ ledger, employee });
const sumRows = (Model, employee) => _stub.rows(Model).filter((r) => String(r.employee) === String(employee)).reduce((a, r) => a + r.direction * r.quantity, 0);
let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };

(async () => {
  /* 1. chronological */
  _stub.reset();
  let e = oid();
  await add('financial', e, '08-26', -1, 200); await add('financial', e, '08-27', -1, 200); await add('financial', e, '08-28', -1, 200);
  assert.strictEqual(await bal('financial', e), -600);
  assert.deepStrictEqual(_stub.rows(Fin).map((r) => r.runningBalance), [-200, -400, -600]);
  ok('chronological entries: balance = sum (-600); stored snapshots -200/-400/-600');

  /* 2. backdated entry (the case from the audit) */
  _stub.reset(); e = oid();
  await add('financial', e, '08-28', -1, 200); await add('financial', e, '08-29', -1, 200); await add('financial', e, '08-30', -1, 200);
  await add('financial', e, '08-26', -1, 200);          // inserted LAST, dated FIRST
  assert.strictEqual(await bal('financial', e), -800);
  const last = _stub.rows(Fin)[3];
  assert.strictEqual(last.runningBalance, -800, 'snapshot of the backdated row is the true total, not a fork');
  const v = await view('financial', e);
  assert.deepStrictEqual(v.map((r) => r.runningBalance), [-200, -400, -600, -800]);
  assert.strictEqual(v[v.length - 1].runningBalance, await bal('financial', e));
  ok('backdated debit inserted last: balance -800 regardless of insertion order; snapshot not forked; ledger view last row = -800');

  /* 3. backdated reversal */
  _stub.reset(); e = oid();
  await add('financial', e, '09-01', -1, 1000);
  await add('financial', e, '09-03', -1, 200);
  await add('financial', e, '08-30', +1, 400);          // reversal dated earlier than the debits
  assert.strictEqual(await bal('financial', e), -800);
  assert.strictEqual((await view('financial', e)).pop().runningBalance, -800);
  ok('backdated reversal: net -800 and consistent in the view');

  /* 4. insertion order never matters (all 24 permutations of 4 rows) */
  const spec = [['08-26', -1, 200], ['08-27', -1, 200], ['08-27', +1, 150], ['09-02', -1, 50]];
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  let seen = new Set();
  for (const p of perms(spec)) {
    _stub.reset(); e = oid();
    for (const [d, dir, q] of p) await add('marks', e, d, dir, q);
    seen.add(await bal('marks', e));
    assert.strictEqual((await view('marks', e)).pop().runningBalance, -300);
  }
  assert.deepStrictEqual([...seen], [-300]);
  ok('24 insertion orders of 4 mixed rows: balance always -300');

  /* 5. debit + credit */
  _stub.reset(); e = oid();
  await add('percentage', e, '09-01', -1, 1000); await add('percentage', e, '09-02', +1, 400);
  assert.strictEqual(await bal('percentage', e), -600);
  ok('debit 1000 then credit 400: -600');

  /* 6. credit followed by backdated debit */
  _stub.reset(); e = oid();
  await add('attendance', e, '09-05', +1, 1); await add('attendance', e, '09-01', -1, 3);
  assert.strictEqual(await bal('attendance', e), -2);
  ok('credit then backdated debit: -2');

  /* 7. same-day entries */
  _stub.reset(); e = oid();
  for (let i = 0; i < 5; i++) await add('financial', e, '09-01', -1, 10);
  await add('financial', e, '09-01', +1, 15);
  assert.strictEqual(await bal('financial', e), -35);
  assert.strictEqual((await view('financial', e)).pop().runningBalance, -35);
  ok('six same-day entries: -35');

  /* 8. concurrent appends */
  _stub.reset(); e = oid();
  await Promise.all(Array.from({ length: 20 }, (_, i) => add('financial', e, `08-${String(10 + (i % 7)).padStart(2, '0')}`, i % 4 === 0 ? +1 : -1, 10 + i)));
  assert.strictEqual(await bal('financial', e), sumRows(Fin, e));
  assert.strictEqual((await view('financial', e)).pop().runningBalance, sumRows(Fin, e));
  assert.strictEqual(_stub.rows(Fin).length, 20, 'no duplicate / lost rows');
  ok('20 concurrent appends: balance = sum of all rows; view total = sum');

  /* 9. date-window view uses an opening balance */
  _stub.reset(); e = oid();
  await add('financial', e, '08-26', -1, 200); await add('financial', e, '08-27', -1, 200); await add('financial', e, '08-30', -1, 200); await add('financial', e, '09-02', +1, 100);
  const w = await view('financial', e, { from: '2026-08-29T00:00:00Z' });
  assert.deepStrictEqual(w.map((r) => r.runningBalance), [-600, -500], 'opening balance -400 carried into the window');
  ok('windowed ledger view carries the opening balance of earlier rows');

  /* 10. audit-shaped fixture: rows written out of date order with FORKED stored balances (as in Atlas) */
  _stub.reset(); e = oid();
  const forked = [['08-26', -200], ['08-27', -400], ['08-26', -600], ['08-28', -600], ['08-26', -800], ['08-27', -800]];
  let t = 1000;
  for (const [d, rb] of forked) await Fin.create({ employee: e, date: D(d), direction: -1, quantity: 200, runningBalance: rb, type: 'action', createdAt: new Date(t += 1000) });
  const before = JSON.stringify(_stub.rows(Fin));
  assert.strictEqual(await bal('financial', e), -1200);
  const fv = await view('financial', e);
  assert.strictEqual(fv[fv.length - 1].runningBalance, -1200, 'shown total is the true sum, not the stale last-by-date snapshot (-800)');
  assert.ok(fv.every((r) => 'storedRunningBalance' in r));
  assert.strictEqual(JSON.stringify(_stub.rows(Fin)), before, 'reading never mutates stored rows');
  ok('legacy forked snapshots: view and balance() show the true -1200; stored rows untouched');

  /* 11. same for every ledger type */
  for (const [name, Model] of [['marks', Marks], ['percentage', Pct], ['attendance', Att], ['financial', Fin]]) {
    _stub.reset(); e = oid();
    await add(name, e, '08-30', -1, 5); await add(name, e, '08-26', -1, 3); await add(name, e, '08-28', +1, 2);
    assert.strictEqual(await bal(name, e), -6);
    assert.strictEqual((await view(name, e)).pop().runningBalance, -6);
  }
  ok('financial / marks / percentage / attendance all derive from the same service');

  /* 12. dashboard net total */
  _stub.reset();
  const e1 = oid(), e2 = oid();
  // exact scenario: debits 5600, credits 4200
  for (let i = 0; i < 28; i++) await add('financial', e1, '08-26', -1, 200);
  for (let i = 0; i < 21; i++) await add('financial', e1, '10-10', +1, 200);
  const sum1 = await call(dash.summary, { user: hr, query: {} });
  assert.strictEqual(sum1.financialTotal, 1400);
  ok('dashboard financialTotal = debits 5600 - credits 4200 = 1400 (was 5600)');

  /* 13. date filters */
  _stub.reset();
  await add('financial', e2, '08-26', -1, 200); await add('financial', e2, '08-27', -1, 200); await add('financial', e2, '09-10', +1, 150);
  const S = (q) => call(dash.summary, { user: hr, query: q }).then((r) => r.financialTotal);
  assert.strictEqual(await S({}), 250, 'all-time');
  assert.strictEqual(await S({ from: '2026-08-27T00:00:00Z' }), 50, 'start date only');
  assert.strictEqual(await S({ to: '2026-08-26T23:59:59Z' }), 200, 'end date only');
  assert.strictEqual(await S({ from: '2026-08-27T00:00:00Z', to: '2026-08-27T23:59:59Z' }), 200, 'same-day range');
  assert.strictEqual(await S({ from: '2026-08-26T00:00:00Z', to: '2026-08-31T00:00:00Z' }), 400, 'range with debits but no credit');
  assert.strictEqual(await S({ from: '2026-08-26T00:00:00Z', to: '2026-09-30T00:00:00Z' }), 250, 'range with debits and the reversal');
  assert.strictEqual(await S({ from: '2026-09-01T00:00:00Z' }), -150, 'credit-only window is negative (not clamped, not hidden)');
  ok('dashboard date filters: all-time, from, to, same-day, debit-only, debit+credit, credit-only');

  /* 14. no ledger writes from any read path */
  const snap = JSON.stringify(_stub.rows(Fin));
  await call(dash.summary, { user: hr, query: {} }); await view('financial', e2);
  assert.strictEqual(JSON.stringify(_stub.rows(Fin)), snap);
  ok('dashboard + ledger view are read-only');

  console.log(`\n  ${n} Phase 3B ledger/dashboard checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
