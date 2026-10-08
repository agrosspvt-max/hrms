/**
 * phase1Integrity.test.js -- Phase 1 "calculation integrity" regressions:
 *   1A  recurring-effect stacking across historical active incidents
 *   1B  dependency / performance-lock / missed-submission criticality
 *   1C  duplicate creation under repeated scheduler runs (v2 + legacy)
 *
 * Realistic scenarios: several employees, several days, repeated and
 * next-day scheduler executions, existing legacy Penalty rows.
 *
 *   cd backend && node services/compliance/__tests__/phase1Integrity.test.js
 */
process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_ACTION_ENGINE = 'true';
process.env.COMPLIANCE_NEW_ENGINE = 'true';
process.env.MISSED_SUBMISSION_EFFECTIVE_FROM = '2020-01-01';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();
const M = (n) => require(`../../../models/${n}`);

const User = M('User'); const Submission = M('Submission'); const Attendance = M('Attendance');
const DependencyTask = M('DependencyTask'); const Template = M('Template'); const Penalty = M('Penalty');
const ComplianceRule = M('ComplianceRule'); const ComplianceIncident = M('ComplianceIncident');
const ComplianceActionEffect = M('ComplianceActionEffect'); const ComplianceEvent = M('ComplianceEvent');
const MarksLedger = M('MarksLedger'); const FinancialLedger = M('FinancialLedger');
const PercentageLedger = M('PercentageLedger'); const AttendanceLedger = M('AttendanceLedger');

[User, Submission, Attendance, DependencyTask, Template, Penalty, ComplianceEvent, MarksLedger,
  FinancialLedger, PercentageLedger, AttendanceLedger, M('AuditLog'), M('Notification'), M('Leave'),
  M('Holiday'), M('Event'), M('ComplianceWaiver'), M('ComplianceRecovery'), M('Assignment')]
  .forEach((m) => _stub.install(m));
_stub.install(ComplianceRule, { uniqueBy: [['code']] });
_stub.install(ComplianceIncident, { uniqueBy: [['naturalKey', 'source']] });
// Same as the DB's compliance_effect_natural_key index; the cross-incident
// recurringKey index is declared on the schema and emulated here.
_stub.install(ComplianceActionEffect, { uniqueBy: [['incidentId', 'ruleActionId', 'effectiveDate']] });

const compliance = require('../../compliance');
const { tick } = compliance.ruleEvaluationScheduler;
const critical = require('../critical');
const penaltyEngine = require('../../penaltyEngine');
const depDetector = require('../detectors/dependencyDetector');
const lockDetector = require('../detectors/performanceLockDetector');
const missedDetector = require('../detectors/missedSubmissionDetector');

const D = (s) => new Date(`${s}T00:00:00Z`);
let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };
const mkEmp = (name) => User.create({ _id: _oid(), name, employeeId: name, email: `${name}@x`, password: 'x',
  role: 'employee', status: 'active', attendanceMode: 'submission_based', department: _oid(), weeklyOff: [0] });
const mkRule = (code, detector, actions, trigger = {}) => ComplianceRule.create({
  code, name: code, category: 'submission', detector, enabled: true, severity: 'medium', version: 1,
  trigger, scope: {}, actions, notifications: {}, recovery: {}, waiver: {},
});
const rows = (Model, f = () => true) => _stub.rows(Model).filter(f);
const sum = (Model, f = () => true) => rows(Model, f).reduce((s, r) => s + r.direction * r.quantity, 0);
const effectsFor = (emp, type, day) => rows(ComplianceActionEffect, (e) =>
  String(e.employee) === String(emp._id) && e.actionType === type && (!day || +new Date(e.effectiveDate) === +D(day)));

(async () => {
  /* =================== 1A. recurring stacking =================== */
  _stub.reset(); critical.clearCache();
  const [e1, e2, e3] = [await mkEmp('E1'), await mkEmp('E2'), await mkEmp('E3')];
  const depRule = await mkRule('dependency_pending_v2', 'built_in.dependency_pending', [
    { _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 200, criticalAmount: 300, recurring: true, recurringCadence: 'daily' } },
    { _id: _oid(), type: 'percent_reduction', enabled: true, config: { percentPerDay: 1, maxCap: 30, recurring: true, recurringCadence: 'daily' } },
  ], { evaluationDelayDays: 0, thresholdDays: 3 });
  for (const e of [e1, e2]) {
    await DependencyTask.create({ _id: _oid(), assignedTo: e._id, assignedBy: e3._id, currentStatus: 'open', waitingSince: D('2026-07-01') });
  }
  const days = ['2026-07-13', '2026-07-14', '2026-07-15'];
  for (const [i, d] of days.entries()) {
    await tick({ day: D(d) });
    await tick({ day: D(d) });          // same-day retry
    if (i === 1) await tick({ day: D(d) });
    for (const e of [e1, e2]) {
      assert.strictEqual(effectsFor(e, 'financial_fine').length, i + 1, `fine effects after day ${i + 1}`);
      assert.strictEqual(effectsFor(e, 'financial_fine', d).length, 1, `exactly one fine for ${d}`);
      assert.strictEqual(effectsFor(e, 'percent_reduction', d).length, 1);
    }
  }
  assert.strictEqual(effectsFor(e3, 'financial_fine').length, 0, 'employee with no dependency is untouched');
  for (const e of [e1, e2]) {
    assert.strictEqual(rows(ComplianceIncident, (i) => String(i.employee) === String(e._id)).length, 3, 'one incident per employee-day');
    assert.strictEqual(sum(FinancialLedger, (r) => String(r.employee) === String(e._id)), -600, 'ledger = 3 days x 200, not 6 x 200');
    assert.strictEqual(sum(PercentageLedger, (r) => String(r.employee) === String(e._id)), -3);
  }
  ok('1A: 3 active historical incidents, 2 employees, retries -> exactly one recurring effect per employee/action/day; ledger = 600 not 1200');

  // The day's own effect is not skipped, and a waived day is not re-charged by an older incident.
  const w = effectsFor(e1, 'financial_fine', '2026-07-15')[0]; w.status = 'waived';
  await tick({ day: D('2026-07-15') });
  assert.strictEqual(effectsFor(e1, 'financial_fine', '2026-07-15').length, 1);
  assert.strictEqual(effectsFor(e1, 'financial_fine').length, 3);
  ok('1A: a waived/cancelled day is not re-charged by an older still-active incident');

  // Older incident keeps charging when the detector emits nothing for the day (single-incident behaviour preserved).
  await tick({ day: D('2026-07-16') });
  assert.strictEqual(effectsFor(e1, 'financial_fine', '2026-07-16').length, 1);
  ok('1A: next business day adds exactly the intended single daily effect');

  // Manual incidents are independent business events: each keeps its own recurring effect.
  _stub.reset();
  const m1 = await mkEmp('M1');
  const manualRule = await mkRule('manual_recurring', 'manual', [
    { _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 100, recurring: true } }]);
  const mkManual = (tok) => ComplianceIncident.create({ ruleId: manualRule._id, ruleVersion: 1, ruleCode: manualRule.code,
    employee: m1._id, severity: 'medium', incidentDate: D('2026-07-13'), effectiveDate: D('2026-07-13'),
    status: 'active', naturalKey: `manual|${tok}`, source: 'manual', context: {} });
  const mi1 = await mkManual('a'); const mi2 = await mkManual('b');
  await compliance.actionEngine.apply({ incident: mi1, day: D('2026-07-13') });
  await compliance.actionEngine.apply({ incident: mi2, day: D('2026-07-13') });
  await tick({ day: D('2026-07-14') }); await tick({ day: D('2026-07-14') });
  assert.strictEqual(effectsFor(m1, 'financial_fine', '2026-07-14').length, 2, 'two separate manual incidents -> two effects');
  ok('1A: separate manual incidents keep their own recurring effects (not collapsed)');

  // Historical effects written BEFORE this fix carry no recurringKey: they must still count as coverage.
  _stub.reset();
  const h1 = await mkEmp('H1');
  const histRule = await mkRule('dependency_pending_v2', 'built_in.dependency_pending', [
    { _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 200, recurring: true } }], { thresholdDays: 3 });
  const actionId = histRule.actions[0]._id;
  const oldInc = await ComplianceIncident.create({ ruleId: histRule._id, ruleVersion: 1, ruleCode: histRule.code, employee: h1._id,
    severity: 'medium', incidentDate: D('2026-07-10'), effectiveDate: D('2026-07-10'), status: 'active',
    naturalKey: 'old', source: 'automatic', context: {} });
  const newInc = await ComplianceIncident.create({ ruleId: histRule._id, ruleVersion: 1, ruleCode: histRule.code, employee: h1._id,
    severity: 'medium', incidentDate: D('2026-07-13'), effectiveDate: D('2026-07-13'), status: 'active',
    naturalKey: 'new', source: 'automatic', context: {} });
  await ComplianceActionEffect.create({ incidentId: oldInc._id, ruleId: histRule._id, ruleActionId: actionId, actionType: 'financial_fine',
    employee: h1._id, status: 'active', effectiveDate: D('2026-07-13'), amount: 200 });          // pre-fix effect, no recurringKey
  const res = await compliance.actionEngine.apply({ incident: newInc, day: D('2026-07-13'), recurringOnly: true });
  assert.strictEqual(effectsFor(h1, 'financial_fine', '2026-07-13').length, 1);
  assert.ok(res.effects[0].dedupedBy, 'reported as deduped');
  assert.strictEqual(sum(FinancialLedger), 0, 'no ledger row for the skipped effect');
  ok('1A: effects created before the fix (no recurringKey) still count as coverage; no extra ledger debit');
  // New effects carry the key; one-shot and manual effects do not.
  _stub.reset();
  const k1 = await mkEmp('K1');
  const keyRule = await mkRule('key_rule', 'manual', [
    { _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 1, recurring: true } },
    { _id: _oid(), type: 'fixed_marks_reduction', enabled: true, config: { marks: 1 } }]);
  const mkInc2 = (source) => ComplianceIncident.create({ ruleId: keyRule._id, ruleVersion: 1, ruleCode: keyRule.code, employee: k1._id,
    severity: 'medium', incidentDate: D('2026-07-13'), effectiveDate: D('2026-07-13'), status: 'active', naturalKey: `k|${source}`, source, context: {} });
  await compliance.actionEngine.apply({ incident: await mkInc2('automatic'), day: D('2026-07-13') });
  const fx = rows(ComplianceActionEffect);
  assert.ok(/^rec\|/.test(fx.find((e) => e.actionType === 'financial_fine').recurringKey));
  assert.ok(!fx.find((e) => e.actionType === 'fixed_marks_reduction').recurringKey);
  ok('1A: only recurring effects of automatic incidents carry a recurringKey');

  /* =================== 1B. criticality =================== */
  _stub.reset(); critical.clearCache();
  const emp = await mkEmp('C1');
  const tCrit = _oid(); const tPlain = _oid(); const tLegacy = _oid();
  const tpl = await Template.create({ _id: _oid(), title: 'T', templateType: 'task',
    tasks: [{ _id: tCrit, title: 'crit', points: 5, isCritical: true }, { _id: tPlain, title: 'plain', points: 5, isCritical: false },
      { _id: tLegacy, title: 'legacy', points: 5, isCritical: true }] });
  const row = (taskId, flag, extra = {}) => {
    const r = { _id: _oid(), taskId, title: 't', points: 5, status: 'pending', pendingSince: D('2026-07-01'), resolveBy: D('2026-07-05'), ...extra };
    if (flag !== undefined) r.isCritical = flag;
    return r;
  };
  const rCrit = row(tCrit, true); const rPlain = row(tPlain, false);
  const rStaleFalse = row(tCrit, false);          // template now critical, snapshot says not -> stays NOT critical
  const rStaleTrue = row(tPlain, true);           // template now plain, snapshot says critical -> stays critical
  const rLegacy = row(tLegacy, undefined);        // pre-snapshot row -> falls back to live template (critical)
  const sub = await Submission.create({ _id: _oid(), employee: emp._id, template: tpl._id, templateType: 'task',
    date: D('2026-07-01'), submitted: true, deleted: false, isTestData: false,
    tasks: [rCrit, rPlain, rStaleFalse, rStaleTrue, rLegacy] });
  // Production writer contract: sourceTaskId = String(Submission.tasks[i]._id).
  const dep = (r, extra = {}) => ({ sourceSubmissionId: sub._id, sourceTaskId: String(r._id), sourceKind: 'task', ...extra });
  const isCrit = async (d) => { critical.clearCache(); return critical.resolveCriticalForDependency(d); };
  assert.strictEqual(await isCrit(dep(rCrit)), true, 'critical task is critical');
  assert.strictEqual(await isCrit(dep(rPlain)), false, 'non-critical task is not critical');
  assert.strictEqual(await isCrit(dep(rStaleFalse)), false, 'snapshot false wins over a later template toggle');
  assert.strictEqual(await isCrit(dep(rStaleTrue)), true, 'snapshot true wins over a later template toggle');
  assert.strictEqual(await isCrit(dep(rLegacy)), true, 'legacy row without snapshot falls back to the template');
  const subLegacyShape = await Submission.create({ _id: _oid(), employee: emp._id, template: tpl._id, templateType: 'task', date: D('2026-07-02'),
    submitted: true, deleted: false, isTestData: false, tasks: [row(tCrit, true), row(tPlain, false)] });
  assert.strictEqual(await isCrit({ sourceSubmissionId: subLegacyShape._id, sourceTaskId: String(tCrit) }), true, 'template-task-id contract still resolves (critical)');
  assert.strictEqual(await isCrit({ sourceSubmissionId: subLegacyShape._id, sourceTaskId: String(tPlain) }), false, 'template-task-id contract still resolves (non-critical)');
  assert.strictEqual(await isCrit({ sourceSubmissionId: sub._id, sourceTaskId: 'Some Excel Column', sourceKind: 'excel' }), false, 'excel/sheet sources are never critical');
  assert.strictEqual(await isCrit({ sourceTaskId: String(rCrit._id) }), false, 'no source submission -> fail closed');
  ok('1B: dependency criticality uses the submission snapshot via the production sourceTaskId (row _id); legacy + template-id shapes preserved');

  // End-to-end: detector flag and the fine tier.
  const fineRule = await mkRule('dependency_pending_v2', 'built_in.dependency_pending', [
    { _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 200, criticalAmount: 300 } }], { thresholdDays: 3 });
  const critEmp = await mkEmp('CE'); const plainEmp = await mkEmp('PE');
  const sCrit = await Submission.create({ _id: _oid(), employee: critEmp._id, template: tpl._id, templateType: 'task', date: D('2026-07-01'),
    submitted: true, deleted: false, isTestData: false, tasks: [rCrit] });
  const sPlain = await Submission.create({ _id: _oid(), employee: plainEmp._id, template: tpl._id, templateType: 'task', date: D('2026-07-01'),
    submitted: true, deleted: false, isTestData: false, tasks: [rPlain] });
  await DependencyTask.create({ _id: _oid(), assignedTo: critEmp._id, currentStatus: 'open', waitingSince: D('2026-07-01'),
    sourceSubmissionId: sCrit._id, sourceTaskId: String(rCrit._id), sourceKind: 'task' });
  await DependencyTask.create({ _id: _oid(), assignedTo: plainEmp._id, currentStatus: 'open', waitingSince: D('2026-07-01'),
    sourceSubmissionId: sPlain._id, sourceTaskId: String(rPlain._id), sourceKind: 'task' });
  critical.clearCache();
  await tick({ day: D('2026-07-13') });
  const fine = (e) => effectsFor(e, 'financial_fine')[0];
  assert.strictEqual(fine(critEmp).amount, 300, 'critical dependency -> critical fine tier');
  assert.strictEqual(fine(plainEmp).amount, 200, 'non-critical dependency -> normal fine tier');
  ok('1B: critical dependency fined at the critical tier (300), non-critical at the normal tier (200)');

  // Performance lock detector.
  const lockRule = await mkRule('performance_lock_v2', 'built_in.performance_lock', [{ _id: _oid(), type: 'performance_lock', enabled: true, config: {} }]);
  const lockOf = async (rows_) => {
    const le = await mkEmp(`L${Math.random()}`);
    await Submission.create({ _id: _oid(), employee: le._id, template: tpl._id, templateType: 'task', date: D('2026-07-01'),
      submitted: true, deleted: false, isTestData: false, tasks: rows_ });
    critical.clearCache();
    const c = await lockDetector.detect({ rule: lockRule, employee: le, day: D('2026-07-13') });
    return c[0].detectorMeta.criticalTask;
  };
  assert.strictEqual(await lockOf([rCrit]), true, 'lock: critical overdue task');
  assert.strictEqual(await lockOf([rPlain]), false, 'lock: non-critical overdue task');
  assert.strictEqual(await lockOf([rStaleFalse]), false, 'lock: snapshot false is NOT overridden by the live template');
  assert.strictEqual(await lockOf([rStaleTrue]), true, 'lock: snapshot true stays critical');
  assert.strictEqual(await lockOf([rLegacy]), true, 'lock: legacy row falls back to template');
  ok('1B: performance-lock criticality honours the submission snapshot (explicit false no longer overridden)');

  // Missed submission: stub snapshot vs live template.
  const missRule = await mkRule('missed_submission_v2', 'built_in.missed_submission', [], { evaluationDelayDays: 1 });
  const missOf = async (tasks, templateId) => {
    const me = await mkEmp(`X${Math.random()}`);
    await Attendance.create({ employee: me._id, date: D('2026-07-14'), status: 'present' });
    await Submission.create({ _id: _oid(), employee: me._id, template: templateId, templateType: 'task', date: D('2026-07-14'),
      submitted: false, deleted: false, isTestData: false, tasks });
    critical.clearCache();
    const c = await missedDetector.detect({ rule: missRule, employee: me, day: D('2026-07-15') });
    return c[0].detectorMeta.criticalTask;
  };
  assert.strictEqual(await missOf([{ _id: _oid(), taskId: tCrit, title: 'a', points: 1, isCritical: true, status: 'pending_submit' }], tpl._id), true);
  assert.strictEqual(await missOf([{ _id: _oid(), taskId: tCrit, title: 'a', points: 1, isCritical: false, status: 'pending_submit' }], tpl._id), false, 'snapshot false beats a template that is critical today');
  assert.strictEqual(await missOf([], tpl._id), true, 'stub without task snapshots (custom/legacy) falls back to the template');
  ok('1B: missed-submission criticality reads the stub snapshot, template only as fallback');

  /* =================== 1C. duplicate creation =================== */
  // Missed submission: legacy + v2, repeated and next-day.
  _stub.reset(); critical.clearCache();
  const [a, b] = [await mkEmp('A'), await mkEmp('B')];
  await mkRule('missed_submission_v2', 'built_in.missed_submission', [
    { _id: _oid(), type: 'fixed_marks_reduction', enabled: true, config: { marks: 4 } }], { evaluationDelayDays: 1 });
  const mkStub = async (e, date, tplId) => {
    await Attendance.create({ employee: e._id, date: D(date), status: 'present' });
    return Submission.create({ _id: _oid(), employee: e._id, template: tplId, templateType: 'task', date: D(date),
      submitted: false, deleted: false, isTestData: false, tasks: [] });
  };
  await mkStub(a, '2026-07-14', _oid()); await mkStub(a, '2026-07-14', _oid()); await mkStub(b, '2026-07-14', _oid());
  const runBoth = async (d) => { for (const e of [a, b]) await penaltyEngine.runDaily({ employeeId: e._id, day: D(d) }); await tick({ day: D(d) }); };
  for (let i = 0; i < 3; i++) await runBoth('2026-07-15');
  const miss = (M_) => rows(M_, (r) => true);
  assert.strictEqual(rows(Penalty, (p) => p.category === 'missed_submission').length, 3);
  assert.strictEqual(rows(ComplianceIncident).length, 3);
  assert.strictEqual(rows(ComplianceActionEffect).length, 3);
  assert.strictEqual(sum(MarksLedger), -12, '3 stubs x 4 marks, once');
  await runBoth('2026-07-16');
  assert.strictEqual(rows(Penalty, (p) => p.category === 'missed_submission').length, 3, 'next day (nothing new missed) adds nothing');
  assert.strictEqual(sum(MarksLedger), -12);
  ok('1C: missed submission x3 runs + next day: 3 penalties / 3 incidents / 3 effects / one debit each');

  // Dependency pending: legacy row created before the day's submission exists must not be duplicated afterwards.
  _stub.reset(); critical.clearCache();
  const d1 = await mkEmp('D1');
  await DependencyTask.create({ _id: _oid(), assignedTo: d1._id, assignedBy: a._id, currentStatus: 'open', waitingSince: D('2026-07-01') });
  await penaltyEngine.runDaily({ employeeId: d1._id, day: D('2026-07-14') });       // 00:15 sweep: no stub yet
  assert.strictEqual(rows(Penalty, (p) => p.category === 'dependency_pending').length, 1);
  const primary = await Submission.create({ _id: _oid(), employee: d1._id, template: _oid(), templateType: 'task', date: D('2026-07-14'),
    submitted: true, earnedPoints: 8, totalPoints: 10, deleted: false, isTestData: false, tasks: [] });
  await penaltyEngine.runDaily({ employeeId: d1._id, day: D('2026-07-14') });       // restart later the same day
  await penaltyEngine.runDaily({ employeeId: d1._id, day: D('2026-07-14') });
  const depPens = rows(Penalty, (p) => p.category === 'dependency_pending');
  assert.strictEqual(depPens.length, 1, 'one dependency penalty per employee-day');
  assert.strictEqual(String(depPens[0].submission), String(primary._id), 'the existing row is completed with the day\'s submission');
  assert.strictEqual(depPens[0].penaltyMarks, 8);
  ok('1C: legacy dependency penalty: restart after the day\'s submission exists does not create a second row');

  // Performance lock: engine row + v2 mirror must be ONE Penalty for the day.
  _stub.reset(); critical.clearCache();
  const l1 = await mkEmp('LK');
  await mkRule('performance_lock_v2', 'built_in.performance_lock', [
    { _id: _oid(), type: 'performance_lock', enabled: true, config: { recurring: true, recurringCadence: 'daily' } }], { workingDaysOnly: true });
  const oldSub = await Submission.create({ _id: _oid(), employee: l1._id, template: _oid(), templateType: 'task', date: D('2026-07-06'),
    submitted: true, deleted: false, isTestData: false,
    tasks: [{ _id: _oid(), taskId: _oid(), title: 'late', points: 5, status: 'pending', pendingSince: D('2026-07-06'), resolveBy: D('2026-07-09'), isCritical: false }] });
  const today = (d) => Submission.create({ _id: _oid(), employee: l1._id, template: _oid(), templateType: 'task', date: D(d), submitted: false,
    deleted: false, isTestData: false, earnedPoints: 0, tasks: [] });
  for (const d of ['2026-07-13', '2026-07-14']) {
    await today(d);
    for (let i = 0; i < 3; i++) { await penaltyEngine.runDaily({ employeeId: l1._id, day: D(d) }); await tick({ day: D(d) }); }
    const pens = rows(Penalty, (p) => p.category === 'performance_lock' && +new Date(p.targetDate) === +D(d));
    assert.strictEqual(pens.length, 1, `one performance_lock Penalty for ${d} (engine row reused by the mirror)`);
  }
  const lockEffects = rows(ComplianceActionEffect, (e) => e.actionType === 'performance_lock');
  assert.strictEqual(lockEffects.length, 2, 'one lock effect per working day despite 2 active incidents');
  assert.ok(lockEffects.every((e) => e.penaltyId), 'effects link to the single Penalty');
  assert.strictEqual(rows(ComplianceIncident).length, 2);
  ok('1C: performance lock x6 runs over 2 days: 1 incident + 1 effect + 1 Penalty per day (mirror links, no extra row)');

  // Existing legacy rows + existing incident rows are respected, not duplicated.
  const before = rows(Penalty).length;
  await penaltyEngine.runDaily({ employeeId: l1._id, day: D('2026-07-14') });
  await tick({ day: D('2026-07-14') });
  assert.strictEqual(rows(Penalty).length, before);
  ok('1C: pre-existing legacy + v2 rows are reused on re-run');

  console.log(`\n${n} Phase 1 checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
