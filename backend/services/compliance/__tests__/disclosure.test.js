/**
 * disclosure.test.js -- Disclosure feature: conditional validation,
 * association with the daily submission, authorization, filtering,
 * idempotency, lifecycle lock, audit, and "no side effects".
 *
 *   cd backend && NODE_ENV=test node services/compliance/__tests__/disclosure.test.js
 */
process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const _stub = require('./_stubMongo');
const _oid = () => new mongoose.Types.ObjectId();

const User = require('../../../models/User');
const Submission = require('../../../models/Submission');
const Disclosure = require('../../../models/Disclosure');
const AuditLog = require('../../../models/AuditLog');
const Penalty = require('../../../models/Penalty');
const Attendance = require('../../../models/Attendance');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const FinancialLedger = require('../../../models/FinancialLedger');
[User, Submission, Disclosure, AuditLog, Penalty, Attendance, ComplianceIncident, FinancialLedger]
  .forEach((m) => _stub.install(m));

const c = require('../../../controllers/disclosureController');
const { authorize } = require('../../../middleware/auth');
const { startOfDay } = require('../../../utils/dateHelpers');

const _mkReq = (user, { body, query } = {}) => ({ body: body || {}, params: {}, query: query || {}, user, ip: '127.0.0.1', get: () => '' });
const _mkRes = () => { const r = { statusCode: 200 }; r.status = (n) => { r.statusCode = n; return r; }; r.json = (v) => { r.body = v; return r; }; return r; };
const _run = async (h, req) => {
  const res = _mkRes(); let err = null;
  try { await h(req, res, (e) => { if (e) err = e; }); } catch (e) { err = e; }
  return { res, err };
};
const save = (user, body) => _run(c.saveMine, _mkReq(user, { body }));
const listAs = (user, query) => _run(c.list, _mkReq(user, { query }));

const TODAY = startOfDay(new Date());
const iso = (d) => d.toISOString().slice(0, 10);
const TODAY_ISO = iso(TODAY);
const YESTERDAY = new Date(TODAY.getTime() - 86400000);

const mkUser = (role, name) => User.create({ _id: _oid(), name, employeeId: name, email: `${name}@x`, password: 'p', role, status: 'active' });
const mkSub = (emp, date, extra = {}) => Submission.create({
  _id: _oid(), employee: emp._id, template: _oid(), templateType: 'task', date,
  deleted: false, isTestData: false, hidden: false, submitted: false, reviewStatus: 'pending', ...extra,
});
const rejected = (r, status) => { assert.ok(r.err, 'expected rejection'); assert.strictEqual(r.res.statusCode, status); };

let n = 0;
const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };

(async () => {
  _stub.reset();
  const emp = await mkUser('employee', 'Rahul');
  const other = await mkUser('employee', 'Other');
  const hr = await mkUser('hr', 'HR');
  const sa = await mkUser('super_admin', 'SA');
  const sub = await mkSub(emp, TODAY);
  await mkSub(other, TODAY);

  /* ---------------- Mistake ---------------- */
  let r = await save(emp, { type: 'mistake', details: 'Wrong entry', correctable: false });
  assert.ifError(r.err);
  assert.strictEqual(r.res.statusCode, 201);
  assert.strictEqual(r.res.body.correctable, false);
  assert.strictEqual(r.res.body.corrected, null);
  ok('Mistake: correctable=No stored, corrected null');

  r = await save(emp, { type: 'mistake', details: 'Wrong entry', correctable: true, corrected: true });
  assert.ifError(r.err);
  assert.strictEqual(r.res.body.corrected, true);
  ok('Mistake: correctable=Yes + corrected=Yes');

  r = await save(emp, { type: 'mistake', details: 'Wrong entry', correctable: true, corrected: false });
  assert.ifError(r.err);
  assert.strictEqual(r.res.body.corrected, false);
  ok('Mistake: correctable=Yes + corrected=No');

  rejected(await save(emp, { type: 'mistake', correctable: false }), 400); ok('Mistake: missing details rejected');
  rejected(await save(emp, { type: 'mistake', details: '   ', correctable: false }), 400); ok('Mistake: blank details rejected');
  rejected(await save(emp, { type: 'mistake', details: 'x' }), 400); ok('Mistake: missing correctable rejected');
  rejected(await save(emp, { type: 'mistake', details: 'x', correctable: 'yes' }), 400); ok('Mistake: non-boolean correctable rejected');
  rejected(await save(emp, { type: 'mistake', details: 'x', correctable: true }), 400); ok('Mistake: correctable=Yes without corrected rejected');
  rejected(await save(emp, { type: 'mistake', details: 'x', correctable: false, corrected: true }), 400); ok('Mistake: correctable=No with corrected=true rejected');
  rejected(await save(emp, { type: 'mistake', details: 'x', correctable: false, corrected: false }), 400); ok('Mistake: correctable=No with corrected=false rejected');
  rejected(await save(emp, { type: 'mistake', details: 'x', correctable: false, authorizedBy: 'Boss' }), 400); ok('Mistake: authorizedBy rejected');

  /* ---------------- Exception ---------------- */
  r = await save(emp, { type: 'exception', details: 'Late dispatch', authorizedBy: '  Mr Sharma ' });
  assert.ifError(r.err);
  assert.strictEqual(r.res.body.authorizedBy, 'Mr Sharma');
  assert.strictEqual(r.res.body.correctable, null);
  assert.strictEqual(r.res.body.corrected, null);
  ok('Exception: details + authorizer (trimmed), Mistake values cleared (no stale data)');
  rejected(await save(emp, { type: 'exception', authorizedBy: 'A' }), 400); ok('Exception: missing details rejected');
  rejected(await save(emp, { type: 'exception', details: 'x' }), 400); ok('Exception: missing authorizer rejected');
  rejected(await save(emp, { type: 'exception', details: 'x', authorizedBy: '  ' }), 400); ok('Exception: blank authorizer rejected');
  rejected(await save(emp, { type: 'exception', details: 'x', authorizedBy: 'A', correctable: true }), 400); ok('Exception: stale Mistake field rejected');

  /* ---------------- Other ---------------- */
  r = await save(emp, { type: 'other', details: 'FYI' });
  assert.ifError(r.err);
  assert.strictEqual(r.res.body.authorizedBy, '');
  assert.strictEqual(r.res.body.correctable, null);
  ok('Other: details accepted, Exception/Mistake values cleared');
  rejected(await save(emp, { type: 'other' }), 400); ok('Other: missing details rejected');
  rejected(await save(emp, { type: 'other', details: 'x', authorizedBy: 'A' }), 400); ok('Other: extra field rejected');
  rejected(await save(emp, { type: 'bogus', details: 'x' }), 400); ok('Unknown type rejected');
  rejected(await save(emp, { details: 'x' }), 400); ok('Missing type rejected');

  /* ---------------- Association, idempotency, history ---------------- */
  assert.strictEqual(_stub.rows(Disclosure).length, 1, 'type changes + retries keep ONE row');
  const row = _stub.rows(Disclosure)[0];
  assert.strictEqual(String(row.employee), String(emp._id));
  assert.strictEqual(String(row.submission), String(sub._id));
  assert.strictEqual(iso(new Date(row.date)), TODAY_ISO);
  ok('Associated with employee, daily submission and business date; one row per employee/day');

  const a = await save(emp, { type: 'other', details: 'FYI' });
  const b = await save(emp, { type: 'other', details: 'FYI' });
  assert.ifError(a.err); assert.ifError(b.err);
  assert.strictEqual(_stub.rows(Disclosure).length, 1);
  ok('Double submit / retry creates no duplicate');

  await new Promise((res) => setTimeout(res, 20)); // audit writes are fire-and-forget
  const audits = _stub.rows(AuditLog).filter((x) => String(x.action).startsWith('disclosure.'));
  assert.ok(audits.some((x) => x.action === 'disclosure.create'));
  const upd = audits.find((x) => x.action === 'disclosure.update' && x.meta.previous && x.meta.previous.type === 'exception');
  assert.ok(upd, 'update audit carries the previous values');
  assert.strictEqual(upd.meta.next.type, 'other');
  ok('Audit trail records create + update with previous values');

  /* ---------------- Date / submission rules ---------------- */
  rejected(await save(emp, { type: 'other', details: 'x', date: iso(new Date(TODAY.getTime() + 86400000)) }), 400); ok('Future date rejected');
  rejected(await save(emp, { type: 'other', details: 'x', date: iso(YESTERDAY) }), 404); ok('No submission for that date -> rejected (cannot detach)');
  rejected(await save(emp, { type: 'other', details: 'x', submissionId: String((await Submission.find({ employee: other._id }))[0]._id) }), 400); ok("Another employee's submissionId rejected");
  const ysub = await mkSub(emp, YESTERDAY);
  r = await save(emp, { type: 'other', details: 'prev day', date: iso(YESTERDAY) });
  assert.ifError(r.err);
  assert.strictEqual(iso(new Date(r.res.body.date)), iso(YESTERDAY));
  assert.strictEqual(String(r.res.body.submission), String(ysub._id));
  assert.strictEqual(_stub.rows(Disclosure).length, 2);
  ok('Past day with its own submission: filed under that submission\'s business date');

  /* ---------------- Lifecycle lock ---------------- */
  ysub.reviewStatus = 'reviewed';
  rejected(await save(emp, { type: 'other', details: 'edit after review', date: iso(YESTERDAY) }), 409);
  ok('Reviewed (finalised) day is immutable for the employee');

  /* ---------------- Authorization ---------------- */
  rejected(await save(emp, { employee: String(other._id), type: 'other', details: 'x' }), 403); ok("Employee cannot file another employee's disclosure");
  r = await save(emp, { employee: String(emp._id), type: 'other', details: 'own id ok' });
  assert.ifError(r.err); ok('Explicit own employee id is accepted');
  const gate = (user) => { let e = null; const res = _mkRes(); try { authorize('hr')({ user }, res, (x) => { if (x) e = x; }); } catch (x) { e = x; } return { e, res }; };
  assert.strictEqual(gate(emp).res.statusCode, 403); assert.ok(gate(emp).e); ok('Employee blocked from the HR listing route');
  assert.ifError(gate(hr).e); assert.ifError(gate(sa).e); ok('HR and Super Admin pass the listing gate');
  // route wiring: the list route carries authorize('hr'), employee routes do not.
  const router = require('../../../routes/disclosureRoutes');
  const listRoute = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  assert.ok(listRoute && listRoute.route.stack.length === 2, 'GET / has authorize + handler');
  ok('GET /api/disclosures is wired behind authorize');

  /* ---------------- Filtering ---------------- */
  _stub.reset();
  const e1 = await mkUser('employee', 'Rahul'); const e2 = await mkUser('employee', 'Priya');
  const D = (s) => new Date(`${s}T00:00:00Z`);
  const mk = (e, day, body) => Disclosure.create({ _id: _oid(), employee: e._id, date: D(day), submission: _oid(), ...body });
  await mk(e1, '2026-10-05', { type: 'mistake', details: 'a', correctable: true, corrected: false });
  await mk(e1, '2026-10-06', { type: 'other', details: 'b' });
  await mk(e2, '2026-10-05', { type: 'exception', details: 'c', authorizedBy: 'X' });
  await mk(e2, '2026-10-06', { type: 'mistake', details: 'd', correctable: false });
  const q = async (query) => { const x = await listAs(hr, query); assert.ifError(x.err); return x.res.body; };
  assert.strictEqual((await q({})).total, 4); ok('List: no filters returns all, newest first');
  assert.strictEqual((await q({ date: '2026-10-05' })).total, 2); ok('Filter: date');
  assert.strictEqual((await q({ employee: String(e1._id) })).total, 2); ok('Filter: employee');
  assert.strictEqual((await q({ type: 'mistake' })).total, 2); ok('Filter: type');
  assert.strictEqual((await q({ type: 'all' })).total, 4); ok('Filter: type=all');
  const combo = await q({ date: '2026-10-05', employee: String(e1._id), type: 'mistake' });
  assert.strictEqual(combo.total, 1); assert.strictEqual(combo.items[0].details, 'a'); ok('Filter: date + employee + type combined');
  assert.strictEqual((await q({ date: '2026-10-05', employee: String(e1._id), type: 'exception' })).total, 0); ok('Combined filter with no match -> empty');
  assert.strictEqual((await q({ from: '2026-10-06', to: '2026-10-06' })).total, 2); ok('Filter: from/to range');
  const pg = await q({ limit: 3 }); assert.strictEqual(pg.items.length, 3); assert.strictEqual(pg.pages, 2); ok('Pagination');
  rejected(await listAs(hr, { type: 'bogus' }), 400); rejected(await listAs(hr, { employee: 'nope' }), 400); ok('Invalid filters rejected');
  assert.ifError((await listAs(sa, {})).err); ok('Super Admin can list');

  /* ---------------- No side effects ---------------- */
  assert.strictEqual(_stub.rows(Penalty).length, 0);
  assert.strictEqual(_stub.rows(Attendance).length, 0);
  assert.strictEqual(_stub.rows(ComplianceIncident).length, 0);
  assert.strictEqual(_stub.rows(FinancialLedger).length, 0);
  ok('Disclosure creates no penalty / attendance / compliance / financial records');

  console.log(`\n${n} disclosure checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
