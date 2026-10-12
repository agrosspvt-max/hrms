/**
 * phase4Refiling.test.js -- Phase 4F: Compliance owns "may this employee
 * re-submit this missed day?".  Eligibility parity with the legacy gate, the
 * request / decision / send-back / revoke / consume lifecycle, idempotency,
 * permissions, and the migrated readers (submitOne gate, expectedSubmissions,
 * daily review index, penalty breakdown badge).  In-memory; the concurrency
 * runs on real MongoDB are in phase4Refiling.integration.test.js.
 *
 *   cd backend && node services/compliance/__tests__/phase4Refiling.test.js
 */
process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const oid = () => new mongoose.Types.ObjectId();
const M = (n) => require(`../../../models/${n}`);
const names = ['User', 'Submission', 'Template', 'Penalty', 'ComplianceRule', 'ComplianceIncident', 'ComplianceActionEffect', 'ComplianceEvent',
  'ComplianceWaiver', 'ComplianceRecovery', 'ComplianceRefile', 'MarksLedger', 'FinancialLedger', 'PercentageLedger', 'AttendanceLedger', 'AuditLog', 'Notification'];
const [User, Submission, Template, Penalty, Rule, Incident, Effect, Event, Waiver, Recovery, Refile, Marks, Fin, Pct, Att, Audit, Notif] = names.map(M);
[User, Submission, Template, Waiver, Recovery, Marks, Fin, Pct, Att, Audit, Notif, Event].forEach((m) => _stub.install(m));
const uOpen = ['submissionId']; uOpen.filter = { open: true };
_stub.install(Refile, { uniqueBy: [uOpen] });
_stub.install(Penalty);
_stub.install(Rule, { uniqueBy: [['code']] });
_stub.install(Incident, { uniqueBy: [['naturalKey', 'source']] });
_stub.install(Effect, { uniqueBy: [['incidentId', 'ruleActionId', 'effectiveDate']] });

const { startOfDay, addDays } = require('../../../utils/dateHelpers');
const eligibility = require('../refile/refileEligibility');
const refile = require('../refile/refileService');
const lifecycle = require('../lifecycle');
const expected = require('../../expectedSubmissions');
const penaltyMath = require('../../penaltyMath');
const compliance = require('../../compliance');
const submissionController = require('../../../controllers/submissionController');
const rc = require('../../../controllers/compliance/refileController');

const TODAY = startOfDay(new Date());
const PAST = addDays(TODAY, -3);
const hr = { role: 'hr', _id: oid() };
const sa = { role: 'super_admin', _id: oid() };
const hod = { role: 'hod', _id: oid() };
let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };
const is = (st, code) => (e) => e instanceof lifecycle.LifecycleError && e.httpStatus === st && (!code || e.code === code);

const mkStub = (emp, extra = {}) => Submission.create({ _id: oid(), employee: emp, template: oid(), date: PAST, submitted: false, earnedPoints: 0, totalPoints: 10, ...extra });
const mkPen = (stub, extra = {}) => Penalty.create({ _id: oid(), employee: stub.employee, category: 'missed_submission', source: 'automatic', probable: false,
  status: 'active', penaltyMarks: 0, targetDate: stub.date, submission: stub._id, ...extra });
// A "blocked" missed day = stub + the legacy missed Penalty (the legacy writer is still on)
const blockedDay = async (emp = oid(), extra = {}) => { const s = await mkStub(emp, extra); const p = await mkPen(s); return { emp, s, p }; };
const decisionOf = async (s) => (await eligibility.check({ submission: s, today: TODAY }));
const events = (kind) => _stub.rows(Event).filter((e) => e.kind === kind);
const call = async (h, req) => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; let err = null; await h(req, res, (e) => { err = e; }); return { res, err }; };

(async () => {
  /* =============== ELIGIBILITY (parity with the legacy gate) =============== */
  const cur = await mkStub(oid(), { date: TODAY });
  assert.deepStrictEqual([(await decisionOf(cur)).allowed, (await decisionOf(cur)).state], [true, 'current_day']);
  ok('1  current-day submission: allowed (never gated)');

  let d = await blockedDay();
  let r = await decisionOf(d.s);
  assert.deepStrictEqual([r.allowed, r.message], [false, eligibility.MESSAGES.none]);
  ok('2  past missed day, no grant: blocked with the legacy "window has closed" message');

  const noMarker = await mkStub(oid());
  assert.strictEqual((await decisionOf(noMarker)).allowed, true);
  const cancelled = await blockedDay(); await Penalty.updateMany({ _id: cancelled.p._id }, { $set: { status: 'cancelled' } });
  assert.strictEqual((await decisionOf(cancelled.s)).allowed, true);
  ok('3  past day with NO missed marker (or a cancelled/resolved penalty): allowed, exactly like before');

  // request -> pending -> blocked
  const req1 = await refile.request({ user: { _id: d.emp, role: 'employee' }, submissionId: d.s._id, reason: 'Was on a site visit', today: TODAY });
  assert.strictEqual(req1.status, 'pending');
  r = await decisionOf(d.s); assert.deepStrictEqual([r.allowed, r.decision, r.message], [false, 'pending', eligibility.MESSAGES.pending]);
  ok('4  request pending: still blocked ("pending HR review")');

  const rej = await refile.decide({ refileId: req1._id, decision: 'rejected', note: 'no', actor: hr });
  assert.strictEqual(rej.status, 'rejected');
  r = await decisionOf(d.s); assert.deepStrictEqual([r.allowed, r.decision, r.message], [false, 'rejected', eligibility.MESSAGES.rejected]);
  ok('5  request rejected: blocked ("HR rejected your reopen request")');

  // after a rejection the employee may ask again (legacy behaviour) and be approved
  const req2 = await refile.request({ user: { _id: d.emp }, submissionId: d.s._id, reason: 'Again', today: TODAY });
  assert.notStrictEqual(String(req2._id), String(req1._id));
  const app = await refile.decide({ refileId: req2._id, decision: 'approved', note: 'ok', actor: hr });
  r = await decisionOf(d.s); assert.deepStrictEqual([r.allowed, r.state, r.source], [true, 'granted', 'compliance']);
  ok('3b new request after a rejection is allowed; approved grant => submission allowed');

  await refile.revoke({ refileId: app._id, reason: 'mistake', actor: hr });
  r = await decisionOf(d.s); assert.strictEqual(r.allowed, false);
  ok('6  grant revoked before use: blocked again');

  // wrong employee / date / stub / non-live: grant rows that do not match the stub never authorize
  const g = await blockedDay();
  const mk = (over) => Refile.create({ employee: g.emp, submissionId: g.s._id, targetDate: g.s.date, status: 'approved', open: true, source: 'hr', requestedBy: hr._id, ...over });
  const wrongEmp = await mk({ employee: oid() }); assert.strictEqual((await decisionOf(g.s)).allowed, false);
  await Refile.deleteMany({ _id: wrongEmp._id });
  const wrongDate = await mk({ targetDate: addDays(PAST, -1) }); assert.strictEqual((await decisionOf(g.s)).allowed, false);
  await Refile.deleteMany({ _id: wrongDate._id });
  const other = await blockedDay(g.emp);                                   // same employee, same day, different task/stub
  await Refile.create({ employee: g.emp, submissionId: other.s._id, targetDate: other.s.date, status: 'approved', open: true, source: 'hr', requestedBy: hr._id });
  assert.strictEqual((await decisionOf(g.s)).allowed, false, 'a grant on another stub does not authorize this one');
  assert.strictEqual((await decisionOf(other.s)).allowed, true);
  ok('7-9  grant for another employee / another date / another task does NOT authorize');

  for (const bad of [{ hidden: true }, { deleted: true }, { isTestData: true }]) {
    const x = await blockedDay(oid(), bad);
    await Refile.create({ employee: x.emp, submissionId: x.s._id, targetDate: x.s.date, status: 'approved', open: true, source: 'hr', requestedBy: hr._id });
    assert.strictEqual((await decisionOf(x.s)).allowed, false, JSON.stringify(bad));
    await assert.rejects(() => refile.request({ user: { _id: x.emp }, submissionId: x.s._id, reason: 'r', today: TODAY }), is(400, 'not_live'));
  }
  ok('10-12  hidden / deleted / test submission: an approved grant does not make it eligible; cannot be requested');

  // incident-only marker (legacy writer off / v2 rule on) blocks and a grant opens it
  const e2 = oid(); const s2 = await mkStub(e2);
  await Incident.create({ ruleId: oid(), ruleVersion: 1, ruleCode: 'missed_submission_v2', employee: e2, status: 'active', incidentDate: PAST, effectiveDate: PAST,
    naturalKey: `m-${oid()}`, source: 'automatic', context: { submissionId: s2._id } });
  assert.strictEqual((await decisionOf(s2)).allowed, false);
  await refile.sendBack({ submissionId: s2._id, actor: hr, today: TODAY });
  assert.strictEqual((await decisionOf(s2)).allowed, true);
  ok('13  Compliance-only missed marker (no legacy Penalty) blocks; send-back opens it');

  // legacy-approved grant honoured (BRIDGE)
  const lg = await blockedDay(); await Penalty.updateMany({ _id: lg.p._id }, { $set: { reopenRequest: { requested: true, decision: 'approved' } } });
  r = await decisionOf(lg.s); assert.deepStrictEqual([r.allowed, r.source], [true, 'legacy']);
  const lg2 = await blockedDay(); await Penalty.updateMany({ _id: lg2.p._id }, { $set: { reopenRequest: { requested: true, decision: 'pending' } } });
  assert.strictEqual((await decisionOf(lg2.s)).message, eligibility.MESSAGES.pending);
  ok('14  BRIDGE: a grant approved on the legacy Fines & Penalties page is still honoured; legacy pending keeps its message');

  /* =============== REQUEST =============== */
  const q = await blockedDay();
  const owner = { _id: q.emp, role: 'employee' };
  await assert.rejects(() => refile.request({ user: { _id: oid(), role: 'employee' }, submissionId: q.s._id, reason: 'x', today: TODAY }), is(403));
  await assert.rejects(() => refile.request({ user: hr, submissionId: q.s._id, reason: 'x', today: TODAY }), is(403));
  await assert.rejects(() => refile.request({ user: owner, submissionId: q.s._id, reason: '  ', today: TODAY }), is(400, 'reason_required'));
  await assert.rejects(() => refile.request({ user: owner, submissionId: cur._id, reason: 'x', today: TODAY }), is(403));  // not theirs
  const ownCur = await mkStub(q.emp, { date: TODAY });
  await assert.rejects(() => refile.request({ user: owner, submissionId: ownCur._id, reason: 'x', today: TODAY }), is(400, 'current_day'));
  const free = await mkStub(q.emp, { date: addDays(PAST, -5) });
  await assert.rejects(() => refile.request({ user: owner, submissionId: free._id, reason: 'x', today: TODAY }), is(400, 'not_gated'));
  const done = await blockedDay(oid(), { submitted: true });
  await assert.rejects(() => refile.request({ user: { _id: done.emp }, submissionId: done.s._id, reason: 'x', today: TODAY }), is(409, 'already_submitted'));
  const a1 = await refile.request({ user: owner, submissionId: q.s._id, reason: 'x', today: TODAY });
  const burst = await Promise.all(Array.from({ length: 6 }, () => refile.request({ user: owner, submissionId: q.s._id, reason: 'x', today: TODAY })));
  assert.ok(burst.every((b) => String(b._id) === String(a1._id) && b.alreadyRequested));
  assert.strictEqual(_stub.rows(Refile).filter((x) => String(x.submissionId) === String(q.s._id)).length, 1);
  assert.strictEqual(events('refile_requested').filter((e) => String(e.payload.submissionId) === String(q.s._id)).length, 1);
  ok('15-17  request: own missed day only (others, HR, current day, un-gated day, submitted day refused); duplicates + 6 concurrent collapse to ONE row and ONE event');

  /* =============== DECISION =============== */
  for (const [who, role] of [[hr, 'HR'], [sa, 'Super Admin']]) {
    const x = await blockedDay(); const rq = await refile.request({ user: { _id: x.emp }, submissionId: x.s._id, reason: 'r', today: TODAY });
    const res = await refile.decide({ refileId: rq._id, decision: 'approved', actor: who });
    assert.strictEqual(res.status, 'approved'); assert.strictEqual(String(res.decidedBy), String(who._id));
  }
  const y = await blockedDay(); const ry = await refile.request({ user: { _id: y.emp }, submissionId: y.s._id, reason: 'r', today: TODAY });
  for (const u of [{ _id: y.emp, role: 'employee' }, hod, { _id: oid(), role: 'employee' }]) {
    await assert.rejects(() => refile.decide({ refileId: ry._id, decision: 'approved', actor: u }), is(403));
    await assert.rejects(() => refile.revoke({ refileId: ry._id, actor: u }), is(403));
    await assert.rejects(() => refile.sendBack({ submissionId: y.s._id, actor: u }), is(403));
  }
  ok('18-20  HR and Super Admin can approve; employee (even the owner) and HOD cannot decide, revoke or send back');

  const before = events('refile_decided').length;
  const i1 = await refile.decide({ refileId: ry._id, decision: 'approved', note: 'a', actor: hr });
  const i2 = await refile.decide({ refileId: ry._id, decision: 'approved', note: 'b', actor: hr });
  assert.ok(i2.alreadyDecided); assert.strictEqual(events('refile_decided').length, before + 1);
  await assert.rejects(() => refile.decide({ refileId: ry._id, decision: 'rejected', actor: hr }), is(409));
  const z = await blockedDay(); const rz = await refile.request({ user: { _id: z.emp }, submissionId: z.s._id, reason: 'r', today: TODAY });
  await refile.decide({ refileId: rz._id, decision: 'rejected', actor: hr });
  const z2 = await refile.decide({ refileId: rz._id, decision: 'rejected', actor: hr }); assert.ok(z2.alreadyDecided);
  await assert.rejects(() => refile.decide({ refileId: rz._id, decision: 'approved', actor: hr }), is(409));
  const conc = await blockedDay(); const rc0 = await refile.request({ user: { _id: conc.emp }, submissionId: conc.s._id, reason: 'r', today: TODAY });
  const cb = events('refile_decided').length;
  const out = await Promise.all(Array.from({ length: 6 }, () => refile.decide({ refileId: rc0._id, decision: 'approved', actor: hr })));
  assert.strictEqual(out.filter((o) => !o.alreadyDecided).length, 1); assert.strictEqual(events('refile_decided').length, cb + 1);
  await assert.rejects(() => refile.decide({ refileId: oid(), decision: 'approved', actor: hr }), is(404));
  await assert.rejects(() => refile.decide({ refileId: rc0._id, decision: 'maybe', actor: hr }), is(400));
  ok('21-23  approval / rejection idempotent (one event); opposite decision after a terminal state -> 409; 6 concurrent approvals -> 1 effective');

  /* =============== SEND BACK (HR-initiated, day level) =============== */
  const E = oid();
  const t1 = await mkStub(E), t2 = await mkStub(E);                       // two templates, same day
  await mkPen(t1); await mkPen(t2);
  const none = await mkStub(E, { date: addDays(PAST, -7) });              // another day, no marker
  const sb = await refile.sendBack({ employeeId: E, date: PAST, note: 'sent back', actor: hr, today: TODAY });
  assert.strictEqual(sb.approved, 2);
  assert.ok([t1, t2].every((t) => _stub.rows(Refile).find((x) => String(x.submissionId) === String(t._id) && x.status === 'approved' && x.source === 'hr')));
  assert.strictEqual((await decisionOf(none)).allowed, true);
  const sb2 = await refile.sendBack({ employeeId: E, date: PAST, actor: hr, today: TODAY });
  assert.deepStrictEqual(sb2.results.map((x) => x.outcome), ['already_approved', 'already_approved']);
  assert.strictEqual(_stub.rows(Refile).filter((x) => [t1, t2].some((t) => String(t._id) === String(x.submissionId))).length, 2);
  await assert.rejects(() => refile.sendBack({ employeeId: E, date: addDays(PAST, -7), actor: hr, today: TODAY }), is(409, 'nothing_to_send_back'));
  // a pending employee request is approved in place (no second row)
  const P1 = await blockedDay(); const pr = await refile.request({ user: { _id: P1.emp }, submissionId: P1.s._id, reason: 'r', today: TODAY });
  await refile.sendBack({ submissionId: P1.s._id, actor: hr, today: TODAY });
  assert.strictEqual(_stub.rows(Refile).filter((x) => String(x.submissionId) === String(P1.s._id)).length, 1);
  assert.strictEqual(_stub.rows(Refile).find((x) => String(x._id) === String(pr._id)).status, 'approved');
  ok('send-back: a whole employee-day (2 templates) is reopened, repeat is idempotent, a day with no missed marker is refused, a pending request is approved in place');

  /* =============== EVALUATION MODE (bridge to recovery) =============== */
  const rule = await Rule.create({ code: 'missed_submission_v2', name: 'x', category: 'submission', detector: 'built_in.missed_submission', enabled: true, severity: 'medium', version: 1,
    trigger: {}, scope: {}, notifications: {}, recovery: {}, waiver: {}, actions: [{ _id: oid(), type: 'fixed_marks_reduction', enabled: true, config: { marks: 4 } }] });
  const M1 = await blockedDay();
  const inc = await Incident.create({ ruleId: rule._id, ruleVersion: 1, ruleCode: rule.code, employee: M1.emp, status: 'active', incidentDate: PAST, effectiveDate: PAST,
    naturalKey: `mm-${oid()}`, source: 'automatic', context: { submissionId: M1.s._id } });
  await compliance.actionEngine.apply({ incident: inc, day: PAST });
  const sbm = await refile.sendBack({ submissionId: M1.s._id, evaluationMode: 'restore', note: 'restore it', actor: hr, today: TODAY });
  const se = sbm.results[0].sideEffects;
  assert.deepStrictEqual([se.compliance.applied, se.legacy.applied], [true, true]);
  assert.strictEqual(_stub.rows(Incident).find((x) => String(x._id) === String(inc._id)).status, 'resolved');
  const lp = _stub.rows(Penalty).find((x) => String(x._id) === String(M1.p._id));
  assert.deepStrictEqual([lp.status, lp.evaluationMode, lp.reopenRequest.decision], ['resolved', 'restore', 'approved']);
  assert.strictEqual(_stub.rows(Marks).filter((x) => String(x.refIncidentId) === String(inc._id) && x.direction === 1).length, 1, 'one credit');
  ok('send-back with a mode: Compliance recovery applied once AND (BRIDGE) the legacy Penalty mirrored -- Final Marks stay equivalent in both stores');

  /* =============== CONSUMPTION =============== */
  const C = await blockedDay(); await refile.sendBack({ submissionId: C.s._id, actor: hr, today: TODAY });
  const k = events('refile_consumed').length;
  const c1 = await refile.consumeForSubmission({ submissionId: C.s._id, actor: C.emp });
  const cs = await Promise.all([1, 2, 3].map(() => refile.consumeForSubmission({ submissionId: C.s._id, actor: C.emp })));
  assert.strictEqual(c1.consumed, true); assert.ok(cs.every((x) => x.consumed === false)); assert.strictEqual(events('refile_consumed').length, k + 1);
  const row = _stub.rows(Refile).find((x) => String(x.submissionId) === String(C.s._id));
  assert.deepStrictEqual([row.status, row.open, !!row.consumedAt, String(row.consumedBy)], ['consumed', false, true, String(C.emp)]);
  assert.strictEqual((await eligibility.decisionIndex([C.s._id])).get(String(C.s._id)).reopenRequest.decision, 'completed');
  const reuse = await Submission.create({ _id: C.s._id, employee: C.emp, template: oid(), date: PAST, submitted: false });   // not reusable: a consumed grant no longer authorizes
  assert.strictEqual((await decisionOf(reuse)).allowed, false);
  await assert.rejects(() => refile.revoke({ refileId: row._id, actor: hr }), is(409));
  const rv = await blockedDay(); const g2 = await refile.sendBack({ submissionId: rv.s._id, actor: hr, today: TODAY });
  const rid = g2.results[0].refileId;
  await refile.revoke({ refileId: rid, actor: hr }); const rv2 = await refile.revoke({ refileId: rid, actor: hr }); assert.ok(rv2.alreadyRevoked);
  ok('24-27  submission consumes the grant exactly once (idempotent, 1 event, who/when recorded); a consumed grant is not reusable; revoke is idempotent, not after use');


  /* =============== DIFFERENTIAL: new gate == legacy gate when only legacy data exists =============== */
  // The legacy condition, copied verbatim from submissionController.submitOne (pre-Phase-4F).
  const legacyGate = (sub, missPenalty, today) => {
    if (sub.date && startOfDay(sub.date).getTime() < today.getTime()) {
      if (missPenalty && ['active', 'pending', 'scheduled'].includes(missPenalty.status)) {
        const decision = (missPenalty.reopenRequest && missPenalty.reopenRequest.decision) || '';
        if (decision !== 'approved') {
          return decision === 'pending' ? eligibility.MESSAGES.pending : decision === 'rejected' ? eligibility.MESSAGES.rejected : eligibility.MESSAGES.none;
        }
      }
    }
    return null;                       // allowed
  };
  let cases = 0;
  for (const when of ['past', 'today']) {
    for (const status of [null, 'active', 'pending', 'scheduled', 'resolved', 'cancelled', 'expired']) {
      for (const decision of ['', 'pending', 'approved', 'rejected', 'completed', 'cancelled']) {
        const emp = oid(); const stub = await mkStub(emp, { date: when === 'past' ? PAST : TODAY });
        let pen = null;
        if (status) pen = await mkPen(stub, { status, reopenRequest: decision ? { requested: true, decision } : undefined });
        const want = legacyGate(stub, pen, TODAY);
        const got = await eligibility.check({ submission: stub, today: TODAY });
        assert.deepStrictEqual([got.allowed, got.allowed ? null : got.message], [want === null, want], `${when}/${status}/${decision}`);
        cases += 1;
      }
    }
  }
  ok(`31  differential: the new gate equals the legacy gate in all ${cases} (day x penalty status x reopen decision) combinations`);

  /* =============== MIGRATED READERS =============== */
  // expectedSubmissions: reopened / pending / rejected / normal / resubmitted
  const mkExp = async (state) => { const x = await blockedDay();
    if (state === 'approved') await refile.sendBack({ submissionId: x.s._id, actor: hr, today: TODAY });
    if (state === 'pending' || state === 'rejected') { const r0 = await refile.request({ user: { _id: x.emp }, submissionId: x.s._id, reason: 'r', today: TODAY });
      if (state === 'rejected') await refile.decide({ refileId: r0._id, decision: 'rejected', actor: hr }); }
    return x.s; };
  for (const [st, want] of [['approved', 'reopened'], ['pending', 'not_submitted'], ['rejected', 'not_submitted'], ['none', 'not_submitted']]) {
    const s = await mkExp(st);
    const idx = await expected.buildReopenIndex([s]);
    assert.strictEqual(expected.classifySubmissionState(s, { reopenPenaltiesByStubId: idx }), want, st);
  }
  const resub = await blockedDay(); await refile.sendBack({ submissionId: resub.s._id, actor: hr, today: TODAY });
  await refile.consumeForSubmission({ submissionId: resub.s._id, actor: resub.emp });
  const submitted = { ...resub.s, submitted: true, currentReviewStage: 'submitted' };
  assert.strictEqual(expected.classifySubmissionState(submitted, { reopenPenaltiesByStubId: await expected.buildReopenIndex([resub.s]) }), 'submitted_pending_review');
  ok('28  expectedSubmissions: approved -> reopened; pending / rejected / none -> not_submitted; re-submitted -> submitted');

  // daily review day index (Send Back button + badge) and approved list for getToday
  const DR = await blockedDay(); await refile.request({ user: { _id: DR.emp }, submissionId: DR.s._id, reason: 'r', today: TODAY });
  const di = await eligibility.dayIndex({ employeeIds: [DR.emp], dates: [PAST] });
  const dv = di.get(`${DR.emp}|${PAST.toISOString().slice(0, 10)}`);
  assert.deepStrictEqual([dv.canSendBack, dv.reopenDecision, String(dv.penaltyId)], [true, 'pending', String(DR.p._id)]);
  const onlyC = oid(); const sc = await mkStub(onlyC);
  await Incident.create({ ruleId: oid(), ruleVersion: 1, ruleCode: 'missed_submission_v2', employee: onlyC, status: 'candidate', incidentDate: PAST, effectiveDate: PAST,
    naturalKey: `c-${oid()}`, source: 'automatic', context: { submissionId: sc._id } });
  const dv2 = (await eligibility.dayIndex({ employeeIds: [onlyC], dates: [PAST] })).get(`${onlyC}|${PAST.toISOString().slice(0, 10)}`);
  assert.deepStrictEqual([dv2.canSendBack, dv2.penaltyId], [true, null]);
  await refile.sendBack({ submissionId: sc._id, actor: hr, today: TODAY });
  assert.deepStrictEqual(await eligibility.approvedStubIds(onlyC), [String(sc._id)]);
  assert.deepStrictEqual(await eligibility.approvedStubIds(oid()), []);
  ok('29  daily review: canSendBack works with a Compliance-only marker; decision merged; getToday list = approved grants only, per employee');

  // Submission Review badge: penalty breakdown rows carry the Compliance decision
  const B = await blockedDay();
  await refile.sendBack({ submissionId: B.s._id, actor: hr, today: TODAY });
  const subs = [{ _id: B.s._id, totalPoints: 10, earnedPoints: 0 }];
  await penaltyMath.attachFinalMarks(subs);
  assert.strictEqual(subs[0].penaltyBreakdown.template[0].reopenRequest.decision, 'approved');
  await refile.consumeForSubmission({ submissionId: B.s._id, actor: B.emp });
  const subs2 = [{ _id: B.s._id, totalPoints: 10, earnedPoints: 0 }]; await penaltyMath.attachFinalMarks(subs2);
  assert.strictEqual(subs2[0].penaltyBreakdown.template[0].reopenRequest.decision, 'completed');
  ok('30  Submission Review badge source: breakdown rows show approved -> completed from Compliance');

  /* submitOne gate through the real controller */
  const gateCall = async (stub, user) => call(submissionController.submitOne, { params: { id: String(stub._id) }, body: { tasks: [] }, user: user || { _id: stub.employee, role: 'employee' } });
  const G1 = await blockedDay();
  let gr = await gateCall(G1.s); assert.deepStrictEqual([gr.res.statusCode, gr.err && gr.err.message], [400, eligibility.MESSAGES.none]);
  const rq1 = await refile.request({ user: { _id: G1.emp }, submissionId: G1.s._id, reason: 'r', today: TODAY });
  gr = await gateCall(G1.s); assert.strictEqual(gr.err.message, eligibility.MESSAGES.pending);
  await refile.decide({ refileId: rq1._id, decision: 'rejected', actor: hr });
  gr = await gateCall(G1.s); assert.strictEqual(gr.err.message, eligibility.MESSAGES.rejected);
  const rq2 = await refile.request({ user: { _id: G1.emp }, submissionId: G1.s._id, reason: 'r2', today: TODAY });
  await refile.decide({ refileId: rq2._id, decision: 'approved', actor: hr });
  gr = await gateCall(G1.s);
  assert.ok(!gr.err || !Object.values(eligibility.MESSAGES).includes(gr.err.message), 'approved grant passes the gate (anything later is the unchanged submit logic)');
  const other2 = await gateCall(G1.s, { _id: oid(), role: 'employee' });
  assert.strictEqual(other2.res.statusCode, 404);
  ok('30b submitOne (real controller): blocked -> pending -> rejected messages as before; approved grant passes the gate; another employee cannot reach the stub');

  /* HTTP layer */
  const H = await blockedDay();
  let hres = await call(rc.create, { user: { _id: H.emp, role: 'employee' }, body: { submissionId: String(H.s._id), reason: 'please' }, params: {}, query: {} });
  assert.strictEqual(hres.res.statusCode, 201);
  hres = await call(rc.create, { user: { _id: H.emp, role: 'employee' }, body: { submissionId: String(H.s._id), reason: 'please' }, params: {}, query: {} });
  assert.strictEqual(hres.res.statusCode, 200);
  assert.strictEqual((await call(rc.decide, { user: { _id: H.emp, role: 'employee' }, params: { id: String(hres.res.body._id) }, body: { decision: 'approved' } })).res.statusCode, 403);
  assert.strictEqual((await call(rc.sendBack, { user: hod, body: { submissionId: String(H.s._id) }, params: {}, query: {} })).res.statusCode, 403);
  const lst = await call(rc.list, { user: { _id: H.emp, role: 'employee' }, query: {}, params: {} }); assert.ok(lst.res.body.every((x) => String(x.employee) === String(H.emp)));
  const lstHr = await call(rc.list, { user: hr, query: { status: 'pending' }, params: {} }); assert.ok(lstHr.res.body.length >= 1);
  assert.strictEqual((await call(rc.decide, { user: hr, params: { id: String(hres.res.body._id) }, body: { decision: 'approved' } })).res.statusCode, 200);
  ok('17b HTTP: 201 then 200 on a duplicate; employee/HOD 403 on HR actions; employees list only their own; HR approves');

  console.log(`\n  ${n} Phase 4F re-file checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
