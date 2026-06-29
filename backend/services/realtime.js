/**
 * realtime.js — lightweight Server-Sent Events fan-out.
 *
 * Per-user client registry: the SSE route adds the response object on
 * connect, removes it on close.  Controllers call publish() / publishAll()
 * to push JSON events to one or many users.
 *
 * Why SSE instead of WebSockets?
 *   - One-way server → client matches every event in this app.
 *   - Built-in browser auto-reconnect via EventSource.
 *   - No extra dependency, no separate process, no Redis pub/sub.
 *   - Plays nicely behind reverse proxies (HTTP).
 *
 * Auth: the SSE route reuses the existing `protect` middleware, which
 * already accepts `?token=...` query strings (the same trick the file
 * download anchors use).  EventSource cannot send custom headers, so
 * the frontend supplies the JWT in the query string when opening the
 * connection.
 */

// Map<userIdString, Set<res>> — one user can have multiple tabs open.
const clients = new Map();

/** Add a connection.  Returns the cleanup function. */
const addClient = (userId, res) => {
  const key = String(userId);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(res);
  return () => removeClient(userId, res);
};

const removeClient = (userId, res) => {
  const key = String(userId);
  const set = clients.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(key);
};

/**
 * Internal: write one SSE message to a single response.  Swallows
 * EPIPE / write-after-end errors so a flaky client never bubbles up.
 */
const _write = (res, event, data) => {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (_e) { /* connection died; the close handler will clean up */ }
};

/** Publish to one user (every tab they have open). */
const publish = (userId, event, data = {}) => {
  if (!userId) return;
  const set = clients.get(String(userId));
  if (!set || set.size === 0) return;
  for (const res of set) _write(res, event, data);
};

/** Publish to many users (deduplicated). */
const publishMany = (userIds, event, data = {}) => {
  if (!Array.isArray(userIds) || userIds.length === 0) return;
  const seen = new Set();
  for (const u of userIds) {
    const key = String(u);
    if (seen.has(key)) continue;
    seen.add(key);
    publish(key, event, data);
  }
};

/**
 * Publish to every connected client.  Used sparingly — only for
 * org-wide signals (e.g. a global heartbeat).  Per-event payloads go
 * through publish() / publishMany() so users don't see updates that
 * weren't meant for them.
 */
const publishAll = (event, data = {}) => {
  for (const set of clients.values()) {
    for (const res of set) _write(res, event, data);
  }
};

/** Diagnostic: connection count + per-user fan-out (used by /health). */
const stats = () => {
  let total = 0;
  for (const set of clients.values()) total += set.size;
  return { users: clients.size, connections: total };
};

module.exports = { addClient, removeClient, publish, publishMany, publishAll, stats };
