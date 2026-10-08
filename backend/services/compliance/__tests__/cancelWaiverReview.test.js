/**
 * cancelWaiverReview.test.js -- regression for:
 *   A. Cancelled compliance item stayed on the employee dashboard
 *      (legacy Penalty behind a v2 incident was never linked, and the
 *      incident's waivers stayed "pending").
 *   B. HR "Review" on Pending waiver requests only reloaded the page.
 *
 *   cd backend && node services/compliance/__tests__/cancelWaiverReview.test.js
 */
process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_DASHBOARD_V2 = 'true';
process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const M = (n) => require(`../../../models/${n}`);
const [User, ComplianceRule, ComplianceIncident, ComplianceEvent, ComplianceActionEffect,
  ComplianceWaiver, ComplianceRecovery, MarksLedger, FinancialLedger, PercentageLedger,
  AttendanceLedger, AuditLog, Penalty] = ['User', 'ComplianceRule', 'ComplianceIncident', 'ComplianceEvent',
  'ComplianceActionEffect', 'ComplianceWaiver', 'ComplianceRecovery', 'MarksLedger', 'FinancialLedger',
  'PercentageLedger', 'AttendanceLedger', 'AuditLog', 'Penalty'].map(M);
_stub.install(User);
_stub.install(ComplianceRule, { uniqueBy: [['code']] });
_stub.install(ComplianceIncident, { uniqueBy: [['naturalKey', 'source']] });
_stub.install(ComplianceActionEffect, { uniqueBy: [['incidentId', 'ruleActionId', 'effectiveDate']] });
[ComplianceEvent, ComplianceWaiver, ComplianceRecovery, MarksLedger, FinancialLedger, PercentageLedger,
  AttendanceLedger, AuditLog, Penalty, M('Notification')].forEach((m) => _stub.install(m));

// The stub has no aggregation pipeline; summary() only needs an empty total here.
FinancialLedger.aggregate = async () => [];

const compliance = require('../../compliance');
const waiverService = compliance.waiverService;
const incidentService = require('../incidents/incidentService');
const dash = require('../../../controllers/compliance/dashboardController');

const D = new Date('2026-10-05T00:00:00Z');
const mkRule = (code = 'missed_submission_v2') => ComplianceRule.create({
  code, name: code, category: 'submission', detector: 'built_in.missed_submission', enabled: true,
  severity: 'medium', version: 1, trigger: {}, scope: {},
  actions: [{ _id: _oid(), type: 'fixed_marks_reduction', enabled: true, config: { marks: 4 } }],
  notifications: {}, recovery: {}, waiver: {},
});
const mkInc = (rule, emp, sub, nk) => ComplianceIncident.create({
  ruleId: rule._id, ruleVersion: 1, ruleCode: rule.code, employee: emp, severity: 'medium',
  incidentDate: D, effectiveDate: D, status: 'active', naturalKey: nk, source: 'automatic',
  context: { submissionId: sub },
});
// What penaltyEngine.enforceAbsentSubmission writes: NOT linked to any effect.
const mkLegacy = (emp, sub, extra = {}) => Penalty.create({
  _id: _oid(), employee: emp, category: 'missed_submission', source: 'automatic', probable: false,
  status: 'active', penaltyMarks: 7, targetDate: D, submission: sub, ...extra,
});
const _mkRes = () => { const r = { statusCode: 200 }; r.status = (n) => { r.statusCode = n; return r; }; r.json = (v) => { r.body = v; return r; }; return r; };
const callDash = async (h) => { const res = _mkRes(); let err = null; await h({ user: { role: 'hr', _id: _oid() }, query: {} }, res, (e) => { err = e; }); assert.ifError(err); return res.body; };
// Same predicate GET /penalties/mine uses for the employee's "active" list.
const activeForEmployee = (emp) => _stub.rows(Penalty).filter((p) => String(p.employee) === String(emp)
  && !p.probable && ['active', 'pending', 'scheduled'].includes(p.status));
let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };

(async () => {
  /* ---------- A. cancel clears the unlinked legacy Penalty ---------- */
  _stub.reset();
  const emp = _oid(); const otherEmp = _oid();
  const subA = _oid(); const subB = _oid();
  const rule = await mkRule();
  const inc = await mkInc(rule, emp, subA, 'nk-a');
  await compliance.actionEngine.apply({ incident: inc });
  const target = await mkLegacy(emp, subA);              // same submission -> must be cancelled
  const sameDayOtherSub = await mkLegacy(emp, subB);     // different submission -> untouched
  const otherEmployee = await mkLegacy(otherEmp, subA);  // different employee -> untouched
  assert.strictEqual(activeForEmployee(emp).length, 2);
  const w = await waiverService.request({ incidentId: inc._id, scope: 'full', reason: 'why', requestedBy: emp });
  assert.strictEqual(w.status, 'pending');

  const c1 = await incidentService.cancelIncident(inc._id, { reason: 'HR overruled', actor: _oid() });
  assert.strictEqual(c1.status, 'cancelled');
  const pen = (p) => _stub.rows(Penalty).find((x) => String(x._id) === String(p._id));
  assert.strictEqual(pen(target).status, 'cancelled');
  assert.strictEqual(pen(sameDayOtherSub).status, 'active');
  assert.strictEqual(pen(otherEmployee).status, 'active');
  assert.deepStrictEqual(activeForEmployee(emp).map((p) => String(p._id)), [String(sameDayOtherSub._id)]);
  ok('cancel: unlinked legacy Penalty (employee dashboard source) is cancelled; unrelated penalties untouched');

  /* ---------- history preserved ---------- */
  assert.strictEqual(_stub.rows(ComplianceIncident).length, 1);
  assert.ok(_stub.rows(ComplianceActionEffect).every((e) => e.status === 'cancelled' && e.cancelReason === 'HR overruled'));
  assert.ok(_stub.rows(Penalty).some((p) => String(p._id) === String(target._id)), 'penalty row kept');
  assert.ok(_stub.rows(ComplianceEvent).some((e) => e.kind === 'incident_cancelled'));
  assert.strictEqual(await compliance.ledgerService.balance({ ledger: 'marks', employee: emp }), 0);
  ok('cancel: incident/effects/penalty rows + events kept; ledger reversed to 0');

  /* ---------- waiver closed, queue + count correct ---------- */
  const wRow = _stub.rows(ComplianceWaiver).find((x) => String(x._id) === String(w._id));
  assert.strictEqual(wRow.status, 'rejected');
  assert.ok(/incident was cancelled/.test(wRow.decisionNote));
  assert.ok(_stub.rows(ComplianceEvent).some((e) => e.kind === 'waiver_decided' && e.payload.reason === 'incident_cancelled'));
  assert.strictEqual((await callDash(dash.pendingWaivers)).length, 0);
  assert.strictEqual((await callDash(dash.summary)).pendingWaivers, 0);
  ok('cancel: pending waiver closed (history kept) and gone from Pending waiver requests + tile count');

  /* ---------- idempotent cancel ---------- */
  const ev = _stub.rows(ComplianceEvent).length; const led = _stub.rows(MarksLedger).length;
  await incidentService.cancelIncident(inc._id, { reason: 'again', actor: _oid() });
  assert.strictEqual(_stub.rows(ComplianceEvent).length, ev);
  assert.strictEqual(_stub.rows(MarksLedger).length, led);
  ok('cancel twice: no duplicate events or reversals');

  /* ---------- stale pre-fix data: pending waiver on a cancelled incident ---------- */
  await ComplianceWaiver.create({ incidentId: inc._id, employee: emp, scope: 'full', status: 'pending', requestedAt: new Date() });
  assert.strictEqual((await callDash(dash.pendingWaivers)).length, 0, 'legacy stale row hidden by backend query');
  assert.strictEqual((await callDash(dash.summary)).pendingWaivers, 0);
  await assert.rejects(() => waiverService.decide({ waiverId: _stub.rows(ComplianceWaiver).at(-1)._id, decision: 'approved', decidedBy: _oid() }), /already cancelled/);
  await assert.rejects(() => waiverService.request({ incidentId: inc._id, scope: 'full', reason: 'x', requestedBy: emp }), /already cancelled/);
  ok('stale pending waiver on cancelled incident: excluded from queue/count; cannot be reviewed or newly requested');

  /* ---------- B. pending waiver lifecycle: listed, reviewed once ---------- */
  _stub.reset();
  const e2 = _oid(); const s2 = _oid();
  const r2 = await mkRule();
  const i2 = await mkInc(r2, e2, s2, 'nk-b');
  await compliance.actionEngine.apply({ incident: i2 });
  const leg2 = await mkLegacy(e2, s2);
  const req1 = await waiverService.request({ incidentId: i2._id, scope: 'full', reason: 'valid', requestedBy: e2 });
  const req2 = await waiverService.request({ incidentId: i2._id, scope: 'full', reason: 'valid', requestedBy: e2 });
  assert.strictEqual(String(req1._id), String(req2._id));
  assert.strictEqual(_stub.rows(ComplianceWaiver).length, 1);
  ok('duplicate identical waiver request returns the existing pending one');
  const queue = await callDash(dash.pendingWaivers);
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(String(queue[0].incidentId), String(i2._id), 'row carries the incident id Review must open');
  assert.strictEqual(String(queue[0]._id), String(req1._id));
  assert.strictEqual((await callDash(dash.summary)).pendingWaivers, 1);
  ok('pending waiver is listed with the correct incident + waiver ids');

  const [d1, d2] = await Promise.all([
    waiverService.decide({ waiverId: req1._id, decision: 'approved', decidedBy: _oid() }),
    waiverService.decide({ waiverId: req1._id, decision: 'approved', decidedBy: _oid() }),
  ]);
  assert.strictEqual(d1.status, 'approved'); assert.strictEqual(d2.status, 'approved');
  const credits = _stub.rows(MarksLedger).filter((r) => r.type === 'waiver');
  assert.strictEqual(credits.length, 1, 'ledger credited once');
  assert.strictEqual(await compliance.ledgerService.balance({ ledger: 'marks', employee: e2 }), 0);
  assert.strictEqual(_stub.rows(ComplianceEvent).filter((e) => e.kind === 'waiver_decided').length, 1);
  assert.strictEqual(_stub.rows(Penalty).find((p) => String(p._id) === String(leg2._id)).status, 'cancelled');
  assert.strictEqual((await callDash(dash.pendingWaivers)).length, 0);
  ok('approve (even double / concurrent): one credit, one event, legacy Penalty cleared, leaves queue');
  await assert.rejects(
    () => waiverService.decide({ waiverId: req1._id, decision: 'rejected', decidedBy: _oid() }),
    (e) => e.httpStatus === 409 && /already approved/.test(e.message),
  );
  assert.strictEqual(_stub.rows(ComplianceWaiver)[0].status, 'approved');
  const same = await waiverService.decide({ waiverId: req1._id, decision: 'approved', decidedBy: _oid() });
  assert.strictEqual(same.status, 'approved');
  ok('re-reviewing a decided waiver changes nothing (same outcome = no-op, conflicting = 409)');

  /* ---------- reject path ---------- */
  _stub.reset();
  const e3 = _oid(); const r3 = await mkRule(); const i3 = await mkInc(r3, e3, _oid(), 'nk-c');
  await compliance.actionEngine.apply({ incident: i3 });
  const w3 = await waiverService.request({ incidentId: i3._id, scope: 'full', reason: 'r', requestedBy: e3 });
  const rej = await waiverService.decide({ waiverId: w3._id, decision: 'rejected', note: 'no', decidedBy: _oid() });
  assert.strictEqual(rej.status, 'rejected');
  assert.strictEqual(_stub.rows(MarksLedger).filter((r) => r.type === 'waiver').length, 0);
  assert.strictEqual(_stub.rows(ComplianceIncident)[0].status, 'active');
  assert.strictEqual((await callDash(dash.pendingWaivers)).length, 0);
  ok('reject: no credit, incident stays active, waiver leaves the queue');

  /* ---------- failure while applying -> waiver returns to pending ---------- */
  _stub.reset();
  const e4 = _oid(); const r4 = await mkRule(); const i4 = await mkInc(r4, e4, _oid(), 'nk-d');
  await compliance.actionEngine.apply({ incident: i4 });
  const w4 = await waiverService.request({ incidentId: i4._id, scope: 'full', reason: 'r', requestedBy: e4 });
  const realAppend = compliance.ledgerService.append;
  compliance.ledgerService.append = async () => { throw new Error('boom'); };
  await assert.rejects(() => waiverService.decide({ waiverId: w4._id, decision: 'approved', decidedBy: _oid() }), /boom/);
  compliance.ledgerService.append = realAppend;
  assert.strictEqual(_stub.rows(ComplianceWaiver)[0].status, 'pending');
  const retry = await waiverService.decide({ waiverId: w4._id, decision: 'approved', decidedBy: _oid() });
  assert.strictEqual(retry.status, 'approved');
  assert.strictEqual(_stub.rows(MarksLedger).filter((r) => r.type === 'waiver').length, 1);
  ok('failed approval rolls the waiver back to pending; retry succeeds once');

  /* ---------- recovery also clears the unlinked legacy Penalty ---------- */
  _stub.reset();
  const e5 = _oid(); const s5 = _oid(); const r5 = await mkRule(); const i5 = await mkInc(r5, e5, s5, 'nk-e');
  await compliance.actionEngine.apply({ incident: i5 });
  const leg5 = await mkLegacy(e5, s5);
  await compliance.recoveryService.apply({ incidentId: i5._id, mode: 'restore', reason: 'ok', actor: _oid() });
  assert.strictEqual(_stub.rows(Penalty).find((p) => String(p._id) === String(leg5._id)).status, 'resolved');
  ok('recovery: unlinked legacy Penalty is resolved too');

  /* ---------- B. frontend Review wiring (static) ---------- */
  const src = fs.readFileSync(path.join(__dirname, '../../../../frontend/src/pages/hr/compliance/ComplianceWorkspace.jsx'), 'utf8');
  assert.ok(!/href=\{`\/hr\/compliance\?incident=/.test(src), 'Review must not be a full-page <a href>');
  assert.ok(/onClick=\{\(\) => onReviewWaiver\(w\.incidentId\)\}/.test(src), 'Review calls the in-app handler with the incident id');
  assert.ok(/useSearchParams/.test(src) && /searchParams\.get\('incident'\)/.test(src), '?incident= deep link is read');
  assert.ok(/toast\.error\(`Could not open the waiver's incident/.test(src), 'open failure is surfaced via toast');
  ok('Review is an in-app handler (no reload), deep link is read, errors are toasted');

  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
