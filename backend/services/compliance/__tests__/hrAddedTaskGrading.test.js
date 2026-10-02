/**
 * hrAddedTaskGrading.test.js -- Issue #1 verification.
 *
 * Ticket: "Additional Tasks can be added to a customized Template, but
 * HR cannot assign/enter marks for those additional tasks."
 *
 * INVESTIGATION OUTCOME (works-as-designed):
 *   An "Additional Task added by HR" is an ordinary Template.tasks[] row
 *   ({title, points, isCritical}) -- it carries NO addedByEmployee flag.
 *   Task-template rows are graded by COMPLETION STATUS x fixed points
 *   (done/ongoing -> earned; done/ongoing/pending -> total).  The manual
 *   numeric-marks path (awardedMarks via editTaskMarks) is deliberately
 *   reserved for EMPLOYEE-ADDED rows, which have no template points.
 *
 *   So HR grades an HR-added task by setting its STATUS -- that path is
 *   NOT gated on addedByEmployee and already works.  There is (by design)
 *   no separate per-submission "marks" box for standard rows; the marks
 *   ARE the points, assigned at template-authoring time.
 *
 * These tests pin that contract against the REAL controllers so the
 * intended boundary can never silently drift:
 *
 *   1  editTaskStatus grades an HR-added row (done)  -> points earned.
 *   2  editTaskStatus grades an HR-added row (pending)-> counts to total only.
 *   3  editTaskStatus works on an HR-added row (NOT gated on addedByEmployee).
 *   4  editTaskMarks REJECTS an HR-added standard row (marks are employee-only).
 *   5  editTaskMarks ACCEPTS an employee-added row (the intended marks path).
 *   6  Mixed submission: HR-added (status->points) + employee-added
 *      (awardedMarks) score side by side without double-counting.
 *   7  Critical HR-added row: isCritical preserved through a status edit.
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/hrAddedTaskGrading.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User       = require('../../../models/User');
const Submission = require('../../../models/Submission');
const AuditLog   = require('../../../models/AuditLog');

[User, Submission, AuditLog].forEach((m) => _stub.install(m));

const dailyReview = require('../../../controllers/dailyReviewController');

/* -- express harness (asyncHandler forwards to next; capture via next) -- */
const _mkReq = (body, user) => ({ body: body || {}, query: {}, params: {}, user, ip: '127.0.0.1', get: () => '' });
const _mkRes = () => { const r = { statusCode: 200 }; r.status = (n) => { r.statusCode = n; return r; }; r.json = (v) => { r.body = v; return r; }; return r; };
const _run = async (h, req) => {
  const res = _mkRes();
  let err = null;
  await h(req, res, (e) => { if (e) err = e; });
  return { res, err };
};

const _mkHR  = async () => User.create({ _id: _oid(), name: 'HR', employeeId: 'HR1', email: 'hr@x', password: 'p', role: 'hr', status: 'active' });
const _mkEmp = async () => User.create({ _id: _oid(), name: 'Emp', employeeId: 'E1', email: 'e@x', password: 'p', role: 'employee', status: 'active' });

// The controllers address task rows via Mongoose's DocumentArray `.id()`
// and flag `markModified`.  The in-memory stub stores plain objects, so
// we give the tasks array an `.id()` finder and the doc a no-op
// markModified -- enough for the real controller logic to run unchanged.
const _tasksArray = (arr) => {
  Object.defineProperty(arr, 'id', {
    value: function (taskId) { return this.find((t) => String(t._id) === String(taskId)) || null; },
    enumerable: false,
  });
  return arr;
};

// A task submission carrying HR-defined (standard) rows and optionally an
// employee-added row.  taskId mirrors the Template.tasks[] _id; _id is the
// subdocument id the controllers address rows by.
const _mkSub = async (emp, tasks) => {
  const sub = await Submission.create({
    _id: _oid(), employee: emp._id, template: _oid(), templateType: 'task',
    date: new Date('2026-09-28T00:00:00Z'), submitted: true, deleted: false,
    isTestData: false, tasks: _tasksArray(tasks),
  });
  sub.markModified = () => {};
  return sub;
};
const _stdRow = (title, points, over = {}) => ({ _id: _oid(), taskId: _oid(), title, points, status: 'pending_submit', ...over });
const _empRow = (title, over = {}) => ({ _id: _oid(), title, points: 0, addedByEmployee: true, status: 'done', awardedMarks: 0, ...over });
const _rowId = (sub, i) => String(sub.tasks[i]._id);
const _reload = async (id) => Submission.findById(id).lean();

/* 1 -- HR-added row marked done -> its points are earned. */
(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const sub = await _mkSub(emp, [_stdRow('Original', 5, { status: 'done' }), _stdRow('HR-added extra', 10)]);
  const { res, err } = await _run(dailyReview.editTaskStatus,
    _mkReq({ submissionId: String(sub._id), taskId: _rowId(sub, 1), status: 'done' }, hr));
  assert.strictEqual(err, null, 'status edit succeeds on HR-added row');
  const r = await _reload(sub._id);
  assert.strictEqual(r.workEarnedPoints, 15, '5 + 10 earned');
  assert.strictEqual(r.workTotalPoints, 15, '5 + 10 total');
  console.log('  ok  1: HR-added row graded done -> points earned via status');
})()

/* 2 -- HR-added row left pending -> counts to total (denominator) only. */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const sub = await _mkSub(emp, [_stdRow('Original', 5, { status: 'done' }), _stdRow('HR-added extra', 10)]);
  const { err } = await _run(dailyReview.editTaskStatus,
    _mkReq({ submissionId: String(sub._id), taskId: _rowId(sub, 1), status: 'pending' }, hr));
  assert.strictEqual(err, null);
  const r = await _reload(sub._id);
  assert.strictEqual(r.workEarnedPoints, 5, 'only the done original is earned');
  assert.strictEqual(r.workTotalPoints, 15, 'pending HR-added row still in denominator');
  console.log('  ok  2: HR-added row pending -> total only (owed work)');
})

/* 3 -- editTaskStatus is NOT gated on addedByEmployee (works on std rows). */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const sub = await _mkSub(emp, [_stdRow('HR-added extra', 8)]);
  const { res, err } = await _run(dailyReview.editTaskStatus,
    _mkReq({ submissionId: String(sub._id), taskId: _rowId(sub, 0), status: 'ongoing' }, hr));
  assert.strictEqual(err, null, 'ongoing accepted on a standard HR-added row');
  assert.strictEqual(res.body.ok, true);
  const r = await _reload(sub._id);
  assert.strictEqual(r.tasks[0].status, 'ongoing');
  assert.strictEqual(r.workEarnedPoints, 8, 'ongoing earns like done');
  console.log('  ok  3: editTaskStatus ungated -> grades HR-added standard rows');
})

/* 4 -- editTaskMarks REJECTS an HR-added standard row (marks are employee-only). */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const sub = await _mkSub(emp, [_stdRow('HR-added extra', 10)]);
  const { res, err } = await _run(dailyReview.editTaskMarks,
    _mkReq({ submissionId: String(sub._id), taskId: _rowId(sub, 0), awardedMarks: 7 }, hr));
  assert.ok(err, 'editTaskMarks throws for a standard row');
  assert.strictEqual(res.statusCode, 400);
  assert.match(String(err.message), /employee-added/, 'error names the employee-added restriction');
  const r = await _reload(sub._id);
  assert.ok(!('awardedMarks' in r.tasks[0]) || !r.tasks[0].awardedMarks, 'no marks written to a standard row');
  console.log('  ok  4: editTaskMarks rejects HR-added standard rows (by design)');
})

/* 5 -- editTaskMarks ACCEPTS an employee-added row (the intended marks path). */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const sub = await _mkSub(emp, [_empRow('Extra work I did')]);
  const { res, err } = await _run(dailyReview.editTaskMarks,
    _mkReq({ submissionId: String(sub._id), taskId: _rowId(sub, 0), awardedMarks: 6 }, hr));
  assert.strictEqual(err, null, 'marks accepted on employee-added row');
  assert.strictEqual(res.body.ok, true);
  const r = await _reload(sub._id);
  assert.strictEqual(r.tasks[0].awardedMarks, 6);
  assert.strictEqual(r.workEarnedPoints, 6, 'awardedMarks flows into earned');
  assert.strictEqual(r.workTotalPoints, 6, 'and grows the denominator');
  console.log('  ok  5: editTaskMarks accepts employee-added rows (intended path)');
})

/* 6 -- Mixed: HR-added (status->points) + employee-added (marks) coexist. */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const sub = await _mkSub(emp, [
    _stdRow('HR-added extra', 10, { status: 'done' }),   // 10 earned / 10 total
    _empRow('Extra work', { awardedMarks: 4 }),           // 4 earned / 4 total
  ]);
  // Recompute happens on any edit; nudge the employee-added marks to 5.
  const { err } = await _run(dailyReview.editTaskMarks,
    _mkReq({ submissionId: String(sub._id), taskId: _rowId(sub, 1), awardedMarks: 5 }, hr));
  assert.strictEqual(err, null);
  const r = await _reload(sub._id);
  assert.strictEqual(r.workEarnedPoints, 15, '10 (status->points) + 5 (marks), no double-count');
  assert.strictEqual(r.workTotalPoints, 15, '10 + 5 total');
  console.log('  ok  6: HR-added + employee-added score side by side, no double-count');
})

/* 7 -- Critical HR-added row keeps isCritical through a status edit. */
.then(async () => {
  _stub.reset();
  const hr = await _mkHR(); const emp = await _mkEmp();
  const sub = await _mkSub(emp, [_stdRow('Critical HR-added', 10, { isCritical: true })]);
  const { err } = await _run(dailyReview.editTaskStatus,
    _mkReq({ submissionId: String(sub._id), taskId: _rowId(sub, 0), status: 'done' }, hr));
  assert.strictEqual(err, null);
  const r = await _reload(sub._id);
  assert.strictEqual(r.tasks[0].isCritical, true, 'isCritical preserved across grading');
  console.log('  ok  7: critical HR-added row keeps isCritical through grading');
})

.then(() => { console.log('\nhrAddedTaskGrading: all checks passed'); process.exit(0); })
.catch((e) => { console.error('hrAddedTaskGrading crashed:', e && e.stack || e); process.exit(1); });
