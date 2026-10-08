/**
 * phase3cSafety.test.js -- Phase 3C: a non-production process must not be
 * able to run against a shared remote database by accident.
 *
 *   cd backend && node services/compliance/__tests__/phase3cSafety.test.js
 */
process.env.NODE_ENV = 'test';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const rs = require('../../../config/runtimeSafety');

// Built from pieces so secret scanners do not mistake this fake fixture for a real connection string.
const ATLAS = ['mongodb+srv://', 'someuser', ':', 'S3cretPw', '@cluster0.example.mongodb.net/hrms?retryWrites=true'].join('');
const REMOTE = ['mongodb://', 'u:p', '@db1.example.com:27017,db2.example.com:27017/hrms'].join('');
const LOCAL = 'mongodb://127.0.0.1:27017/hrms';
let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };
const quiet = { warn: () => {} };

/* classification */
assert.deepStrictEqual(rs.hostsOf(ATLAS), { srv: true, hosts: ['cluster0.example.mongodb.net'] });
assert.deepStrictEqual(rs.hostsOf(REMOTE).hosts, ['db1.example.com', 'db2.example.com']);
assert.deepStrictEqual(rs.hostsOf('mongodb://u:p@w@rd@localhost:27017/x').hosts, ['localhost'], 'password containing @');
assert.ok(rs.isLocalUri(LOCAL) && rs.isLocalUri('mongodb://localhost/x') && rs.isLocalUri('mongodb://[::1]:27017/x'));
assert.ok(!rs.isLocalUri(ATLAS) && !rs.isLocalUri(REMOTE) && !rs.isLocalUri('mongodb://localhost,db.example.com/x'));
assert.ok(!rs.isLocalUri('mongodb+srv://localhost/x'), '+srv is never treated as local');
assert.ok(!rs.isLocalUri('mongodb://127.0.0.1.evil.com/x'), 'lookalike host');
assert.ok(!rs.isLocalUri(''));
ok('URI host parsing: Atlas/remote/local/IPv6, password containing "@", lookalike host, +srv');

/* policy matrix */
const ev = (uri, env) => rs.evaluate(uri, env);
assert.strictEqual(ev(LOCAL, { NODE_ENV: 'development' }).mode, 'local');
assert.strictEqual(ev(LOCAL, { NODE_ENV: 'test' }).mode, 'local');
assert.strictEqual(ev(LOCAL, {}).jobs, true);
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'production' }).mode, 'production');
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'production' }).jobs, true, 'production unchanged');
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'development' }).allowed, false);
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'DEVELOPMENT ' }).allowed, false, 'case/space insensitive');
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'test' }).allowed, false);
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'test', ALLOW_SHARED_DB_DEV: 'true' }).allowed, false, 'no override for tests');
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'development', ALLOW_SHARED_DB_DEV: '1' }).allowed, false, 'only the exact value "true"');
const sd = ev(ATLAS, { NODE_ENV: 'development', ALLOW_SHARED_DB_DEV: 'true' });
assert.deepStrictEqual([sd.mode, sd.allowed, sd.jobs], ['shared-dev', true, false], 'override allows connect but NOT background jobs');
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'development', ALLOW_SHARED_DB_DEV: 'true', ALLOW_SHARED_DB_DEV_JOBS: 'true' }).jobs, true);
assert.strictEqual(ev(ATLAS, { ALLOW_SHARED_DB_DEV_JOBS: 'true' }).mode, 'unclassified', 'unset NODE_ENV keeps starting (cannot break an unknown host)');
assert.strictEqual(ev(ATLAS, {}).allowed, true);
assert.strictEqual(ev('', { NODE_ENV: 'production' }).allowed, false, 'missing URI');
ok('policy matrix: local always; production unchanged; dev+remote refused; test+remote refused with no override; override needs exact "true" and keeps jobs off');

/* a deployed host with a wrong NODE_ENV is warned, never locked out; a laptop is */
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'development', RENDER: 'true' }).mode, 'hosted');
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'development', RENDER: 'true' }).allowed, true);
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'development', DYNO: 'web.1' }).jobs, true);
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'test', RENDER: 'true' }).allowed, false, 'tests are never exempt');
assert.strictEqual(ev(ATLAS, { NODE_ENV: 'development' }).allowed, false, 'no marker => laptop => refused');
ok('hosting-platform markers keep a misconfigured deployed server starting (warning only); tests and laptops are still refused');

/* errors never leak the URI */
for (const [uri, env] of [[ATLAS, { NODE_ENV: 'development' }], [ATLAS, { NODE_ENV: 'test' }], [REMOTE, { NODE_ENV: 'development' }]]) {
  assert.throws(() => rs.assertDatabaseTarget(uri, env, quiet), (e) => e instanceof rs.UnsafeDatabaseTargetError
    && !/S3cretPw|someuser|cluster0|example\.com/i.test(e.message));
}
assert.throws(() => rs.assertLocalOnly(ATLAS, 'seed.js'), (e) => !/S3cretPw|cluster0/i.test(e.message) && /seed\.js/.test(e.message));
assert.ok(rs.assertLocalOnly(LOCAL, 'seed.js'));
ok('refusal messages contain no URI, host or credential');

/* shared-dev warns loudly */
const logs = []; rs.assertDatabaseTarget(ATLAS, { NODE_ENV: 'development', ALLOW_SHARED_DB_DEV: 'true' }, { warn: (m) => logs.push(m) });
assert.ok(logs.length === 1 && /SHARED DATABASE/.test(logs[0]) && /DISABLED/.test(logs[0]) && !/cluster0|S3cret/.test(logs[0]));
ok('override is logged loudly (jobs disabled message), without the URI');

/* connectDB: refused target never reaches mongoose.connect */
(async () => {
  const mongoose = require('mongoose');
  const connectDB = require('../../../config/db');
  let connected = 0, exited = null;
  const realConnect = mongoose.connect, realExit = process.exit, realErr = console.error;
  mongoose.connect = async () => { connected += 1; return { connection: { host: 'x' } }; };
  process.exit = (c) => { exited = c; };
  console.error = () => {};
  try {
    const save = { ...process.env };
    process.env.NODE_ENV = 'development'; process.env.MONGO_URI = ATLAS; delete process.env.ALLOW_SHARED_DB_DEV;
    await connectDB();
    assert.strictEqual(connected, 0, 'no connection attempted'); assert.strictEqual(exited, 1);
    exited = null; process.env.ALLOW_SHARED_DB_DEV = 'true'; await connectDB();
    assert.strictEqual(connected, 1); assert.strictEqual(exited, null);
    connected = 0; process.env.NODE_ENV = 'production'; delete process.env.ALLOW_SHARED_DB_DEV; await connectDB();
    assert.strictEqual(connected, 1, 'production connects normally');
    connected = 0; process.env.NODE_ENV = 'test'; process.env.ALLOW_SHARED_DB_DEV = 'true'; exited = null; await connectDB();
    assert.strictEqual(connected, 0); assert.strictEqual(exited, 1);
    process.env.NODE_ENV = save.NODE_ENV; delete process.env.MONGO_URI; delete process.env.ALLOW_SHARED_DB_DEV;
  } finally { mongoose.connect = realConnect; process.exit = realExit; console.error = realErr; }
  ok('connectDB: dev+Atlas -> no connect + exit(1); override connects; production connects; test+Atlas refused even with override');

  /* seed.js and server.js are wired to the guard */
  const root = path.join(__dirname, '../../..');
  const seed = fs.readFileSync(path.join(root, 'seed.js'), 'utf8');
  assert.ok(/assertLocalOnly\(process\.env\.MONGO_URI, 'seed\.js'\)/.test(seed) && seed.indexOf('assertLocalOnly') < seed.indexOf('connectDB()'));
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const startIdx = server.indexOf('const start = async');
  assert.ok(server.indexOf('backgroundJobsAllowed()', startIdx) > startIdx
    && server.indexOf('backgroundJobsAllowed()', startIdx) < server.indexOf('syncSalaryIndexes()', startIdx)
    && server.indexOf('backgroundJobsAllowed()', startIdx) < server.indexOf('startCompliance()', startIdx), 'gate precedes migrations and schedulers');
  ok('seed.js asserts a local DB before connecting; server.js gates migrations/schedulers before the first one runs');

  /* no test or helper reads the company URI */
  const dir = __dirname; const offenders = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'phase3cSafety.test.js')) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/process\.env\.MONGO_URI|require\(['"]dotenv|config\/db['"]|connectDB/.test(src)) offenders.push(f);
    if (/mongoose\.connect\(/.test(src) && !/assertLocalOnly|getUri\(\)/.test(src) && f !== '_stubMongo.js') offenders.push(f);
  }
  assert.deepStrictEqual(offenders, [], `tests that could reach a shared DB: ${offenders}`);
  ok('no test file reads MONGO_URI / dotenv / connectDB; every mongoose.connect uses a disposable server and asserts local');

  console.log(`\n  ${n} Phase 3C safety checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
