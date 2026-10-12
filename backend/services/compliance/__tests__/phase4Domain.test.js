/**
 * phase4Domain.test.js -- Phase 4 behaviour of the canonical Compliance system:
 * effect->submission link, zero-the-day marks, acknowledgement, payroll
 * deduction, warnings view, manual issue, permissions.  In-memory; the
 * concurrency / replica-set versions are in phase4Domain.integration.test.js.
 *
 *   cd backend && node services/compliance/__tests__/phase4Domain.test.js
 */
process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';
process.env.COMPLIANCE_RULES = 'true';
process.env.COMPLIANCE_NEW_ENGINE = 'true';
process.env.COMPLIANCE_ACTION_ENGINE = 'true';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const oid = () => new mongoose.Types.ObjectId();
const M = (n) => require(`../../../models/${n}`);
const names = ['User', 'Submission', 'SalarySlip', 'ComplianceRule', 'ComplianceIncident', 'ComplianceEvent', 'ComplianceActionEffect',
  'ComplianceWaiver', 'ComplianceRecovery', 'MarksLedger', 'FinancialLedger', 'PercentageLedger', 'AttendanceLedger', 'AuditLog', 'Penalty', 'Notification', 'Template'];
const [User, Submission, SalarySlip, Rule, Incident, Event, Effect, Waiver, Recovery, Marks, Fin, Pct, Att, Audit, Penalty, Notif, Template] = names.map(M);
_stub.install(User); _stub.install(Submission); _stub.install(Template);
_stub.install(Rule, { uniqueBy: [['code']] });
_stub.install(Incident, { uniqueBy: [['naturalKey', 'source']] });
_stub.install(Effect, { uniqueBy: [['incidentId', 'ruleActionId', 'effectiveDate']] });
[SalarySlip, Event, Waiver, Recovery, Marks, Fin, Pct, Att, Audit, Penalty, Notif].forEach((m) => _stub.install(m));

const compliance = require('../../compliance');
const incidentService = require('../incidents/incidentService');
const ruleSeed = require('../rules/ruleSeed');
const ruleService = require('../rules/ruleService');
const ackService = require('../acknowledgement/acknowledgementService');
const payroll = require('../payroll/payrollService');
const accountability = require('../projections/accountability');
const finalMarks = require('../projections/finalMarks');
const lifecycle = require('../lifecycle');
const ic = require('../../../controllers/compliance/incidentController');
const pc = require('../../../controllers/compliance/payrollController');
const recoveryService = compliance.recoveryService;

const DAY = 86400e3;
const D = (s) => new Date(`${s}T00:00:00Z`);
const mkRes = () => { const r = { statusCode: 200 }; r.status = (n) => { r.statusCode = n; return r; }; r.json = (v) => { r.body = v; return r; }; return r; };
const call = async (h, req) => { const res = mkRes(); let err = null; await h(req, res, (e) => { err = e; }); return { res, err }; };
const hr = { role: 'hr', _id: oid() };
let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };

const mkSub = (emp, date, extra = {}) => Submission.create({
  _id: oid(), employee: emp, date: D(date), earnedPoints: 6, totalPoints: 10, submitted: false, ...extra });
const mkInc = async (rule, emp, extra = {}) => Incident.create({
  ruleId: rule._id, ruleVersion: 1, ruleCode: rule.code, employee: emp, severity: 'medium',
  incidentDate: D('2026-10-05'), effectiveDate: D('2026-10-05'), status: 'active',
  naturalKey: `nk-${oid()}`, source: 'automatic', context: {}, ...extra });
const effectsOf = (inc) => _stub.rows(Effect).filter((e) => String(e.incidentId) === String(inc._id));

(async () => {
  /* ---------- seeds: validated, complete ---------- */
  await ruleSeed.run();
  const rules = {}; for (const r of _stub.rows(Rule)) rules[r.code] = r;
  assert.ok(['missed_submission_v2', 'dependency_pending_v2', 'performance_lock_v2', 'attendance_manual_v2', 'manual_marks_v2',
    'completion_adjustment_v2', 'financial_penalty_v2', 'manual_warning_v2'].every((c) => rules[c]));
  for (const r of Object.values(rules)) ruleService.validateRulePayload({ ...r }, { isUpdate: false });
  ok('all 8 seeded rules (incl. new manual_warning_v2) pass rule validation, incl. the submission_earned strategy');
  // The in-memory stub (unlike Mongoose) does not mint sub-document _ids for rule actions.
  for (const r of Object.values(rules)) { r.enabled = true; r.actions.forEach((a) => { if (!a._id) a._id = oid(); }); }

  /* ---------- link: explicit identity, frozen marks, ledger ---------- */
  const emp = oid();
  const sub = await mkSub(emp, '2026-10-04', { earnedPoints: 6 });
  const inc = await mkInc(rules.missed_submission_v2, emp, { incidentDate: D('2026-10-04'), effectiveDate: D('2026-10-05'), context: { submissionId: sub._id } });
  await compliance.actionEngine.apply({ incident: inc, day: D('2026-10-05') });
  let z = effectsOf(inc).find((e) => e.actionType === 'zero_daily_marks');
  assert.strictEqual(String(z.submissionId), String(sub._id)); assert.strictEqual(z.marks, 6); assert.strictEqual(z.ruleCode, 'missed_submission_v2');
  assert.strictEqual(_stub.rows(Marks).filter((r) => r.direction === -1)[0].quantity, 6);
  _stub.rows(Submission)[0].earnedPoints = 9;                       // later edit of the submission
  assert.strictEqual(effectsOf(inc).find((e) => e.actionType === 'zero_daily_marks').marks, 6, 'frozen at creation');
  const subs = [JSON.parse(JSON.stringify({ ...sub, earnedPoints: 9 }))]; await finalMarks.attachFinalMarks(subs);
  assert.strictEqual(subs[0].finalMarks, 3, 'Final = max(0, earned 9 - frozen 6), exactly as the legacy engine');
  ok('missed submission: zero_daily_marks = submission earned (frozen), linked by submissionId, ledger debited, Final Marks projected');

  /* ---------- link: never test / hidden / deleted / foreign / "first found" ---------- */
  for (const bad of [{ isTestData: true }, { hidden: true }, { deleted: true }]) {
    const e2 = oid();
    const live = await mkSub(e2, '2026-10-04', { earnedPoints: 5 });                    // a perfectly fine live sibling on the same day
    const stale = await mkSub(e2, '2026-10-04', { earnedPoints: 8, ...bad });
    const i2 = await mkInc(rules.missed_submission_v2, e2, { incidentDate: D('2026-10-04'), effectiveDate: D('2026-10-05'), context: { submissionId: stale._id } });
    await compliance.actionEngine.apply({ incident: i2, day: D('2026-10-05') });
    const ef = effectsOf(i2).find((e) => e.actionType === 'zero_daily_marks');
    assert.strictEqual(ef.submissionId, undefined, `explicit ${Object.keys(bad)[0]} submission => no link`);
    assert.strictEqual(ef.marks, 0, 'and nothing is deducted');
    assert.notStrictEqual(String(ef.submissionId), String(live._id), 'never falls back to the live sibling');
  }
  const foreign = await mkSub(oid(), '2026-10-04');
  const i3 = await mkInc(rules.missed_submission_v2, oid(), { incidentDate: D('2026-10-04'), effectiveDate: D('2026-10-05'), context: { submissionId: foreign._id } });
  await compliance.actionEngine.apply({ incident: i3, day: D('2026-10-05') });
  assert.strictEqual(effectsOf(i3).find((e) => e.actionType === 'zero_daily_marks').submissionId, undefined);
  ok('explicit submission that is test / hidden / deleted / another employee\'s => unlinked, 0 marks, no fallback to a sibling');

  /* ---------- dependency pending: primary submission of the DAY, deterministic ---------- */
  const e4 = oid();
  const later = await mkSub(e4, '2026-10-06', { earnedPoints: 4, submitted: true, submittedAt: new Date('2026-10-06T12:00:00Z') });
  const first = await mkSub(e4, '2026-10-06', { earnedPoints: 9, submitted: true, submittedAt: new Date('2026-10-06T08:00:00Z') });
  await mkSub(e4, '2026-10-06', { earnedPoints: 20, submitted: true, submittedAt: new Date('2026-10-06T07:00:00Z'), isTestData: true });
  await mkSub(e4, '2026-10-06', { earnedPoints: 30, submitted: true, submittedAt: new Date('2026-10-06T06:00:00Z'), hidden: true });
  const i4 = await mkInc(rules.dependency_pending_v2, e4, { incidentDate: D('2026-10-06'), effectiveDate: D('2026-10-06') });
  await compliance.actionEngine.apply({ incident: i4, day: D('2026-10-06') });
  let dz = effectsOf(i4).find((e) => e.actionType === 'zero_daily_marks');
  assert.strictEqual(String(dz.submissionId), String(first._id)); assert.strictEqual(dz.marks, 9);
  const ff = effectsOf(i4).find((e) => e.actionType === 'financial_fine');
  assert.deepStrictEqual([ff.amount, ff.payroll.status], [200, 'pending']);
  const pr = effectsOf(i4).find((e) => e.actionType === 'percent_reduction'); assert.strictEqual((pr.payroll && pr.payroll.status) || '', '');
  ok('dependency pending: primary LIVE submission of the day (earliest submitted; test/hidden ignored), marks frozen, fine starts payroll-pending');
  // next day is day-scoped: its own primary
  await mkSub(e4, '2026-10-07', { earnedPoints: 2, submitted: true, submittedAt: new Date('2026-10-07T09:00:00Z') });
  await compliance.actionEngine.apply({ incident: i4, day: D('2026-10-07'), recurringOnly: true });
  const nextDay = effectsOf(i4).filter((e) => e.actionType === 'zero_daily_marks' && e.effectiveDate.getTime() === D('2026-10-07').getTime());
  assert.strictEqual(nextDay.length, 1); assert.strictEqual(nextDay[0].marks, 2);
  ok('recurring day 2 is day-scoped: its own primary submission and its own frozen marks');

  /* ---------- performance lock: lock + zero effect merge into one explanatory row ---------- */
  const e5 = oid(); const s5 = await mkSub(e5, '2026-10-05', { earnedPoints: 7, submitted: true, submittedAt: new Date('2026-10-05T10:00:00Z') });
  const i5 = await mkInc(rules.performance_lock_v2, e5, { incidentDate: D('2026-10-05'), effectiveDate: D('2026-10-05') });
  await compliance.actionEngine.apply({ incident: i5, day: D('2026-10-05') });
  _stub.rows(Effect).filter((e) => String(e.incidentId) === String(i5._id) && e.actionType === 'performance_lock')
    .forEach((e) => { e.taskRef = { taskTitle: 'Close PO', pendingSince: D('2026-10-01'), resolveBy: D('2026-10-03') }; });
  const s5v = [JSON.parse(JSON.stringify(s5))]; await finalMarks.attachFinalMarks(s5v);
  assert.strictEqual(s5v[0].finalMarks, 0);
  assert.strictEqual(s5v[0].penaltyBreakdown.performanceLocks.length, 1);
  assert.strictEqual(s5v[0].penaltyBreakdown.performanceLocks[0].pendingTask, 'Close PO');
  ok('performance lock: day zeroed, ONE lock row with the task explanation (lock + marks effects merged)');

  /* ---------- recovery modes feed the projection ---------- */
  const rec = await recoveryService.apply({ incidentId: inc._id, mode: 'restore', reason: 'ok', actor: hr._id });
  const zr = effectsOf(inc).find((e) => e.actionType === 'zero_daily_marks');
  assert.deepStrictEqual([zr.evaluationMode, zr.restoredMarks, zr.status], ['restore', 6, 'resolved']);
  const subs2 = [JSON.parse(JSON.stringify({ ...sub, earnedPoints: 9 }))]; await finalMarks.attachFinalMarks(subs2);
  assert.deepStrictEqual([subs2[0].finalMarks, subs2[0].manualRestoration], [9, 6]);
  ok('recovery(restore): effect stamped evaluationMode/restoredMarks; Final Marks restored, manualRestoration = 6');

  /* ---------- acknowledgement ---------- */
  const eA = oid(); const iA = await mkInc(rules.missed_submission_v2, eA);
  const emp2 = { _id: eA, role: 'employee' };
  await assert.rejects(() => ackService.acknowledge({ incidentId: iA._id, user: { _id: oid(), role: 'employee' } }), (e) => e.httpStatus === 403);
  await assert.rejects(() => ackService.acknowledge({ incidentId: iA._id, user: hr }), (e) => e.httpStatus === 403);
  const a1 = await ackService.acknowledge({ incidentId: iA._id, user: emp2 });
  const evs = () => _stub.rows(Event).filter((e) => String(e.incidentId) === String(iA._id) && e.kind === 'incident_acknowledged').length;
  assert.ok(a1.acknowledgedAt && !a1.alreadyAcknowledged); assert.strictEqual(evs(), 1);
  const [a2, a3] = await Promise.all([ackService.acknowledge({ incidentId: iA._id, user: emp2 }), ackService.acknowledge({ incidentId: iA._id, user: emp2 })]);
  assert.ok(a2.alreadyAcknowledged && a3.alreadyAcknowledged); assert.strictEqual(evs(), 1);
  for (const st of ['cancelled', 'waived', 'candidate']) {
    const e = oid(); const x = await mkInc(rules.missed_submission_v2, e, { status: st });
    await assert.rejects(() => ackService.acknowledge({ incidentId: x._id, user: { _id: e } }), (er) => er.httpStatus === 409, st);
  }
  await assert.rejects(() => ackService.acknowledge({ incidentId: oid(), user: emp2 }), (e) => e.httpStatus === 404);
  ok('acknowledgement: owner only (403 for others and HR), idempotent + concurrent-safe (1 event), refused on cancelled/waived/candidate');

  /* ---------- payroll ---------- */
  const eP = oid();
  const fRule = rules.financial_penalty_v2;
  const slip = await SalarySlip.create({ _id: oid(), employee: eP });
  const mkFine = async (amount) => {
    const x = await mkInc(fRule, eP, { source: 'manual', detectorMeta: { hrOverride: { amount }, reason: 'late' } });
    await compliance.actionEngine.apply({ incident: x, day: D('2026-10-05') });
    return effectsOf(x).find((e) => e.actionType === 'financial_fine');
  };
  const f1 = await mkFine(300), f2 = await mkFine(150), f3 = await mkFine(500), f4 = await mkFine(75);
  let pend = await payroll.listPending({ employeeId: eP, asOf: D('2026-10-08') });
  assert.deepStrictEqual(pend.map((p) => p.amount).sort((a, b) => a - b), [75, 150, 300, 500]);
  assert.deepStrictEqual(Object.keys(pend[0]).sort(), ['amount', 'date', 'effectId', 'eligibleFromMonth', 'employee', 'incidentId', 'payrollStatus', 'reason', 'ruleCode', 'status']);
  assert.deepStrictEqual(payroll.asDeductionItems(pend).length, 4);
  // reversed fines are not offered
  await incidentService.cancelIncident(f2.incidentId, { reason: 'x', actor: hr._id });
  await compliance.waiverService.request({ incidentId: f3.incidentId, scope: 'full', reason: 'r', requestedBy: eP });
  const w = _stub.rows(Waiver).find((x) => String(x.incidentId) === String(f3.incidentId));
  await compliance.waiverService.decide({ waiverId: w._id, decision: 'approved', decidedBy: hr._id });
  pend = await payroll.listPending({ employeeId: eP, asOf: D('2026-10-08') });
  assert.deepStrictEqual(pend.map((p) => p.amount).sort((a, b) => a - b), [75, 300]);
  ok('pending payroll list: employee, amount, date, reason, status, eligible month; cancelled and waived fines are excluded');
  const r1 = await payroll.markDeducted({ effectIds: [f1._id, f2._id, f3._id], salarySlipId: slip._id, salaryMonth: '2026-10', actor: hr._id });
  assert.deepStrictEqual(r1.results.map((r) => r.outcome + (r.reason ? ':' + r.reason : '')), ['deducted', 'skipped:effect_cancelled', 'skipped:effect_waived']);
  const f1row = _stub.rows(Effect).find((e) => String(e._id) === String(f1._id));
  assert.deepStrictEqual([f1row.payroll.status, String(f1row.payroll.salarySlipId), f1row.payroll.salaryMonth], ['deducted', String(slip._id), '2026-10']);
  const r2 = await payroll.markDeducted({ effectIds: [f1._id], salarySlipId: slip._id, salaryMonth: '2026-10', actor: hr._id });
  assert.strictEqual(r2.results[0].reason, 'already_deducted');
  const [c1, c2] = await Promise.all([1, 2].map(() => payroll.markDeducted({ effectIds: [f4._id], salarySlipId: slip._id, salaryMonth: '2026-10', actor: hr._id })));
  assert.strictEqual(c1.deducted + c2.deducted, 1);
  assert.strictEqual(_stub.rows(Event).filter((e) => e.kind === 'payroll_deducted').length, 2, 'one event per actual deduction');
  const otherSlip = await SalarySlip.create({ _id: oid(), employee: oid() });
  const f5 = await mkFine(40);
  assert.strictEqual((await payroll.markDeducted({ effectIds: [f5._id], salarySlipId: otherSlip._id, salaryMonth: '2026-10', actor: hr._id })).results[0].reason, 'slip_belongs_to_another_employee');
  await assert.rejects(() => payroll.markDeducted({ effectIds: [f5._id], salarySlipId: slip._id, salaryMonth: '10-2026', actor: hr._id }), (e) => e.httpStatus === 400);
  await assert.rejects(() => payroll.markDeducted({ effectIds: [f5._id], salarySlipId: oid(), salaryMonth: '2026-10', actor: hr._id }), (e) => e.httpStatus === 404);
  ok('payroll: deduct once (slip + month + who recorded), repeat = already_deducted, concurrent = single deduction, wrong slip / bad month / unknown slip refused');
  // a deducted fine that is later reversed is flagged for refund, never silently
  await incidentService.cancelIncident(f1.incidentId, { reason: 'late', actor: hr._id });
  assert.strictEqual(_stub.rows(Effect).find((e) => String(e._id) === String(f1._id)).payroll.refundDue, true);
  assert.deepStrictEqual((await payroll.listRefundDue({ employeeId: eP })).map((e) => String(e._id)), [String(f1._id)]);
  assert.ok(!_stub.rows(Effect).find((e) => String(e._id) === String(f4._id)).payroll.refundDue);
  ok('deducted fine later cancelled => payroll.refundDue raised; untouched fines are not flagged');

  /* ---------- warnings / accountability view ---------- */
  const eW = oid();
  const wi = await mkInc(rules.manual_warning_v2, eW, { source: 'manual', detectorMeta: { reason: 'Late reply' } });
  await compliance.actionEngine.apply({ incident: wi, day: D('2026-10-05') });
  const mi = await mkInc(rules.missed_submission_v2, eW, { incidentDate: D('2026-10-03'), effectiveDate: D('2026-10-04') });
  await compliance.actionEngine.apply({ incident: mi, day: D('2026-10-04') });
  let view = await accountability.forEmployee({ employeeId: eW });
  assert.deepStrictEqual([view.probable.length, view.active.length, view.resolved.length], [1, 1, 0]);
  assert.strictEqual(view.probable[0].reason, 'Late reply'); assert.strictEqual(view.active[0].category, 'missed_submission');
  assert.ok(/\/compliance\/incidents\/.+\/acknowledge$/.test(view.active[0].acknowledgeUrl));
  await incidentService.cancelIncident(wi._id, { reason: 'x', actor: hr._id });
  view = await accountability.forEmployee({ employeeId: eW });
  assert.deepStrictEqual([view.probable.length, view.active.length, view.resolved.length], [0, 1, 1]);
  await ackService.acknowledge({ incidentId: mi._id, user: { _id: eW } });
  view = await accountability.forEmployee({ employeeId: eW });
  assert.ok(view.active[0].acknowledgedAt);
  const other = await accountability.forEmployee({ employeeId: oid() });
  assert.deepStrictEqual([other.active.length, other.probable.length, other.resolved.length], [0, 0, 0]);
  ok('warnings view: warning case -> probable bucket, missed submission -> active, cancelled warning leaves it; ack status shown; no leakage across employees');

  /* ---------- manual issue (HTTP layer): permissions + validation ---------- */
  const eM = oid(); await User.create({ _id: eM, name: 'E', employeeId: 'E9', email: 'e9@x', password: 'secret1', role: 'employee', status: 'active' });
  const penaltiesBefore = _stub.rows(Penalty).length;   // the performance-lock shim (legacy mirror) wrote one earlier
  const create = (user, body) => call(ic.create, { user, body: { employee: String(eM), ...body }, params: {}, query: {} });
  assert.strictEqual((await create({ role: 'employee', _id: eM }, { ruleCode: 'manual_warning_v2' })).res.statusCode, 403);
  assert.strictEqual((await create({ role: 'hod', _id: oid() }, { ruleCode: 'manual_warning_v2' })).res.statusCode, 403);
  const bad = async (body, why) => { const r = await create(hr, body); assert.strictEqual(r.res.statusCode, 400, why); return r; };
  await bad({ ruleCode: 'financial_penalty_v2' }, 'fine without amount');
  await bad({ ruleCode: 'financial_penalty_v2', detectorMeta: { hrOverride: { amount: -5 } } }, 'negative amount');
  await bad({ ruleCode: 'completion_adjustment_v2', detectorMeta: { hrOverride: { percent: 5 } } }, 'completion without window');
  await bad({ ruleCode: 'completion_adjustment_v2', detectorMeta: { hrOverride: { percent: 5, evaluationPeriod: { startDate: '2099-01-01', endDate: '2099-01-02' } } } }, 'future window');
  await bad({ ruleCode: 'manual_marks_v2', context: { submissionId: String(foreign._id) }, detectorMeta: { hrOverride: { marks: 3 } } }, 'someone else\'s submission');
  const hidden = await mkSub(eM, '2026-10-04', { hidden: true });
  await bad({ ruleCode: 'manual_marks_v2', context: { submissionId: String(hidden._id) }, detectorMeta: { hrOverride: { marks: 3 } } }, 'hidden submission');
  assert.strictEqual((await create(hr, { ruleCode: 'nope' })).res.statusCode, 404);
  ok('manual issue: employee/HOD -> 403; bad fine/percent/window/submission -> 400; unknown rule -> 404');
  const liveSub = await mkSub(eM, '2026-10-04', { earnedPoints: 8, submitted: true });
  const fine = await create(hr, { ruleCode: 'financial_penalty_v2', reason: 'Equipment damage', detectorMeta: { hrOverride: { amount: 250 } } });
  assert.strictEqual(fine.res.statusCode, 201);
  const fineEff = _stub.rows(Effect).find((e) => String(e.incidentId) === String(fine.res.body._id) && e.actionType === 'financial_fine');
  assert.deepStrictEqual([fineEff.amount, fineEff.payroll.status], [250, 'pending']);
  assert.strictEqual(fine.res.body.status, 'active', 'applied immediately');
  const marks = await create(hr, { ruleCode: 'manual_marks_v2', context: { submissionId: String(liveSub._id) }, detectorMeta: { hrOverride: { marks: 3 } } });
  const mEff = _stub.rows(Effect).find((e) => String(e.incidentId) === String(marks.res.body._id) && e.actionType === 'fixed_marks_reduction');
  assert.deepStrictEqual([mEff.marks, String(mEff.submissionId)], [3, String(liveSub._id)]);
  const comp = await create(hr, { ruleCode: 'completion_adjustment_v2', detectorMeta: { hrOverride: { percent: 5, evaluationPeriod: { startDate: '2026-09-01', endDate: '2026-09-30' } } } });
  const cEff = _stub.rows(Effect).find((e) => String(e.incidentId) === String(comp.res.body._id) && e.actionType === 'percent_reduction');
  assert.deepStrictEqual([cEff.percent, cEff.ruleCode], [5, 'completion_adjustment_v2']); assert.ok(cEff.evaluationPeriod.startDate);
  const warn = await create(hr, { ruleCode: 'manual_warning_v2', reason: 'Please reply to HR mails' });
  assert.ok(_stub.rows(Effect).some((e) => String(e.incidentId) === String(warn.res.body._id) && e.actionType === 'warning'));
  const grace = await create(hr, { ruleCode: 'manual_marks_v2', graceHours: 24, detectorMeta: { hrOverride: { marks: 1 } } });
  assert.strictEqual(grace.res.body.status, 'candidate'); assert.strictEqual(effectsOf({ _id: grace.res.body._id }).length, 0);
  assert.strictEqual(_stub.rows(Penalty).length, penaltiesBefore, 'no legacy Penalty row is written by the Compliance manual path');
  ok('manual issue through Compliance: fine (payroll-pending), marks (linked), completion (window), warning -- immediate; grace hours stays candidate; no Penalty row');

  /* ---------- HTTP permissions: payroll + ack ---------- */
  assert.strictEqual((await call(pc.pending, { user: { role: 'employee', _id: eP }, query: {} })).res.statusCode, 403);
  assert.strictEqual((await call(pc.markDeducted, { user: { role: 'hod', _id: oid() }, query: {}, body: {} })).res.statusCode, 403);
  const hrPending = await call(pc.pending, { user: hr, query: { employee: String(eP) } });
  assert.strictEqual(hrPending.res.statusCode, 200); assert.ok(Array.isArray(hrPending.res.body.pending) && Array.isArray(hrPending.res.body.deductionItems));
  const sa = { role: 'super_admin', _id: oid() };
  assert.strictEqual((await call(pc.pending, { user: sa, query: {} })).res.statusCode, 200);
  assert.strictEqual((await call(pc.pending, { user: hr, query: { employee: 'zzz' } })).res.statusCode, 400);
  const ackHttp = await call(ic.acknowledge, { user: { role: 'employee', _id: eW }, params: { id: String(wi._id) }, body: {} });
  assert.strictEqual(ackHttp.res.statusCode, 409);                                    // cancelled warning
  const ackOther = await call(ic.acknowledge, { user: { role: 'employee', _id: oid() }, params: { id: String(mi._id) }, body: {} });
  assert.strictEqual(ackOther.res.statusCode, 403);
  ok('permissions (HTTP): employee/HOD cannot use payroll; HR and Super Admin can; ack 403 for non-owner, 409 on a cancelled case');

  console.log(`\n  ${n} Phase 4 domain checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
