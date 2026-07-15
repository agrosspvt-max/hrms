/**
 * eventController.js
 *
 * Phase 73 -- every read endpoint here is now a thin adapter over
 * `services/eventOccurrences.js`.  There is exactly ONE aggregation
 * pipeline in the module; the endpoints below choose their date
 * window and (for analytics) partition the result via the shared
 * `bucketize()` helper.  Nothing here queries Event / Holiday /
 * User directly for reads anymore.
 *
 * Notification firing was intentionally disabled in Phase 45 and
 * the dead `processDue` / `fireOnce` scaffold has been removed here.
 * If notifications are ever re-enabled they belong in their own
 * dedicated module and should still consume the shared resolver.
 */
const asyncHandler = require('express-async-handler');
const Event = require('../models/Event');
const User  = require('../models/User');
const {
  inclusiveRange,
  resolveOccurrences,
  bucketize,
  classify,
} = require('../services/eventOccurrences');
const { startOfDay, addDays, parseDay } = require('../utils/dateHelpers');

/* ============================== CRUD ============================== */

/**
 * GET /api/events?from=&to=
 * Default window: today-30 .. today+89 (inclusive) so the calendar's
 * "surrounding month" view still works.  Every occurrence -- Event
 * rows, Holiday collection entries and auto-birthdays -- is returned
 * from the same resolver so the calendar always matches analytics.
 */
const list = asyncHandler(async (req, res) => {
  const from = req.query.from ? parseDay(req.query.from) : addDays(startOfDay(new Date()), -30);
  const to   = req.query.to   ? parseDay(req.query.to)   : addDays(startOfDay(new Date()),  89);
  const occurrences = await resolveOccurrences({ from, to });
  res.json(occurrences);
});

const get = asyncHandler(async (req, res) => {
  const e = await Event.findById(req.params.id)
    .populate('linkedEmployee', 'name employeeId')
    .populate('audienceDepartment', 'name')
    .populate('audienceDesignation', 'title')
    .populate('audienceEmployees', 'name employeeId');
  if (!e) { res.status(404); throw new Error('Event not found'); }
  res.json(e);
});

const normalizeBody = (body) => {
  const type = ['birthday', 'festival', 'company_event', 'custom'].includes(body.type) ? body.type : 'custom';
  const isHoliday = type === 'birthday' ? false : !!body.isHoliday;
  const audience = ['everyone', 'department', 'designation', 'employees'].includes(body.audience) ? body.audience : 'everyone';
  const offsets = Array.isArray(body.notifyOffsets)
    ? body.notifyOffsets.map(Number).filter((n) => [0, 1, 3, 7].includes(n))
    : [0];
  return {
    type, title: String(body.title || '').trim(), description: body.description || '',
    startDate: parseDay(body.startDate),
    endDate: body.endDate ? parseDay(body.endDate) : undefined,
    repeatYearly: !!body.repeatYearly, isHoliday,
    notify: body.notify !== false, notifyOffsets: offsets,
    audience,
    audienceDepartment: audience === 'department' ? body.audienceDepartment : undefined,
    audienceDesignation: audience === 'designation' ? body.audienceDesignation : undefined,
    audienceEmployees: audience === 'employees' && Array.isArray(body.audienceEmployees) ? body.audienceEmployees : [],
    linkedEmployee: type === 'birthday' ? body.linkedEmployee : undefined,
  };
};

const create = asyncHandler(async (req, res) => {
  const payload = normalizeBody(req.body);
  if (!payload.title) { res.status(400); throw new Error('Title is required'); }
  payload.createdBy = req.user._id;
  const e = await Event.create(payload);
  res.status(201).json(e);
});

const update = asyncHandler(async (req, res) => {
  const payload = normalizeBody(req.body);
  const e = await Event.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!e) { res.status(404); throw new Error('Event not found'); }
  res.json(e);
});

const remove = asyncHandler(async (req, res) => {
  const e = await Event.findByIdAndDelete(req.params.id);
  if (!e) { res.status(404); throw new Error('Event not found'); }
  res.json({ message: 'Event deleted' });
});

/* ========================= Reads / widgets ======================== */

/**
 * GET /api/events/upcoming?days=N
 * Inclusive window: today .. today+(N-1).  Returns the same normalised
 * occurrence shape as /events (calendar + widget consume identical data).
 */
const upcoming = asyncHandler(async (req, res) => {
  const days = Math.max(1, Number(req.query.days || 30));
  const { from, to } = inclusiveRange(startOfDay(new Date()), days);
  const occurrences = await resolveOccurrences({ from, to });
  res.json(occurrences);
});

/**
 * GET /api/events/birthdays/today
 * Every occurrence today that classifies as a birthday.  This
 * unifies auto-birthdays (User.dob) AND stored Event rows of
 * type='birthday' (previous versions missed the latter).
 */
const birthdaysToday = asyncHandler(async (_req, res) => {
  const today = startOfDay(new Date());
  const occurrences = await resolveOccurrences({ from: today, to: today });
  const bdays = occurrences.filter((o) => classify(o) === 'birthday');
  res.json(bdays);
});

/* ===================== Notifications ============================== */
/*
 * Phase 45 disabled birthday / event reminder notifications and
 * Phase 73 removed the dead `processDue` / `fireOnce` scaffold that
 * still walked the resolver for no side-effect.  Frontend callers
 * that previously POSTed /events/process-due are updated to no
 * longer do so; the route is removed in eventRoutes.js.
 */

/* ===================== Analytics ================================== */

/**
 * GET /api/events/analytics
 *
 * Overview cards for the Events & Holidays management page.  Uses the
 * shared resolver + shared classifier so every "Upcoming (90d)" figure
 * is computed as a strict partition of the same list the calendar and
 * upcoming widget render.  No bucket ever overlaps another; the total
 * is the simple sum.
 */
const analytics = asyncHandler(async (_req, res) => {
  const today = startOfDay(new Date());
  const { from, to } = inclusiveRange(today, 90);

  // ---- Totals (all-time / on-file) ------------------------------
  // Every-time counts read from the raw collections because "totals"
  // is intentionally not date-bounded.  These stay in sync with the
  // resolver because the resolver reads the same collections.
  const [totalHolidays, evTypeCounts, totalBirthdays] = await Promise.all([
    require('../models/Holiday').countDocuments({}),
    Event.aggregate([{ $group: { _id: '$type', n: { $sum: 1 } } }]),
    User.countDocuments({ status: 'active', dateOfBirth: { $exists: true, $ne: null } }),
  ]);
  const byType = { festival: 0, company_event: 0, custom: 0, birthday: 0 };
  for (const row of evTypeCounts) if (byType[row._id] !== undefined) byType[row._id] = row.n;

  // ---- Upcoming buckets via shared partitioning -------------------
  const occurrences = await resolveOccurrences({ from, to });
  const buckets = bucketize(occurrences);

  res.json({
    range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    totals: {
      holidays: totalHolidays,
      festivals: byType.festival,
      companyEvents: byType.company_event,
      custom: byType.custom,
      // Birthdays "on file" = active users with a DOB PLUS any stored
      // birthday events that don't map to a user's DOB (rare, but the
      // classifier includes both so totals stay honest).
      birthdays: totalBirthdays + byType.birthday,
    },
    upcoming: {
      birthdays: buckets.birthdays,
      holidays:  buckets.holidays,
      events:    buckets.events,
      total:     buckets.total,
    },
  });
});

module.exports = {
  list, get, create, update, remove,
  upcoming, birthdaysToday, analytics,
};
