/**
 * realtimePolicy.js -- pure rules for the SSE client (src/realtime.js).
 *
 * No imports, no browser globals: unit-testable in plain Node.
 */

export const BASE_DELAY_MS = 3000;        // first retry
export const MAX_DELAY_MS = 5 * 60 * 1000; // hard ceiling (5 minutes)
export const JITTER_RATIO = 0.2;          // +/-20% so tabs don't retry in lock-step

/**
 * Delay before reconnect attempt `failures` (1-based count of consecutive
 * failures since the last successful `ready` event):
 *   1 -> 3s, 2 -> 6s, 3 -> 12s, 4 -> 24s, 5 -> 48s, 6 -> 96s, 7 -> 192s, 8+ -> 300s
 * then +/-20% jitter, clamped so it NEVER exceeds MAX_DELAY_MS.
 * `random` is injectable for tests (defaults to Math.random).
 */
export const backoffDelay = (failures, random = Math.random) => {
  const n = Math.max(1, Math.floor(Number(failures) || 1));
  const nominal = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(n - 1, 30));
  const jitter = 1 + (random() * 2 - 1) * JITTER_RATIO;
  return Math.round(Math.min(MAX_DELAY_MS, Math.max(1000, nominal * jitter)));
};

/**
 * Whether failure number `failures` should trigger one session check
 * (GET /auth/me).  EventSource never exposes the HTTP status, so this is
 * how an expired / invalid token is told apart from an outage.  Checking
 * on failures 1, 2, 4, 8, 16, ... keeps it logarithmic: never on every
 * retry, yet a token that expires during a long outage is still noticed.
 */
export const shouldCheckSession = (failures) => {
  const n = Math.floor(Number(failures) || 0);
  return n >= 1 && (n & (n - 1)) === 0;
};

/**
 * Base URL of the API for the stream, or null when a connection must NOT
 * be opened.  In a production build the API lives on another host
 * (Render); falling back to the relative '/api' would hit the frontend
 * host (Vercel), whose SPA rewrite answers with index.html -- the request
 * explosion this module used to cause.  In development '/api' is correct
 * (Vite proxies it to the local backend).
 */
export const resolveStreamBase = ({ configured, isProd }) => {
  const url = typeof configured === 'string' ? configured.trim() : '';
  if (url) return url.replace(/\/+$/, '');
  return isProd ? null : '/api';
};
