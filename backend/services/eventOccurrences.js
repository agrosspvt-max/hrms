/**
 * eventOccurrences.js
 *
 * Phase 73 -- SINGLE SOURCE OF TRUTH for every Events & Holidays read.
 *
 * Merges three underlying data stores into one normalised occurrence
 * stream and one deterministic classifier so every calendar, upcoming
 * widget, analytics card, working-day engine, submission gate,
 * attendance evaluator, salary calculator and (future) notification
 * pipeline sees the same data:
 *
 *   A. Holiday collection            (Holiday.find)
 *   B. Event collection              (Event.find)   -- typed festival /
 *                                                     company_event /
 *                                                     custom / birthday
 *   C. Auto birthdays from User.dob  (User.find)
 *
 * Interval convention (STANDARDISED across the module):
 *   Every helper accepts (from, to) as INCLUSIVE UTC-midnight Dates.
 *   Internally we normalise via startOfDay() and compare occDate in
 *   [from, to].  No half-open intervals.  No mixed inclusive/exclusive
 *   boundaries.  If a caller has "next N days" semantics, use
 *   inclusiveRange(today, N) below.
 *
 * Classification is MUTUALLY EXCLUSIVE, checked in this order so the
 * buckets always partition:
 *
 *   birthday -> occ.source==='user_dob' OR occ.type==='birthday'
 *   holiday  -> occ.isHoliday === true
 *                (covers Holiday collection AND Event isHoliday=true)
 *   event    -> everything else (festival / company_event / custom
 *                with isHoliday=false)
 *
 * The resolver never touches Notifications; it is a read-only layer.
 */
const Event   = require('../models/Event');
const Holiday = require('../models/Holiday');
const User    = require('../models/User');
const { startOfDay, addDays } = require('../utils/dateHelpers');

/* ------------------------------------------------------------------ */
/* Interval helpers                                                     */
/* ------------------------------------------------------------------ */
/** Normalise a caller-provided value to a UTC-midnight Date. */
const _norm = (d) => startOfDay(d instanceof Date ? d : new Date(d));

/** Same MM-DD as `d` but in `year` (UTC). */
const _sameDayInYear = (d, year) => new Date(Date.UTC(year, d.getUTCMonth(), d.getUTCDate()));

/** YYYY-MM-DD key for maps/sets. */
const _iso = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * "Next N days starting today" convenience for widgets/analytics.
 * Returns { from, to } as INCLUSIVE UTC-midnight bounds where `to` is
 * today + (days - 1).  So `inclusiveRange(today, 30)` covers exactly
 * 30 calendar days ending today+29 inclusive.
 */
const inclusiveRange = (today, days) => {
  const from = _norm(today);
  const to   = _norm(addDays(from, Math.max(1, Number(days) || 1) - 1));
  return { from, to };
};

/* ------------------------------------------------------------------ */
/* Per-source resolvers                                                 */
/* ------------------------------------------------------------------ */
/**
 * Expand one Event document to every occurrence inside [from, to]
 * inclusive.  Yearly-recurring events emit one occurrence per matching
 * calendar year in range.  Returns [] if none match.
 */
const _expandEvent = (ev, from, to) => {
  const start = startOfDay(ev.startDate);
  const end   = ev.endDate ? startOfDay(ev.endDate) : start;
  const span  = Math.max(0, Math.round((end - start) / 86400000));
  const emit = (occStart) => {
    const occEnd = addDays(occStart, span);
    // Any overlap with [from, to] counts.
    if (occEnd < from || occStart > to) return null;
    return { occStart, occEnd };
  };
  const rows = [];
  if (!ev.repeatYearly) {
    const r = emit(start);
    if (r) rows.push(r);
  } else {
    for (let y = from.getUTCFullYear() - 1; y <= to.getUTCFullYear() + 1; y += 1) {
      const r = emit(_sameDayInYear(start, y));
      if (r) rows.push(r);
    }
  }
  return rows;
};

/** Fetch every Holiday-collection row overlapping [from, to] inclusive. */
const _holidaysInRange = async (from, to) => Holiday.find({
  date: { $gte: from, $lte: to },
}).lean();

/** Fetch every Event and expand into occurrences inside [from, to]. */
const _eventsInRange = async (from, to) => {
  const stored = await Event.find({}).lean();
  const out = [];
  for (const ev of stored) {
    for (const occ of _expandEvent(ev, from, to)) out.push({ ev, ...occ });
  }
  return out;
};

/**
 * Auto-derived birthdays for active employees with User.dateOfBirth
 * set.  A stored Event of type='birthday' for the same user in the
 * same year is de-duplicated (stored wins so audience / description
 * survive).  Returns occurrences already in [from, to] inclusive.
 */
const _autoBirthdaysInRange = async (from, to, storedBirthdayIds) => {
  const employees = await User.find({
    status: 'active',
    dateOfBirth: { $exists: true, $ne: null },
  }).select('name employeeId dateOfBirth department designation').lean();
  const dedupe = storedBirthdayIds || new Set();
  const rows = [];
  for (const u of employees) {
    if (!u.dateOfBirth) continue;
    const dob = new Date(u.dateOfBirth);
    for (let y = from.getUTCFullYear() - 1; y <= to.getUTCFullYear() + 1; y += 1) {
      const occ = _sameDayInYear(dob, y);
      if (occ < from || occ > to) continue;
      const key = `${String(u._id)}:${y}`;
      if (dedupe.has(key)) continue;
      rows.push({
        id: `birthday:${u._id}:${y}`,
        source: 'user_dob',
        type: 'birthday',
        title: `${u.name}'s Birthday`,
        description: `${u.name} (${u.employeeId})`,
        occStart: occ,
        occEnd: occ,
        isHoliday: false,        // birthdays NEVER stop work per spec.
        repeatYearly: true,
        linkedEmployee: u._id,
        linkedEmployeeName: u.name,
        notify: true,
        notifyOffsets: [0],
        audience: 'everyone',
        raw: null,
      });
    }
  }
  return rows;
};

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */
/**
 * Return every occurrence in [from, to] inclusive, drawn from all
 * three sources, normalised to the shape below and sorted by date.
 *
 *   { id, source, type, title, description, occStart, occEnd,
 *     isHoliday, repeatYearly, linkedEmployee, linkedEmployeeName,
 *     notify, notifyOffsets, audience, audienceDepartment,
 *     audienceDesignation, audienceEmployees, raw }
 *
 * `id` is a stable string suitable for React keys.  `raw` is the
 * underlying Mongo document (or null for auto-birthdays).
 */
const resolveOccurrences = async ({ from, to }) => {
  const f = _norm(from);
  const t = _norm(to);
  if (t < f) return [];

  const [holidays, events] = await Promise.all([
    _holidaysInRange(f, t),
    _eventsInRange(f, t),
  ]);

  const out = [];

  // Holiday collection -> occurrences.
  for (const h of holidays) {
    const d = startOfDay(h.date);
    out.push({
      id: `holiday:${h._id}`,
      source: 'holiday',
      type: 'holiday',
      title: h.name,
      description: h.description || '',
      occStart: d,
      occEnd: d,
      isHoliday: true,
      repeatYearly: false,
      linkedEmployee: null,
      linkedEmployeeName: '',
      notify: false,
      notifyOffsets: [],
      audience: 'everyone',
      raw: h,
    });
  }

  // Track stored birthdays so we don't emit an auto-birthday for the
  // same (user, year) pair.
  const storedBirthdayKeys = new Set();

  // Event collection -> occurrences.
  for (const { ev, occStart, occEnd } of events) {
    // Every stored birthday event has isHoliday forced to false at
    // the controller layer, so we don't need to re-normalise here.
    out.push({
      id: `event:${ev._id}:${_iso(occStart)}`,
      source: 'event',
      type: ev.type,
      title: ev.title,
      description: ev.description || '',
      occStart,
      occEnd,
      isHoliday: !!ev.isHoliday,
      repeatYearly: !!ev.repeatYearly,
      linkedEmployee: ev.linkedEmployee || null,
      linkedEmployeeName: '',   // populated on-demand by consumers if needed
      notify: ev.notify !== false,
      notifyOffsets: ev.notifyOffsets || [0],
      audience: ev.audience || 'everyone',
      audienceDepartment: ev.audienceDepartment || null,
      audienceDesignation: ev.audienceDesignation || null,
      audienceEmployees: ev.audienceEmployees || [],
      raw: ev,
    });
    if (ev.type === 'birthday' && ev.linkedEmployee) {
      storedBirthdayKeys.add(`${String(ev.linkedEmployee)}:${occStart.getUTCFullYear()}`);
    }
  }

  // Auto birthdays (de-duplicated against stored birthday events).
  const autoBdays = await _autoBirthdaysInRange(f, t, storedBirthdayKeys);
  out.push(...autoBdays);

  out.sort((a, b) => a.occStart - b.occStart);
  return out;
};

/**
 * Classify one occurrence into a mutually-exclusive bucket.  Order of
 * checks matters -- birthday first, then holiday, then event.
 */
const classify = (occ) => {
  if (!occ) return 'event';
  if (occ.source === 'user_dob' || occ.type === 'birthday') return 'birthday';
  if (occ.isHoliday) return 'holiday';
  return 'event';
};

/**
 * Partition a list of occurrences into { birthdays, holidays, events }
 * with a total.  The three buckets never overlap so the total is the
 * simple sum -- no double-counting, no manual arithmetic at the
 * consumer.
 */
const bucketize = (occurrences) => {
  const out = { birthdays: 0, holidays: 0, events: 0, total: 0 };
  for (const o of occurrences) {
    const b = classify(o);
    if (b === 'birthday') out.birthdays += 1;
    else if (b === 'holiday') out.holidays += 1;
    else out.events += 1;
  }
  out.total = out.birthdays + out.holidays + out.events;
  return out;
};

/* ------------------------------------------------------------------ */
/* Engine helpers -- "is this day a holiday for work-stop purposes?"    */
/* ------------------------------------------------------------------ */
/**
 * Build a Set<YYYY-MM-DD> of every day in [from, to] inclusive that
 * counts as a work-stop holiday.  Includes Holiday collection AND
 * every Event occurrence with isHoliday=true (yearly recurrence
 * expanded).  Used by workingDays, salary, submission guards etc.
 */
const holidayDaySet = async (from, to) => {
  const occs = await resolveOccurrences({ from, to });
  const set = new Set();
  for (const o of occs) {
    if (!o.isHoliday) continue;
    // Multi-day spans (rare -- only Event rows have endDate) stamp
    // every day.
    for (let t = o.occStart.getTime(); t <= o.occEnd.getTime(); t += 86400000) {
      set.add(_iso(new Date(t)));
    }
  }
  return set;
};

/**
 * Fast per-day check: returns { name } if the given day is a
 * unified holiday, otherwise null.  Preferred over ad-hoc
 * `Holiday.findOne({ date })` calls scattered across controllers.
 */
const isHolidayOn = async (day) => {
  const d = _norm(day);
  const occs = await resolveOccurrences({ from: d, to: d });
  const hit = occs.find((o) => o.isHoliday);
  return hit ? { name: hit.title } : null;
};

module.exports = {
  inclusiveRange,
  resolveOccurrences,
  classify,
  bucketize,
  holidayDaySet,
  isHolidayOn,
};
