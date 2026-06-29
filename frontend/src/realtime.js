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
 * Reconnect: EventSource handles transient drops automatically.  On a
 * hard error (token rotated, server restart) we re-open with backoff
 * after a short delay so the UI keeps catching up.
 */

const BACKOFF_MS = 3000;

let es = null;
let reconnectTimer = null;
let stopped = false;

// Resolve the SSE URL.  When VITE_API_URL is set we honour it (lets
// dev hit a deployed backend); otherwise we fall back to a relative
// /api path so Vite's dev proxy handles it identically to axios calls.
const _streamUrl = (token) => {
  const base = (import.meta?.env?.VITE_API_URL || '/api').replace(/\/$/, '');
  return `${base}/realtime/stream?token=${encodeURIComponent(token)}`;
};

const _dispatch = (eventName, detail) => {
  try {
    window.dispatchEvent(new CustomEvent(`hrms:rt:${eventName}`, { detail }));
  } catch (_) { /* IE11 not supported anyway */ }
};

const _wire = (source) => {
  // Each typed event from the server arrives as a named EventSource
  // event.  We forward the full payload as a window CustomEvent so any
  // component anywhere can subscribe with one useEffect.
  const TYPED = [
    'ready',
    'notification:new', 'notification:read', 'notification:resolved',
    'leave:applied', 'leave:decision',
    'assignment:created',
    'salary:slip:generated',
    'submission:submitted',
    'attendance:changed',
  ];
  for (const name of TYPED) {
    source.addEventListener(name, (ev) => {
      let detail = {};
      try { detail = ev.data ? JSON.parse(ev.data) : {}; } catch (_) {}
      _dispatch(name, detail);
    });
  }
};

const _scheduleReconnect = () => {
  if (reconnectTimer || stopped) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (stopped) return;
    const token = localStorage.getItem('hrms_token');
    if (token) connectRealtime(token);
  }, BACKOFF_MS);
};

/**
 * Open (or replace) the SSE connection.  Safe to call multiple times —
 * the previous connection is closed first.  No-op when no token.
 */
export const connectRealtime = (token) => {
  stopped = false;
  if (es) { try { es.close(); } catch (_) {} es = null; }
  if (!token) return;

  try {
    es = new EventSource(_streamUrl(token));
  } catch (e) {
    console.warn('[rt] EventSource failed to construct:', e?.message);
    _scheduleReconnect();
    return;
  }

  es.onerror = () => {
    // Browser auto-retries on transient drops; we add our own backoff
    // for the hard-error case (e.g. server restarted).  If readyState
    // is CLOSED we know the browser gave up and we need to re-open.
    if (es && es.readyState === 2 /* CLOSED */) {
      try { es.close(); } catch (_) {}
      es = null;
      _scheduleReconnect();
    }
  };

  _wire(es);
};

export const disconnectRealtime = () => {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (es) { try { es.close(); } catch (_) {} es = null; }
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
