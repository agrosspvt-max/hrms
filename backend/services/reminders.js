/**
 * reminders.js -- upsert-by-hash helpers for the Reminder collection.
 *
 * Callers should NEVER `Reminder.create(...)` directly.  Going
 * through `createOrUpdate` guarantees the deterministic natural key
 * is applied uniformly and dedupe works across restarts, cron
 * double-ticks, and concurrent writers.
 */
const crypto = require('crypto');
const Reminder = require('../models/Reminder');

/** Small helper for a stable hash key. */
const _sha = (parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 32);

/** Bucket the due date at hour granularity so re-runs of the same
 *  hour collapse; day-cadence reminders bucket at day granularity. */
const _dueBucket = (dueAt, granularity = 'hour') => {
  const d = new Date(dueAt);
  if (granularity === 'day') return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
};

/**
 * Deterministic hash for a reminder.  A restart / concurrent
 * scheduler / duplicate publisher will always land on the same hash
 * and therefore the same DB row.
 */
const hashFor = ({ recipient, actionKind, entityType, entityId, dueAt, granularity }) =>
  _sha([
    String(recipient || ''),
    actionKind || '',
    entityType || '',
    String(entityId || ''),
    _dueBucket(dueAt, granularity),
  ]);

/**
 * Upsert a reminder.  Returns `{ doc, created }` so callers can
 * emit realtime frames only on first insert.  If a row with the
 * same hash already exists AND is still active, its non-key fields
 * are updated (title/message/cadence/priority etc.) but timestamps
 * are preserved.  If it's completed/dismissed, a fresh active row
 * is inserted with the same hash (the partial unique index only
 * covers ACTIVE rows).
 */
const createOrUpdate = async (input) => {
  const {
    recipient, subject, actionKind, entityType, entityId,
    title, message, dueAt, cadence = {}, priority = 'normal',
    targetRoute = '', meta = {}, createdBy = null,
    granularity = 'hour',
  } = input || {};
  if (!recipient || !actionKind || !dueAt) {
    return { doc: null, created: false, error: 'recipient, actionKind, dueAt required' };
  }
  const hash = hashFor({ recipient, actionKind, entityType, entityId, dueAt, granularity });
  try {
    const res = await Reminder.findOneAndUpdate(
      { hash, completedAt: null, dismissedAt: null },
      {
        $setOnInsert: {
          recipient, subject: subject || recipient,
          actionKind, entityType, entityId,
          hash, createdBy,
          createdAt: new Date(),
        },
        $set: {
          title:       title || '',
          message:     message || '',
          dueAt,
          priority,
          targetRoute: targetRoute || '',
          meta:        meta || {},
          cadence: {
            every: cadence.every || '',
            until: cadence.until || null,
            maxRepeats: Number(cadence.maxRepeats) || 0,
          },
        },
      },
      { upsert: true, new: true, rawResult: true, setDefaultsOnInsert: true },
    );
    const created = !!(res?.lastErrorObject && res.lastErrorObject.updatedExisting === false);
    return { doc: res?.value || null, created };
  } catch (err) {
    if (err && err.code === 11000) {
      const doc = await Reminder.findOne({ hash, completedAt: null, dismissedAt: null }).lean();
      return { doc, created: false };
    }
    console.error('[reminders] createOrUpdate failed:', err.message);
    return { doc: null, created: false, error: err.message };
  }
};

/**
 * Mark a reminder as completed (`done`), dismissed, or snoozed.
 * Never deletes -- the row stays for the timeline / audit trail.
 */
const applyAction = async ({ id, action, userId }) => {
  const patch = {};
  if (action === 'done')     patch.completedAt = new Date();
  if (action === 'dismiss')  patch.dismissedAt = new Date();
  if (action === 'snooze')   patch.snoozedUntil = new Date(Date.now() + 30 * 60 * 1000); // default 30 min
  const doc = await Reminder.findOneAndUpdate(
    { _id: id, recipient: userId },
    { $set: patch },
    { new: true },
  );
  return doc;
};

/**
 * Resolve every active reminder for a given (recipient, actionKind,
 * entityId).  Used by subscribers when the underlying business
 * state changes: e.g. submission.submitted resolves the
 * submit_today reminder.
 */
const resolveByEntity = async ({ recipient, actionKind, entityType, entityId }) => {
  const filter = { recipient, actionKind, completedAt: null, dismissedAt: null };
  if (entityType) filter.entityType = entityType;
  if (entityId)   filter.entityId   = entityId;
  const now = new Date();
  const r = await Reminder.updateMany(filter, { $set: { completedAt: now } });
  return { matched: r.matchedCount || 0, modified: r.modifiedCount || 0 };
};

module.exports = { hashFor, createOrUpdate, applyAction, resolveByEntity };
