/**
 * phase2Lifecycle.test.js -- Phase 2: compliance lifecycle / state safety.
 *
 * In-memory checks (state matrix, idempotency, ledger shape, legacy
 * Penalty mirror, audit events).  Concurrency against real MongoDB lives in
 * phase2Lifecycle.integration.test.js.
 *
 *   cd backend && node services/compliance/__tests__/phase2Lifecycle.test.js
 */
process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();
const M = (n) => require(`../../../models/${n}`);
const names = ['User', 'ComplianceRule', 'ComplianceIncident', 'ComplianceEvent', 'ComplianceActionEffect',
  'ComplianceWaiver', 'ComplianceRecovery', 'MarksLedger', 'FinancialLedger', 'PercentageLedger',
  'AttendanceLedger', 'AuditLog', 'Penalty', 'Notification'];
const [User, Rule, Incident, Event, Effect, Waiver, Recovery, Marks, Fin, Pct, Att, Audit, Penalty, Notif] = names.map(M);
_stub.install(User);
_stub.install(Rule, { uniqueBy: [['code']] });
_stub.install(Incident, { uniqueBy: [['naturalKey', 'source']] });
_stub.install(Effect, { uniqueBy: [['incidentId', 'ruleActionId', 'effectiveDate']] });
[Event, Waiver, Recovery, Marks, Fin, Pct, Att, Audit, Penalty, Notif].forEach((m) => _stub.install(m));

const compliance = require('../../compliance');
const waiverService = compliance.waiverService;
const recoveryService = compliance.recoveryService;
const incidentService = require('../incidents/incidentService');
const lifecycle = require('../lifecycle');

const D = new Date('2026-10-05T00:00:00Z');
let nk = 0;
const mkRule = () => Rule.create({
  code: `missed_submission_v2`, name: 'x', category: 'submission', detector: 'built_in.missed_submission', enabled: true,
  severity: 'medium', version: 1, trigger: {}, scope: {},
  actions: [
    { _id: _oid(), type: 'fixed_marks_reduction', enabled: true, config: { marks: 4 } },
    { _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 100 } },
  ],
  notifications: {}, recovery: {}, waiver: {},
});
let rule;
// A fresh ACTIVE incident with two applied effects (marks 4, financial 100) and a mirrored legacy Penalty.
const fresh = async () => {
  const emp = _oid(); const sub = _oid();
  const inc = await Incident.create({
    ruleId: rule._id, ruleVersion: 1, ruleCode: rule.code, employee: emp, severity: 'medium',
    incidentDate: D, effectiveDate: D, status: 'active', naturalKey: `nk-${++nk}`, source: 'automatic',
    context: { submissionId: sub },
  });
  await compliance.actionEngine.apply({ incident: inc });
  const pen = await Penalty.create({ _id: _oid(), employee: emp, category: 'missed_submission', source: 'automatic',
    probable: false, status: 'active', penaltyMarks: 4, targetDate: D, submission: sub });
  const other = await Penalty.create({ _id: _oid(), employee: emp, category: 'missed_submission', source: 'automatic',
    probable: false, status: 'active', penaltyMarks: 4, targetDate: D, submission: _oid() });
  return { emp, inc, pen, other };
};
const incStatus = (i) => _stub.rows(Incident).find((r) => String(r._id) === String(i._id)).status;
const penStatus = (p) => _stub.rows(Penalty).find((r) => String(r._id) === String(p._id)).status;
const effects = (i) => _stub.rows(Effect).filter((e) => String(e.incidentId) === String(i._id));
const credits = (emp) => [..._stub.rows(Marks), ..._stub.rows(Fin)].filter((r) => String(r.employee) === String(emp) && r.direction === 1);
const events = (i, kind) => _stub.rows(Event).filter((e) => String(e.incidentId) === String(i._id) && (!kind || e.kind === kind));
const actor = _oid();
const cancel = (i) => incidentService.cancelIncident(i._id, { reason: 'r', actor });
const waiveAll = async (i, emp) => {
  const w = await waiverService.request({ incidentId: i._id, scope: 'full', reason: 'r', requestedBy: emp });
  return waiverService.decide({ waiverId: w._id, decision: 'approved', decidedBy: actor });
};
const recover = (i, extra = {}) => recoveryService.apply({ incidentId: i._id, mode: 'restore', reason: 'r', actor, ...extra });
const isConflict = (e) => e instanceof lifecycle.LifecycleError && e.httpStatus === 409;
let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };

(async () => {
  _stub.reset();
  rule = await mkRule();

  /* ---- valid transitions from active ---- */
  let a = await fresh();
  assert.strictEqual(effects(a.inc).length, 2);
  const c = await cancel(a.inc);
  assert.strictEqual(c.status, 'cancelled');
  assert.deepStrictEqual(effects(a.inc).map((e) => e.status), ['cancelled', 'cancelled']);
  const cr = credits(a.emp);
  assert.strictEqual(cr.length, 2);
  assert.deepStrictEqual(cr.map((r) => [r.type, r.direction, r.quantity]).sort(), [['recovery', 1, 100], ['recovery', 1, 4]]);
  assert.ok(cr.every((r) => String(r.refIncidentId) === String(a.inc._id) && r.refEffectId));
  assert.strictEqual(new Set(cr.map((r) => String(r.refEffectId))).size, 2, 'one reversal per effect');
  assert.strictEqual(penStatus(a.pen), 'cancelled'); assert.strictEqual(penStatus(a.other), 'active');
  const ce = events(a.inc, 'incident_cancelled');
  assert.strictEqual(ce.length, 1); assert.strictEqual(ce[0].payload.from, 'active'); assert.strictEqual(ce[0].payload.to, 'cancelled');
  ok('active -> cancel: 2 effects cancelled, exactly 2 credits (+1, ref effect), mirror cancelled, unrelated Penalty untouched, event from/to');

  a = await fresh();
  const w = await waiveAll(a.inc, a.emp);
  assert.strictEqual(w.status, 'auto_approved' === w.status ? w.status : 'approved');
  assert.strictEqual(incStatus(a.inc), 'waived');
  assert.deepStrictEqual(effects(a.inc).map((e) => e.status), ['waived', 'waived']);
  const wc = credits(a.emp);
  assert.deepStrictEqual(wc.map((r) => [r.type, r.direction, r.quantity]).sort(), [['waiver', 1, 100], ['waiver', 1, 4]]);
  assert.ok(wc.every((r) => String(r.refWaiverId) === String(w._id)));
  assert.strictEqual(penStatus(a.pen), 'cancelled'); assert.strictEqual(penStatus(a.other), 'active');
  ok('active -> waive (full): incident waived, 2 credits tied to the waiver, mirror cancelled once');

  a = await fresh();
  const rc = await recover(a.inc);
  assert.strictEqual(incStatus(a.inc), 'resolved');
  assert.deepStrictEqual(effects(a.inc).map((e) => e.status), ['resolved', 'resolved']);
  const rcr = credits(a.emp);
  assert.deepStrictEqual(rcr.map((r) => [r.type, r.direction, r.quantity]).sort(), [['recovery', 1, 100], ['recovery', 1, 4]]);
  assert.ok(rcr.every((r) => String(r.refRecoveryId) === String(rc._id)));
  assert.strictEqual(_stub.rows(Recovery).filter((r) => String(r.incidentId) === String(a.inc._id)).length, 1);
  assert.strictEqual(penStatus(a.pen), 'resolved'); assert.strictEqual(penStatus(a.other), 'active');
  const re = events(a.inc, 'recovery_applied');
  assert.strictEqual(re.length, 1); assert.strictEqual(re[0].payload.incidentTo, 'resolved');
  ok('active -> recover: resolved, 2 credits tied to the recovery, ONE Recovery row, mirror resolved, unrelated untouched');

  a = await fresh();
  await incidentService.resolveIncident(a.inc._id, { reason: 'cleared', actor });
  assert.strictEqual(incStatus(a.inc), 'resolved');
  assert.strictEqual(credits(a.emp).length, 0, 'resolve does not reverse effects');
  ok('active -> resolve: resolved, no ledger movement');

  /* ---- invalid transitions: nothing changes ---- */
  const snapshot = (i, emp) => JSON.stringify({
    inc: _stub.rows(Incident).find((r) => String(r._id) === String(i._id)),
    eff: effects(i).map((e) => e.status),
    led: _stub.rows(Marks).length + _stub.rows(Fin).length,
    ev: _stub.rows(Event).length, rec: _stub.rows(Recovery).length,
    pen: _stub.rows(Penalty).map((p) => p.status),
    wv: _stub.rows(Waiver).length,
  });
  const invalid = async (label, i, emp, op, re) => {
    const before = snapshot(i, emp);
    await assert.rejects(op, (e) => isConflict(e) && re.test(e.message), `${label} should be a 409 ${re}`);
    assert.strictEqual(snapshot(i, emp), before, `${label}: state must be untouched`);
  };
  const reach = {
    cancelled: async () => { const x = await fresh(); await cancel(x.inc); return x; },
    waived: async () => { const x = await fresh(); await waiveAll(x.inc, x.emp); return x; },
    resolved: async () => { const x = await fresh(); await recover(x.inc); return x; },
  };
  for (const [state, mk] of Object.entries(reach)) {
    const x = await mk();
    if (state !== 'cancelled') await invalid(`${state} -> cancel`, x.inc, x.emp, () => cancel(x.inc), new RegExp(`already ${state}`));
    await invalid(`${state} -> recover`, x.inc, x.emp, () => recover(x.inc), new RegExp(`already ${state}|no outstanding`));
    await invalid(`${state} -> waive request`, x.inc, x.emp,
      () => waiverService.request({ incidentId: x.inc._id, scope: 'full', reason: 'r', requestedBy: x.emp }), new RegExp(`already ${state}`));
    if (state !== 'resolved') await invalid(`${state} -> resolve (strict)`, x.inc, x.emp,
      () => incidentService.resolveIncident(x.inc._id, { actor, strict: true }), new RegExp(`already ${state}`));
    assert.strictEqual(incStatus(x.inc), state, `${state} must not be rewritten`);
  }
  ok('invalid transitions (cancelled/waived/resolved x cancel|recover|waive|resolve) -> 409, zero side effects, status never rewritten');

  /* ---- cancelled/waived never flipped to resolved by the legacy resolver ---- */
  for (const state of ['cancelled', 'waived']) {
    const x = await reach[state]();
    const before = snapshot(x.inc, x.emp);
    await incidentService.resolveIncident(x.inc._id, { actor });            // non-strict (automation path)
    assert.strictEqual(incStatus(x.inc), state);
    assert.strictEqual(snapshot(x.inc, x.emp), before);
  }
  ok('automation resolveIncident leaves cancelled/waived incidents alone (no silent flip, no event)');

  /* ---- idempotency ---- */
  a = await fresh();
  await cancel(a.inc);
  const evBefore = _stub.rows(Event).length; const ledBefore = credits(a.emp).length;
  const again = await cancel(a.inc);
  assert.strictEqual(again.status, 'cancelled'); assert.strictEqual(again.alreadyCancelled, true);
  assert.strictEqual(_stub.rows(Event).length, evBefore); assert.strictEqual(credits(a.emp).length, ledBefore);
  ok('cancel twice: second is a no-op (no event, no credit, no Penalty write)');

  a = await fresh();
  const [c1, c2] = await Promise.allSettled([cancel(a.inc), cancel(a.inc)]);
  assert.strictEqual(c1.status, 'fulfilled'); assert.strictEqual(c2.status, 'fulfilled');
  assert.strictEqual(credits(a.emp).length, 2); assert.strictEqual(events(a.inc, 'incident_cancelled').length, 1);
  ok('cancel + cancel (concurrent): one cancellation, 2 credits total, 1 event');

  a = await fresh();
  await recover(a.inc);
  await assert.rejects(() => recover(a.inc), isConflict);
  assert.strictEqual(credits(a.emp).length, 2); assert.strictEqual(_stub.rows(Recovery).filter((r) => String(r.incidentId) === String(a.inc._id)).length, 1);
  assert.strictEqual(events(a.inc, 'recovery_applied').length, 1);
  ok('recover twice: second refused, 1 Recovery row, 2 credits, 1 event');

  a = await fresh();
  const rr = await Promise.allSettled([recover(a.inc), recover(a.inc)]);
  assert.strictEqual(rr.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(rr.find((r) => r.status === 'rejected').reason instanceof lifecycle.LifecycleError);
  assert.strictEqual(credits(a.emp).length, 2); assert.strictEqual(_stub.rows(Recovery).filter((r) => String(r.incidentId) === String(a.inc._id)).length, 1);
  ok('recover + recover (concurrent): exactly one wins, 2 credits, 1 Recovery row');

  a = await fresh();
  const wq = await waiverService.request({ incidentId: a.inc._id, scope: 'full', reason: 'r', requestedBy: a.emp });
  const dd = await Promise.allSettled([
    waiverService.decide({ waiverId: wq._id, decision: 'approved', decidedBy: actor }),
    waiverService.decide({ waiverId: wq._id, decision: 'approved', decidedBy: actor }),
  ]);
  assert.ok(dd.every((r) => r.status === 'fulfilled'));
  assert.strictEqual(credits(a.emp).length, 2); assert.strictEqual(events(a.inc, 'waiver_decided').length, 1);
  assert.strictEqual(incStatus(a.inc), 'waived');
  ok('approve + approve (concurrent): 2 credits, 1 decision event');

  a = await fresh();
  const wr = await waiverService.request({ incidentId: a.inc._id, scope: 'full', reason: 'r', requestedBy: a.emp });
  await waiverService.decide({ waiverId: wr._id, decision: 'rejected', decidedBy: actor });
  const evN = _stub.rows(Event).length;
  const rej2 = await waiverService.decide({ waiverId: wr._id, decision: 'rejected', decidedBy: actor });
  assert.strictEqual(rej2.status, 'rejected'); assert.strictEqual(_stub.rows(Event).length, evN, 'no second event');
  await assert.rejects(() => waiverService.decide({ waiverId: wr._id, decision: 'approved', decidedBy: actor }), isConflict);
  assert.strictEqual(incStatus(a.inc), 'active'); assert.strictEqual(credits(a.emp).length, 0);
  ok('reject twice: no second event; approving a rejected waiver -> 409, nothing resurrected');

  /* ---- waiver approval cannot resurrect terminal incidents ---- */
  a = await fresh();
  const wp = await waiverService.request({ incidentId: a.inc._id, scope: 'full', reason: 'r', requestedBy: a.emp });
  await recover(a.inc);                                       // resolved; pending waiver left behind
  await assert.rejects(() => waiverService.decide({ waiverId: wp._id, decision: 'approved', decidedBy: actor }), isConflict);
  assert.strictEqual(incStatus(a.inc), 'resolved'); assert.strictEqual(credits(a.emp).length, 2);
  const cleared = await waiverService.decide({ waiverId: wp._id, decision: 'rejected', decidedBy: actor });
  assert.strictEqual(cleared.status, 'rejected');
  ok('approve on resolved incident -> 409 (status kept); stale pending waiver can still be rejected out of the queue');

  /* ---- cancel + waiver approval: deterministic ---- */
  a = await fresh();
  const wc2 = await waiverService.request({ incidentId: a.inc._id, scope: 'full', reason: 'r', requestedBy: a.emp });
  const res = await Promise.allSettled([
    cancel(a.inc),
    waiverService.decide({ waiverId: wc2._id, decision: 'approved', decidedBy: actor }),
  ]);
  const finalStatus = incStatus(a.inc);
  assert.ok(['cancelled', 'waived'].includes(finalStatus));
  assert.strictEqual(credits(a.emp).length, 2, 'each effect credited exactly once');
  assert.strictEqual(_stub.rows(Waiver).filter((x) => x.status === 'pending').length, 0, 'no pending waiver left on a terminal incident');
  assert.ok(effects(a.inc).every((e) => e.status === finalStatus));
  assert.ok(res.filter((r) => r.status === 'fulfilled').length >= 1);
  ok(`cancel + waiver approval (concurrent): single final state "${finalStatus}", 2 credits, nothing pending`);

  /* ---- cancel + recover: deterministic ---- */
  a = await fresh();
  const res2 = await Promise.allSettled([cancel(a.inc), recover(a.inc)]);
  const fs2 = incStatus(a.inc);
  assert.ok(['cancelled', 'resolved'].includes(fs2));
  assert.strictEqual(credits(a.emp).length, 2);
  assert.ok(effects(a.inc).every((e) => e.status === fs2));
  assert.strictEqual(res2.filter((r) => r.status === 'rejected').length <= 1, true);
  ok(`cancel + recover (concurrent): single final state "${fs2}", 2 credits, no mixed effects`);

  /* ---- partial recovery / waiver ---- */
  a = await fresh();
  const first = effects(a.inc)[0];
  await recover(a.inc, { effectIds: [first._id] });
  assert.strictEqual(incStatus(a.inc), 'active', 'partial recovery keeps the incident open');
  assert.strictEqual(credits(a.emp).length, 1);
  assert.strictEqual(penStatus(a.pen), 'active', 'incident-wide mirror untouched by a partial recovery');
  await assert.rejects(() => recover(a.inc, { effectIds: [first._id] }), isConflict);
  assert.strictEqual(credits(a.emp).length, 1);
  await recover(a.inc);
  assert.strictEqual(incStatus(a.inc), 'resolved'); assert.strictEqual(credits(a.emp).length, 2);
  assert.strictEqual(penStatus(a.pen), 'resolved');
  ok('partial recovery: incident stays open, mirror untouched; re-recovering the same effect refused; finishing resolves + mirrors');

  a = await fresh();
  const [e1] = effects(a.inc);
  const pw = await waiverService.request({ incidentId: a.inc._id, scope: 'partial', effectIds: [e1._id], reason: 'r', requestedBy: a.emp });
  await waiverService.decide({ waiverId: pw._id, decision: 'approved', decidedBy: actor });
  assert.strictEqual(incStatus(a.inc), 'active'); assert.strictEqual(credits(a.emp).length, 1);
  assert.strictEqual(penStatus(a.pen), 'active');
  await assert.rejects(() => waiverService.request({ incidentId: a.inc._id, scope: 'partial', effectIds: [_oid()], reason: 'r', requestedBy: a.emp }), /belong to this incident/);
  ok('partial waiver: incident stays active, one credit, mirror untouched; foreign effectIds rejected');

  /* ---- cancel mirrors a candidate (no effects yet) ---- */
  const emp3 = _oid(); const sub3 = _oid();
  const cand = await Incident.create({ ruleId: rule._id, ruleVersion: 1, ruleCode: rule.code, employee: emp3, severity: 'medium',
    incidentDate: D, effectiveDate: D, status: 'candidate', naturalKey: `nk-${++nk}`, source: 'automatic', context: { submissionId: sub3 } });
  const cp = await Penalty.create({ _id: _oid(), employee: emp3, category: 'missed_submission', source: 'automatic', probable: false,
    status: 'active', penaltyMarks: 4, targetDate: D, submission: sub3 });
  await cancel(cand);
  assert.strictEqual(penStatus(cp), 'cancelled'); assert.strictEqual(incStatus(cand), 'cancelled');
  ok('cancel of a candidate (no effects) still cancels its legacy Penalty mirror');

  /* ---- no resurrection of a cancelled Penalty ---- */
  a = await fresh();
  await Penalty.updateMany({ _id: a.pen._id }, { $set: { status: 'cancelled', cancelReason: 'earlier' } });
  await recover(a.inc);
  assert.strictEqual(penStatus(a.pen), 'cancelled');
  assert.strictEqual(_stub.rows(Penalty).find((p) => String(p._id) === String(a.pen._id)).cancelReason, 'earlier');
  ok('recovery never resurrects / re-stamps an already-cancelled Penalty');

  /* ---- ledger de-dup guard for legacy half-reversed state ---- */
  a = await fresh();
  const [m1] = effects(a.inc).filter((e) => e.actionType === 'fixed_marks_reduction');
  await compliance.ledgerService.append({ ledger: 'marks', employee: a.emp, date: new Date(), direction: 1, quantity: 4,
    type: 'recovery', reason: 'old double', refIncidentId: a.inc._id, refEffectId: m1._id });
  await cancel(a.inc);
  assert.strictEqual(credits(a.emp).filter((r) => String(r.refEffectId) === String(m1._id)).length, 1, 'no second reversal for an effect that already has one');
  ok('an effect that already has a reversal row is not credited again');

  /* ---- failure paths leave no half state ---- */
  a = await fresh();
  const realAppend = compliance.ledgerService.append;
  let calls = 0;
  compliance.ledgerService.append = async (x) => { if (++calls === 2) throw new Error('boom'); return realAppend(x); };
  await assert.rejects(() => cancel(a.inc), /boom/);
  compliance.ledgerService.append = realAppend;
  assert.strictEqual(incStatus(a.inc), 'active', 'serial-mode failure reopens the incident');
  await cancel(a.inc);
  assert.strictEqual(incStatus(a.inc), 'cancelled');
  assert.strictEqual(credits(a.emp).length, 2, 'retry completes with exactly one credit per effect');
  ok('failure mid-cancel then retry: exactly one credit per effect, final state cancelled');

  /* ---- bad input mapped to proper HTTP statuses ---- */
  await assert.rejects(() => cancel({ _id: _oid() }).then((r) => { if (!r) throw Object.assign(new Error('nf'), { nf: true }); }), (e) => e.nf);
  await assert.rejects(() => recover({ _id: _oid() }), (e) => e.httpStatus === 404);
  ok('unknown incident: cancel -> null (404 in controller), recover -> 404');

  console.log(`\n  ${n} Phase 2 lifecycle checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
