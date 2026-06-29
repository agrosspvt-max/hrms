/**
 * realtimeRoutes — single SSE stream endpoint.
 *
 *   GET /api/realtime/stream?token=<JWT>
 *
 * Opens an EventSource-compatible stream.  The frontend connects once
 * per session via src/realtime.js and re-dispatches incoming events as
 * window CustomEvents ('hrms:rt:<event>') so individual pages can
 * subscribe with a one-line useEffect.
 */
const router = require('express').Router();
const { protect } = require('../middleware/auth');
const rt = require('../services/realtime');

router.get('/stream', protect, (req, res) => {
  // SSE handshake.  Disable nagle/buffering so events land instantly
  // even behind a reverse proxy.  No-transform stops the proxy from
  // gzip-buffering the response and stalling the stream.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Push a hello so the client knows it's connected (the readyState
  // change alone is enough, but a typed event is easier to debug).
  res.write(`event: ready\ndata: {"ok":true}\n\n`);

  const cleanup = rt.addClient(req.user._id, res);

  // Heartbeat every 25s.  Two purposes:
  //   1. Keeps idle proxies from killing the connection.
  //   2. Lets the server detect a dead client when write() throws and
  //      lets the cleanup handler fire.
  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); }
    catch (_) { /* will be torn down by close handler */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    cleanup();
  });
});

// Diagnostic — used by ops / smoke tests to confirm the registry is alive.
router.get('/stats', protect, (_req, res) => res.json(rt.stats()));

module.exports = router;
