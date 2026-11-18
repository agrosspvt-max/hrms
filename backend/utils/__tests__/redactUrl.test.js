/**
 * redactUrl.test.js -- credential redaction for request logs.
 *
 *   cd backend && node utils/__tests__/redactUrl.test.js
 */
const assert = require('assert');
const http = require('http');
const { PassThrough } = require('stream');
const express = require('express');
const morgan = require('morgan');
const { redactUrl } = require('../redactUrl');

let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InRlc3QtdXNlciJ9.c2lnbmF0dXJlLXRlc3QtdmFsdWU';

(async () => {
  assert.strictEqual(redactUrl(`/api/realtime/stream?token=${JWT}`), '/api/realtime/stream?token=[REDACTED]');
  ok('single token parameter redacted');

  assert.strictEqual(
    redactUrl(`/api/salary/export.csv?periodStart=2026-10-01&token=${JWT}&periodEnd=2026-10-31`),
    '/api/salary/export.csv?periodStart=2026-10-01&token=[REDACTED]&periodEnd=2026-10-31');
  ok('token among other parameters: others and their order preserved');

  assert.strictEqual(
    redactUrl(`/x?access_token=a1&refresh_token=r1&token=t1&token=t2&q=keep`),
    '/x?access_token=[REDACTED]&refresh_token=[REDACTED]&token=[REDACTED]&token=[REDACTED]&q=keep');
  ok('access_token, refresh_token and repeated token all redacted');

  assert.strictEqual(redactUrl(`/x?TOKEN=${JWT}&Access_Token=z`), '/x?TOKEN=[REDACTED]&Access_Token=[REDACTED]');
  assert.strictEqual(redactUrl(`/x?%74oken=${JWT}`), '/x?%74oken=[REDACTED]');
  assert.strictEqual(redactUrl(`/x?token`), '/x?token=[REDACTED]');
  assert.strictEqual(redactUrl(`/x?a=1;token=${JWT}`), '/x?a=1;token=[REDACTED]');
  ok('case-insensitive, URL-encoded names, value-less and ;-separated params handled');

  assert.strictEqual(redactUrl('/api/leaves?status=pending&page=2'), '/api/leaves?status=pending&page=2');
  assert.strictEqual(redactUrl('/api/health'), '/api/health');
  assert.strictEqual(redactUrl('/x?mytoken=1&token_type=bearer'), '/x?mytoken=1&token_type=bearer');
  assert.strictEqual(redactUrl(`/x?token=${JWT}#frag`), '/x?token=[REDACTED]#frag');
  assert.strictEqual(redactUrl(''), '');
  assert.strictEqual(redactUrl(undefined), undefined);
  assert.strictEqual(redactUrl(`/x?%E0%A4%A=1&token=${JWT}`), '/x?%E0%A4%A=1&token=[REDACTED]');
  ok('URLs without credentials unchanged; similar names untouched; fragments, empties and malformed encodings safe');

  // The logging middleware itself: morgan('dev') must print the redacted URL.
  const out = new PassThrough(); let logged = '';
  out.on('data', (c) => { logged += c.toString(); });
  morgan.token('url', (req) => redactUrl(req.originalUrl || req.url));   // same wiring as server.js
  const app = express();
  app.use(morgan('dev', { stream: out }));
  app.get('/api/realtime/stream', (_req, res) => res.status(401).json({ message: 'no' }));
  app.get('/api/salary/:id/pdf', (_req, res) => res.send('pdf'));
  const srv = app.listen(0);
  const port = srv.address().port;
  const get = (p) => new Promise((resolve) => http.get({ port, path: p, headers: { Authorization: `Bearer ${JWT}` } }, (r) => { r.resume(); r.on('end', resolve); }));
  await get(`/api/realtime/stream?token=${JWT}`);
  await get(`/api/salary/abc/pdf?token=${JWT}&download=1`);
  srv.close();
  await new Promise((r) => setTimeout(r, 50));
  const plain = logged.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(!plain.includes(JWT) && !plain.includes(JWT.split('.')[1]), 'no JWT (or its payload) in morgan output');
  assert.ok(plain.includes('GET /api/realtime/stream?token=[REDACTED] 401'), plain);
  assert.ok(plain.includes('GET /api/salary/abc/pdf?token=[REDACTED]&download=1 200'), plain);
  assert.ok(!/authorization|bearer/i.test(plain), 'headers not logged');
  ok(`morgan('dev') prints method, redacted URL, status and timing; no JWT, no headers:\n${plain.trim().split('\n').map((l) => `        ${l}`).join('\n')}`);

  console.log(`\n  ${n} redactUrl checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
