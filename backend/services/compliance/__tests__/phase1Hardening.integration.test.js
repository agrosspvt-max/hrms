/**
 * phase1Hardening.integration.test.js -- REAL MongoDB checks for the Phase 1
 * hardening patch (the in-memory stub cannot reproduce these):
 *
 *   - duplicate-key handling for ComplianceActionEffect does not run on an
 *     aborted replica-set transaction (previously: ~120 s stall per duplicate)
 *   - concurrent / repeated apply => exactly 1 effect, 1 ledger row
 *   - the recurringKey partial unique index behaves as designed
 *   - dependency Penalty anchoring never picks a test / hidden / deleted
 *     submission and is deterministic, against real unique indexes
 *
 * Runs against BOTH a single-node replica set (transactions) and a standalone.
 * Needs a mongod binary: set MONGOMS_SYSTEM_BINARY=/path/to/mongod (or let
 * mongodb-memory-server download one).  When none can be started the test
 * prints SKIPPED and exits 0 -- it never touches a real database.
 *
 *   cd backend && MONGOMS_SYSTEM_BINARY=$(which mongod) node services/compliance/__tests__/phase1Hardening.integration.test.js
 */
process.env.NODE_ENV = 'test';
process.env.MISSED_SUBMISSION_EFFECTIVE_FROM = '2020-01-01';

const assert = require('assert');
const mongoose = require('mongoose');

// A duplicate must resolve in well under a second; the old behaviour was ~120 000 ms.
const FAST_MS = 5000;
const D = (s) => new Date(`${s}T00:00:00Z`);
const oid = () => new mongoose.Types.ObjectId();
let checks = 0; const ok = (m) => { checks += 1; console.log(`  ok  ${checks}: ${m}`); };

const M = (n) => require(`../../../models/${n}`);

const suite = async (label, uri, expectTxn) => {
  require('../../../config/runtimeSafety').assertLocalOnly(uri, 'integration test');   // never a shared database
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, autoIndex: true });
  const Effect = M('ComplianceActionEffect'), Incident = M('ComplianceIncident'), Rule = M('ComplianceRule'), Fin = M('FinancialLedger');
  const Penalty = M('Penalty'), Submission = M('Submission'), Dep = M('DependencyTask'), User = M('User');
  for (const m of [Effect, Incident, Rule, Fin, Penalty, Submission, Dep, User, M('ComplianceEvent'), M('MarksLedger'), M('PercentageLedger'),
    M('AttendanceLedger'), M('AuditLog'), M('Holiday'), M('Leave'), M('Event')]) await m.syncIndexes();
  require('../txn')._resetForTest();
  const compliance = require('../../compliance');
  const penaltyEngine = require('../../penaltyEngine');
  const { withComplianceTransaction } = require('../txn');
  assert.strictEqual((await withComplianceTransaction(async () => 1)).mode, expectTxn ? 'transaction' : 'serial', `${label}: txn mode`);

  const idx = (await Effect.collection.indexes()).find((i) => i.name === 'compliance_effect_recurring_key');
  assert.ok(idx && idx.unique && idx.partialFilterExpression.recurringKey.$type === 'string', `${label}: recurringKey partial unique index built`);
  ok(`[${label}] recurringKey partial unique index exists`);

  const rule = await Rule.create({ code: `dep_${label}`, name: 'x', category: 'dependency', detector: 'built_in.dependency_pending', enabled: true,
    severity: 'medium', version: 1, trigger: {}, scope: {}, notifications: {}, recovery: {}, waiver: {},
    actions: [{ type: 'financial_fine', enabled: true, config: { amount: 200, recurring: true } }] });
  const emp = oid();
  const mkInc = (day, key) => Incident.create({ ruleId: rule._id, ruleVersion: 1, ruleCode: rule.code, employee: emp, severity: 'medium',
    incidentDate: D(day), effectiveDate: D(day), status: 'active', naturalKey: key, source: 'automatic', context: {} });
  const [A, B] = [await mkInc('2026-07-10', 'a'), await mkInc('2026-07-11', 'b')];
  const apply = (inc, day) => compliance.actionEngine.apply({ incident: inc.toObject(), day: D(day), recurringOnly: true });
  const timed = async (fn) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };
  // Ledger rows are matched through their effect reference (a recurring debit
  // carries the INCIDENT's date, not the effect day).
  const state = async (day) => {
    const ids = (await Effect.find({ employee: emp, effectiveDate: D(day) }).select('_id').lean()).map((e) => e._id);
    return { effects: ids.length, ledger: await Fin.countDocuments({ refEffectId: { $in: ids } }) };
  };

  // sequential: apply, then apply the same incident again
  let t1 = await timed(() => apply(A, '2026-07-13'));
  assert.deepStrictEqual(t1.r.effects.map((e) => e.created), [true]);
  let t2 = await timed(() => apply(A, '2026-07-13'));
  assert.deepStrictEqual(t2.r.effects.map((e) => e.created), [false]);
  assert.ok(t2.ms < FAST_MS, `${label}: sequential duplicate took ${t2.ms} ms`);
  assert.deepStrictEqual(await state('2026-07-13'), { effects: 1, ledger: 1 });
  ok(`[${label}] sequential duplicate apply returned already-created in ${t2.ms} ms (1 effect, 1 ledger row)`);

  // a sibling incident is covered by the pre-check
  let t3 = await timed(() => apply(B, '2026-07-13'));
  assert.ok(t3.r.effects[0].dedupedBy && t3.ms < FAST_MS);
  ok(`[${label}] sibling incident deduped by pre-check in ${t3.ms} ms`);

  // concurrent race: same incident twice + sibling incidents, 3 days, 8-way
  const C = await mkInc('2026-07-12', 'c'), Dd = await mkInc('2026-07-12T12:00:00Z'.slice(0, 10), 'd');
  const all = [A, B, C, Dd];
  for (const d of ['2026-07-14', '2026-07-15', '2026-07-16']) {
    const { r, ms } = await timed(() => Promise.all([...all, ...all].map((i) => apply(i, d))));
    assert.strictEqual(r.reduce((s, x) => s + x.errors.length, 0), 0, `${label}: no errors in the race`);
    assert.strictEqual(r.flatMap((x) => x.effects.map((e) => e.created)).filter(Boolean).length, 1, `${label}: exactly one creator`);
    assert.ok(ms < FAST_MS, `${label}: 8-way race took ${ms} ms`);
    assert.deepStrictEqual(await state(d), { effects: 1, ledger: 1 });
    ok(`[${label}] 8-way concurrent race ${d}: 1 creator, 1 effect, 1 ledger row, ${ms} ms`);
  }
  const effs = await Effect.find({ employee: emp }).lean(); const fin = await Fin.find({ employee: emp }).lean();
  assert.strictEqual(fin.reduce((s, r) => s + r.direction * r.quantity, 0), -200 * effs.length);
  assert.ok(fin.every((f) => effs.some((e) => String(e._id) === String(f.refEffectId))), `${label}: no orphan ledger rows`);
  assert.strictEqual(new Set(effs.map((e) => String(e.ledgerRefs.financial))).size, effs.length, `${label}: one distinct ledger ref per effect`);
  ok(`[${label}] ledger total = -200 x effects; no orphan rows; one ledger ref per effect`);

  // dependency anchoring on real indexes
  const mkEmp = async (n) => { const e = await User.create({ name: n, employeeId: `${label}${n}`, email: `${label}${n}@x`, password: 'secret1', role: 'employee',
    status: 'active', department: oid(), weeklyOff: [0] });
    await Dep.create({ assignedBy: e._id, assignedTo: e._id, currentStatus: 'open', waitingSince: D('2026-07-01') }); return e; };
  const sub = (e, o = {}) => Submission.create({ employee: e._id, template: oid(), templateType: 'task', date: D('2026-07-14'), earnedPoints: 0, ...o });
  const run = (e) => penaltyEngine.enforceDependencyPending({ employeeId: e._id, day: D('2026-07-14') });
  const rows = (e) => Penalty.find({ employee: e._id, category: 'dependency_pending' }).lean();
  for (const [lbl, flag] of [['test-data', { isTestData: true }], ['hidden', { hidden: true }], ['deleted', { deleted: true }]]) {
    const e = await mkEmp(lbl); await run(e);
    const bad = await sub(e, { ...flag, earnedPoints: 1 }); const good = await sub(e, { earnedPoints: 9 });
    await Promise.all([run(e), run(e), run(e)]);
    const r = await rows(e);
    assert.strictEqual(r.length, 1); assert.strictEqual(String(r[0].submission), String(good._id)); assert.notStrictEqual(String(r[0].submission), String(bad._id));
    assert.strictEqual(r[0].penaltyMarks, 9);
    ok(`[${label}] dependency anchoring ignores a ${lbl} submission (even with concurrent runs): 1 row, valid submission, marks 9`);
  }
  { const e = await mkEmp('multi'); const un = await sub(e);
    await sub(e, { submitted: true, submittedAt: new Date('2026-07-14T15:00:00Z'), earnedPoints: 20 });
    const early = await sub(e, { submitted: true, submittedAt: new Date('2026-07-14T09:00:00Z'), earnedPoints: 12 });
    await run(e); await Submission.updateOne({ _id: un._id }, { $set: { submitted: true, submittedAt: new Date('2026-07-14T01:00:00Z') } }); await run(e);
    const r = await rows(e); assert.strictEqual(r.length, 1); assert.strictEqual(String(r[0].submission), String(early._id)); assert.strictEqual(r[0].penaltyMarks, 12);
    ok(`[${label}] multiple valid submissions: deterministic (earliest submitted), no second row when the primary later changes`); }
  { const e = await mkEmp('none'); await sub(e, { isTestData: true }); await sub(e, { hidden: true }); await sub(e, { deleted: true }); await run(e); await run(e);
    const r = await rows(e); assert.strictEqual(r.length, 1); assert.strictEqual(r[0].submission, null);
    ok(`[${label}] only invalid submissions: penalty stays unanchored`); }

  // escalation: a step whose effect already exists must not stall or double-debit
  const stepId = oid(); const act = { _id: oid(), type: 'financial_fine', config: { amount: 50 } };
  const eRule = await Rule.create({ code: `esc_${label}`, name: 'e', category: 'dependency', detector: 'built_in.dependency_pending', enabled: true, severity: 'medium',
    version: 1, trigger: {}, scope: {}, notifications: {}, recovery: {}, waiver: {}, actions: [], escalation: [{ _id: stepId, afterDays: 1, actionsAdd: [act] }] });
  const eEmp = oid();
  const eInc = await Incident.create({ ruleId: eRule._id, ruleVersion: 1, ruleCode: eRule.code, employee: eEmp, severity: 'medium', incidentDate: D('2026-07-10'),
    effectiveDate: D('2026-07-10'), status: 'active', naturalKey: `esc-${label}`, source: 'automatic', context: {} });
  await Effect.create({ incidentId: eInc._id, ruleId: eRule._id, ruleActionId: act._id, actionType: 'financial_fine', employee: eEmp, status: 'active',
    effectiveDate: D('2026-07-13'), amount: 50 });
  const esc = await timed(() => compliance.escalationRunner.run({ day: D('2026-07-13') }));
  assert.strictEqual(esc.r.errors, 0); assert.ok(esc.ms < FAST_MS);
  assert.strictEqual(await Effect.countDocuments({ employee: eEmp }), 1); assert.strictEqual(await Fin.countDocuments({ employee: eEmp }), 0);
  ok(`[${label}] escalation with a pre-existing step effect: no error, no second debit, ${esc.ms} ms`);

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
    console.log(`\n${checks} real-MongoDB hardening checks passed`);
  } finally {
    try { await rs.stop(); } catch (_) { /* */ }
    try { await sa.stop(); } catch (_) { /* */ }
  }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
