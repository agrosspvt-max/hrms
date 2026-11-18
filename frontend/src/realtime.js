/**
 * realtime.js — single EventSource connection for the whole app.
 *
 * Why a singleton (not a hook per page)?
 *   Each browser tab keeps ONE long-lived SSE connection.  Mounting
 *   one EventSource per page would multiply server connections and
 *   produce duplicate event handling.  This module owns the connection;
 *   pages simply listen for `window`-level CustomEvents the singleton
 *   re-dispatches.
 *
 * Event surface (window CustomEvents):
 *   hrms:rt:notification:new     – new notification arrived
 *   hrms:rt:notification:read    – a recipient read one of MY sends
 *   hrms:rt:notification:resolved– a recipient resolved an urgent notice
 *   hrms:rt:leave:applied        – new leave request landed (HR/SA)
 *   hrms:rt:leave:decision       – my leave was decided (employee)
 *   hrms:rt:assignment:created   – I was assigned new work
 *   hrms:rt:salary:slip:generated– my slip is ready (also fires for HR)
 *   hrms:rt:submission:submitted – an employee submitted (reviewers)
 *   hrms:rt:attendance:changed   – my attendance was edited
 *
 * Endpoint: GET <VITE_API_URL>/realtime/stream?token=<JWT>
 *   (EventSource cannot send headers, so the backend's `protect`
 *   middleware accepts the JWT from the query string.)
 *
 * Reconnection (owned entirely by this module):
 *   - On ANY error the failed EventSource is closed immediately, so the
 *     browser's native auto-reconnect never runs alongside ours.
 *   - Retries use exponential backoff with jitter (3s, 6s, 12s, 24s,
 *     48s, ... capped at 5 minutes; see realtimePolicy.js).  The counter
 *     resets when the server's `ready` event arrives -- unless that stream
 *     then dies within STABLE_MS, so accept-then-drop still backs off.
 *   - EventSource never exposes the HTTP status, so on failures 1, 2, 4,
 *     8, ... one GET /auth/me is made through the shared axios client.
 *     A 401 there runs the app's existing session handling (axios
 *     interceptor: clear storage + go to /login) and stops the stream for
 *     good; anything else is treated as an outage and backoff continues.
 *   - While the tab is hidden no retry is scheduled; a healthy open
 *     connection is left alone.  When the tab becomes visible again a
 *     missing connection is re-opened (at most once per BASE_DELAY_MS).
 *   - Production guard: without VITE_API_URL a production build never
 *     connects (the relative '/api' would hit the frontend host).
 */

import api from './api/axios';
import { BASE_DELAY_MS, backoffDelay, shouldCheckSession, resolveStreamBase } from './realtimePolicy';

// A stream that dies within this long of its `ready` event does not count
// as recovered: the earlier failure count is restored, so a server or proxy
// that accepts and immediately drops connections still backs off instead
// of looping every 3s.  Longer-lived connections reset the counter.
const STABLE_MS = 30000;

let es = null;                 // current EventSource (only one per tab)
let reconnectTimer = null;     // the single pending retry timer
let stopped = true;            // true = no session / logged out: never reconnect
let failures = 0;              // consecutive failures since the last `ready`
let failuresAtReady = 0;       // count before the last `ready` (see STABLE_MS)
let readyAt = 0;               // ms timestamp of the last `ready` on the open stream
let lastAttemptAt = 0;         // ms timestamp of the last open()
let resumeWhenVisible = false; // a retry was skipped because the tab was hidden
let visibilityBound = false;
let guardWarned = false;

const _streamUrl = (token) => {
  const base = resolveStreamBase({
    configured: import.meta.env.VITE_API_URL,
    isProd: import.meta.env.PROD,
  });
  if (!base) return null;
  return `${base}/realtime/stream?token=${encodeURIComponent(token)}`;
};

const _isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

const _dispatch = (eventName, detail) => {
  try {
    window.dispatchEvent(new CustomEvent(`hrms:rt:${eventName}`, { detail }));
  } catch (_) { /* IE11 not supported anyway */ }
};

// Each typed event from the server arrives as a named EventSource
// event.  We forward the full payload as a window CustomEvent so any
// component anywhere can subscribe with one useEffect.
const TYPED = [
  'ready',
  'notification:new', 'notification:read', 'notification:resolved',
  // Phase 48 -- broadcast that fires for every active HR / Super
  // Admin when ANY admin sends a new alert.  Powers live refresh of
  // the shared Sent Alerts history page.
  'notification:sent',
  'leave:applied', 'leave:decision',
  'assignment:created',
  'salary:slip:generated',
  'submission:submitted',
  'attendance:changed',
  // businessStateSync fires this to the affected employee whenever a
  // leave change (approve / revoke / edit) re-materialises or
  // suppresses today's Submission.  Without it in this allowlist the
  // SSE event is silently dropped and the dashboard only updates on a
  // manual refresh.
  'working_day:changed',
];

const _wire = (source) => {
  for (const name of TYPED) {
    source.addEventListener(name, (ev) => {
      if (source !== es) return; // stale instance: ignore
      if (name === 'ready') {
        failuresAtReady = failures;
        failures = 0;
        readyAt = Date.now();
        resumeWhenVisible = false;
      }
      let detail = {};
      try { detail = ev.data ? JSON.parse(ev.data) : {}; } catch (_) {}
      _dispatch(name, detail);
    });
  }
};

const _clearTimer = () => {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
};

const _closeSource = () => {
  if (!es) return;
  const old = es;
  es = null;                 // stale guards in handlers now ignore `old`
  old.onerror = null;
  try { old.close(); } catch (_) {}
};

/** One controlled session check; a 401 ends the stream for good. */
const _checkSession = () => {
  api.get('/auth/me').catch((err) => {
    if (err?.response?.status === 401) {
      // The axios response interceptor has already cleared the session
      // and navigated to /login (existing app behaviour).  Just make sure
      // nothing here retries in the meantime.
      disconnectRealtime();
    }
    // No response / 5xx: an outage, not a bad session -- keep backing off.
  });
};

const _scheduleReconnect = (delayMs) => {
  if (stopped || reconnectTimer) return;
  if (_isHidden()) { resumeWhenVisible = true; return; }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (stopped) return;
    if (_isHidden()) { resumeWhenVisible = true; return; }
    _open();
  }, delayMs);
};

const _onFailure = () => {
  if (readyAt && Date.now() - readyAt < STABLE_MS) failures = Math.max(failures, failuresAtReady);
  readyAt = 0;
  failures += 1;
  if (shouldCheckSession(failures)) _checkSession();
  _scheduleReconnect(backoffDelay(failures));
};

const _open = () => {
  _clearTimer();
  _closeSource();
  if (stopped) return;
  if (_isHidden()) { resumeWhenVisible = true; return; }

  // Always read the CURRENT token: another tab may have logged out or in.
  const token = localStorage.getItem('hrms_token');
  if (!token) { disconnectRealtime(); return; }

  const url = _streamUrl(token);
  if (!url) {
    if (!guardWarned) {
      guardWarned = true;
      console.warn('[rt] Live updates disabled: VITE_API_URL is not set for this production build. '
        + 'Set it to the API base (e.g. https://hrms-jvxy.onrender.com/api) in the frontend build '
        + 'environment and redeploy. Not falling back to the frontend host.');
    }
    return;
  }

  lastAttemptAt = Date.now();
  let source;
  try {
    source = new EventSource(url);
  } catch (e) {
    console.warn('[rt] EventSource failed to construct:', e?.message);
    _onFailure();
    return;
  }
  es = source;
  _wire(source);
  source.onerror = () => {
    if (source !== es) return;
    // Close it ourselves: covers HTTP errors (401/403/5xx, wrong content
    // type), refused connections and dropped streams alike, and stops the
    // browser's own fixed-interval reconnect from running in parallel.
    _closeSource();
    _onFailure();
  };
};

const _onVisibilityChange = () => {
  if (stopped) return;
  if (_isHidden()) {
    // Suspend pending retries; a healthy open connection stays open.
    if (reconnectTimer) { _clearTimer(); resumeWhenVisible = true; }
    return;
  }
  if (es) return;                                 // already open / connecting
  if (!resumeWhenVisible && failures === 0) return;
  resumeWhenVisible = false;
  // Reconnect promptly on return, but never more than once per BASE_DELAY_MS
  // however often the tab is toggled.
  const since = Date.now() - lastAttemptAt;
  if (since >= BASE_DELAY_MS) _open();
  else _scheduleReconnect(BASE_DELAY_MS - since);
};

const _bindVisibility = () => {
  if (visibilityBound || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', _onVisibilityChange);
  visibilityBound = true;
};

const _unbindVisibility = () => {
  if (!visibilityBound) return;
  document.removeEventListener('visibilitychange', _onVisibilityChange);
  visibilityBound = false;
};

/**
 * Open (or replace) the SSE connection.  Safe to call multiple times —
 * the previous connection and any pending retry are dropped first, so a
 * React remount never leaves two connections.  No-op when no token.
 */
export const connectRealtime = (token) => {
  if (!token) return;
  stopped = false;
  failures = 0;
  failuresAtReady = 0;
  readyAt = 0;
  resumeWhenVisible = false;
  _bindVisibility();
  _open();
};

export const disconnectRealtime = () => {
  stopped = true;
  failures = 0;
  failuresAtReady = 0;
  readyAt = 0;
  resumeWhenVisible = false;
  _clearTimer();
  _closeSource();
  _unbindVisibility();
};

/**
 * Convenience subscription helper used by individual pages.
 * Returns a cleanup function for useEffect.
 *
 *   useEffect(() => subscribe('notification:new', load), []);
 */
export const subscribe = (eventName, handler) => {
  const key = `hrms:rt:${eventName}`;
  const wrapped = (ev) => handler(ev.detail);
  window.addEventListener(key, wrapped);
  return () => window.removeEventListener(key, wrapped);
};
