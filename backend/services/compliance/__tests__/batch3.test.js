/**
 * batch3.test.js -- regression suite for Batch 3 fixes.
 *
 *   #14  Template-derived expectedMarks fallback
 *   #15  templateTitle mapping
 *   #16  Skip zero-quantity ledger rows
 *   #17  Cancel semantics
 *   #18  includeEffects N+1 elimination
 *
 * Runs against the shared _stubMongo harness -- no live Mongo required.
 *
 *   cd backend && node services/compliance/__tests__/batch3.test.js
 */

process.env.NODE_ENV = 'test';
process.env.MISSED_SUBMISSION_EFFECTIVE_FROM = '2020-01-01';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User                    = require('../../../models/User');
const Submission              = require('../../../models/Submission');
const Attendance              = require('../../../models/Attendance');
const DependencyTask          = require('../../../models/DependencyTask');
const Template                = require('../../../models/Template');
const Penalty                 = require('../../../models/Penalty');
const ComplianceRule          = require('../../../models/ComplianceRule');
const ComplianceIncident      = require('../../../models/ComplianceIncident');
const ComplianceActionEffect  = require('../../../models/ComplianceActionEffect');
const ComplianceEvent         = require('../../../models/ComplianceEvent');
const ComplianceWaiver        = require('../../../models/ComplianceWaiver');
const ComplianceRecovery      = require('../../../models/ComplianceRecovery');
const MarksLedger             = require('../../../models/MarksLedger');
const FinancialLedger         = require('../../../models/FinancialLedger');
const PercentageLedger        = require('../../../models/PercentageLedger');
const AttendanceLedger        = require('../../../models/AttendanceLedger');
const AuditLog                = require('../../../models/AuditLog');

_stub.install(User);
_stub.install(Submission);
_stub.install(Attendance);
_stub.install(DependencyTask);
_stub.install(Template);
_stub.install(Penalty);
_stub.install(ComplianceRule, { uniqueBy: [['code']] });
_stub.install(ComplianceIncident, { uniqueBy: [['naturalKey', 'source']] });
_stub.install(ComplianceActionEffect, {
  uniqueBy: [['incidentId', 'ruleActionId', 'effectiveDate']],
});
_stub.install(ComplianceEvent);
_stub.install(ComplianceWaiver);
_stub.install(ComplianceRecovery);
_stub.install(MarksLedger);
_stub.install(FinancialLedger);
_stub.install(PercentageLedger);
_stub.install(AttendanceLedger);
_stub.install(AuditLog);

const compliance = require('../../compliance');
const strategies = require('../marks/strategies');
const critical = require('../critical');
strategies.registerAll();

// ---------------------------------------------------------------
// #14 -- template-derived expectedMarks
// ---------------------------------------------------------------
(async () => {
  _stub.reset();

  // Case 1: task template with three tasks summing to 30 points.
  const tplTask = await Template.create({
    title: 'Daily Tasks', templateType: 'task',
    tasks: [{ title: 'A', points: 10 }, { title: 'B', points: 15 }, { title: 'C', points: 5 }],
  });
  const v1 = await strategies.templateDefault({ template: { _id: tplTask._id } });
  assert.strictEqual(v1, 30, 'task template: sum of tasks[].points');
  console.log('  ok  #14: task template expectedMarks derived from tasks[]');

  // Case 2: custom template with mixed enableMarks flags.
  const tplCustom = await Template.create({
    title: 'Custom Report', templateType: 'custom',
    customFields: [
      { key: 'a', label: 'A', fieldType: 'text', enableMarks: true,  maxMarks: 8 },
      { key: 'b', label: 'B', fieldType: 'text', enableMarks: true,  maxMarks: 12 },
      { key: 'c', label: 'C', fieldType: 'text', enableMarks: false, maxMarks: 100 },  // ignored
    ],
  });
  const v2 = await strategies.templateDefault({ template: { _id: tplCustom._id } });
  assert.strictEqual(v2, 20, 'custom template: sum of enableMarks maxMarks only');
  console.log('  ok  #14: custom template expectedMarks ignores disabled marks');

  // Case 3: excel template with mixed markEligible flags.
  const tplExcel = await Template.create({
    title: 'Excel Report', templateType: 'excel',
    excelColumns: [
      { fieldName: 'x', markEligible: true,  maxMarks: 4 },
      { fieldName: 'y', markEligible: true,  maxMarks: 6 },
      { fieldName: 'z', markEligible: false, maxMarks: 999 },
    ],
  });
  const v3 = await strategies.templateDefault({ template: { _id: tplExcel._id } });
  assert.strictEqual(v3, 10, 'excel template: sum of markEligible columns');
  console.log('  ok  #14: excel template expectedMarks respects markEligible');

  // Case 4: template with no scoring shape -> 0 (chain must fall through).
  const tplEmpty = await Template.create({
    title: 'Empty', templateType: 'task', tasks: [],
  });
  const v4 = await strategies.templateDefault({ template: { _id: tplEmpty._id } });
  assert.strictEqual(v4, 0, 'empty template returns 0 (chain falls through)');
  console.log('  ok  #14: empty template returns 0 -> admin_defined fallback');

  // Case 5: chain integration -- template_default value wins over admin_defined.
  const chainVal = await strategies.compute({
    strategy: 'last_n_avg',
    config: { N: 7, marks: 5 },
    employee: { _id: _oid(), department: _oid() },
    template: { _id: tplTask._id },
    day: new Date('2026-07-16T00:00:00Z'),
  });
  assert.strictEqual(chainVal, 30, 'template_default (30) wins over admin_defined (5)');
  console.log('  ok  #14: template-derived value overrides admin_defined floor');

  // Case 6: Batch-1 fresh-hire behaviour preserved.  No template passed +
  // no submission history -> falls through to admin_defined = 5.
  const freshVal = await strategies.compute({
    strategy: 'last_n_avg',
    config: { N: 7, marks: 5 },
    employee: { _id: _oid(), department: _oid() },
    day: new Date('2026-07-16T00:00:00Z'),
  });
  assert.strictEqual(freshVal, 5, 'no template + no history -> admin_defined 5 (Batch 1 #4 preserved)');
  console.log('  ok  #14: Batch-1 fresh-hire fallback preserved');

  // Case 7: caller passes full template doc -> no extra Mongo hit.
  const origFindById = Template.findById;
  let findByIdCalls = 0;
  Template.findById = (id) => { findByIdCalls += 1; return origFindById.call(Template, id); };
  const v7 = await strategies.templateDefault({ template: {
    _id: tplTask._id,
    tasks: [{ title: 'A', points: 10 }, { title: 'B', points: 15 }, { title: 'C', points: 5 }],
  } });
  Template.findById = origFindById;
  assert.strictEqual(v7, 30, 'inline template doc computed without DB call');
  assert.strictEqual(findByIdCalls, 0, 'no findById when caller passes full doc');
  console.log('  ok  #14: full-doc caller skips Template.findById');
})()

// ---------------------------------------------------------------
// #15 -- templateTitle mapping (real title, not templateType)
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  process.env.MISSED_SUBMISSION_EFFECTIVE_FROM = '2020-01-01';
  const missedDetector = require('../detectors/missedSubmissionDetector');

  const emp = await User.create({
    name: 'E', employeeId: 'E1', email: 'e1', password: 'x',
    role: 'employee', status: 'active',
  });
  const tpl = await Template.create({
    title: 'Daily Sales Report', templateType: 'custom',
    customFields: [{ key: 'a', label: 'A', fieldType: 'text' }],
  });
  const day = new Date('2026-07-17T00:00:00Z');
  const prevDay = new Date('2026-07-16T00:00:00Z');

  // A missed submission stub for the previous day (T-1).
  await Submission.create({
    employee: emp._id, template: tpl._id, templateType: 'custom',
    date: prevDay, submitted: false,
  });

  const cands = await missedDetector.detect({
    rule: { code: 'r_ms', trigger: {} },
    employee: emp,
    day,
  });
  assert.strictEqual(cands.length, 1, 'one missed candidate produced');
  assert.strictEqual(cands[0].context.templateTitle, 'Daily Sales Report',
    'templateTitle is the real Template.title (NOT the templateType enum)');
  assert.notStrictEqual(cands[0].context.templateTitle, 'custom',
    'templateTitle must not fall back to templateType');
  console.log('  ok  #15: real template title emitted, no templateType fallback');

  // Bulk fetch efficiency: multiple stubs for the same employee, same template
  // -> exactly ONE Template.find call.
  const origFind = Template.find;
  let findCalls = 0;
  Template.find = (q, ...rest) => { findCalls += 1; return origFind.call(Template, q, ...rest); };
  const tpl2 = await Template.create({
    title: 'Weekly Ops Report', templateType: 'task',
    tasks: [{ title: 'T', points: 5 }],
  });
  await Submission.create({
    employee: emp._id, template: tpl2._id, templateType: 'task',
    date: prevDay, submitted: false,
    tasks: [{ _id: _oid(), title: 'T', status: 'pending' }],
  });
  const cands2 = await missedDetector.detect({
    rule: { code: 'r_ms', trigger: {} },
    employee: emp,
    day,
  });
  Template.find = origFind;
  assert.strictEqual(findCalls, 1, 'template titles resolved via ONE bulk $in query');
  const titles = cands2.map((c) => c.context.templateTitle).sort();
  assert.deepStrictEqual(titles, ['Daily Sales Report', 'Weekly Ops Report'],
    'multi-stub titles resolved correctly by template');
  console.log('  ok  #15: multiple stubs resolved via one bulk template query');

  // Missing template row -> empty string, no throw.
  await Submission.create({
    employee: emp._id, template: _oid(), templateType: 'custom',   // template does not exist
    date: prevDay, submitted: false,
  });
  const cands3 = await missedDetector.detect({
    rule: { code: 'r_ms', trigger: {} },
    employee: emp,
    day,
  });
  const orphan = cands3.find((c) => !c.context.templateTitle);
  assert.ok(orphan, 'orphan stub produces empty templateTitle (no throw)');
  console.log('  ok  #15: missing template resolves to empty string, no crash');
})

// ---------------------------------------------------------------
// #16 -- skip zero-quantity ledger rows
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const ledgerService = require('../ledger/ledgerService');
  const empId = _oid();

  // Zero-quantity write returns null and produces no row.
  const r0 = await ledgerService.append({
    ledger: 'marks', employee: empId, date: new Date(),
    direction: -1, quantity: 0, type: 'action',
  });
  assert.strictEqual(r0, null, 'zero-quantity write returns null');
  assert.strictEqual(_stub.rows(MarksLedger).length, 0, 'no ledger row created for zero quantity');
  console.log('  ok  #16: zero-quantity append is a no-op');

  // Non-zero write appends normally.
  const r1 = await ledgerService.append({
    ledger: 'marks', employee: empId, date: new Date(),
    direction: -1, quantity: 10, type: 'action',
  });
  assert.ok(r1 && r1._id, 'non-zero write returns row');
  assert.strictEqual(r1.runningBalance, -10);

  // Interleaved zero writes must NOT bump the running balance or
  // create a "phantom" row at the same balance as the previous row.
  const rZero = await ledgerService.append({
    ledger: 'marks', employee: empId, date: new Date(),
    direction: +1, quantity: 0, type: 'recovery',
  });
  assert.strictEqual(rZero, null);
  assert.strictEqual(_stub.rows(MarksLedger).length, 1,
    'phantom row not created for zero recovery');

  const r2 = await ledgerService.append({
    ledger: 'marks', employee: empId, date: new Date(),
    direction: -1, quantity: 5, type: 'action',
  });
  assert.strictEqual(r2.runningBalance, -15,
    'running balance advances correctly after zero-quantity no-op');

  // balance() reflects the correct total; a zero write doesn't perturb it.
  const bal = await ledgerService.balance({ ledger: 'marks', employee: empId });
  assert.strictEqual(bal, -15, 'balance() unaffected by skipped zero writes');
  console.log('  ok  #16: running balances preserved; balance() correct');

  // Reconciler still passes over the zero-free ledger.
  const summary = await compliance.ledgerReconciler.runOnce();
  assert.strictEqual(summary.marks.checked, 2, 'reconciler sees only 2 rows (zero rows never persisted)');
  assert.strictEqual(summary.marks.drift.length, 0, 'no drift under zero-skip semantics');
  console.log('  ok  #16: reconciler passes; zero-skip introduces no drift');

  // actionEngine tolerates zero-quantity ledger appends (row=null path).
  _stub.reset();
  critical.beginTick && critical.beginTick();
  const rule = await ComplianceRule.create({
    code: 'r_zero', name: 'x', category: 'submission',
    detector: 'built_in.missed_submission', enabled: true,
    severity: 'medium', version: 1, trigger: {}, scope: {},
    // financial_fine with amount 0 -> executor emits ledgerAppend with quantity 0.
    actions: [{ _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 0 } }],
    notifications: {}, recovery: {}, waiver: {},
  });
  const inc = await ComplianceIncident.create({
    ruleId: rule._id, ruleVersion: 1, ruleCode: 'r_zero',
    employee: empId, severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'zero-nk', source: 'automatic',
    context: {},
  });
  const applied = await compliance.actionEngine.apply({ incident: inc });
  assert.deepStrictEqual(applied.errors, [], 'actionEngine did not crash on zero-quantity append');
  assert.strictEqual(_stub.rows(FinancialLedger).length, 0,
    'zero-amount financial_fine produced no ledger row');
  console.log('  ok  #16: actionEngine tolerates zero-quantity appends');
})

// ---------------------------------------------------------------
// #17 -- cancel semantics: reverse ledgers + effects + Penalty mirror
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  critical.beginTick && critical.beginTick();
  const incidentService = require('../incidents/incidentService');

  const empId = _oid();
  const penaltyId = _oid();
  await Penalty.create({
    _id: penaltyId, employee: empId, category: 'v2', source: 'automatic',
    status: 'active', amount: 500,
  });
  const rule = await ComplianceRule.create({
    code: 'r_cancel', name: 'x', category: 'submission',
    detector: 'built_in.missed_submission', enabled: true,
    severity: 'medium', version: 1, trigger: {}, scope: {},
    actions: [
      { _id: _oid(), type: 'financial_fine', enabled: true, config: { amount: 500 } },
      { _id: _oid(), type: 'fixed_marks_reduction', enabled: true, config: { marks: 3 } },
    ],
    notifications: {}, recovery: {}, waiver: {},
  });
  const inc = await ComplianceIncident.create({
    ruleId: rule._id, ruleVersion: 1, ruleCode: 'r_cancel',
    employee: empId, severity: 'medium',
    incidentDate: new Date(), effectiveDate: new Date(),
    status: 'active', naturalKey: 'cancel-nk', source: 'automatic',
    context: {},
  });
  await compliance.actionEngine.apply({ incident: inc });

  // Attach a Penalty mirror to one of the effects so we can verify the mirror cancel.
  const effects = _stub.rows(ComplianceActionEffect);
  assert.ok(effects.length >= 1, 'actionEngine wrote at least one effect');
  effects[0].penaltyId = penaltyId;

  // Baseline balances (post-action, pre-cancel):
  const finBefore = await compliance.ledgerService.balance({ ledger: 'financial', employee: empId });
  const marksBefore = await compliance.ledgerService.balance({ ledger: 'marks', employee: empId });
  assert.strictEqual(finBefore, -500, 'financial balance -500 after action');
  assert.strictEqual(marksBefore, -3, 'marks balance -3 after action');

  // Cancel the incident.
  const cancelled = await incidentService.cancelIncident(inc._id,
    { reason: 'HR overruled', actor: _oid() });
  assert.strictEqual(cancelled.status, 'cancelled', 'incident.status flipped to cancelled');
  assert.strictEqual(cancelled.cancelReason, 'HR overruled');
  console.log('  ok  #17: incident status flipped to cancelled');

  // Effects moved to 'cancelled' with cancelReason.
  const effectsAfter = _stub.rows(ComplianceActionEffect);
  for (const e of effectsAfter) {
    assert.strictEqual(e.status, 'cancelled',
      `effect ${e.actionType} moved to cancelled`);
    assert.strictEqual(e.cancelReason, 'HR overruled');
    assert.ok(e.cancelledAt, 'cancelledAt stamped');
  }
  console.log('  ok  #17: every active/pending effect moved to cancelled with reason');

  // Inverse ledger rows present; running balances restored to zero.
  const finAfter = await compliance.ledgerService.balance({ ledger: 'financial', employee: empId });
  const marksAfter = await compliance.ledgerService.balance({ ledger: 'marks', employee: empId });
  assert.strictEqual(finAfter, 0, 'financial balance restored after cancel');
  assert.strictEqual(marksAfter, 0, 'marks balance restored after cancel');

  const finRows = _stub.rows(FinancialLedger);
  const cancelRows = finRows.filter((r) => r.type === 'recovery' && r.direction === +1);
  assert.ok(cancelRows.length >= 1, 'inverse ledger row written for cancel');
  assert.ok(cancelRows[0].reason && cancelRows[0].reason.startsWith('cancel:'),
    'reason prefixed with "cancel:" for audit clarity');
  console.log('  ok  #17: inverse ledger rows written; balances restored');

  // Mirror Penalty cancelled.
  const pen = _stub.rows(Penalty).find((p) => String(p._id) === String(penaltyId));
  assert.strictEqual(pen.status, 'cancelled', 'mirror Penalty cancelled');
  assert.ok(pen.cancelReason && pen.cancelReason.includes('v2 incident cancel'));
  console.log('  ok  #17: legacy Penalty mirror moved to cancelled');

  // Timeline event emitted.
  const events = _stub.rows(ComplianceEvent);
  const cancelEvent = events.find((e) => e.kind === 'incident_cancelled');
  assert.ok(cancelEvent, 'incident_cancelled event emitted');
  assert.strictEqual(cancelEvent.payload.reason, 'HR overruled', 'reason preserved in event');
  console.log('  ok  #17: audit trail preserved (event + reason)');

  // Idempotency: cancel again is a no-op.
  const before = _stub.rows(FinancialLedger).length;
  const again = await incidentService.cancelIncident(inc._id, { reason: 'again' });
  const after = _stub.rows(FinancialLedger).length;
  assert.strictEqual(again.status, 'cancelled', 'still cancelled');
  assert.strictEqual(after, before, 'no additional ledger rows on second cancel');
  console.log('  ok  #17: idempotent -- second cancel is a no-op');

  // Reconciler still passes.
  const summary = await compliance.ledgerReconciler.runOnce();
  assert.strictEqual(summary.financial.drift.length, 0, 'no financial drift');
  assert.strictEqual(summary.marks.drift.length, 0, 'no marks drift');
  console.log('  ok  #17: reconciler passes after cancel');
})

// ---------------------------------------------------------------
// #18 -- includeEffects endpoint eliminates N+1
// ---------------------------------------------------------------
.then(async () => {
  _stub.reset();
  const featureFlags = require('../../../config/featureFlags');
  process.env.COMPLIANCE_WAIVER_RECOVERY = 'true';
  featureFlags._resetForTest();

  // Seed 10 incidents, each with 2 effects and 1 waiver.
  const empId = _oid();
  const incIds = [];
  for (let i = 0; i < 10; i++) {
    const inc = await ComplianceIncident.create({
      ruleId: _oid(), ruleVersion: 1, ruleCode: `r_${i}`,
      employee: empId, severity: 'low',
      incidentDate: new Date(Date.now() - i * 86400000),
      effectiveDate: new Date(),
      status: 'active', naturalKey: `nk_${i}`, source: 'automatic', context: {},
    });
    incIds.push(inc._id);
    await ComplianceActionEffect.create([
      { incidentId: inc._id, ruleActionId: _oid(), employee: empId, actionType: 'financial_fine', amount: 100, status: 'active', effectiveDate: new Date() },
      { incidentId: inc._id, ruleActionId: _oid(), employee: empId, actionType: 'fixed_marks_reduction', marks: 2, status: 'active', effectiveDate: new Date() },
    ]);
    await ComplianceWaiver.create({
      incidentId: inc._id, employee: empId, scope: 'full', effectIds: [],
      status: 'pending', requestedBy: empId, requestedAt: new Date(i),
    });
  }

  const controller = require('../../../controllers/compliance/incidentController');
  const adminReq = { user: { _id: _oid(), role: 'hr' }, query: {} };
  const makeRes = () => {
    const r = { _status: 200, _body: null };
    r.status = (n) => { r._status = n; return r; };
    r.json = (b) => { r._body = b; return r; };
    return r;
  };

  // --- Legacy call (no includeEffects) -- response shape unchanged ---
  const res1 = makeRes();
  await controller.list(adminReq, res1, () => {});
  assert.ok(Array.isArray(res1._body), 'legacy call returns a plain array');
  assert.strictEqual(res1._body.length, 10, '10 incidents returned');
  assert.strictEqual(res1._body[0].effects, undefined, 'no effects attached by default');
  assert.strictEqual(res1._body[0].waivers, undefined, 'no waivers attached by default');
  console.log('  ok  #18: legacy call returns unchanged shape');

  // --- includeEffects=true : one bulk query, effects grouped per incident ---
  const origEffectFind = ComplianceActionEffect.find;
  const origWaiverFind = ComplianceWaiver.find;
  let effectFindCalls = 0;
  let waiverFindCalls = 0;
  let effectQueryShape = null;
  ComplianceActionEffect.find = (q, ...rest) => {
    effectFindCalls += 1; effectQueryShape = q;
    return origEffectFind.call(ComplianceActionEffect, q, ...rest);
  };
  ComplianceWaiver.find = (q, ...rest) => {
    waiverFindCalls += 1;
    return origWaiverFind.call(ComplianceWaiver, q, ...rest);
  };

  const res2 = makeRes();
  const adminReq2 = { user: { _id: _oid(), role: 'hr' }, query: { includeEffects: 'true' } };
  await controller.list(adminReq2, res2, () => {});
  assert.strictEqual(effectFindCalls, 1, 'exactly ONE effect query for the whole page (no N+1)');
  assert.strictEqual(waiverFindCalls, 0, 'no waiver query when only effects requested');
  assert.ok(effectQueryShape && effectQueryShape.incidentId && Array.isArray(effectQueryShape.incidentId.$in),
    'effect query uses $in with the incident-id list');
  assert.strictEqual(effectQueryShape.incidentId.$in.length, 10, 'bulk $in covers all 10 incidents');
  assert.strictEqual(res2._body.length, 10);
  for (const inc of res2._body) {
    assert.ok(Array.isArray(inc.effects), 'each incident has effects array');
    assert.strictEqual(inc.effects.length, 2, 'each incident gets its own 2 effects');
    for (const e of inc.effects) {
      assert.strictEqual(String(e.incidentId), String(inc._id),
        'effect actually belongs to the parent incident');
    }
  }
  console.log('  ok  #18: includeEffects populates via one $in query; correct grouping');

  // --- includeWaivers=true too, order preserved ---
  effectFindCalls = 0; waiverFindCalls = 0;
  const res3 = makeRes();
  const adminReq3 = { user: { _id: _oid(), role: 'hr' },
    query: { includeEffects: '1', includeWaivers: 'true' } };
  await controller.list(adminReq3, res3, () => {});
  assert.strictEqual(effectFindCalls, 1, 'one effect query');
  assert.strictEqual(waiverFindCalls, 1, 'one waiver query');
  for (const inc of res3._body) {
    assert.strictEqual(inc.waivers.length, 1, 'one waiver per incident');
    assert.strictEqual(String(inc.waivers[0].incidentId), String(inc._id),
      'waiver belongs to the parent incident');
  }
  console.log('  ok  #18: includeWaivers piggybacks via one more $in query');

  // --- Pagination preserved: limit=5 -> 5 rows + 1 effect query over those 5 ids ---
  effectFindCalls = 0;
  const res4 = makeRes();
  const adminReq4 = { user: { _id: _oid(), role: 'hr' },
    query: { includeEffects: 'true', limit: '5' } };
  await controller.list(adminReq4, res4, () => {});
  assert.strictEqual(res4._body.length, 5, 'limit respected');
  assert.strictEqual(effectFindCalls, 1);
  console.log('  ok  #18: pagination preserved; still one effect query');

  ComplianceActionEffect.find = origEffectFind;
  ComplianceWaiver.find = origWaiverFind;

  // --- Empty result short-circuits (no extra queries) ---
  effectFindCalls = 0; waiverFindCalls = 0;
  ComplianceActionEffect.find = (q, ...rest) => { effectFindCalls += 1; return origEffectFind.call(ComplianceActionEffect, q, ...rest); };
  const res5 = makeRes();
  const adminReq5 = { user: { _id: _oid(), role: 'hr' },
    query: { includeEffects: 'true', employee: String(_oid()) } };   // nobody
  await controller.list(adminReq5, res5, () => {});
  assert.strictEqual(res5._body.length, 0, 'no incidents match unknown employee');
  assert.strictEqual(effectFindCalls, 0, 'no effect query when zero rows');
  ComplianceActionEffect.find = origEffectFind;
  console.log('  ok  #18: empty page short-circuits attachment queries');

  delete process.env.COMPLIANCE_WAIVER_RECOVERY;
  featureFlags._resetForTest();
})

.then(() => {
  _stub.restore();
  console.log('\nbatch3: all regression tests passed');
})
.catch((e) => {
  console.error('batch3 test crashed:', e && e.stack || e);
  _stub.restore();
  process.exit(1);
});
