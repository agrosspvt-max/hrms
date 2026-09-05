/**
 * templateTaskSync.test.js
 *
 * Regression suite for the "newly-added Template task is not gradable
 * in an existing Submission" fix.
 *
 * The fix mirrors the existing Phase-58 custom-field splice for TASK
 * templates: getToday appends any Template.tasks[] not yet present in
 * an UNSUBMITTED Submission.tasks[] snapshot (additive, idempotent,
 * immutable for submitted rows).  These tests drive the exact splice
 * predicate + the exact reviewSubmission task-template scoring formula
 * against real stub rows.
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/templateTaskSync.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const Submission = require('../../../models/Submission');
const Template   = require('../../../models/Template');

_stub.install(Submission);
_stub.install(Template);

/**
 * Faithful replica of the getToday task-template splice
 * (submissionController.js).  Operates on the SAME data the controller
 * would, so the invariants under test match production behaviour.
 */
const spliceTaskTemplate = async (sub, tpl) => {
  if ((sub.templateType || 'task') !== 'task' || sub.submitted) return { added: 0 };
  const tplTasks = tpl?.tasks || [];
  if (tplTasks.length === 0) return { added: 0 };
  const have = new Set(
    (sub.tasks || []).map((t) => (t.taskId ? String(t.taskId) : null)).filter(Boolean),
  );
  const missing = tplTasks.filter((t) => t && t._id && !have.has(String(t._id)));
  if (missing.length === 0) return { added: 0 };
  const added = missing.map((t) => ({
    taskId: t._id, title: t.title, points: t.points,
    isCritical: t.isCritical === true, status: 'pending_submit',
  }));
  sub.tasks = [...(sub.tasks || []), ...added];
  await Submission.updateOne({ _id: sub._id }, { $set: { tasks: sub.tasks } });
  return { added: added.length };
};

/** Replica of reviewSubmission task-template scoring. */
const scoreTaskTemplate = (sub) => {
  let earned = 0; let total = 0;
  for (const t of sub.tasks || []) {
    if (t.addedByEmployee) {
      const a = Number(t.awardedMarks) || 0; earned += a; total += a;
    } else {
      if (t.status === 'done' || t.status === 'ongoing') earned += Number(t.points) || 0;
      if (t.status === 'done' || t.status === 'ongoing' || t.status === 'pending') total += Number(t.points) || 0;
    }
  }
  return { earned, total, pct: total > 0 ? Math.round((earned / total) * 1000) / 10 : 0 };
};

const _mkTpl = async (tasks) => Template.create({
  _id: _oid(), title: 'Daily Calling', templateType: 'task', isActive: true, tasks,
});
const _mkSub = async (tpl, snapshotTasks, { submitted = false } = {}) => Submission.create({
  _id: _oid(), employee: _oid(), template: tpl._id, templateType: 'task',
  date: new Date('2026-09-05T00:00:00Z'), submitted,
  deleted: false, isTestData: false, tasks: snapshotTasks,
});
const _snap = (t, status = 'pending_submit') => ({
  taskId: t._id, title: t.title, points: t.points, isCritical: t.isCritical === true, status,
});

/* ================================================================== */
/* 1 -- New task on a NEW submission (daily engine path already snaps).*/
/* ================================================================== */
(async () => {
  _stub.reset();
  const A = { _id: _oid(), title: 'Task A', points: 5 };
  const B = { _id: _oid(), title: 'Task B', points: 5 };
  const C = { _id: _oid(), title: 'Task C', points: 10 };
  const tpl = await _mkTpl([A, B, C]);
  // Simulate the daily engine snapshotting all current tasks at creation.
  const sub = await _mkSub(tpl, [_snap(A), _snap(B), _snap(C)]);
  const r = await spliceTaskTemplate(sub, tpl);
  assert.strictEqual(r.added, 0, 'nothing to splice — all present');
  assert.strictEqual(sub.tasks.length, 3);
  console.log('  ok  1: new task on new submission already present');
})()

/* ================================================================== */
/* 2 -- New task on an EXISTING open submission -> spliced.            */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const A = { _id: _oid(), title: 'Task A', points: 5 };
  const B = { _id: _oid(), title: 'Task B', points: 5 };
  const tpl = await _mkTpl([A, B]);
  const sub = await _mkSub(tpl, [_snap(A), _snap(B)]);   // seeded before Task C
  // HR adds Task C.
  const C = { _id: _oid(), title: 'Task C', points: 10 };
  tpl.tasks = [A, B, C];
  const r = await spliceTaskTemplate(sub, tpl);
  assert.strictEqual(r.added, 1, 'Task C spliced');
  const reloaded = await Submission.findById(sub._id).lean();
  assert.strictEqual(reloaded.tasks.length, 3);
  const cRow = reloaded.tasks.find((t) => String(t.taskId) === String(C._id));
  assert.ok(cRow, 'Task C present in snapshot');
  assert.strictEqual(cRow.points, 10);
  assert.strictEqual(cRow.status, 'pending_submit');
  console.log('  ok  2: new task on existing open submission is spliced');
})

/* ================================================================== */
/* 3 -- HR grading: new task participates in total + percentage.      */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const A = { _id: _oid(), title: 'Task A', points: 5 };
  const B = { _id: _oid(), title: 'Task B', points: 5 };
  const tpl = await _mkTpl([A, B]);
  const sub = await _mkSub(tpl, [_snap(A, 'done'), _snap(B, 'done')]);
  // Before Task C: 10/10 = 100%.
  assert.deepStrictEqual(scoreTaskTemplate(sub), { earned: 10, total: 10, pct: 100 });
  // HR adds Task C (10 pts) and it splices in.
  const C = { _id: _oid(), title: 'Task C', points: 10 };
  tpl.tasks = [A, B, C];
  await spliceTaskTemplate(sub, tpl);
  // Employee marks C done -> 20/20 = 100%.
  sub.tasks.find((t) => String(t.taskId) === String(C._id)).status = 'done';
  assert.deepStrictEqual(scoreTaskTemplate(sub), { earned: 20, total: 20, pct: 100 });
  // If C is pending instead -> 10 earned / 20 total = 50%.
  sub.tasks.find((t) => String(t.taskId) === String(C._id)).status = 'pending';
  assert.deepStrictEqual(scoreTaskTemplate(sub), { earned: 10, total: 20, pct: 50 });
  console.log('  ok  3: new task participates in total + percentage');
})

/* ================================================================== */
/* 4 -- Multiple new tasks spliced at once.                            */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const A = { _id: _oid(), title: 'A', points: 5 };
  const tpl = await _mkTpl([A]);
  const sub = await _mkSub(tpl, [_snap(A)]);
  const C = { _id: _oid(), title: 'C', points: 3 };
  const D = { _id: _oid(), title: 'D', points: 4 };
  tpl.tasks = [A, C, D];
  const r = await spliceTaskTemplate(sub, tpl);
  assert.strictEqual(r.added, 2, 'two tasks spliced');
  assert.strictEqual((await Submission.findById(sub._id).lean()).tasks.length, 3);
  console.log('  ok  4: multiple new tasks spliced');
})

/* ================================================================== */
/* 5 -- Critical task snapshot carries isCritical.                     */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const A = { _id: _oid(), title: 'A', points: 5 };
  const tpl = await _mkTpl([A]);
  const sub = await _mkSub(tpl, [_snap(A)]);
  const C = { _id: _oid(), title: 'Critical C', points: 10, isCritical: true };
  tpl.tasks = [A, C];
  await spliceTaskTemplate(sub, tpl);
  const cRow = (await Submission.findById(sub._id).lean()).tasks.find((t) => String(t.taskId) === String(C._id));
  assert.strictEqual(cRow.isCritical, true, 'isCritical snapshotted from template');
  console.log('  ok  5: critical task snapshot carries isCritical');
})

/* ================================================================== */
/* 6 -- Idempotent: re-run never duplicates.                          */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const A = { _id: _oid(), title: 'A', points: 5 };
  const tpl = await _mkTpl([A]);
  const sub = await _mkSub(tpl, [_snap(A)]);
  const C = { _id: _oid(), title: 'C', points: 3 };
  tpl.tasks = [A, C];
  await spliceTaskTemplate(sub, tpl);
  await spliceTaskTemplate(sub, tpl);
  await spliceTaskTemplate(sub, tpl);
  assert.strictEqual((await Submission.findById(sub._id).lean()).tasks.length, 2, '3 runs -> 2 rows');
  console.log('  ok  6: idempotent (no duplicate rows)');
})

/* ================================================================== */
/* 7 -- Submitted submission is IMMUTABLE (not spliced).             */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const A = { _id: _oid(), title: 'A', points: 5 };
  const tpl = await _mkTpl([A]);
  const sub = await _mkSub(tpl, [_snap(A, 'done')], { submitted: true });
  const C = { _id: _oid(), title: 'C', points: 3 };
  tpl.tasks = [A, C];
  const r = await spliceTaskTemplate(sub, tpl);
  assert.strictEqual(r.added, 0, 'submitted submission not spliced');
  assert.strictEqual((await Submission.findById(sub._id).lean()).tasks.length, 1, 'history preserved');
  console.log('  ok  7: submitted submission immutable — new task NOT added');
})

/* ================================================================== */
/* 8 -- Editing an existing template task does NOT overwrite snapshot.*/
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const A = { _id: _oid(), title: 'Task A', points: 5 };
  const tpl = await _mkTpl([A]);
  const sub = await _mkSub(tpl, [_snap(A)]);
  // HR renames A + changes points on the TEMPLATE.
  tpl.tasks = [{ _id: A._id, title: 'Task A (renamed)', points: 99 }];
  const r = await spliceTaskTemplate(sub, tpl);
  assert.strictEqual(r.added, 0, 'no new row for an edited existing task');
  const row = (await Submission.findById(sub._id).lean()).tasks[0];
  assert.strictEqual(row.title, 'Task A', 'snapshot title preserved (not overwritten)');
  assert.strictEqual(row.points, 5, 'snapshot points preserved');
  console.log('  ok  8: editing existing template task does not overwrite snapshot');
})

/* ================================================================== */
/* 9 -- Removing a template task does NOT remove the snapshot row.    */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const A = { _id: _oid(), title: 'A', points: 5 };
  const B = { _id: _oid(), title: 'B', points: 5 };
  const tpl = await _mkTpl([A, B]);
  const sub = await _mkSub(tpl, [_snap(A), _snap(B)]);
  // HR removes B from the template.
  tpl.tasks = [A];
  const r = await spliceTaskTemplate(sub, tpl);
  assert.strictEqual(r.added, 0);
  assert.strictEqual((await Submission.findById(sub._id).lean()).tasks.length, 2, 'B row preserved in snapshot');
  console.log('  ok  9: removing a template task preserves the snapshot row');
})

/* ================================================================== */
/* 10 -- Employee-added rows never collide with template task splice. */
/* ================================================================== */
.then(async () => {
  _stub.reset();
  const A = { _id: _oid(), title: 'A', points: 5 };
  const tpl = await _mkTpl([A]);
  const sub = await _mkSub(tpl, [
    _snap(A),
    { title: 'My extra work', points: 0, status: 'done', addedByEmployee: true, awardedMarks: 3 },
  ]);
  const C = { _id: _oid(), title: 'C', points: 4 };
  tpl.tasks = [A, C];
  const r = await spliceTaskTemplate(sub, tpl);
  assert.strictEqual(r.added, 1, 'only Task C spliced');
  const reloaded = await Submission.findById(sub._id).lean();
  assert.strictEqual(reloaded.tasks.length, 3, 'A + extra + C');
  assert.ok(reloaded.tasks.some((t) => t.addedByEmployee), 'employee-added row untouched');
  console.log('  ok  10: employee-added rows coexist with template task splice');
})

.then(() => { console.log('\ntemplateTaskSync: all regression tests passed'); process.exit(0); })
.catch((e) => { console.error('templateTaskSync test crashed:', e && e.stack || e); process.exit(1); });
