const asyncHandler = require('express-async-handler');
const Notification = require('../models/Notification');

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
    priority,
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
  const docs = recipients.map((r) => ({
    recipient: r,
    sender: req.user._id,
    title: title.trim(),
    message: message.trim(),
    type: type || 'general',
    relatedTaskIds,
    relatedTitles,
    priority: priorityNorm,
  }));
  const created = await Notification.insertMany(docs);
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
  }
  res.json(n);
});

/**
 * PATCH /api/notifications/read-all
 */
const markAllRead = asyncHandler(async (req, res) => {
  const r = await Notification.updateMany(
    { recipient: req.user._id, read: false },
    { $set: { read: true, readAt: new Date() } },
  );
  res.json({ updated: r.modifiedCount });
});

/**
 * DELETE /api/notifications/:id
 *
 * Phase 45 -- Important / Urgent notices may only be cleared after the
 * employee has actually opened them.  Normal notifications keep their
 * previous behaviour (delete at any time) so the inbox doesn't change.
 */
const remove = asyncHandler(async (req, res) => {
  const n = await Notification.findOne({ _id: req.params.id, recipient: req.user._id });
  if (!n) { res.status(404); throw new Error('Notification not found'); }
  if (n.priority && n.priority !== 'normal' && !n.read) {
    res.status(400);
    throw new Error('Open the notice before clearing it.');
  }
  await n.deleteOne();
  res.json({ message: 'Deleted' });
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

module.exports = { send, myInbox, myPriority, unreadCount, markRead, markAllRead, remove, sentByMe };
