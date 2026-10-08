/**
 * phase1Hardening.test.js -- Phase 1 hardening regressions:
 *   (1) duplicate-key handling for ComplianceActionEffect is resolved OUTSIDE
 *       the transaction (no follow-up work on an aborted transaction),
 *       and an already-applied effect is answered from a plain read;
 *   (2) dependency Penalty anchoring never selects a test / hidden / deleted
 *       submission, is deterministic, and never creates a second row.
 *
 * The in-memory stub cannot reproduce the replica-set stall itself (that is
 * verified against a real replica set -- see phase1Hardening.integration.test.js);
 * these tests pin the behaviour that removes it: the duplicate paths no
 * longer run inside / after a transaction and never write a second ledger row.
 *
 *   cd backend && node services/compliance/__tests__/phase1Hardening.test.js
 */
process.env.NODE_ENV = 'test';
process.env.COMPLIANCE_ACTION_ENGINE = 'true';
process.env.COMPLIANCE_NEW_ENGINE = 'true';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();
const M = (n) => require(`../../../models/${n}`);
const [User, Submission, DependencyTask, Penalty, Rule, Incident, Effect, FinancialLedger] =
  ['User', 'Submission', 'DependencyTask', 'Penalty', 'ComplianceRule', 'ComplianceIncident', 'ComplianceActionEffect', 'FinancialLedger'].map(M);
[User, Submission, DependencyTask, Penalty, FinancialLedger, M('ComplianceEvent'), M('MarksLedger'), M('PercentageLedger'),
  M('AttendanceLedger'), M('AuditLog'), M('Notification'), M('ComplianceWaiver'), M('Leave'), M('Holiday'), M('Event')].forEach((m) => _stub.install(m));
_stub.install(Rule, { uniqueBy: [['code']] });
_stub.install(Incident, { uniqueBy: [['naturalKey', 'source']] });
_stub.install(Effect, { uniqueBy: [['incidentId', 'ruleActionId', 'effectiveDate']] });

const compliance = require('../../compliance');
const penaltyEngine = require('../../penaltyEngine');

// Emulate the DB's partial unique index on recurringKey (the stub cannot).
const rawCreate = Effect.create;
let createCalls = 0;
Effect.create = async (docs, opts) => {
  createCalls += 1;
  const d = Array.isArray(docs) ? docs[0] : docs;
  if (typeof d.recurringKey === 'string' && _stub.rows(Effect).some((r) => r.recurringKey === d.recurringKey)) {
    const e = new Error('E11000 duplicate key (recurringKey)'); e.code = 11000; throw e;
  }
  return rawCreate(docs, opts);
};

const D = (s) => new Date(`${s}T00:00:00Z`);
const rows = (Model, f = () => true) => _stub.rows(Model).filter(f);
const ledgerSum = () => rows(FinancialLedger).reduce((s, r) => s + r.direction * r.quantity, 0);
let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };
const mkEmp = (name) => User.create({ _id: _oid(), name, employeeId: name, email: `${name}@x`, password: 'secret1', role: 'employee',
  status: 'active', attendanceMode: 'submission_based', department: _oid(), weeklyOff: [0] });
const mkRule = (actions, code = 'dependency_pending_v2') => Rule.create({ code, name: code, category: 'dependency', detector: 'built_in.dependency_pending',
  enabled: true, severity: 'medium', version: 1, trigger: {}, scope: {}, notifications: {}, recovery: {}, waiver: {}, actions });
const mkInc = (rule, emp, day, source = 'automatic', key) => Incident.create({ ruleId: rule._id, ruleVersion: 1, ruleCode: rule.code, employee: emp._id,
  severity: 'medium', incidentDate: D(day), effectiveDate: D(day), status: 'active', naturalKey: key || `nk|${day}|${source}|${_oid()}`, source, context: {} });
const fineAction = (extra = {}) => ({ _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 200, recurring: true, ...extra } });

(async () => {
  /* ===================== Part 1: effect idempotency ===================== */
  _stub.reset(); createCalls = 0;
  const e1 = await mkEmp('E1'); const rule = await mkRule([fineAction()]);
  const inc = await mkInc(rule, e1, '2026-07-13');
  const day = D('2026-07-13');
  const r1 = await compliance.actionEngine.apply({ incident: inc.toObject(), day });
  assert.deepStrictEqual(r1.effects.map((e) => e.created), [true]);
  assert.strictEqual(createCalls, 1);
  const r2 = await compliance.actionEngine.apply({ incident: inc.toObject(), day, recurringOnly: true });
  assert.deepStrictEqual(r2.effects.map((e) => e.created), [false]);
  assert.strictEqual(createCalls, 1, 'existing effect answered from a plain read: no insert attempt, no transaction work');
  assert.strictEqual(rows(Effect).length, 1); assert.strictEqual(rows(FinancialLedger).length, 1); assert.strictEqual(ledgerSum(), -200);
  ok('sequential re-apply: pre-check returns the existing effect without an insert attempt; 1 effect, 1 ledger row');

  // One-shot action (not recurring) gets the same fast path.
  _stub.reset(); createCalls = 0;
  const one = await mkRule([{ _id: _oid(), type: 'fixed_marks_reduction', enabled: true, config: { marks: 3 } }], 'one_shot');
  const incOne = await mkInc(one, e1, '2026-07-13');
  await compliance.actionEngine.apply({ incident: incOne.toObject(), day });
  await compliance.actionEngine.apply({ incident: incOne.toObject(), day });
  assert.strictEqual(createCalls, 1); assert.strictEqual(rows(Effect).length, 1);
  ok('one-shot actions: same pre-check, no repeated insert');

  // Concurrent apply of the SAME incident (natural-key race): the loser's insert hits E11000.
  _stub.reset(); createCalls = 0;
  const e2 = await mkEmp('E2'); const rule2 = await mkRule([fineAction()]);
  const inc2 = await mkInc(rule2, e2, '2026-07-13');
  const [a, b] = await Promise.all([
    compliance.actionEngine.apply({ incident: inc2.toObject(), day }),
    compliance.actionEngine.apply({ incident: inc2.toObject(), day }),
  ]);
  assert.deepStrictEqual([...a.effects, ...b.effects].map((e) => e.created).sort(), [false, true]);
  assert.strictEqual(a.errors.length + b.errors.length, 0, 'the loser is an idempotent success, not an error');
  assert.ok(createCalls >= 2, 'the race really reached the unique index');
  assert.strictEqual(rows(Effect).length, 1); assert.strictEqual(rows(FinancialLedger).length, 1); assert.strictEqual(ledgerSum(), -200);
  const ref = rows(Effect)[0].ledgerRefs.financial;
  assert.strictEqual(String(ref), String(rows(FinancialLedger)[0]._id), 'effect references its single ledger row');
  ok('concurrent same-incident race: one winner, loser re-reads outside the txn -> already-created; 1 effect / 1 debit / 1 ledger ref');

  // Cross-incident race (recurringKey index): two sibling automatic incidents, same employee/action/day.
  _stub.reset(); createCalls = 0;
  const e3 = await mkEmp('E3'); const rule3 = await mkRule([fineAction()]);
  const iA = await mkInc(rule3, e3, '2026-07-10'); const iB = await mkInc(rule3, e3, '2026-07-11');
  const [x, y] = await Promise.all([
    compliance.actionEngine.apply({ incident: iA.toObject(), day, recurringOnly: true }),
    compliance.actionEngine.apply({ incident: iB.toObject(), day, recurringOnly: true }),
  ]);
  assert.deepStrictEqual([...x.effects, ...y.effects].map((e) => e.created).sort(), [false, true]);
  assert.strictEqual(x.errors.length + y.errors.length, 0);
  assert.strictEqual(rows(Effect).length, 1); assert.strictEqual(rows(FinancialLedger).length, 1); assert.strictEqual(ledgerSum(), -200);
  assert.ok(rows(Effect)[0].recurringKey, 'winner carries the recurringKey');
  ok('cross-incident race on recurringKey: loser resolves via recurringKey re-read; 1 effect / 1 debit');

  // A non-duplicate failure is still reported (not swallowed as "already exists").
  _stub.reset();
  const e4 = await mkEmp('E4'); const rule4 = await mkRule([fineAction()]);
  const inc4 = await mkInc(rule4, e4, '2026-07-13');
  const keep = Effect.create; Effect.create = async () => { throw new Error('disk full'); };
  const bad = await compliance.actionEngine.apply({ incident: inc4.toObject(), day });
  Effect.create = keep;
  assert.strictEqual(bad.effects.length, 0); assert.strictEqual(bad.errors[0].error, 'disk full');
  assert.strictEqual(rows(Effect).length, 0); assert.strictEqual(rows(FinancialLedger).length, 0);
  ok('non-duplicate errors are still reported; no effect and no ledger row');

  // Duplicate that cannot be resolved by a re-read must surface as an error, never a silent success.
  Effect.create = async () => { const e = new Error('E11000 phantom'); e.code = 11000; throw e; };
  const phantom = await compliance.actionEngine.apply({ incident: inc4.toObject(), day });
  Effect.create = keep;
  assert.strictEqual(phantom.effects.length, 0); assert.strictEqual(phantom.errors.length, 1);
  assert.strictEqual(rows(FinancialLedger).length, 0);
  ok('an unresolvable duplicate is reported as an error (no false success, no ledger row)');

  // Escalation: step whose effect already exists (crash-before-memo) neither errors nor re-debits.
  _stub.reset();
  const e5 = await mkEmp('E5'); const stepId = _oid(); const escAction = { _id: _oid(), type: 'financial_fine', config: { amount: 50 } };
  const rule5 = await Rule.create({ code: 'esc', name: 'esc', category: 'dependency', detector: 'built_in.dependency_pending', enabled: true,
    severity: 'medium', version: 1, trigger: {}, scope: {}, notifications: {}, recovery: {}, waiver: {},
    actions: [{ _id: _oid(), type: 'notification', enabled: true, config: {} }],
    escalation: [{ _id: stepId, afterDays: 0, actionsAdd: [escAction] }] });
  const inc5 = await mkInc(rule5, e5, '2026-07-10');
  const escDay = D('2026-07-13');
  await Effect.create({ incidentId: inc5._id, ruleId: rule5._id, ruleActionId: escAction._id, actionType: 'financial_fine',
    employee: e5._id, status: 'active', effectiveDate: escDay, amount: 50 });
  const s1 = await compliance.escalationRunner.run({ day: escDay });
  assert.strictEqual(s1.errors, 0); assert.strictEqual(rows(Effect).length, 1); assert.strictEqual(rows(FinancialLedger).length, 0);
  assert.ok((rows(Incident)[0].detectorMeta.escalatedStepIds || []).includes(String(stepId)), 'step memoised');
  _stub.reset();
  const e6 = await mkEmp('E6'); const rule6 = await Rule.create({ code: 'esc2', name: 'esc2', category: 'dependency', detector: 'built_in.dependency_pending', enabled: true,
    severity: 'medium', version: 1, trigger: {}, scope: {}, notifications: {}, recovery: {}, waiver: {}, actions: [],
    escalation: [{ _id: stepId, afterDays: 0, actionsAdd: [escAction] }] });
  await mkInc(rule6, e6, '2026-07-10');
  await compliance.escalationRunner.run({ day: escDay }); await compliance.escalationRunner.run({ day: escDay });
  assert.strictEqual(rows(Effect).length, 1); assert.strictEqual(rows(FinancialLedger).length, 1);
  ok('escalation: pre-existing step effect is skipped (no error, no second debit); fresh step applies once across reruns');

  /* ===================== Part 2: dependency anchoring ===================== */
  const mkDepEmp = async (name) => {
    const e = await mkEmp(name);
    await DependencyTask.create({ _id: _oid(), assignedTo: e._id, assignedBy: e._id, currentStatus: 'open', waitingSince: D('2026-07-01') });
    return e;
  };
  const sub = (e, over = {}) => Submission.create({ _id: _oid(), employee: e._id, template: _oid(), templateType: 'task', date: D('2026-07-14'),
    deleted: false, isTestData: false, hidden: false, submitted: false, earnedPoints: 0, ...over });
  const depRows = (e) => rows(Penalty, (p) => String(p.employee) === String(e._id) && p.category === 'dependency_pending');
  const run = (e) => penaltyEngine.enforceDependencyPending({ employeeId: e._id, day: D('2026-07-14') });

  // A: one valid submission.
  _stub.reset(); let e = await mkDepEmp('DA'); await run(e); let v = await sub(e, { earnedPoints: 5 }); await run(e); await run(e);
  assert.strictEqual(depRows(e).length, 1); assert.strictEqual(String(depRows(e)[0].submission), String(v._id)); assert.strictEqual(depRows(e)[0].penaltyMarks, 5);
  ok('A: single valid submission -> anchored, marks from it, rerun idempotent');

  // B/C/D: invalid siblings created BEFORE (so natural order would pick them).
  for (const [label, flag] of [['B test-data', { isTestData: true }], ['C hidden', { hidden: true }], ['D deleted', { deleted: true }]]) {
    _stub.reset(); e = await mkDepEmp(`D${label[0]}`);
    await run(e);                                           // 00:15: nothing yet -> unanchored row
    const bad = await sub(e, { ...flag, earnedPoints: 1 }); // created first
    const good = await sub(e, { earnedPoints: 9 });
    await run(e); await run(e);
    assert.strictEqual(depRows(e).length, 1, `${label}: one row`);
    assert.strictEqual(String(depRows(e)[0].submission), String(good._id), `${label}: anchored to the valid submission`);
    assert.notStrictEqual(String(depRows(e)[0].submission), String(bad._id));
    assert.strictEqual(depRows(e)[0].penaltyMarks, 9);
  }
  ok('B/C/D: test-data, hidden and deleted submissions are never selected; the valid one is, with its own marks');

  // Same, but the penalty is created fresh (no 00:15 null row first).
  _stub.reset(); e = await mkDepEmp('DFresh'); await sub(e, { isTestData: true, earnedPoints: 1 }); const goodF = await sub(e, { earnedPoints: 4 });
  await run(e); await run(e);
  assert.strictEqual(depRows(e).length, 1); assert.strictEqual(String(depRows(e)[0].submission), String(goodF._id));
  ok('creation path uses the same eligibility (not only anchoring)');

  // E: several valid submissions -> deterministic: submitted first, earliest submittedAt, then _id.
  _stub.reset(); e = await mkDepEmp('DE');
  const unsub = await sub(e, { earnedPoints: 0 });
  const late = await sub(e, { submitted: true, submittedAt: new Date('2026-07-14T15:00:00Z'), earnedPoints: 20 });
  const early = await sub(e, { submitted: true, submittedAt: new Date('2026-07-14T09:00:00Z'), earnedPoints: 12 });
  await run(e);
  assert.strictEqual(String(depRows(e)[0].submission), String(early._id), 'earliest submitted wins (same rule as the daily review primary)');
  assert.strictEqual(depRows(e)[0].penaltyMarks, 12);
  await Submission.updateOne({ _id: unsub._id }, { $set: { submitted: true, submittedAt: new Date('2026-07-14T01:00:00Z') } });  // primary would now change
  await run(e); await run(e);
  assert.strictEqual(depRows(e).length, 1, 'a changing "primary" never creates a second row');
  assert.strictEqual(String(depRows(e)[0].submission), String(early._id), 'an anchored row is not re-pointed');
  assert.strictEqual(depRows(e)[0].penaltyMarks, 12, 'marks are not re-written');
  void late;
  ok('E: multiple valid submissions -> deterministic choice; later changes neither duplicate nor re-anchor, marks frozen');

  // F: only invalid submissions -> stays unanchored (existing "no submission" behaviour), never attaches.
  _stub.reset(); e = await mkDepEmp('DF');
  await sub(e, { isTestData: true }); await sub(e, { hidden: true }); await sub(e, { deleted: true });
  await run(e); await run(e);
  assert.strictEqual(depRows(e).length, 1); assert.strictEqual(depRows(e)[0].submission, null); assert.strictEqual(depRows(e)[0].penaltyMarks, 0);
  const real = await sub(e, { earnedPoints: 6 });
  await run(e);
  assert.strictEqual(depRows(e).length, 1); assert.strictEqual(String(depRows(e)[0].submission), String(real._id));
  ok('F: only invalid submissions -> row stays unanchored; anchors when a valid one appears');

  // Historical rows: an already-anchored (even to an invalid submission) row is never rewritten; cancelled rows are not resurrected.
  _stub.reset(); e = await mkDepEmp('DH');
  const hist = await sub(e, { isTestData: true, earnedPoints: 3 });
  await Penalty.create({ _id: _oid(), employee: e._id, category: 'dependency_pending', source: 'automatic', probable: false, status: 'cancelled',
    penaltyMarks: 3, targetDate: D('2026-07-14'), effectiveDate: D('2026-07-14'), submission: hist._id });
  await sub(e, { earnedPoints: 8 });
  await run(e);
  assert.strictEqual(depRows(e).length, 1); assert.strictEqual(depRows(e)[0].status, 'cancelled');
  assert.strictEqual(String(depRows(e)[0].submission), String(hist._id));
  ok('historical anchored/cancelled row is left untouched and not duplicated or resurrected');

  console.log(`\n${n} hardening checks passed`);
})().catch((x) => { console.error('FAIL', x); process.exit(1); });
