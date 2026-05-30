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
  const { recipients = [], title, message, type, relatedTaskIds = [], relatedTitles = [] } = req.body;
  if (!recipients.length) {
    res.status(400);
    throw new Error('At least one recipient is required');
  }
  if (!title || !message) {
    res.status(400);
    throw new Error('title and message are required');
  }
  const docs = recipients.map((r) => ({
    recipient: r,
    sender: req.user._id,
    title: title.trim(),
    message: message.trim(),
    type: type || 'general',
    relatedTaskIds,
    relatedTitles,
  }));
  const created = await Notification.insertMany(docs);
  res.status(201).json({ count: created.length, notifications: created });
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
 */
const remove = asyncHandler(async (req, res) => {
  const n = await Notification.findOneAndDelete({ _id: req.params.id, recipient: req.user._id });
  if (!n) { res.status(404); throw new Error('Notification not found'); }
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

module.exports = { send, myInbox, unreadCount, markRead, markAllRead, remove, sentByMe };
