/**
 * resubmissionSelfEval.test.js
 *
 * Regression suite for the returned-submission Self Evaluation bug.
 *
 * Root cause: DailyReflection is uniquely keyed by { employee, date }.
 * The employee-facing card was hard-coded to TODAY, so a returned
 * past-day submission's Self Evaluation was saved under today while
 * submitOne validates DailyReflection(employee, submission.date).
 *
 * The fix makes the card date-aware (frontend).  These tests pin the
 * backend contract the frontend now honours:
 *
 *   - saveReflection / getMyReflection are date-scoped (real controllers).
 *   - The submitOne self-rating GATE (replicated verbatim from
 *     submissionController.js) passes IFF a DailyReflection exists for
 *     (employee, submission.date).
 *   - The one-per-(employee,date) rule holds: repeated saves upsert a
 *     single row; multiple same-day submissions share it.
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/resubmissionSelfEval.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User            = require('../../../models/User');
const DailyReflection = require('../../../models/DailyReflection');

_stub.install(User);
_stub.install(DailyReflection, {
  // Mirror the production unique index on { employee, date } so the
  // stub throws E11000 on a genuine duplicate -- proving the upsert
  // path never creates two rows.
  uniqueBy: [{ keys: ['employee', 'date'] }],
});

const dailyReview = require('../../../controllers/dailyReviewController');
const { startOfDay } = require('../../../utils/dateHelpers');

/* -- express harness -- */
const _mkReq = (body, query, user) => ({ body: body || {}, query: query || {}, params: {}, user, ip: '127.0.0.1', get: () => '' });
const _mkRes = () => { const r = { statusCode: 200 }; r.status = (n) => { r.statusCode = n; return r; }; r.json = (v) => { r.body = v; return r; }; return r; };
const _run = async (h, req) => { const res = _mkRes(); await h(req, res, (e) => { if (e) throw e; }); return res; };

const _mkEmp = async () => User.create({ _id: _oid(), name: 'Anoop', employeeId: 'AMI0047', email: 'a@x', password: 'p', role: 'employee', status: 'active' });

/**
 * Verbatim replica of the submitOne self-rating gate
 * (submissionController.js ~402-409) -- the "no inline rating" branch
 * that runs on every resubmit (the frontend never feeds inline
 * selfRating).  Returns true when the submission would be allowed.
 */
const submitOneGatePasses = async (employeeId, subDate) => {
  const subDay = startOfDay(subDate);
  const existing = await DailyReflection.findOne({ employee: employeeId, date: subDay })
    .select('selfRating').lean();
  return !!(existing && typeof existing.selfRating === 'number'
    && existing.selfRating >= 0 && existing.selfRating <= 10);
};

const ISO = (d) => new Date(d).toISOString().slice(0, 10);
// Env-relative dates.  The sandbox clock can be any date, so "returned"
// days are computed as offsets from the real today to guarantee they
// are strictly in the past AND distinct from today.
const TODAY = startOfDay(new Date());
const daysAgo = (n) => startOfDay(new Date(TODAY.getTime() - n * 86400000));

/* ================================================================== */
/* 1 -- Today's submission: fill self-eval today, gate passes today.  */
/* ================================================================== */
(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const today = startOfDay(new Date());
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(today), selfRating: 8 }, {}, emp));
  assert.strictEqual(await submitOneGatePasses(emp._id, today), true, 'today gate passes');
  assert.strictEqual(_stub.rows(DailyReflection).length, 1);
  console.log('  ok  1: today submission — fill + submit unchanged');
})()

/* ================================================================== */
/* 2 -- Returned from yesterday: save under yesterday, gate passes.   */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const yesterday = startOfDay(new Date(Date.now() - 86400000));
  // Card is date-aware -> saves under the submission's date.
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(yesterday), selfRating: 7 }, {}, emp));
  const row = _stub.rows(DailyReflection)[0];
  assert.strictEqual(ISO(row.date), ISO(yesterday), 'reflection stored under yesterday');
  assert.strictEqual(await submitOneGatePasses(emp._id, yesterday), true, 'resubmit gate passes for yesterday');
  console.log('  ok  2: returned-from-yesterday stored under submission date; resubmit passes');
})

/* ================================================================== */
/* 3 -- Returned from several days ago: same behaviour.               */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const past = daysAgo(6);
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(past), selfRating: 9 }, {}, emp));
  assert.strictEqual(await submitOneGatePasses(emp._id, past), true, 'resubmit gate passes for the past day');
  console.log('  ok  3: returned several-days-ago stored + resubmit passes');
})

/* ================================================================== */
/* 4 -- Existing reflection for the returned date is UPDATED, no dup. */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const past = daysAgo(3);
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(past), selfRating: 4 }, {}, emp));
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(past), selfRating: 9, selfNote: 'edited' }, {}, emp));
  const rows = _stub.rows(DailyReflection);
  assert.strictEqual(rows.length, 1, 'still exactly one row (updated, not duplicated)');
  assert.strictEqual(rows[0].selfRating, 9, 'row updated to new value');
  assert.strictEqual(rows[0].selfNote, 'edited');
  console.log('  ok  4: existing reflection for returned date updated, no duplicate');
})

/* ================================================================== */
/* 5 -- Today's reflection must NOT satisfy a returned earlier date.  */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const today = TODAY;
  const returnedDay = daysAgo(2);       // strictly earlier than today
  // Employee has TODAY's reflection only.
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(today), selfRating: 8 }, {}, emp));
  // The returned earlier-day submission must NOT be satisfied by today's row.
  assert.strictEqual(await submitOneGatePasses(emp._id, returnedDay), false, 'today reflection does not satisfy the returned day');
  // getMyReflection for the returned day returns null (not today's row).
  const res = await _run(dailyReview.getMyReflection, _mkReq({}, { date: ISO(returnedDay) }, emp));
  assert.strictEqual(res.body, null, 'my-reflection?date=returnedDay returns null, not today');
  // After the date-aware card saves for the returned day, the gate passes.
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(returnedDay), selfRating: 6 }, {}, emp));
  assert.strictEqual(await submitOneGatePasses(emp._id, returnedDay), true, 'gate passes after saving for the returned day');
  assert.strictEqual(_stub.rows(DailyReflection).length, 2, 'today + returned day are two distinct rows');
  console.log('  ok  5: today reflection never satisfies a returned earlier date');
})

/* ================================================================== */
/* 6 -- One-per-day rule: many saves -> one row.                      */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const past = daysAgo(4);
  for (let i = 0; i < 5; i += 1) {
    await _run(dailyReview.saveReflection, _mkReq({ date: ISO(past), selfRating: i + 1 }, {}, emp));
  }
  const rows = _stub.rows(DailyReflection).filter((r) => ISO(r.date) === ISO(past));
  assert.strictEqual(rows.length, 1, '5 saves -> 1 row');
  assert.strictEqual(rows[0].selfRating, 5, 'last write wins');
  console.log('  ok  6: one-per-day upsert (5 saves = 1 row)');
})

/* ================================================================== */
/* 7 -- Submission validation: with reflection passes; without fails. */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const d = daysAgo(5);
  // Without a reflection for that date -> gate fails.
  assert.strictEqual(await submitOneGatePasses(emp._id, d), false, 'no reflection -> gate fails');
  // With one -> passes.
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(d), selfRating: 5 }, {}, emp));
  assert.strictEqual(await submitOneGatePasses(emp._id, d), true, 'reflection present -> gate passes');
  console.log('  ok  7: validation passes with reflection on its own date, fails without');
})

/* ================================================================== */
/* 8 -- Multiple submissions on the same date share ONE reflection.   */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const d = daysAgo(7);
  // The date-aware dashboard renders ONE card per date, so even with
  // three returned submissions on the same day only one save happens;
  // but even if each submission attempted a save, the upsert dedups.
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(d), selfRating: 7 }, {}, emp));
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(d), selfRating: 7 }, {}, emp));
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(d), selfRating: 7 }, {}, emp));
  const rows = _stub.rows(DailyReflection).filter((r) => ISO(r.date) === ISO(d));
  assert.strictEqual(rows.length, 1, 'three same-day submissions -> one reflection');
  // All three submissions validate against the same shared row.
  assert.strictEqual(await submitOneGatePasses(emp._id, d), true);
  console.log('  ok  8: multiple same-day submissions share one reflection');
})

/* ================================================================== */
/* 9 -- End-to-end scenario from the ticket.                          */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const emp = await _mkEmp();
  const missedDay = daysAgo(2);   // "5 Sept" -- the missed submission's date
  // (HR returns the submission -- modelled as: the returned submission
  //  carries date = missedDay and appears on the dashboard today, i.e.
  //  "two days later".)  The date-aware card posts date = missedDay.
  await _run(dailyReview.saveReflection, _mkReq({ date: ISO(missedDay), selfRating: 8 }, {}, emp));
  // Reflection is stored as employee + missedDay.
  const row = _stub.rows(DailyReflection)[0];
  assert.strictEqual(ISO(row.date), ISO(missedDay), 'stored under the missed day');
  // Employee resubmits -> backend checks employee + missedDay -> passes.
  assert.strictEqual(await submitOneGatePasses(emp._id, missedDay), true, 'resubmit validation passes');
  console.log('  ok  9: full ticket flow — miss day, return, fill later, resubmit passes');
})

.then(() => { console.log('\nresubmissionSelfEval: all regression tests passed'); process.exit(0); })
.catch((e) => { console.error('resubmissionSelfEval test crashed:', e && e.stack || e); process.exit(1); });
