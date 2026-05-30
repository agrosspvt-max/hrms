const asyncHandler = require('express-async-handler');
const Event = require('../models/Event');
const Holiday = require('../models/Holiday');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { startOfDay, addDays, parseDay, formatYMD } = require('../utils/dateHelpers');

const COMPANY_NAME = () => process.env.COMPANY_NAME || 'Agromaxx Industry';

/** Same MM-DD as the given date in a target year (UTC). */
const sameDayInYear = (d, year) => new Date(Date.UTC(year, d.getUTCMonth(), d.getUTCDate()));

/**
 * Expand a yearly recurring event to its in-range occurrences.  Returns
 * one occurrence per matching year in [from, to).  Non-recurring events
 * fall through unchanged.
 */
const expandEvent = (ev, from, to) => {
  const start = startOfDay(ev.startDate);
  const end = ev.endDate ? startOfDay(ev.endDate) : start;
  const span = Math.max(0, Math.round((end - start) / 86400000));
  if (!ev.repeatYearly) {
    if (end >= from && start < to) return [{ ...ev, occStart: start, occEnd: end }];
    return [];
  }
  const out = [];
  for (let y = from.getUTCFullYear() - 1; y <= to.getUTCFullYear() + 1; y += 1) {
    const occStart = sameDayInYear(start, y);
    const occEnd = addDays(occStart, span);
    if (occEnd >= from && occStart < to) out.push({ ...ev, occStart, occEnd });
  }
  return out;
};

/**
 * Birthdays auto-derived from active employees' dateOfBirth.  Anyone can
 * see today's birthdays; the calendar also shows them for richer browsing.
 */
const birthdaysForRange = async (from, to) => {
  const employees = await User.find({ status: 'active', dateOfBirth: { $exists: true, $ne: null } })
    .select('name employeeId dateOfBirth department designation').lean();
  const out = [];
  for (const u of employees) {
    if (!u.dateOfBirth) continue;
    const dob = new Date(u.dateOfBirth);
    for (let y = from.getUTCFullYear() - 1; y <= to.getUTCFullYear() + 1; y += 1) {
      const occ = sameDayInYear(dob, y);
      if (occ >= from && occ < to) {
        out.push({
          _id: `birthday:${u._id}:${y}`,
          type: 'birthday', title: `${u.name}'s Birthday`,
          description: `${u.name} (${u.employeeId})`,
          isHoliday: false, notify: true, audience: 'everyone',
          repeatYearly: true,
          occStart: occ, occEnd: occ,
          linkedEmployee: u._id, linkedEmployeeName: u.name,
        });
      }
    }
  }
  return out;
};

/* ============================== CRUD ============================== */

const list = asyncHandler(async (req, res) => {
  const from = req.query.from ? parseDay(req.query.from) : addDays(startOfDay(new Date()), -30);
  const to = req.query.to ? addDays(parseDay(req.query.to), 1) : addDays(startOfDay(new Date()), 90);
  const stored = await Event.find({}).lean();
  let occurrences = [];
  for (const ev of stored) occurrences.push(...expandEvent(ev, from, to));
  occurrences.push(...await birthdaysForRange(from, to));
  occurrences.sort((a, b) => a.occStart - b.occStart);
  res.json(occurrences.map((o) => ({ ...o, occStart: o.occStart, occEnd: o.occEnd })));
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

const upcoming = asyncHandler(async (req, res) => {
  const today = startOfDay(new Date());
  const to = addDays(today, Number(req.query.days || 30));
  const stored = await Event.find({}).lean();
  const all = [];
  for (const ev of stored) all.push(...expandEvent(ev, today, addDays(to, 1)));
  all.push(...await birthdaysForRange(today, addDays(to, 1)));
  // Include the existing Holiday model so the widget shows real holidays too.
  const holidays = await Holiday.find({ date: { $gte: today, $lt: addDays(to, 1) } }).lean();
  for (const h of holidays) {
    all.push({ _id: `holiday:${h._id}`, type: 'holiday', title: h.name, description: h.description || '',
      isHoliday: true, occStart: startOfDay(h.date), occEnd: startOfDay(h.date), repeatYearly: false });
  }
  all.sort((a, b) => a.occStart - b.occStart);
  res.json(all);
});

const birthdaysToday = asyncHandler(async (_req, res) => {
  const today = startOfDay(new Date());
  const list = await birthdaysForRange(today, addDays(today, 1));
  res.json(list);
});

/* ===================== Notifications + analytics ================== */

/**
 * Idempotent on-demand pass: fire today's birthday + event notifications.
 * Safe to call from any dashboard load - duplicate notifications are
 * suppressed by checking for an existing same-day notification per
 * (recipient, type, eventKey).
 */
const processDue = asyncHandler(async (req, res) => {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);

  // ---- Birthdays ----
  const bdays = await birthdaysForRange(today, tomorrow);
  for (const b of bdays) {
    // To the birthday person.
    await fireOnce(b.linkedEmployee, 'birthday_today', `birthday:${b.linkedEmployee}:${formatYMD(today)}:self`, {
      title: `Happy Birthday from ${COMPANY_NAME()}`,
      message: `Wishing you a fantastic year ahead!`,
    });
    // Team-wide (everyone except the birthday person).
    const others = await User.find({ status: 'active', _id: { $ne: b.linkedEmployee } }).select('_id');
    for (const u of others) {
      await fireOnce(u._id, 'birthday_today', `birthday:${b.linkedEmployee}:${formatYMD(today)}:${u._id}`, {
        title: 'Birthday today',
        message: `Today is ${b.linkedEmployeeName}'s birthday — wish them well!`,
      });
    }
  }

  // ---- Stored events (notification offsets) ----
  const events = await Event.find({ notify: true }).lean();
  for (const ev of events) {
    for (const offset of (ev.notifyOffsets || [0])) {
      const target = addDays(today, offset); // notify N days BEFORE event day → look ahead
      const occs = expandEvent(ev, target, addDays(target, 1));
      if (occs.length === 0) continue;
      const occ = occs[0];
      const eventKey = `event:${ev._id}:${formatYMD(occ.occStart)}:${offset}`;
      const title = offset === 0 ? `Today: ${ev.title}` : `Upcoming: ${ev.title}`;
      const message = offset === 0
        ? (ev.description || `${ev.title} is today.`)
        : `${ev.title} starts in ${offset} day${offset === 1 ? '' : 's'}.`;
      const audience = await resolveAudience(ev);
      for (const uid of audience) {
        const type = offset === 0 ? 'event_today' : 'event_reminder';
        await fireOnce(uid, type, eventKey + `:${uid}`, { title, message });
      }
    }
  }

  res.json({ ok: true });
});

const resolveAudience = async (ev) => {
  if (ev.audience === 'employees') return (ev.audienceEmployees || []).map(String);
  let where = { status: 'active' };
  if (ev.audience === 'department' && ev.audienceDepartment) where.department = ev.audienceDepartment;
  if (ev.audience === 'designation' && ev.audienceDesignation) where.designation = ev.audienceDesignation;
  const users = await User.find(where).select('_id').lean();
  return users.map((u) => String(u._id));
};

const fireOnce = async (recipient, type, eventKey, payload) => {
  if (!recipient) return;
  const existing = await Notification.findOne({ recipient, type, eventKey }).select('_id');
  if (existing) return;
  await Notification.create({ recipient, type, eventKey, ...payload }).catch(() => {});
};

const analytics = asyncHandler(async (_req, res) => {
  const today = startOfDay(new Date());
  const upcomingTo = addDays(today, 90);
  const stored = await Event.find({}).lean();
  const counts = { festival: 0, company_event: 0, custom: 0 };
  const upcomingCounts = { events: 0, festivals: 0, holidays: 0, birthdays: 0 };
  for (const ev of stored) {
    if (counts[ev.type] !== undefined) counts[ev.type] += 1;
    const occs = expandEvent(ev, today, upcomingTo);
    if (occs.length) {
      upcomingCounts.events += occs.length;
      if (ev.type === 'festival') upcomingCounts.festivals += occs.length;
    }
  }
  const totalHolidays = await Holiday.countDocuments({});
  const upcomingHolidays = await Holiday.countDocuments({ date: { $gte: today, $lt: upcomingTo } });
  const bdays = await birthdaysForRange(today, upcomingTo);
  upcomingCounts.birthdays = bdays.length;
  upcomingCounts.holidays = upcomingHolidays;
  const totalBirthdays = await User.countDocuments({ status: 'active', dateOfBirth: { $exists: true, $ne: null } });

  res.json({
    totals: { holidays: totalHolidays, festivals: counts.festival, companyEvents: counts.company_event, custom: counts.custom, birthdays: totalBirthdays },
    upcoming: upcomingCounts,
  });
});

module.exports = { list, get, create, update, remove, upcoming, birthdaysToday, processDue, analytics };
