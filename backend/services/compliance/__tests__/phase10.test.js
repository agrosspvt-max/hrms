/**
 * phase10.test.js -- deprecation helper contract tests.
 *
 *   - warn() emits at most one console.warn per code per process.
 *   - warn() is silent when compliance.legacyGone is off.
 *   - stampResponse() sets Deprecation + Link headers.
 *   - The Penalty enum still contains legacy values (so historical
 *     rows keep validating) and the new v2 values are present.
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const featureFlags = require('../../../config/featureFlags');
const deprecations = require('../../deprecations');
const Penalty = require('../../../models/Penalty');

// -----------------------------------------------------------
// Warn -- silent when flag off, emits once when on
// -----------------------------------------------------------
(async () => {
  deprecations._resetForTest();
  featureFlags._resetForTest();
  let calls = 0;
  const orig = console.warn;
  console.warn = () => { calls += 1; };
  try {
    // Flag off -> silent.
    deprecations.warn('test.code', 'silent when off');
    assert.strictEqual(calls, 0, 'flag off -> no warn');

    // Force on to emit exactly once.
    deprecations.warn('test.code', 'first', { forceOn: true });
    deprecations.warn('test.code', 'second', { forceOn: true });
    assert.strictEqual(calls, 1, 'same code emits at most once per process');

    // Different code -> new warn.
    deprecations.warn('other.code', 'other', { forceOn: true });
    assert.strictEqual(calls, 2, 'different code emits its own warn');
  } finally {
    console.warn = orig;
  }
  console.log('  ok  deprecations.warn: silent + one-shot per code');
})()

// -----------------------------------------------------------
// stampResponse writes the Deprecation + Link headers
// -----------------------------------------------------------
.then(() => {
  const headers = {};
  const fakeRes = {
    headersSent: false,
    setHeader(k, v) { headers[k] = v; },
  };
  deprecations.stampResponse(fakeRes, {
    code: 'test.code',
    sunset: 'Fri, 01 Jan 2027 00:00:00 GMT',
    replacement: '/api/compliance/incidents',
  });
  assert.strictEqual(headers.Deprecation, 'test.code');
  assert.strictEqual(headers.Sunset, 'Fri, 01 Jan 2027 00:00:00 GMT');
  assert.match(headers.Link, /rel="successor-version"/);

  // Idempotent on headersSent.
  const sent = { headersSent: true, setHeader() { throw new Error('nope'); } };
  deprecations.stampResponse(sent, { code: 'x' });
  console.log('  ok  deprecations.stampResponse: writes standard headers');
})

// -----------------------------------------------------------
// Penalty enum retains legacy values
// -----------------------------------------------------------
.then(() => {
  const paths = Penalty.schema.paths;
  const enumValues = paths.category.enumValues;
  for (const legacy of ['absent_submission', 'manual_marks', 'manual_completion']) {
    assert.ok(enumValues.includes(legacy),
      `enum still accepts legacy value: ${legacy}`);
  }
  for (const v2 of ['missed_submission', 'marks_adjustment', 'completion_adjustment']) {
    assert.ok(enumValues.includes(v2),
      `enum accepts v2 value: ${v2}`);
  }
  console.log('  ok  Penalty enum retains legacy + v2 values');
})

.then(() => {
  console.log('\nphase10: all unit tests passed');
})
.catch((e) => {
  console.error('phase10 test crashed:', e && e.stack || e);
  process.exit(1);
});
