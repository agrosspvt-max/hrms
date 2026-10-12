/**
 * phase4Refiling.integration.test.js -- REAL MongoDB (single-node replica set
 * AND standalone, disposable) concurrency checks for the Compliance re-file
 * grant: one-open-per-stub index, concurrent request / approve / reject /
 * consume, and the races request+approve, approve+revoke, approve+consume.
 * Prints SKIPPED (exit 0) when no mongod can be started.
 *
 *   cd backend && MONGOMS_SYSTEM_BINARY=$(which mongod) node services/compliance/__tests__/phase4Refiling.integration.test.js
 */
process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';

const assert = require('assert');
const mongoose = require('mongoose');
const oid = () => new mongoose.Types.ObjectId();
const M = (n) => require(`../../../models/${n}`);
let checks = 0; const ok = (m) => { checks += 1; console.log(`  ok  ${checks}: ${m}`); };
const ITER = 12;
const lag = (ms) => new Promise((r) => setTimeout(r, ms));

const suite = async (label, uri) => {
  require('../../../config/runtimeSafety').assertLocalOnly(uri, 'integration test');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, autoIndex: true });
  const Refile = M('ComplianceRefile'), Event = M('ComplianceEvent'), Incident = M('ComplianceIncident'), Penalty = M('Penalty');
  for (const m of [Refile, Event, Incident, Penalty, M('AuditLog')]) await m.syncIndexes();
  const { startOfDay, addDays } = require('../../../utils/dateHelpers');
  const refile = require('../refile/refileService');
  const eligibility = require('../refile/refileEligibility');
  const lifecycle = require('../lifecycle');
  const db = mongoose.connection.db;
  const TODAY = startOfDay(new Date()), PAST = addDays(TODAY, -3);
  const hr = { _id: oid(), role: 'hr' };

  assert.ok((await Refile.collection.indexes()).some((i) => i.name === 'compliance_refile_one_open_per_submission' && i.unique));
  ok(`[${label}] partial unique index "one open re-file per submission" is built`);

  const day = async () => {
    const emp = oid(); const _id = oid();
    await db.collection('submissions').insertOne({ _id, employee: emp, template: oid(), date: PAST, submitted: false, earnedPoints: 0, totalPoints: 10 });
    await db.collection('penalties').insertOne({ _id: oid(), employee: emp, category: 'missed_submission', source: 'automatic', probable: false, status: 'active',
      penaltyMarks: 0, targetDate: PAST, submission: _id, createdAt: new Date(), updatedAt: new Date() });
    return { emp, id: _id, sub: await db.collection('submissions').findOne({ _id }) };
  };
  const ev = (kind, id) => Event.countDocuments({ kind, 'payload.submissionId': id });
  const accept = (res) => { for (const r of res) if (r.status === 'rejected') assert.ok(r.reason instanceof lifecycle.LifecycleError, r.reason && r.reason.stack); };

  /* concurrent identical requests */
  for (let i = 0; i < ITER; i++) {
    const d = await day();
    const out = await Promise.all(Array.from({ length: 10 }, () => refile.request({ user: { _id: d.emp }, submissionId: d.id, reason: 'r', today: TODAY })));
    assert.strictEqual(new Set(out.map((o) => String(o._id))).size, 1);
    assert.strictEqual(await Refile.countDocuments({ submissionId: d.id }), 1);
    assert.strictEqual(await ev('refile_requested', d.id), 1);
  }
  ok(`[${label}] x${ITER}: 10 concurrent identical requests -> 1 row, 1 event`);

  /* concurrent approval / rejection / mixed */
  for (const [name, decision] of [['approval', 'approved'], ['rejection', 'rejected']]) {
    for (let i = 0; i < ITER; i++) {
      const d = await day(); const r = await refile.request({ user: { _id: d.emp }, submissionId: d.id, reason: 'r', today: TODAY });
      const out = await Promise.all(Array.from({ length: 10 }, () => refile.decide({ refileId: r._id, decision, actor: hr })));
      assert.strictEqual(out.filter((o) => !o.alreadyDecided).length, 1);
      assert.strictEqual(await ev('refile_decided', d.id), 1);
      assert.strictEqual((await Refile.findById(r._id).lean()).status, decision);
    }
    ok(`[${label}] x${ITER}: 10 concurrent ${name}s -> exactly one effective, one event`);
  }
  for (let i = 0; i < ITER; i++) {                                     // opposite decisions at once
    const d = await day(); const r = await refile.request({ user: { _id: d.emp }, submissionId: d.id, reason: 'r', today: TODAY });
    const res = await Promise.allSettled([refile.decide({ refileId: r._id, decision: 'approved', actor: hr }), refile.decide({ refileId: r._id, decision: 'rejected', actor: hr })]);
    accept(res);
    assert.strictEqual(res.filter((x) => x.status === 'fulfilled').length, 1, 'exactly one of the opposite decisions wins');
    assert.strictEqual(await ev('refile_decided', d.id), 1);
  }
  ok(`[${label}] x${ITER}: approve vs reject at once -> one wins, the other is a 409, one event`);

  /* request vs HR send-back */
  const finals = new Set();
  for (let i = 0; i < ITER; i++) {
    const d = await day(); const j = Math.floor(Math.random() * 30) * (Math.random() < 0.5 ? 1 : -1);
    const res = await Promise.allSettled([
      lag(Math.max(0, j)).then(() => refile.request({ user: { _id: d.emp }, submissionId: d.id, reason: 'r', today: TODAY })),
      lag(Math.max(0, -j)).then(() => refile.sendBack({ submissionId: d.id, actor: hr, today: TODAY })),
    ]);
    accept(res);
    const rows = await Refile.find({ submissionId: d.id }).lean();
    assert.strictEqual(rows.filter((r) => r.open).length, 1, 'exactly one open row');
    assert.strictEqual(rows.length, 1, 'never a second row');
    assert.strictEqual(rows[0].status, 'approved');
    assert.strictEqual((await eligibility.check({ submission: d.sub, today: TODAY })).allowed, true);
    finals.add(rows[0].source);
  }
  ok(`[${label}] x${ITER}: request vs send-back race -> one approved grant (sources seen: ${JSON.stringify([...finals])})`);

  /* approve vs revoke */
  const seen = new Set();
  for (let i = 0; i < ITER; i++) {
    const d = await day(); const r = await refile.request({ user: { _id: d.emp }, submissionId: d.id, reason: 'r', today: TODAY });
    const j = Math.floor(Math.random() * 30) * (Math.random() < 0.5 ? 1 : -1);
    const res = await Promise.allSettled([
      lag(Math.max(0, j)).then(() => refile.decide({ refileId: r._id, decision: 'approved', actor: hr })),
      lag(Math.max(0, -j)).then(() => refile.revoke({ refileId: r._id, actor: hr })),
    ]);
    accept(res);
    const fin = await Refile.findById(r._id).lean();
    assert.ok(['approved', 'revoked'].includes(fin.status));
    assert.strictEqual(fin.open, fin.status === 'approved');
    assert.strictEqual((await eligibility.check({ submission: d.sub, today: TODAY })).allowed, fin.status === 'approved');
    seen.add(fin.status);
  }
  ok(`[${label}] x${ITER}: approve vs revoke -> consistent final state ${JSON.stringify([...seen])}; eligibility follows the state`);

  /* approval then concurrent submissions (consume) and revoke */
  for (let i = 0; i < ITER; i++) {
    const d = await day(); await refile.sendBack({ submissionId: d.id, actor: hr, today: TODAY });
    const res = await Promise.allSettled([...Array.from({ length: 8 }, () => refile.consumeForSubmission({ submissionId: d.id, actor: d.emp })),
      refile.revoke({ refileId: (await Refile.findOne({ submissionId: d.id }).lean())._id, actor: hr })]);
    accept(res);
    const fin = await Refile.findOne({ submissionId: d.id }).lean();
    assert.ok(['consumed', 'revoked'].includes(fin.status));
    assert.strictEqual(await ev('refile_consumed', d.id) + await Event.countDocuments({ kind: 'refile_revoked', 'payload.refileId': fin._id }), 1, 'exactly one of consume / revoke happened');
    assert.strictEqual(fin.open, false);
  }
  ok(`[${label}] x${ITER}: 8 concurrent submissions + a revoke -> exactly one transition (consumed XOR revoked), one event`);

  /* eligibility is never an error while everything churns */
  const d = await day(); await refile.request({ user: { _id: d.emp }, submissionId: d.id, reason: 'r', today: TODAY });
  const rid = (await Refile.findOne({ submissionId: d.id }).lean())._id;
  const churn = await Promise.allSettled([refile.decide({ refileId: rid, decision: 'approved', actor: hr }),
    ...Array.from({ length: 20 }, () => eligibility.check({ submission: d.sub, today: TODAY }))]);
  assert.ok(churn.every((c) => c.status === 'fulfilled'));
  ok(`[${label}] 20 gate checks during an approval: no errors`);

  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
};

(async () => {
  let ReplSet, Server;
  try { ({ MongoMemoryReplSet: ReplSet, MongoMemoryServer: Server } = require('mongodb-memory-server')); }
  catch (e) { console.log('SKIPPED: mongodb-memory-server is not installed.'); return; }
  let rs; let sa;
  try { rs = await ReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); sa = await Server.create(); }
  catch (e) {
    console.log(`SKIPPED: could not start a disposable mongod (${String(e.message).split('\n')[0]}).`);
    console.log('         Set MONGOMS_SYSTEM_BINARY=/path/to/mongod to run these real-MongoDB checks.');
    try { if (rs) await rs.stop(); } catch (_) { /* */ }
    return;
  }
  try { await suite('replset', rs.getUri()); await suite('standalone', sa.getUri()); console.log(`\n${checks} real-MongoDB Phase 4F checks passed`); }
  finally { try { await rs.stop(); } catch (_) { /* */ } try { await sa.stop(); } catch (_) { /* */ } }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
