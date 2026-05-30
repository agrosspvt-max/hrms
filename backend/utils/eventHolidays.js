/**
 * eventHolidays - thin bridge used by the daily engine so events flagged
 * `isHoliday=true` stop work generation alongside the existing Holiday
 * model.  Birthdays are guaranteed to NEVER set isHoliday at the
 * controller layer, so the rules in the spec are enforced end-to-end.
 */
const Event = require('../models/Event');
const { startOfDay, addDays, eachDay } = require('./dateHelpers');

const sameDayInYear = (d, year) => new Date(Date.UTC(year, d.getUTCMonth(), d.getUTCDate()));

/**
 * Walk yearly-recurring + one-off events that have isHoliday=true and
 * return a Map<YMD, { name }> covering [from, to).
 */
const getEventHolidayMap = async (from, to) => {
  const evs = await Event.find({ isHoliday: true }).lean();
  const map = new Map();
  const stamp = (d, name) => map.set(d.toISOString(), { name });
  for (const ev of evs) {
    const start = startOfDay(ev.startDate);
    const end = ev.endDate ? startOfDay(ev.endDate) : start;
    const span = Math.max(0, Math.round((end - start) / 86400000));
    const occurrences = [];
    if (ev.repeatYearly) {
      for (let y = from.getUTCFullYear() - 1; y <= to.getUTCFullYear() + 1; y += 1) {
        const occStart = sameDayInYear(start, y);
        const occEnd = addDays(occStart, span);
        if (occEnd >= from && occStart < to) occurrences.push([occStart, occEnd]);
      }
    } else if (end >= from && start < to) {
      occurrences.push([start, end]);
    }
    for (const [s, e] of occurrences) {
      for (const day of eachDay(s, addDays(e, 1))) {
        if (day >= from && day < to) stamp(day, ev.title);
      }
    }
  }
  return map;
};

/** True (with name) if an event marks this single day as a holiday. */
const isEventHolidayOn = async (day) => {
  const d = startOfDay(day);
  const map = await getEventHolidayMap(d, addDays(d, 1));
  const hit = map.get(d.toISOString());
  return hit ? hit.name : null;
};

module.exports = { getEventHolidayMap, isEventHolidayOn };
