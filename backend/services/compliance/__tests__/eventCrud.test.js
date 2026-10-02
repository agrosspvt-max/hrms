/**
 * eventCrud.test.js -- Calendar Event edit/delete fix regression suite.
 *
 *   1  full update via real ObjectId persists all fields
 *   2  PARTIAL update (title only) preserves every other field
 *   3  partial update never blanks title (guard)
 *   4  delete removes the correct Event, leaves others untouched
 *   5  malformed / namespaced id (event:...:...) never mutates a doc
 *   6  malformed / namespaced id never deletes a doc
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/eventCrud.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const Event = require('../../../models/Event');
// Event holiday changes now trigger leaveHolidaySync.recalc; stub the
// models it touches so the (no-leaves) recompute is a fast no-op here.
const Leave = require('../../../models/Leave');
const User = require('../../../models/User');
const AuditLog = require('../../../models/AuditLog');
_stub.install(Event);
_stub.install(Leave);
_stub.install(User);
_stub.install(AuditLog);

const eventController = require('../../../controllers/eventController');

const _mkReq = (body, params, user) => ({ body: body || {}, params: params || {}, query: {}, user: user || { _id: _oid(), role: 'hr' }, ip: '127.0.0.1', get: () => '' });
const _mkRes = () => { const r = { statusCode: 200 }; r.status = (n) => { r.statusCode = n; return r; }; r.json = (v) => { r.body = v; return r; }; return r; };
// express-async-handler forwards thrown errors to `next(err)` (it does
// NOT reject the returned promise), so capture via next.
const _run = async (h, req) => {
  const res = _mkRes();
  let thrown = null;
  await h(req, res, (e) => { if (e) thrown = e; });
  return { res, thrown };
};

const HR = { _id: _oid(), role: 'hr', name: 'HR' };
const _seedEvent = async (over = {}) => {
  const { res } = await _run(eventController.create, _mkReq({
    type: 'company_event', title: 'Town Hall', description: 'Q3 all-hands',
    startDate: '2026-10-01', endDate: '2026-10-01', isHoliday: true,
    audience: 'department', audienceDepartment: String(_oid()),
    notify: true, notifyOffsets: [0, 1], ...over,
  }, {}, HR));
  return res.body;
};
const iso = (d) => new Date(d).toISOString().slice(0, 10);

/* 1 -- full update persists all fields. */
(async () => {
  _stub.reset();
  const ev = await _seedEvent();
  const { res } = await _run(eventController.update, _mkReq({
    type: 'festival', title: 'Diwali', description: 'Festival of lights',
    startDate: '2026-11-08', endDate: '2026-11-08', isHoliday: true,
    audience: 'everyone', notify: true, notifyOffsets: [0],
  }, { id: String(ev._id) }, HR));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.title, 'Diwali');
  assert.strictEqual(res.body.type, 'festival');
  assert.strictEqual(iso(res.body.startDate), '2026-11-08');
  assert.strictEqual(res.body.audience, 'everyone');
  console.log('  ok  1: full update persists all fields');
})()

/* 2 -- PARTIAL update (title only) preserves every other field. */
.then(async () => {
  _stub.reset();
  const ev = await _seedEvent();
  const before = _stub.rows(Event)[0];
  const { res } = await _run(eventController.update, _mkReq(
    { title: 'Town Hall (Renamed)' },   // ONLY title
    { id: String(ev._id) }, HR,
  ));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.title, 'Town Hall (Renamed)', 'title updated');
  assert.strictEqual(res.body.type, 'company_event', 'type preserved');
  assert.strictEqual(res.body.description, 'Q3 all-hands', 'description preserved');
  assert.strictEqual(iso(res.body.startDate), '2026-10-01', 'startDate preserved (not Invalid Date)');
  assert.strictEqual(res.body.audience, 'department', 'audience preserved');
  assert.strictEqual(res.body.isHoliday, true, 'isHoliday preserved');
  assert.deepStrictEqual(res.body.notifyOffsets, [0, 1], 'notifyOffsets preserved');
  console.log('  ok  2: partial update preserves untouched fields');
})

/* 3 -- partial update cannot blank the title. */
.then(async () => {
  _stub.reset();
  const ev = await _seedEvent();
  const { res, thrown } = await _run(eventController.update, _mkReq(
    { title: '   ' }, { id: String(ev._id) }, HR,
  ));
  assert.ok(thrown && /Title is required/.test(thrown.message), 'blank title rejected');
  const row = _stub.rows(Event)[0];
  assert.strictEqual(row.title, 'Town Hall', 'original title intact after rejected update');
  console.log('  ok  3: partial update cannot blank title');
})

/* 4 -- delete removes the correct Event only. */
.then(async () => {
  _stub.reset();
  const a = await _seedEvent({ title: 'Event A' });
  const b = await _seedEvent({ title: 'Event B' });
  const { res } = await _run(eventController.remove, _mkReq({}, { id: String(a._id) }, HR));
  assert.strictEqual(res.statusCode, 200);
  const remaining = _stub.rows(Event);
  assert.strictEqual(remaining.length, 1, 'one event left');
  assert.strictEqual(String(remaining[0]._id), String(b._id), 'the OTHER event survived');
  console.log('  ok  4: delete removes only the target event');
})

/* 5 -- namespaced/malformed id never mutates a document. */
.then(async () => {
  _stub.reset();
  const ev = await _seedEvent();
  const namespaced = `event:${ev._id}:2026-10-01`;   // what the resolver emits
  const { res, thrown } = await _run(eventController.update, _mkReq(
    { title: 'HACKED' }, { id: namespaced }, HR,
  ));
  // Either a 404 (no doc matches the namespaced string) -- never a mutation.
  assert.ok(res.statusCode === 404 || thrown, 'namespaced id does not update');
  assert.strictEqual(_stub.rows(Event)[0].title, 'Town Hall', 'document untouched');
  console.log('  ok  5: namespaced id never mutates a document');
})

/* 6 -- namespaced/malformed id never deletes a document. */
.then(async () => {
  _stub.reset();
  const ev = await _seedEvent();
  const namespaced = `holiday:${ev._id}`;
  const { res, thrown } = await _run(eventController.remove, _mkReq({}, { id: namespaced }, HR));
  assert.ok(res.statusCode === 404 || thrown, 'namespaced id does not delete');
  assert.strictEqual(_stub.rows(Event).length, 1, 'document not deleted');
  console.log('  ok  6: namespaced id never deletes a document');
})

.then(() => { console.log('\neventCrud: all regression tests passed'); process.exit(0); })
.catch((e) => { console.error('eventCrud test crashed:', e && e.stack || e); process.exit(1); });
