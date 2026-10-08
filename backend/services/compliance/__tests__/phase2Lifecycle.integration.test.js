/**
 * phase2Lifecycle.integration.test.js -- REAL MongoDB concurrency checks
 * for the Phase 2 lifecycle fixes (cancel / waive / recover / resolve).
 * The in-memory stub cannot reproduce write conflicts, transaction retries
 * or index-backed uniqueness, so these run against a disposable mongod:
 * a single-node replica set (transactions) and a standalone.
 *
 * Each race is repeated ITER times with fresh data.  Invariants per run:
 *   - every effect that left pending|active has EXACTLY ONE compensating
 *     (+1) ledger row; every still-outstanding effect has none
 *   - the incident ends in exactly one terminal state, events/recoveries
 *     are not duplicated, no waiver is left pending on a terminal incident
 *   - replica set only: every effect carries the same final state as the
 *     incident (standalone cannot be atomic across documents, so a
 *     cancel/recover race may split effects between the two winners, but
 *     never double-credits)
 *
 * Needs a mongod binary (MONGOMS_SYSTEM_BINARY=/path/to/mongod); prints
 * SKIPPED and exits 0 when none can be started.
 *
 *   cd backend && MONGOMS_SYSTEM_BINARY=$(which mongod) node services/compliance/__tests__/phase2Lifecycle.integration.test.js
 */
process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';

const assert = require('assert');
const mongoose = require('mongoose');

const ITER = 6;
const FAST_MS = 5000;
const D = new Date('2026-10-05T00:00:00Z');
const oid = () => new mongoose.Types.ObjectId();
const M = (n) => require(`../../../models/${n}`);
let checks = 0; const ok = (m) => { checks += 1; console.log(`  ok  ${checks}: ${m}`); };

const suite = async (label, uri, expectTxn) => {
  require('../../../config/runtimeSafety').assertLocalOnly(uri, 'integration test');   // never a shared database
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, autoIndex: true });
  const Rule = M('ComplianceRule'), Incident = M('ComplianceIncident'), Effect = M('ComplianceActionEffect'),
    Waiver = M('ComplianceWaiver'), Recovery = M('ComplianceRecovery'), Event = M('ComplianceEvent'),
    Marks = M('MarksLedger'), Fin = M('FinancialLedger'), Penalty = M('Penalty');
  for (const m of [Rule, Incident, Effect, Waiver, Recovery, Event, Marks, Fin, Penalty, M('PercentageLedger'),
    M('AttendanceLedger'), M('AuditLog')]) await m.syncIndexes();
  require('../txn')._resetForTest();
  const compliance = require('../../compliance');
  const incidentService = require('../incidents/incidentService');
  const lifecycle = require('../lifecycle');
  const { withComplianceTransaction } = require('../txn');
  assert.strictEqual((await withComplianceTransaction(async () => 1)).mode, expectTxn ? 'transaction' : 'serial', `${label}: txn mode`);
  const wIdx = (await Waiver.collection.indexes()).find((i) => i.name === 'compliance_waiver_pending_request_key');
  assert.ok(wIdx && wIdx.unique, `${label}: pending waiver request-key index built`);
  ok(`[${label}] pending-waiver request-key partial unique index exists`);

  const rule = await Rule.create({
    code: 'missed_submission_v2', name: 'x', category: 'submission', detector: 'built_in.missed_submission', enabled: true,
    severity: 'medium', version: 1, trigger: {}, scope: {}, notifications: {}, recovery: {}, waiver: {},
    actions: [
      { type: 'fixed_marks_reduction', enabled: true, config: { marks: 4 } },
      { type: 'financial_fine', enabled: true, config: { amount: 100 } },
    ],
  });
  let seq = 0;
  const actor = oid();
  const fresh = async () => {
    const emp = oid(); const sub = oid();
    const inc = await Incident.create({ ruleId: rule._id, ruleVersion: 1, ruleCode: rule.code, employee: emp, severity: 'medium',
      incidentDate: D, effectiveDate: D, status: 'active', naturalKey: `p2-${label}-${++seq}`, source: 'automatic',
      context: { submissionId: sub } });
    await compliance.actionEngine.apply({ incident: inc.toObject() });
    const pen = await Penalty.create({ employee: emp, category: 'missed_submission', source: 'automatic', probable: false,
      status: 'active', penaltyMarks: 4, targetDate: D, submission: sub });
    const other = await Penalty.create({ employee: emp, category: 'missed_submission', source: 'automatic', probable: false,
      status: 'active', penaltyMarks: 4, targetDate: D, submission: oid() });
    return { emp, inc: inc.toObject(), pen, other };
  };
  const cancel = (x) => incidentService.cancelIncident(x.inc._id, { reason: 'r', actor });
  const recover = (x) => compliance.recoveryService.apply({ incidentId: x.inc._id, mode: 'restore', reason: 'r', actor });
  const reqWaiver = (x) => compliance.waiverService.request({ incidentId: x.inc._id, scope: 'full', reason: 'r', requestedBy: x.emp });
  const approve = (x, w) => compliance.waiverService.decide({ waiverId: w._id, decision: 'approved', decidedBy: actor });
  const timed = async (fn) => { const t = Date.now(); const r = await Promise.allSettled(fn()); return { r, ms: Date.now() - t }; };

  // Verifies the invariants above; returns the final incident status.
  const verify = async (x, name) => {
    const inc = await Incident.findById(x.inc._id).lean();
    const effs = await Effect.find({ incidentId: x.inc._id }).lean();
    assert.strictEqual(effs.length, 2, `${name}: effects kept`);
    const rows = [...await Marks.find({ employee: x.emp }).lean(), ...await Fin.find({ employee: x.emp }).lean()]
      .filter((r) => r.direction === 1);
    for (const e of effs) {
      const mine = rows.filter((r) => String(r.refEffectId) === String(e._id));
      const left = !['pending', 'active'].includes(e.status);
      assert.strictEqual(mine.length, left ? 1 : 0, `${name}: effect ${e.actionType} (${e.status}) credits=${mine.length}`);
      if (left) assert.strictEqual(mine[0].quantity, e.actionType === 'financial_fine' ? 100 : 4, `${name}: credit amount`);
    }
    assert.strictEqual(rows.length, effs.filter((e) => !['pending', 'active'].includes(e.status)).length, `${name}: no orphan credits`);
    assert.ok(['cancelled', 'resolved', 'waived'].includes(inc.status), `${name}: terminal (${inc.status})`);
    assert.ok((await Event.countDocuments({ incidentId: x.inc._id, kind: 'incident_cancelled' })) <= 1, `${name}: <=1 cancel event`);
    assert.ok((await Event.countDocuments({ incidentId: x.inc._id, kind: 'recovery_applied' })) <= 1, `${name}: <=1 recovery event`);
    assert.ok((await Recovery.countDocuments({ incidentId: x.inc._id })) <= 1, `${name}: <=1 Recovery row`);
    assert.strictEqual(await Waiver.countDocuments({ incidentId: x.inc._id, status: 'pending' }), 0, `${name}: no pending waiver left`);
    const unrelated = await Penalty.findById(x.other._id).lean();
    assert.strictEqual(unrelated.status, 'active', `${name}: unrelated Penalty untouched`);
    if (expectTxn) {
      assert.ok(effs.every((e) => e.status === inc.status), `${name}: txn mode => effects share the incident's final state (${inc.status})`);
      const p = await Penalty.findById(x.pen._id).lean();
      assert.strictEqual(p.status, inc.status === 'waived' ? 'cancelled' : inc.status, `${name}: mirror follows final state`);
    }
    return inc.status;
  };

  const race = async (name, setup, ops, expectOutcomes) => {
    const finals = []; let maxMs = 0; const rejections = [];
    for (let i = 0; i < ITER; i++) {
      const x = await fresh();
      const ctx = setup ? await setup(x) : null;
      const t = await timed(() => ops(x, ctx));
      maxMs = Math.max(maxMs, t.ms);
      for (const r of t.r) if (r.status === 'rejected') {
        assert.ok(r.reason instanceof lifecycle.LifecycleError, `${name}: unexpected error ${r.reason && r.reason.stack}`);
        rejections.push(r.reason.code);
      }
      assert.ok(t.r.some((r) => r.status === 'fulfilled'), `${name}: at least one operation succeeds`);
      const f = await verify(x, name);
      assert.ok(expectOutcomes.includes(f), `${name}: final ${f}`);
      finals.push(f);
      assert.ok(t.ms < FAST_MS, `${name}: took ${t.ms} ms`);
    }
    ok(`[${label}] ${name} x${ITER}: finals=${JSON.stringify([...new Set(finals)])}, refused=${rejections.length}, max ${maxMs} ms, 0 duplicate credits`);
  };

  await race('cancel + cancel', null, (x) => [cancel(x), cancel(x)], ['cancelled']);
  await race('recover + recover', null, (x) => [recover(x), recover(x)], ['resolved']);
  await race('approve + approve', (x) => reqWaiver(x), (x, w) => [approve(x, w), approve(x, w)], ['waived']);
  await race('cancel + recover', null, (x) => [cancel(x), recover(x)], ['cancelled', 'resolved']);
  await race('cancel + waiver approval', (x) => reqWaiver(x), (x, w) => [cancel(x), approve(x, w)], ['cancelled', 'waived']);
  await race('recover + waiver approval', (x) => reqWaiver(x), (x, w) => [recover(x), approve(x, w)], ['resolved', 'waived']);
  await race('8-way cancel storm', null, (x) => Array.from({ length: 8 }, () => cancel(x)), ['cancelled']);

  // duplicate pending waiver requests collapse to one row (index-backed)
  const x = await fresh();
  const ws = await Promise.all([reqWaiver(x), reqWaiver(x), reqWaiver(x)]);
  assert.strictEqual(new Set(ws.map((w) => String(w._id))).size, 1);
  assert.strictEqual(await Waiver.countDocuments({ incidentId: x.inc._id }), 1);
  ok(`[${label}] 3 concurrent identical waiver requests -> 1 pending row`);

  // sequential idempotency on real data
  const y = await fresh();
  await cancel(y);
  const before = { ev: await Event.countDocuments({ incidentId: y.inc._id }), led: await Marks.countDocuments({ employee: y.emp }) + await Fin.countDocuments({ employee: y.emp }) };
  const again = await cancel(y);
  assert.strictEqual(again.alreadyCancelled, true);
  assert.deepStrictEqual({ ev: await Event.countDocuments({ incidentId: y.inc._id }), led: await Marks.countDocuments({ employee: y.emp }) + await Fin.countDocuments({ employee: y.emp }) }, before);
  await assert.rejects(() => recover(y), (e) => e.httpStatus === 409);
  await assert.rejects(() => reqWaiver(y), (e) => e.httpStatus === 409);
  assert.strictEqual((await Incident.findById(y.inc._id).lean()).status, 'cancelled');
  ok(`[${label}] cancelled incident: re-cancel is a no-op; recover / waive refused; status unchanged`);

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
    console.log(`\n${checks} real-MongoDB Phase 2 checks passed`);
  } finally {
    try { await rs.stop(); } catch (_) { /* */ }
    try { await sa.stop(); } catch (_) { /* */ }
  }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
