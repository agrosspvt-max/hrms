/**
 * eventHolidays -- backwards-compatible thin bridge.
 *
 * Phase 73: the original file duplicated Event expansion / yearly
 * recurrence logic against `services/eventOccurrences.js`.  The
 * duplication is removed; both exports now delegate to the shared
 * resolver so there is exactly ONE place where "is this day a holiday
 * because of an Event with isHoliday=true?" is decided.
 *
 * NOTE: the returned Map preserves the old string-ISO key format so
 * existing callers (dailyEngine.generateDailyForEmployee +
 * dailyEngine.deriveAttendance) work unchanged.
 */
const { holidayDaySet, isHolidayOn: _isHolidayOn, resolveOccurrences } = require('../services/eventOccurrences');
const { startOfDay, addDays } = require('./dateHelpers');

/**
 * Map<isoDate, { name }> of EVENT-driven holidays (Event.isHoliday=true)
 * inside [from, to).  Historical signature: half-open [from, to).  We
 * convert to the resolver's inclusive [from, to] internally and drop
 * the upper boundary day to preserve the original semantics.
 */
const getEventHolidayMap = async (from, to) => {
  const fromIn = startOfDay(from);
  const toEx   = startOfDay(to);           // caller's exclusive upper
  // Resolver uses inclusive [from, to]; subtract one day to match the
  // legacy half-open contract.
  const toIn = addDays(toEx, -1);
  const map = new Map();
  if (toIn < fromIn) return map;
  const occs = await resolveOccurrences({ from: fromIn, to: toIn });
  for (const o of occs) {
    // Only Event-sourced holidays here -- Holiday-collection rows are
    // fetched separately by the legacy engine sites to keep the
    // original two-step merge behaviour intact.
    if (o.source !== 'event' || !o.isHoliday) continue;
    for (let t = o.occStart.getTime(); t <= o.occEnd.getTime(); t += 86400000) {
      const d = new Date(t);
      if (d >= fromIn && d <= toIn) map.set(d.toISOString(), { name: o.title });
    }
  }
  return map;
};

/** True (with name) if an event marks this single day as a holiday. */
const isEventHolidayOn = async (day) => {
  const hit = await _isHolidayOn(day);
  // The unified helper returns holidays from EITHER source; the legacy
  // consumer of this function only wanted Event-driven holidays (the
  // Holiday collection is queried separately alongside).  Filter to
  // Event source only to preserve exact behaviour.
  if (!hit) return null;
  const d = startOfDay(day);
  const occs = await resolveOccurrences({ from: d, to: d });
  const eventHit = occs.find((o) => o.isHoliday && o.source === 'event');
  return eventHit ? eventHit.title : null;
};

/**
 * Phase 73 addition: canonical day-set used by everything that needs
 * "unified holiday" semantics (Holiday collection + Event.isHoliday).
 * Callers should prefer this over the legacy pair above.
 */
const unifiedHolidayDaySet = holidayDaySet;

module.exports = { getEventHolidayMap, isEventHolidayOn, unifiedHolidayDaySet };
