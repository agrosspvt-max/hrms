/**
 * phase4Domain.integration.test.js -- REAL MongoDB (single-node replica set AND
 * standalone, disposable) checks for the Phase 4 pieces that depend on atomicity
 * and indexes: acknowledgement, payroll deduction, deduction-vs-reversal races,
 * effect->submission link under concurrent applies, and Final Marks parity read
 * from real collections.  Prints SKIPPED (exit 0) when no mongod can be started.
 *
 *   cd backend && MONGOMS_SYSTEM_BINARY=$(which mongod) node services/compliance/__tests__/phase4Domain.integration.test.js
 */
process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';

const assert = require('assert');
const mongoose = require('mongoose');
const oid = () => new mongoose.Types.ObjectId();
const D = (s) => new Date(`${s}T00:00:00Z`);
const M = (n) => require(`../../../models/${n}`);
let checks = 0; const ok = (m) => { checks += 1; console.log(`  ok  ${checks}: ${m}`); };
const ITER = 14;

const suite = async (label, uri, expectTxn) => {
  require('../../../config/runtimeSafety').assertLocalOnly(uri, 'integration test');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, autoIndex: true });
  const Rule = M('ComplianceRule'), Incident = M('ComplianceIncident'), Effect = M('ComplianceActionEffect'), Waiver = M('ComplianceWaiver'),
    Event = M('ComplianceEvent'), Penalty = M('Penalty'), Marks = M('MarksLedger'), Fin = M('FinancialLedger');
  for (const m of [Rule, Incident, Effect, Waiver, Event, Penalty, Marks, Fin, M('PercentageLedger'), M('AttendanceLedger'), M('ComplianceRecovery'), M('AuditLog')]) await m.syncIndexes();
  require('../txn')._resetForTest();
  const compliance = require('../../compliance');
  const incidentService = require('../incidents/incidentService');
  const ack = require('../acknowledgement/acknowledgementService');
  const payroll = require('../payroll/payrollService');
  const finalMarks = require('../projections/finalMarks');
  const penaltyMath = require('../../penaltyMath');
  const lifecycle = require('../lifecycle');
  const { withComplianceTransaction } = require('../txn');
  assert.strictEqual((await withComplianceTransaction(async () => 1)).mode, expectTxn ? 'transaction' : 'serial');
  const db = mongoose.connection.db;
  const hr = oid();
  const idx = (await Effect.collection.indexes()).map((i) => i.name);
  assert.ok(idx.some((n) => /submissionId/.test(n)) && idx.some((n) => /payroll/.test(n)), `${label}: Phase 4 effect indexes built`);
  ok(`[${label}] effect indexes for submissionId and payroll.status are built`);

  const mkRule = (code, actions) => Rule.create({ code, name: code, category: 'conduct', detector: 'manual', enabled: true, severity: 'medium', version: 1,
    trigger: {}, scope: {}, notifications: {}, recovery: {}, waiver: {}, actions });
  const fineRule = await mkRule(`fine_${label}`, [{ type: 'financial_fine', enabled: true, config: { amount: 100 } }]);
  const missRule = await mkRule('missed_submission_v2', [{ type: 'zero_daily_marks', enabled: true, config: { marksStrategy: 'submission_earned' } }]);
  const sub = async (emp, day, earned, extra = {}) => { const _id = oid();
    await db.collection('submissions').insertOne({ _id, employee: emp, template: oid(), date: D(day), earnedPoints: earned, totalPoints: 20, submitted: true, submittedAt: new Date(), ...extra }); return { _id, employee: emp, totalPoints: 20, earnedPoints: earned }; };
  const slipFor = async (emp) => { const _id = oid(); await db.collection('salaryslips').insertOne({ _id, employee: emp }); return _id; };
  const mkFine = async (emp, amount) => {
    const inc = await Incident.create({ ruleId: fineRule._id, ruleVersion: 1, ruleCode: fineRule.code, employee: emp, severity: 'medium', incidentDate: D('2026-10-05'),
      effectiveDate: D('2026-10-05'), status: 'active', naturalKey: `f-${oid()}`, source: 'manual', context: {}, detectorMeta: { hrOverride: { amount } } });
    await compliance.actionEngine.apply({ incident: inc.toObject(), day: D('2026-10-05') });
    return Effect.findOne({ incidentId: inc._id, actionType: 'financial_fine' }).lean();
  };

  /* ---- acknowledgement under concurrency ---- */
  for (let i = 0; i < ITER; i++) {
    const emp = oid();
    const inc = await Incident.create({ ruleId: fineRule._id, ruleVersion: 1, ruleCode: fineRule.code, employee: emp, severity: 'low',
      incidentDate: D('2026-10-05'), effectiveDate: D('2026-10-05'), status: 'active', naturalKey: `a-${oid()}`, source: 'manual', context: {} });
    const r = await Promise.all(Array.from({ length: 10 }, () => ack.acknowledge({ incidentId: inc._id, user: { _id: emp } })));
    assert.strictEqual(r.filter((x) => !x.alreadyAcknowledged).length, 1, 'exactly one winner');
    assert.strictEqual(await Event.countDocuments({ incidentId: inc._id, kind: 'incident_acknowledged' }), 1);
  }
  ok(`[${label}] acknowledgement x${ITER}: 10 concurrent calls -> 1 acknowledgement, 1 event`);

  /* ---- payroll: overlapping concurrent deduction requests ---- */
  const emp = oid(); const slip = await slipFor(emp);
  const fines = []; for (const a of [100, 200, 300, 400, 500]) fines.push(await mkFine(emp, a));
  const ids = fines.map((f) => f._id);
  const t0 = Date.now();
  const res = await Promise.all(Array.from({ length: 12 }, (_, i) => payroll.markDeducted({
    effectIds: ids.filter((_, j) => (i + j) % 2 === 0 || i % 3 === 0), salarySlipId: slip, salaryMonth: '2026-10', actor: hr })));
  const touched = new Set(res.flatMap((r) => r.results.map((x) => String(x.effectId))));
  const deductedTotal = res.reduce((a, r) => a + r.deducted, 0);
  assert.strictEqual(deductedTotal, touched.size, 'every effect that was requested was deducted exactly once');
  const rows = await Effect.find({ _id: { $in: ids } }).lean();
  assert.ok(rows.filter((e) => e.payroll.status === 'deducted').length === touched.size);
  assert.strictEqual(await Event.countDocuments({ kind: 'payroll_deducted', employee: emp }), touched.size);
  assert.ok(Date.now() - t0 < 5000);
  ok(`[${label}] 12 overlapping deduction requests: ${touched.size} fines deducted exactly once each, ${touched.size} events`);

  /* ---- deduction vs reversal races: never "deducted+reversed" without a refund flag, never a reversed fine deducted ---- */
  const racers = {
    cancel: (f) => incidentService.cancelIncident(f.incidentId, { reason: 'r', actor: hr }),
    recover: (f) => compliance.recoveryService.apply({ incidentId: f.incidentId, mode: 'restore', reason: 'r', actor: hr }),
    waive: async (f) => { const w = await compliance.waiverService.request({ incidentId: f.incidentId, scope: 'full', reason: 'r', requestedBy: f.employee });
      return compliance.waiverService.decide({ waiverId: w._id, decision: 'approved', decidedBy: hr }); },
  };
  for (const [name, op] of Object.entries(racers)) {
    const seen = new Set();
    for (let i = 0; i < ITER; i++) {
      const e = oid(); const sl = await slipFor(e); const f = await mkFine(e, 250);
      // Random head start for either side so both orderings (and true overlap) are exercised.
      const lag = (ms) => new Promise((r) => setTimeout(r, ms));
      const jitter = Math.floor(Math.random() * 40) * (Math.random() < 0.5 ? 1 : -1);
      const out = await Promise.allSettled([
        lag(Math.max(0, jitter)).then(() => op(f)),
        lag(Math.max(0, -jitter)).then(() => payroll.markDeducted({ effectIds: [f._id], salarySlipId: sl, salaryMonth: '2026-10', actor: hr })),
      ]);
      for (const o of out) if (o.status === 'rejected') assert.ok(o.reason instanceof lifecycle.LifecycleError, `${name}: ${o.reason && o.reason.stack}`);
      const now = await Effect.findById(f._id).lean();
      assert.notStrictEqual(now.status, 'active', `${name}: the reversal always lands`);
      const deducted = now.payroll.status === 'deducted';
      assert.strictEqual(!!now.payroll.refundDue, deducted, `${name}: refundDue iff the fine had already been deducted (${deducted})`);
      const credits = await Fin.countDocuments({ refEffectId: f._id, direction: 1 });
      assert.strictEqual(credits, 1, `${name}: exactly one credit`);
      seen.add(deducted ? 'deducted-then-reversed(refundDue)' : 'reversed-first(not deducted)');
    }
    ok(`[${label}] ${name} vs payroll x${ITER}: outcomes ${JSON.stringify([...seen])}; one credit; refundDue exactly when needed`);
  }

  /* ---- effect->submission link under concurrent applies ---- */
  const eM = oid(); const sM = await sub(eM, '2026-10-04', 7);
  await sub(eM, '2026-10-04', 99, { isTestData: true });
  const incM = await Incident.create({ ruleId: missRule._id, ruleVersion: 1, ruleCode: 'missed_submission_v2', employee: eM, severity: 'medium',
    incidentDate: D('2026-10-04'), effectiveDate: D('2026-10-05'), status: 'active', naturalKey: `m-${oid()}`, source: 'automatic', context: { submissionId: sM._id } });
  await Promise.all(Array.from({ length: 8 }, () => compliance.actionEngine.apply({ incident: incM.toObject(), day: D('2026-10-05') })));
  const zs = await Effect.find({ incidentId: incM._id, actionType: 'zero_daily_marks' }).lean();
  assert.strictEqual(zs.length, 1); assert.deepStrictEqual([String(zs[0].submissionId), zs[0].marks], [String(sM._id), 7]);
  assert.strictEqual(await Marks.countDocuments({ refEffectId: zs[0]._id }), 1);
  ok(`[${label}] 8 concurrent applies: 1 zero-day effect linked to the right submission (marks 7), 1 ledger row`);

  /* ---- Final Marks: real collections, parity with an equivalent legacy Penalty ---- */
  const eF = oid(); const sF = await sub(eF, '2026-10-02', 10);
  await Penalty.create({ employee: eF, category: 'missed_submission', source: 'automatic', probable: false, status: 'active', penaltyMarks: 4, submission: sF._id, targetDate: D('2026-10-02') });
  const incF = await Incident.create({ ruleId: missRule._id, ruleVersion: 1, ruleCode: 'missed_submission_v2', employee: eF, severity: 'medium',
    incidentDate: D('2026-10-02'), effectiveDate: D('2026-10-02'), status: 'active', naturalKey: `p-${oid()}`, source: 'manual', context: { submissionId: sF._id }, detectorMeta: { hrOverride: { marks: 4 } } });
  await compliance.actionEngine.apply({ incident: incF.toObject(), day: D('2026-10-02') });
  const a = [JSON.parse(JSON.stringify(sF))], b = [JSON.parse(JSON.stringify(sF))];
  await penaltyMath.attachFinalMarksLegacy(a); await finalMarks.attachFinalMarks(b);
  assert.strictEqual(a[0].finalMarks, 6); assert.deepStrictEqual([b[0].finalMarks, b[0].penaltyDeduction, b[0].originalEarnedMarks], [6, 4, 10]);
  ok(`[${label}] Final Marks from real collections: legacy Penalty = ${a[0].finalMarks}, Compliance effects = ${b[0].finalMarks}`);

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
  try { await suite('replset', rs.getUri(), true); await suite('standalone', sa.getUri(), false); console.log(`\n${checks} real-MongoDB Phase 4 checks passed`); }
  finally { try { await rs.stop(); } catch (_) { /* */ } try { await sa.stop(); } catch (_) { /* */ } }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
