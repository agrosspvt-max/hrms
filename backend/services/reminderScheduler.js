/**
 * reminderScheduler.js -- fires alert:changed for every reminder
 * that just became due.  Never writes a Notification.  Never
 * creates a new reminder (that's the projector's job).
 *
 * Runs every 15 minutes.  Uses `lastFiredAt` to guard against
 * duplicate fires across restarts within the same tick.
 */
const Reminder = require('../models/Reminder');
const rt = require('./realtime');

const TICK_MS = 15 * 60 * 1000;
const WINDOW_MS = 20 * 60 * 1000;  // fire anything due in the past 20 min
let _timer = null;

const tick = async () => {
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  try {
    const rows = await Reminder.find({
      dueAt: { $gte: cutoff, $lte: now },
      completedAt: null,
      dismissedAt: null,
      $or: [{ lastFiredAt: { $exists: false } }, { lastFiredAt: null }, { lastFiredAt: { $lt: cutoff } }],
    }).select('_id recipient dueAt actionKind').limit(500).lean();

    let fired = 0;
    for (const r of rows) {
      try {
        rt.publish(r.recipient, 'reminder:changed', { reminderId: r._id, actionKind: r.actionKind });
        await Reminder.updateOne({ _id: r._id }, { $set: { lastFiredAt: now } });
        fired += 1;
      } catch (e) { /* per-row failure never breaks the sweep */ }
    }
    if (fired > 0) console.log(`[reminder-scheduler] fired ${fired} due reminder(s) at ${now.toISOString()}`);
    return { fired, considered: rows.length };
  } catch (err) {
    console.error('[reminder-scheduler] tick failed:', err.message);
    return { error: err.message };
  }
};

const start = () => {
  if (_timer) return;
  // Boot catch-up (non-blocking) + interval.
  setImmediate(() => tick().catch(() => {}));
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  console.log(`[reminder-scheduler] started (every ${TICK_MS / 60000} min)`);
};
const stop = () => { if (_timer) clearInterval(_timer); _timer = null; };

module.exports = { start, stop, tick };
