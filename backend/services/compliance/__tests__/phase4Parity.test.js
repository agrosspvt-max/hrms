/**
 * phase4Parity.test.js -- Phase 4 parity: the Compliance Final Marks and
 * completion projections must equal the legacy Penalty projections for
 * equivalent fixtures.  Each scenario is written ONCE as a neutral spec and
 * materialised twice: as Penalty rows (legacy) and as ComplianceActionEffect
 * rows (new).  The two read paths are then compared field by field.
 *
 *   cd backend && node services/compliance/__tests__/phase4Parity.test.js
 */
process.env.NODE_ENV = 'test';
const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const oid = () => new mongoose.Types.ObjectId();
const Penalty = require('../../../models/Penalty');
const Effect = require('../../../models/ComplianceActionEffect');
_stub.install(Penalty); _stub.install(Effect); _stub.install(require('../../../models/ComplianceRefile'));

const legacy = require('../../penaltyMath');
const projection = require('../projections/finalMarks');
const completion = require('../projections/completion');
const { RULE_TO_CATEGORY } = require('../projections/effectShape');

const DAY = 86400e3;
const past = (n) => new Date(Date.now() - n * DAY);
const future = (n) => new Date(Date.now() + n * DAY);
const CAT_TO_RULE = Object.fromEntries(Object.entries(RULE_TO_CATEGORY).map(([r, c]) => [c, r]));
CAT_TO_RULE.absent_submission = 'missed_submission_v2';

// --- materialisers ----------------------------------------------------
const mkLegacy = async (sub, spec) => Penalty.create({
  employee: sub.employee, category: spec.cat, source: 'automatic', probable: !!spec.probable,
  status: spec.legacyStatus, penaltyMarks: spec.legacyMarks, restoredMarks: spec.restored || 0,
  evaluationMode: spec.mode || '', submission: sub._id,
  effectiveDate: spec.effectiveDate || past(5), expiryDate: spec.expiry || null,
  overdueRef: spec.lock ? { taskTitle: spec.lock.task, pendingSince: past(9), resolveBy: past(3) } : undefined,
  reason: spec.reason || '',
});
const mkEffects = async (sub, spec) => {
  if (spec.probable) return;                      // warnings never deduct and are not linked
  const incidentId = oid();
  const base = {
    incidentId, ruleId: oid(), ruleActionId: oid(), employee: sub.employee,
    ruleCode: CAT_TO_RULE[spec.cat] || 'manual_marks_v2', submissionId: sub._id,
    effectiveDate: spec.effectiveDate || past(5), expiryDate: spec.expiry || null,
    status: spec.effStatus, evaluationMode: spec.mode || '', restoredMarks: spec.restored || 0,
  };
  const type = spec.cat === 'manual_marks' ? 'fixed_marks_reduction' : 'zero_daily_marks';
  await Effect.create({ ...base, actionType: type, marks: spec.effMarks, ruleActionId: oid() });
  if (spec.cat === 'performance_lock') {
    await Effect.create({ ...base, actionType: 'performance_lock', marks: 0, ruleActionId: oid(),
      taskRef: { taskTitle: spec.lock.task, pendingSince: past(9), resolveBy: past(3) }, reason: spec.reason || '' });
  }
};

const norm = (s) => ({
  finalMarks: s.finalMarks, avail: s.availableMarksDisplay, earned: s.earnedMarksDisplay, mode: s.evaluationMode,
  oAvail: s.originalAvailableMarks, oEarned: s.originalEarnedMarks, ded: s.penaltyDeduction, restoration: s.manualRestoration,
  fAvail: s.finalAvailableMarks, fEarned: s.finalEarnedMarks, score: s.finalScore,
  totalDeducted: s.penaltyBreakdown.totalDeducted, totalRaw: s.penaltyBreakdown.totalDeductedRaw,
  groups: ['template', 'attendance', 'dependency', 'manual'].map((g) => s.penaltyBreakdown[g].length),
  locks: s.penaltyBreakdown.performanceLocks.map((l) => [l.pendingTask, l.status, l.evaluationMode, l.lockCategory]),
});

let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };

// Spec helper: (category, marks, outcome) + overrides.  legacyStatus / effStatus default to the same word.
const P = (cat, marks, status, extra = {}) => ({
  cat, legacyMarks: marks, effMarks: marks, legacyStatus: status, effStatus: status === 'scheduled' ? 'pending' : status, ...extra,
});

const SCENARIOS = {
  'no penalty': [],
  '1 missed-submission penalty (6 of 10)': [P('missed_submission', 6, 'active')],
  '2 penalties stack (missed 4 + attendance 3)': [P('missed_submission', 4, 'active'), P('attendance_manual', 3, 'active')],
  'penalties exceed earned (clamp to 0, capped deduction)': [P('missed_submission', 9, 'active'), P('manual_marks', 7, 'active')],
  'resolved effect ignored': [P('missed_submission', 5, 'resolved')],
  'cancelled effect ignored': [P('missed_submission', 5, 'cancelled')],
  'waived effect ignored (legacy: waiver cancels the penalty)': [P('missed_submission', 5, 'cancelled', { effStatus: 'waived' })],
  'expired by status': [P('manual_marks', 5, 'expired')],
  'expired by expiryDate in the past (active row)': [P('manual_marks', 5, 'active', { expiry: past(1) })],
  'future expiry still counts': [P('manual_marks', 5, 'active', { expiry: future(3) })],
  'grace: future effectiveDate does not count yet': [P('manual_marks', 5, 'scheduled', { effectiveDate: future(2) })],
  'grace: past effectiveDate activates': [P('manual_marks', 5, 'scheduled', { effectiveDate: past(2) })],
  'restore: marks given back + manualRestoration': [P('missed_submission', 6, 'resolved', { mode: 'restore', legacyMarks: 0, effMarks: 6, restored: 6 })],
  'information mode (legacy active+mode / compliance resolved+mode)': [P('missed_submission', 6, 'active', { mode: 'information', effStatus: 'resolved' })],
  'neutral mode (compliance resolved+mode)': [P('missed_submission', 6, 'active', { mode: 'neutral', effStatus: 'resolved' })],
  'neutral wins over information and plain penalties': [
    P('missed_submission', 3, 'active', { mode: 'information', effStatus: 'resolved' }),
    P('manual_marks', 2, 'active', { mode: 'neutral', effStatus: 'resolved' }), P('attendance_manual', 1, 'active')],
  'information beats plain penalties': [P('missed_submission', 3, 'active', { mode: 'information', effStatus: 'resolved' }), P('manual_marks', 2, 'active')],
  'performance lock with explanation metadata (one row, two effects)': [P('performance_lock', 8, 'active', { lock: { task: 'Close vendor PO' }, reason: 'overdue' })],
  'performance lock restored': [P('performance_lock', 8, 'resolved', { mode: 'restore', legacyMarks: 0, effMarks: 8, restored: 8, lock: { task: 'T2' } })],
  'dependency pending zeroes the day': [P('dependency_pending', 10, 'active')],
  'probable warning does not deduct (numbers only; the warning LIST is the warnings projection)': [P('missed_submission', 0, 'active', { probable: true })],
  'mixed lifecycle on one submission': [
    P('missed_submission', 4, 'active'), P('manual_marks', 3, 'cancelled'), P('attendance_manual', 2, 'resolved'),
    P('dependency_pending', 1, 'active'), P('manual_marks', 9, 'expired')],
};

(async () => {
  for (const [name, specs] of Object.entries(SCENARIOS)) {
    _stub.reset();
    const employee = oid();
    const mkSub = () => ({ _id: oid(), employee, totalPoints: 20, earnedPoints: 10 });
    const subA = mkSub();
    for (const sp of specs) { await mkLegacy(subA, sp); await mkEffects(subA, sp); }
    const a = [JSON.parse(JSON.stringify(subA))]; const b = [JSON.parse(JSON.stringify(subA))];
    await legacy.attachFinalMarksLegacy(a);
    await projection.attachFinalMarks(b);
    const na = norm(a[0]), nb = norm(b[0]);
    // The legacy breakdown LISTS a probable (warning) row for display; in Compliance warnings are
    // served by the warnings projection, so only the group list sizes are exempt here.
    if (specs.some((x) => x.probable)) { delete na.groups; delete nb.groups; }
    assert.deepStrictEqual(nb, na, `scenario "${name}"`);
    ok(`parity: ${name}  [final=${a[0].finalMarks}${a[0].evaluationMode ? ' mode=' + a[0].evaluationMode : ''}]`);
  }

  /* multiple submissions, same employee + different employees: isolation */
  _stub.reset();
  const e1 = oid(), e2 = oid();
  const mk = (e, earned) => ({ _id: oid(), employee: e, totalPoints: 20, earnedPoints: earned });
  const s1 = mk(e1, 10), s2 = mk(e1, 8), s3 = mk(e2, 12);
  const plan = [[s1, P('missed_submission', 4, 'active')], [s1, P('manual_marks', 1, 'active')], [s2, P('dependency_pending', 8, 'active')], [s3, P('missed_submission', 2, 'resolved')]];
  for (const [s, sp] of plan) { await mkLegacy(s, sp); await mkEffects(s, sp); }
  const A = [s1, s2, s3].map((x) => JSON.parse(JSON.stringify(x))); const Bx = [s1, s2, s3].map((x) => JSON.parse(JSON.stringify(x)));
  await legacy.attachFinalMarksLegacy(A); await projection.attachFinalMarks(Bx);
  assert.deepStrictEqual(Bx.map(norm), A.map(norm));
  assert.deepStrictEqual(A.map((x) => x.finalMarks), [5, 0, 12]);
  ok('parity: 3 submissions / 2 employees at once (finals 5, 0, 12) -- no cross-submission or cross-employee leakage');

  /* the dispatcher: flag off = legacy (untouched); flag on = compliance */
  process.env.COMPLIANCE_READ_FINAL_MARKS = 'true';
  require('../../../config/featureFlags')._resetForTest();
  const viaFlag = [JSON.parse(JSON.stringify(s1))];
  _stub.reset();   // legacy rows gone: only the flag-on path can still see... nothing => full earned
  await legacy.attachFinalMarks(viaFlag);
  assert.strictEqual(viaFlag[0].finalMarks, 10, 'flag on reads Compliance (no effects now => Final = Earned)');
  await mkEffects(s1, P('missed_submission', 4, 'active'));
  const viaFlag2 = [JSON.parse(JSON.stringify(s1))]; await legacy.attachFinalMarks(viaFlag2);
  assert.strictEqual(viaFlag2[0].finalMarks, 6);
  delete process.env.COMPLIANCE_READ_FINAL_MARKS; require('../../../config/featureFlags')._resetForTest();
  const viaFlagOff = [JSON.parse(JSON.stringify(s1))]; await legacy.attachFinalMarks(viaFlagOff);
  assert.strictEqual(viaFlagOff[0].finalMarks, 10, 'flag off reads Penalty (none in this fixture)');
  ok('dispatcher: penaltyMath.attachFinalMarks follows compliance.readFinalMarks (callers unchanged)');

  /* isolation: an effect pointing at a DIFFERENT submission never touches this one; unlinked effects never deduct */
  _stub.reset();
  const sx = mk(e1, 10), sy = mk(e1, 10);
  await mkEffects(sx, P('missed_submission', 7, 'active'));
  await Effect.create({ incidentId: oid(), ruleId: oid(), ruleActionId: oid(), employee: e1, actionType: 'zero_daily_marks', marks: 9,
    status: 'active', effectiveDate: past(1), ruleCode: 'missed_submission_v2' });          // no submissionId
  const C = [JSON.parse(JSON.stringify(sx)), JSON.parse(JSON.stringify(sy))]; await projection.attachFinalMarks(C);
  assert.deepStrictEqual(C.map((x) => x.finalMarks), [3, 10]);
  ok('only effects linked by submissionId deduct; an unlinked marks effect and other submissions are unaffected');

  /* ---------- completion % ---------- */
  const rows = async (specs) => {
    _stub.reset();
    const emp = oid();
    for (const sp of specs) {
      await Penalty.create({ employee: emp, category: 'completion_adjustment', source: 'manual', probable: false, status: sp.status,
        completionPercent: sp.pct, evaluationPeriod: sp.period });
      await Effect.create({ incidentId: oid(), ruleId: oid(), ruleActionId: oid(), employee: emp, actionType: 'percent_reduction',
        percent: sp.pct, status: sp.status, effectiveDate: past(1), ruleCode: 'completion_adjustment_v2', evaluationPeriod: sp.period || {} });
    }
    return emp;
  };
  const from = new Date('2026-07-01T00:00:00Z'), to = new Date('2026-07-31T00:00:00Z'), yearFrom = new Date('2026-01-01T00:00:00Z'), yearTo = new Date('2026-12-31T00:00:00Z');
  const cases = {
    'one adjustment, full window': { s: [{ pct: 5, status: 'active' }], q: [from, to] },
    'adjustments stack additively (-5 and -3)': { s: [{ pct: 5, status: 'active' }, { pct: 3, status: 'active' }], q: [from, to] },
    'period overlap weighting (July inside a full year)': { s: [{ pct: 5, status: 'active', period: { startDate: from, endDate: to } }], q: [yearFrom, yearTo] },
    'period outside the query window contributes 0': { s: [{ pct: 5, status: 'active', period: { startDate: new Date('2026-03-01'), endDate: new Date('2026-03-31') } }], q: [from, to] },
    'cancelled / resolved / expired adjustments ignored': { s: [{ pct: 5, status: 'cancelled' }, { pct: 4, status: 'resolved' }, { pct: 2, status: 'expired' }, { pct: 1, status: 'active' }], q: [from, to] },
  };
  for (const [name, c] of Object.entries(cases)) {
    const emp = await rows(c.s);
    const legacyRows = await Penalty.find({ employee: emp, category: { $in: ['completion_adjustment', 'manual_completion'] }, status: 'active' }).lean();
    const effRows = await completion.fetchAdjustments({ employeeIds: [emp] });
    const a = legacy.applyCompletionAdjustment(80, legacyRows, c.q[0], c.q[1]);
    const b = legacy.applyCompletionAdjustment(80, effRows, c.q[0], c.q[1]);
    assert.deepStrictEqual(b, a, name);
    ok(`completion parity: ${name}  [final=${a.final.toFixed(2)}]`);
  }
  /* automatic rules' percent effects are NOT completion adjustments */
  _stub.reset();
  const emp3 = oid();
  await Effect.create({ incidentId: oid(), ruleId: oid(), ruleActionId: oid(), employee: emp3, actionType: 'percent_reduction', percent: 1,
    status: 'active', effectiveDate: past(1), ruleCode: 'dependency_pending_v2' });
  assert.deepStrictEqual(await completion.fetchAdjustments({ employeeIds: [emp3] }), []);
  ok('automatic-rule percent effects (e.g. dependency 1%/day) stay ledger-only, as in the legacy engine');

  console.log(`\n  ${n} Phase 4 parity checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
