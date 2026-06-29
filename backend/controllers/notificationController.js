const asyncHandler = require('express-async-handler');
const Notification = require('../models/Notification');
// Phase 47 -- realtime fan-out so recipients (and the sender) see
// updates without a manual refresh.
const rt = require('../services/realtime');

/**
 * POST /api/notifications
 *
 * HR-only. Body:
 *   {
 *     recipients: [userId, ...],   // one or more employees
 *     title: 'Pending backlog reminder',
 *     message: 'Please complete...',
 *     type: 'backlog_alert' | 'general',
 *     relatedTaskIds: [...],       // optional
 *     relatedTitles: [...],        // optional
 *   }
 *
 * Creates one Notification per recipient.  Returns the number created.
 */
const send = asyncHandler(async (req, res) => {
  const {
    recipients = [], title, message, type,
    relatedTaskIds = [], relatedTitles = [],
    priority, deadline,
  } = req.body;
  if (!recipients.length) {
    res.status(400);
    throw new Error('At least one recipient is required');
  }
  if (!title || !message) {
    res.status(400);
    throw new Error('title and message are required');
  }
  // Phase 45 -- accept priority on the broadcast.  Unknown values fall
  // back to 'normal' so legacy callers (no field) behave unchanged.
  const allowedPriority = new Set(['normal', 'important', 'urgent']);
  const priorityNorm = allowedPriority.has(priority) ? priority : 'normal';

  // Phase 46 -- urgent notices REQUIRE a deadline (date + time).  We
  // accept anything Date() can parse so the frontend can post an ISO
  // string built from <input type="date"> + <input type="time">.  The
  // field is ignored for non-urgent notices to keep the inbox model
  // clean (no stray deadlines on Normal/Important rows).
  let deadlineDate;
  if (priorityNorm === 'urgent') {
    if (!deadline) {
      res.status(400);
      throw new Error('A deadline (date + time) is required for time-bound notices.');
    }
    deadlineDate = new Date(deadline);
    if (Number.isNaN(deadlineDate.getTime())) {
      res.status(400);
      throw new Error('Deadline is not a valid date/time.');
    }
  }

  const docs = recipients.map((r) => ({
    recipient: r,
    sender: req.user._id,
    title: title.trim(),
    message: message.trim(),
    type: type || 'general',
    relatedTaskIds,
    relatedTitles,
    priority: priorityNorm,
    deadline: deadlineDate,
  }));
  const created = await Notification.insertMany(docs);
  // Phase 47 -- push notification:new to every recipient.  Priority
  // matters on the client (the Dashboard panel re-fetches separately
  // from the inbox), so include it in the payload.
  rt.publishMany(recipients, 'notification:new', { priority: priorityNorm });
  res.status(201).json({ count: created.length, notifications: created });
});

/**
 * Phase 45 -- GET /api/notifications/priority
 *
 * Returns the current employee's Important + Urgent notices, newest
 * first.  Drives the "Priority Notices" panel on the Employee Dashboard.
 * Read/unread state is the same field the inbox uses, so the existing
 * read-receipt workflow on HR's Send Alerts page keeps working
 * untouched.
 */
const myPriority = asyncHandler(async (req, res) => {
  const items = await Notification.find({
    recipient: req.user._id,
    priority: { $in: ['important', 'urgent'] },
    // Phase 46 -- dashboard panel hides notices the employee has
    // already cleared from the dashboard.  The Notification document
    // itself stays in their inbox (permanent history).
    dismissedFromDashboardAt: { $in: [null, undefined] },
  })
    .populate('sender', 'name role')
    .sort({ createdAt: -1 });
  res.json(items);
});

/**
 * GET /api/notifications/mine?status=unread|all
 * Returns the current user's notifications, newest first.
 */
const myInbox = asyncHandler(async (req, res) => {
  const where = { recipient: req.user._id };
  if (req.query.status === 'unread') where.read = false;
  const items = await Notification.find(where)
    .populate('sender', 'name role')
    .sort({ createdAt: -1 });
  res.json(items);
});

/**
 * GET /api/notifications/unread-count
 * Lightweight count endpoint for the sidebar badge.
 */
const unreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.countDocuments({ recipient: req.user._id, read: false });
  res.json({ count });
});

/**
 * PATCH /api/notifications/:id/read
 */
const markRead = asyncHandler(async (req, res) => {
  const n = await Notification.findOne({ _id: req.params.id, recipient: req.user._id });
  if (!n) { res.status(404); throw new Error('Notification not found'); }
  if (!n.read) {
    n.read = true;
    n.readAt = new Date();
    await n.save();
    // Phase 47 -- the sender's Sent Alerts page updates its Read column.
    if (n.sender) rt.publish(n.sender, 'notification:read', { notificationId: String(n._id) });
  }
  res.json(n);
});

/**
 * PATCH /api/notifications/read-all
 */
const markAllRead = asyncHandler(async (req, res) => {
  // Phase 47 -- need senders of the rows we're about to mark so we can
  // tell each sender's Sent Alerts page to refresh.  One query + a set
  // keeps it O(senders) instead of one publish per row.
  const senders = await Notification.find(
    { recipient: req.user._id, read: false },
  ).distinct('sender');
  const r = await Notification.updateMany(
    { recipient: req.user._id, read: false },
    { $set: { read: true, readAt: new Date() } },
  );
  if (senders?.length) rt.publishMany(senders, 'notification:read', { bulk: true });
  res.json({ updated: r.modifiedCount });
});

/**
 * DELETE /api/notifications/:id
 *
 * Phase 46 -- Notifications are permanent history.  Employees can no
 * longer delete a notification: the route returns 403 with an
 * explanatory message so any stale frontend that still attempts a
 * delete fails loudly instead of silently breaking the audit trail.
 * Dashboard dismissal lives on a separate endpoint (see dismissDashboard).
 *
 * HR / Super Admin keep the ability to prune their own sent records via
 * future admin tooling -- not exposed here yet, but the route stays a
 * single source of truth for "can this be deleted?".
 */
const remove = asyncHandler(async (req, res) => {
  const n = await Notification.findOne({ _id: req.params.id, recipient: req.user._id });
  if (!n) { res.status(404); throw new Error('Notification not found'); }
  if (req.user.role !== 'super_admin') {
    res.status(403);
    throw new Error('Notifications are permanent history and cannot be deleted. Use Clear on the Dashboard to dismiss a priority notice.');
  }
  await n.deleteOne();
  res.json({ message: 'Deleted' });
});

/**
 * Phase 46 -- POST /api/notifications/:id/resolve
 *
 * Marks a Time-bound (urgent) notice as resolved.  Idempotent: a
 * second call is a no-op.  The employee must have read the notice
 * first -- this mirrors the spec: Read = opened, Resolved = work done.
 * Only urgent notices can be resolved; calling resolve on an important
 * / normal notice returns 400 so the action is unambiguous.
 */
const resolve = asyncHandler(async (req, res) => {
  const n = await Notification.findOne({ _id: req.params.id, recipient: req.user._id });
  if (!n) { res.status(404); throw new Error('Notification not found'); }
  if (n.priority !== 'urgent') {
    res.status(400);
    throw new Error('Only time-bound notices can be resolved.');
  }
  if (!n.resolvedAt) {
    n.resolvedAt = new Date();
    // Resolving without first opening is allowed by some workflows, but
    // we also stamp readAt so HR's "Read" receipt reflects reality.
    if (!n.read) { n.read = true; n.readAt = n.resolvedAt; }
    await n.save();
    // Phase 47 -- HR's Sent Alerts page sees Resolved status update.
    if (n.sender) rt.publish(n.sender, 'notification:resolved', { notificationId: String(n._id) });
  }
  res.json(n);
});

/**
 * Phase 46 -- POST /api/notifications/:id/dismiss-dashboard
 *
 * Removes a priority notice from the employee's Dashboard panel
 * without deleting the underlying Notification.  The Notification
 * stays in the inbox as permanent proof of delivery.
 *
 * Gating mirrors the spec:
 *   important -> must be read
 *   urgent    -> must be resolved
 *   normal    -> not surfaced on the dashboard; rejected so the call
 *                is treated as a programming error rather than silent.
 */
const dismissDashboard = asyncHandler(async (req, res) => {
  const n = await Notification.findOne({ _id: req.params.id, recipient: req.user._id });
  if (!n) { res.status(404); throw new Error('Notification not found'); }
  if (n.priority === 'normal') {
    res.status(400);
    throw new Error('Normal notices are inbox-only and have nothing to dismiss from the dashboard.');
  }
  if (n.priority === 'important' && !n.read) {
    res.status(400);
    throw new Error('Open the notice before clearing it from the dashboard.');
  }
  if (n.priority === 'urgent' && !n.resolvedAt) {
    res.status(400);
    throw new Error('Resolve this time-bound notice before clearing it from the dashboard.');
  }
  if (!n.dismissedFromDashboardAt) {
    n.dismissedFromDashboardAt = new Date();
    await n.save();
  }
  res.json(n);
});

/**
 * GET /api/notifications/sent  (HR)
 * History of notifications HR has sent (most recent first).
 */
const sentByMe = asyncHandler(async (req, res) => {
  const items = await Notification.find({ sender: req.user._id })
    .populate('recipient', 'name employeeId email')
    .sort({ createdAt: -1 });
  res.json(items);
});

module.exports = {
  send, myInbox, myPriority, unreadCount, markRead, markAllRead,
  remove, resolve, dismissDashboard, sentByMe,
};
