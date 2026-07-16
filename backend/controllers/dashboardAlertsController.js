/**
 * dashboardAlertsController.js
 *
 * Dashboard = CURRENT STATE.  Every card is a derived count over an
 * existing collection.  Nothing is stored.  This endpoint is pure
 * read.
 *
 * Extensible response shape (Phase 2, Part 8):
 *   {
 *     alerts: [
 *       {
 *         type:       'active_penalty',
 *         label:      'Active Penalties',
 *         count:      2,
 *         priority:   'critical' | 'high' | 'normal' | 'info',
 *         entity:     'penalty',
 *         deepLink:   '/penalties',
 *         icon:       '⚠',
 *         color:      '#ef4444',
 *       },
 *       ...
 *     ],
 *     unreadNotifications: 5,       // top-nav badge (not a card)
 *     todayReminders: [ ... ],      // due today for the caller
 *     generatedAt: '2026-07-16T...'
 *   }
 *
 * Adding a new alert type = add one entry to `_probes` below and the
 * UI picks it up automatically.  No client change required.
 */
const asyncHandler = require('express-async-handler');
const Penalty = require('../models/Penalty');
const Leave = require('../models/Leave');
const Interaction = require('../models/Interaction');
const Notification = require('../models/Notification');
const Submission = require('../models/Submission');
const Reminder = require('../models/Reminder');
const { startOfDay } = require('../utils/dateHelpers');

const _isAdmin = (u) => u && (u.role === 'hr' || u.role === 'super_admin');

/**
 * Each probe is `{ type, run(ctx) -> { count, priority, extra? } }`.
 * Adding a new dashboard card = add one entry here.
 */
const _probes = [
  {
    type:  'active_penalty',
    label: 'Active Penalties',
    entity: 'penalty',
    deepLink: '/penalties',
    icon: '⚠',
    color: '#ef4444',
    run: async ({ uid }) => {
      const n = await Penalty.countDocuments({ employee: uid, status: 'active' });
      return { count: n, priority: n > 0 ? 'critical' : 'info' };
    },
  },
  {
    type:  'pending_leave',
    label: 'Pending Leave',
    entity: 'leave',
    deepLink: '/my-leaves',
    icon: '🌴',
    color: '#0ea5e9',
    run: async ({ uid }) => {
      const n = await Leave.countDocuments({ employee: uid, status: 'pending' });
      return { count: n, priority: n > 0 ? 'normal' : 'info' };
    },
  },
  {
    type:  'upcoming_meetings',
    label: "Today's Meetings",
    entity: 'interaction',
    deepLink: '/my-interactions',
    icon: '📅',
    color: '#6366f1',
    run: async ({ uid, today, dayAfter }) => {
      const n = await Interaction.countDocuments({
        'participants.employee': uid,
        type: 'meeting',
        'meeting.date': { $gte: today, $lt: dayAfter },
        status: { $ne: 'cancelled' },
      });
      return { count: n, priority: n > 0 ? 'high' : 'info' };
    },
  },
  {
    type:  'today_submission_pending',
    label: "Today's Submission",
    entity: 'submission',
    deepLink: '/',
    icon: '📤',
    color: '#f59e0b',
    run: async ({ uid, today, tomorrow }) => {
      const n = await Submission.countDocuments({
        employee: uid,
        date: { $gte: today, $lt: tomorrow },
        submitted: { $ne: true },
      });
      return { count: n, priority: n > 0 ? 'high' : 'info' };
    },
  },
  {
    type:  'pending_leave_approvals',
    label: 'Pending Leave Approvals',
    entity: 'leave',
    deepLink: '/leaves',
    icon: '📝',
    color: '#0891b2',
    hrOnly: true,
    run: async () => {
      const n = await Leave.countDocuments({ status: 'pending' });
      return { count: n, priority: n > 0 ? 'high' : 'info' };
    },
  },
];

const mine = asyncHandler(async (req, res) => {
  const uid = req.user._id;
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = new Date(today.getTime() + 86400000);
  const dayAfter = new Date(tomorrow.getTime() + 86400000);
  const ctx = { uid, today, tomorrow, dayAfter };

  const applicable = _probes.filter((p) => !p.hrOnly || _isAdmin(req.user));

  const [probeResults, unreadNotifications, todayReminders] = await Promise.all([
    Promise.all(applicable.map(async (p) => {
      const r = await p.run(ctx);
      return {
        type:      p.type,
        label:     p.label,
        entity:    p.entity,
        deepLink:  p.deepLink,
        icon:      p.icon,
        color:     p.color,
        count:     r.count,
        priority:  r.priority || 'info',
      };
    })),
    Notification.countDocuments({
      recipient: uid,
      read: { $ne: true },
      archivedAt: { $exists: false },
    }),
    Reminder.find({
      recipient: uid,
      completedAt: null,
      dismissedAt: null,
      dueAt: { $lte: tomorrow },
      $or: [{ snoozedUntil: { $exists: false } }, { snoozedUntil: null }, { snoozedUntil: { $lte: now } }],
    }).sort({ dueAt: 1, priority: -1 }).limit(20).lean(),
  ]);

  res.json({
    alerts: probeResults,
    unreadNotifications,
    todayReminders,
    generatedAt: now,
  });
});

module.exports = { mine };
