/**
 * disclosure.js -- validation + persistence for the Disclosure feature.
 *
 * Source of truth: the `Disclosure` collection (one row per employee per
 * business date).  This module is the ONLY place the conditional rules
 * live; the controller only adapts HTTP.
 */
const mongoose = require('mongoose');
const Disclosure = require('../models/Disclosure');
const Submission = require('../models/Submission');
const { startOfDay } = require('../utils/dateHelpers');
const { liveSubmissionFilter } = require('../utils/submissionFilter');

const TYPES = ['mistake', 'exception', 'other'];

class DisclosureError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const _isNil = (v) => v === undefined || v === null;
const _str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Validate + normalise a disclosure payload.  Returns the field set to
 * persist (non-applicable fields explicitly null / '').  Rejects missing
 * required fields AND fields that do not apply to the chosen type.
 */
const validatePayload = (body = {}) => {
  const type = body.type;
  if (!TYPES.includes(type)) throw new DisclosureError(400, `Disclosure type must be one of: ${TYPES.join(', ')}.`);

  const details = _str(body.details);
  if (!details) throw new DisclosureError(400, 'Details are required.');
  if (details.length > 2000) throw new DisclosureError(400, 'Details must be 2000 characters or fewer.');

  const out = { type, details, correctable: null, corrected: null, authorizedBy: '' };
  const hasAuth = !_isNil(body.authorizedBy) && _str(body.authorizedBy) !== '';

  if (type === 'mistake') {
    if (hasAuth) throw new DisclosureError(400, 'Authorized By does not apply to a Mistake.');
    if (typeof body.correctable !== 'boolean') {
      throw new DisclosureError(400, 'Please state whether the mistake is correctable (true/false).');
    }
    out.correctable = body.correctable;
    if (body.correctable === false) {
      if (!_isNil(body.corrected)) throw new DisclosureError(400, 'Corrected does not apply when the mistake is not correctable.');
    } else {
      if (typeof body.corrected !== 'boolean') {
        throw new DisclosureError(400, 'Please state whether you corrected the mistake (true/false).');
      }
      out.corrected = body.corrected;
    }
  } else if (type === 'exception') {
    if (!_isNil(body.correctable) || !_isNil(body.corrected)) {
      throw new DisclosureError(400, 'Correctable / Corrected do not apply to an Exception.');
    }
    const authorizedBy = _str(body.authorizedBy);
    if (!authorizedBy) throw new DisclosureError(400, 'Who authorized the exception is required.');
    if (authorizedBy.length > 200) throw new DisclosureError(400, 'Authorized By must be 200 characters or fewer.');
    out.authorizedBy = authorizedBy;
  } else {
    if (!_isNil(body.correctable) || !_isNil(body.corrected) || hasAuth) {
      throw new DisclosureError(400, 'Only Details apply to an Other disclosure.');
    }
  }
  return out;
};

/** 'YYYY-MM-DD' / ISO / Date -> UTC-midnight business day (same helper as submissions). */
const resolveDay = (raw) => {
  const d = startOfDay(raw ? new Date(raw) : new Date());
  if (Number.isNaN(d.getTime())) throw new DisclosureError(400, 'Invalid date.');
  return d;
};

const _snapshot = (d) => (d ? {
  type: d.type, details: d.details, correctable: d.correctable,
  corrected: d.corrected, authorizedBy: d.authorizedBy,
} : null);

/**
 * Create or update the acting employee's disclosure for a business day.
 * Idempotent: (employee, date) is unique, so retries / double-clicks
 * converge on one record.
 */
const saveForEmployee = async ({ actor, body = {} }) => {
  if (!actor || !actor._id) throw new DisclosureError(401, 'Not authorized.');
  if (!_isNil(body.employee) && String(body.employee) !== String(actor._id)) {
    throw new DisclosureError(403, 'You can only file a disclosure for yourself.');
  }
  const fields = validatePayload(body);
  const day = resolveDay(body.date);
  if (day.getTime() > startOfDay(new Date()).getTime()) {
    throw new DisclosureError(400, 'A disclosure cannot be filed for a future date.');
  }

  const subs = await Submission.find({
    employee: actor._id, date: day, ...liveSubmissionFilter({}),
  }).sort({ createdAt: 1, _id: 1 }).select('_id reviewStatus').lean();
  if (subs.length === 0) {
    throw new DisclosureError(404, 'No daily submission exists for that date, so a disclosure cannot be attached.');
  }
  let primary = subs[0];
  if (!_isNil(body.submissionId) && body.submissionId !== '') {
    primary = subs.find((s) => String(s._id) === String(body.submissionId));
    if (!primary) throw new DisclosureError(400, 'submissionId does not belong to you for that date.');
  }
  // Follow the submission lifecycle: once HR has finalised the day it is
  // immutable for the employee (Super Admin submissions auto-finalise).
  if (actor.role !== 'super_admin' && subs.some((s) => s.reviewStatus === 'reviewed')) {
    throw new DisclosureError(409, 'This day has already been reviewed; the disclosure can no longer be changed.');
  }

  const query = { employee: actor._id, date: day };
  const previous = await Disclosure.findOne(query).lean();
  const patch = {
    $set: { ...fields, submission: primary._id, lastEditedBy: actor._id },
    $setOnInsert: { employee: actor._id, date: day },
  };
  const opts = { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true };
  let doc;
  try {
    doc = await Disclosure.findOneAndUpdate(query, patch, opts);
  } catch (e) {
    // Two concurrent first-time saves race on the unique index; the loser
    // retries as a plain update.
    if (e && e.code === 11000) doc = await Disclosure.findOneAndUpdate(query, patch, opts);
    else throw e;
  }
  return { doc, previous: _snapshot(previous), created: !previous };
};

const getForEmployee = async ({ employeeId, date }) =>
  Disclosure.findOne({ employee: employeeId, date: resolveDay(date) }).lean();

/**
 * HR / Super Admin listing.  Filters: date (exact day) OR from/to range,
 * employee, type.  All combinable.  Paginated, newest first.
 */
const list = async (q = {}) => {
  const where = {};
  if (q.date) {
    where.date = resolveDay(q.date);
  } else if (q.from || q.to) {
    where.date = {};
    if (q.from) where.date.$gte = resolveDay(q.from);
    if (q.to) where.date.$lte = resolveDay(q.to);
  }
  if (q.employee) {
    if (!mongoose.Types.ObjectId.isValid(q.employee)) throw new DisclosureError(400, 'Invalid employee id.');
    where.employee = q.employee;
  }
  if (q.type && q.type !== 'all') {
    if (!TYPES.includes(q.type)) throw new DisclosureError(400, `type must be one of: all, ${TYPES.join(', ')}.`);
    where.type = q.type;
  }
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const [items, total] = await Promise.all([
    Disclosure.find(where)
      .populate('employee', 'name employeeId email')
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Disclosure.countDocuments(where),
  ]);
  return { items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
};

module.exports = { TYPES, DisclosureError, validatePayload, resolveDay, saveForEmployee, getForEmployee, list };
