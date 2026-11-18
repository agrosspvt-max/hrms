// Plain-Node checks for realtimePolicy.js (no test runner needed):
//   cd frontend && node src/realtimePolicy.test.js
import assert from 'node:assert/strict';
import {
  BASE_DELAY_MS, MAX_DELAY_MS, JITTER_RATIO,
  backoffDelay, shouldCheckSession, resolveStreamBase,
} from './realtimePolicy.js';

let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };
const mid = () => 0.5;                       // jitter factor exactly 1.0

// 1. Nominal schedule (no jitter): 3, 6, 12, 24, 48, 96, 192, 300, 300 ... seconds
const nominal = [1, 2, 3, 4, 5, 6, 7, 8, 9, 50, 1000].map((f) => backoffDelay(f, mid));
assert.deepEqual(nominal, [3000, 6000, 12000, 24000, 48000, 96000, 192000, 300000, 300000, 300000, 300000]);
ok(`schedule 3s,6s,12s,24s,48s,96s,192s then capped at 300s: ${nominal.map((x) => x / 1000).join(',')}`);

// 2. Jitter bounds, and the 5-minute ceiling holds even with maximal positive jitter
for (let f = 1; f <= 40; f++) {
  for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
    const d = backoffDelay(f, () => r);
    const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (f - 1));
    assert.ok(d <= MAX_DELAY_MS, `never above 5 min (f=${f}, r=${r}, d=${d})`);
    assert.ok(d >= Math.round(base * (1 - JITTER_RATIO)) - 1 && d <= Math.min(MAX_DELAY_MS, Math.round(base * (1 + JITTER_RATIO)) + 1));
  }
}
const spread = new Set(Array.from({ length: 50 }, () => backoffDelay(3)));
assert.ok(spread.size > 10, 'real jitter varies');
ok('jitter within +/-20%, never above 300000 ms; Math.random jitter actually varies');

// 3. Bad inputs are safe
assert.equal(backoffDelay(0, mid), 3000);
assert.equal(backoffDelay(-5, mid), 3000);
assert.equal(backoffDelay(undefined, mid), 3000);
assert.equal(backoffDelay(Infinity, mid), 300000);
ok('zero/negative/undefined counts use the first delay; an absurdly large count stays at the 5-minute cap');

// 4. Session check cadence: logarithmic, never every retry
const checks = Array.from({ length: 64 }, (_, i) => i + 1).filter(shouldCheckSession);
assert.deepEqual(checks, [1, 2, 4, 8, 16, 32, 64]);
assert.equal(shouldCheckSession(0), false);
ok(`session checked on failures ${checks.join(',')} only (7 of 64)`);

// 5. URL resolution + production guard
assert.equal(resolveStreamBase({ configured: 'https://hrms-jvxy.onrender.com/api', isProd: true }), 'https://hrms-jvxy.onrender.com/api');
assert.equal(resolveStreamBase({ configured: 'https://hrms-jvxy.onrender.com/api/', isProd: true }), 'https://hrms-jvxy.onrender.com/api');
assert.equal(resolveStreamBase({ configured: undefined, isProd: true }), null);
assert.equal(resolveStreamBase({ configured: '', isProd: true }), null);
assert.equal(resolveStreamBase({ configured: '   ', isProd: true }), null);
assert.equal(resolveStreamBase({ configured: undefined, isProd: false }), '/api');
ok('Render URL kept (trailing slash trimmed); production without VITE_API_URL -> null (no connection); dev -> /api');

console.log(`\n  ${n} realtime policy checks passed`);
