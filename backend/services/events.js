/**
 * events.js — internal event bus.
 *
 * Phase 2 architectural seam.  Every domain module publishes ONE
 * event through this façade; subscribers (NotificationProjector,
 * TimelineProjector, ReminderProjector, RealtimeMirror, future
 * modules) react.  Publishers never call notifiers directly.
 *
 * Design principles:
 *   - Synchronous fan-out relative to the publisher (fine at our
 *     scale; heavy subscribers can move to a queue later without
 *     touching publishers).
 *   - Subscribers are wrapped in try/catch so one broken subscriber
 *     cannot break another (or the request).
 *   - Every event type must be registered in `services/events/registry.js`.
 *     Publishing an unknown type throws in dev, logs a warning in
 *     production so we don't crash live traffic on a typo.
 *   - The bus keeps no state; if we ever want replay we add a
 *     durable log behind `publish()` without changing callers.
 */
const EventEmitter = require('events');
const registry = require('./events/registry');

const IS_DEV = process.env.NODE_ENV !== 'production';

const bus = new EventEmitter();
// The HRMS registers ~10 subscribers per event type at most.  Bump
// the ceiling well above that so Node's leak warning doesn't fire
// when the notification / timeline / realtime projectors all sign
// up for the same event.
bus.setMaxListeners(100);

/**
 * Publish a domain event.  Payload should contain everything a
 * subscriber needs -- the bus doesn't hydrate anything.
 *
 * @param {string} type    -- must be listed in the registry.
 * @param {object} payload -- serialisable event body.
 * @returns {object} the emitted event object (useful for tests).
 */
const publish = (type, payload = {}) => {
  if (!registry.isKnown(type)) {
    const msg = `[events] Unknown event type "${type}" -- register it in services/events/registry.js`;
    if (IS_DEV) throw new Error(msg);
    console.warn(msg);
  }
  const evt = { type, occurredAt: new Date(), ...payload };
  try {
    bus.emit(type, evt);
    bus.emit('*', evt);  // fire-hose channel for global observers (e.g. timeline)
  } catch (err) {
    console.error('[events] fan-out failed:', err && err.message);
  }
  return evt;
};

/**
 * Convenience: publish an array of events one by one.
 */
const publishMany = (events) => (events || []).map((e) => publish(e.type, e.payload || {}));

/**
 * Subscribe to one event type (or '*' for every event).  Handler
 * may be async; the bus awaits it inside a try/catch so a rejected
 * promise or thrown error is logged, not propagated.  Returns an
 * unsubscribe function.
 */
const subscribe = (type, handler) => {
  const wrapped = (evt) => {
    try {
      const result = handler(evt);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => console.error(`[events] subscriber "${type}" rejected:`, err && err.message));
      }
    } catch (err) {
      console.error(`[events] subscriber "${type}" threw:`, err && err.message);
    }
  };
  bus.on(type, wrapped);
  return () => bus.off(type, wrapped);
};

/** Remove every listener for a specific type.  Used only in tests. */
const unsubscribe = (type) => { bus.removeAllListeners(type); };

/** For test / diagnostics only: list registered listener counts. */
const _stats = () => {
  const out = {};
  for (const type of bus.eventNames()) out[type] = bus.listenerCount(type);
  return out;
};

module.exports = { publish, publishMany, subscribe, unsubscribe, _stats };
