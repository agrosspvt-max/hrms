/**
 * reminderController.js -- HTTP surface for the Reminder collection.
 *
 * Employee endpoints:
 *   GET   /api/reminders/mine                  active reminders for me
 *   PATCH /api/reminders/:id/done              mark completed
 *   PATCH /api/reminders/:id/dismiss           dismiss (won't repeat)
 *   PATCH /api/reminders/:id/snooze            snooze for a while
 *
 * HR endpoints:
 *   POST  /api/reminders                       create a custom reminder for an employee
 *   PATCH /api/reminders/:id                   edit fields
 *   POST  /api/reminders/:id/cancel            HR cancels (equivalent to dismiss with audit)
 *   POST  /api/reminders/:id/complete          HR marks completed on behalf of employee
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Reminder = require('../models/Reminder');
const reminders = require('../services/reminders');
const events = require('../services/events');
const rt = require('../services/realtime');
const { logAudit } = require('../utils/audit');

const _isAdmin = (u) => u && (u.role === 'hr' || u.role === 'super_admin');

const mine = asyncHandler(async (req, res) => {
  const now = new Date();
  const rows = await Reminder.find({
    recipient: req.user._id,
    completedAt: null,
    dismissedAt: null,
    $or: [{ snoozedUntil: { $exists: false } }, { snoozedUntil: null }, { snoozedUntil: { $lte: now } }],
  }).sort({ dueAt: 1, priority: -1 }).limit(50).lean();
  res.json({ rows, generatedAt: now });
});

const create = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  const b = req.body || {};
  if (!b.recipient || !b.actionKind || !b.dueAt) {
    res.status(400); throw new Error('recipient, actionKind, dueAt are required.');
  }
  const { doc, created } = await reminders.createOrUpdate({
    ...b, createdBy: req.user._id,
  });
  if (!doc) { res.status(400); throw new Error('Could not create reminder.'); }
  logAudit(req, { action: 'reminder.create', targetType: 'Reminder', targetId: doc._id, targetLabel: doc.actionKind });
  if (created) rt.publish(doc.recipient, 'reminder:changed', { reminderId: doc._id });
  res.status(201).json(doc);
});

const update = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) { res.status(400); throw new Error('Invalid id.'); }
  const editable = ['title', 'message', 'dueAt', 'priority', 'targetRoute', 'meta'];
  const patch = {};
  for (const k of editable) if (k in req.body) patch[k] = req.body[k];
  const doc = await Reminder.findByIdAndUpdate(id, patch, { new: true });
  if (!doc) { res.status(404); throw new Error('Reminder not found.'); }
  logAudit(req, { action: 'reminder.update', targetType: 'Reminder', targetId: doc._id });
  rt.publish(doc.recipient, 'reminder:changed', { reminderId: doc._id });
  res.json(doc);
});

const _action = (action) => asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await reminders.applyAction({ id, action, userId: req.user._id });
  if (!doc) { res.status(404); throw new Error('Reminder not found.'); }
  logAudit(req, { action: `reminder.${action}`, targetType: 'Reminder', targetId: doc._id });
  rt.publish(doc.recipient, 'reminder:changed', { reminderId: doc._id, action });
  events.publish('reminder.completed', {
    reminderId: doc._id, recipient: doc.recipient, actionKind: doc.actionKind,
    entityType: doc.entityType, entityId: doc.entityId, via: action,
  });
  res.json(doc);
});

const done    = _action('done');
const dismiss = _action('dismiss');
const snooze  = _action('snooze');

const cancel = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  const { id } = req.params;
  const doc = await Reminder.findByIdAndUpdate(id, { $set: { dismissedAt: new Date() } }, { new: true });
  if (!doc) { res.status(404); throw new Error('Reminder not found.'); }
  logAudit(req, { action: 'reminder.cancel', targetType: 'Reminder', targetId: doc._id });
  rt.publish(doc.recipient, 'reminder:changed', { reminderId: doc._id, action: 'cancel' });
  res.json(doc);
});

const complete = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  const { id } = req.params;
  const doc = await Reminder.findByIdAndUpdate(id, { $set: { completedAt: new Date() } }, { new: true });
  if (!doc) { res.status(404); throw new Error('Reminder not found.'); }
  logAudit(req, { action: 'reminder.complete', targetType: 'Reminder', targetId: doc._id });
  rt.publish(doc.recipient, 'reminder:changed', { reminderId: doc._id, action: 'complete' });
  res.json(doc);
});

module.exports = { mine, create, update, done, dismiss, snooze, cancel, complete };
