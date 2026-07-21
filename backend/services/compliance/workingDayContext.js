/**
 * workingDayContext.js -- per-tick working-day preload for the
 * compliance scheduler.
 *
 * Split into two disjoint, non-cacheable-across-employees layers:
 *
 *   1. GLOBAL context  (company-wide, identical for every employee):
 *        - holidaySet: Set<YYYY-MM-DD> of company holidays for the tick day.
 *      Loaded ONCE per tick via `loadGlobalWorkingDayContext(day)`.
 *
 *   2. EMPLOYEE leave map  (per-employee approved leaves for the day):
 *        - Map<employeeIdString, Set<YYYY-MM-DD>>
 *      Loaded ONCE per rule per tick via `loadEmployeeLeaveMap(empIds, day)`
 *      using a single `Leave.find({ employee: {$in: empIds}, ... })` query.
 *
 * `composeContext({ globalCtx, employee, employeeLeaveMap })` builds
 * the per-employee ctx object that `utils/workingDays.isWorkingDay`
 * accepts.  Crucially, the compose function reads leaves via
 * `employeeLeaveMap.get(String(employee._id))` -- a missing key
 * yields an empty Set, never another employee's Set.
 *
 * Why this design fixes the Batch-2 #11 defect:
 *   - The previous cache keyed the WHOLE context (including
 *     leaveDaySet) by the employee's weeklyOff pattern.  Two
 *     employees with the same weeklyOff shared the same cached
 *     leaveDaySet, so employee B could inherit employee A's
 *     approved-leave days.
 *   - Splitting the context makes leaveDaySet employee-parameterised
 *     by construction; there is no shared cache to leak across
 *     employees.  Holidays are the only shared piece, and they are
 *     genuinely global.
 *
 * Performance: for a tick covering N employees under M rules,
 * this issues 1 holiday query + M leave queries.  Total cost is
 * O(N) rows returned, O(1) round-trips per rule.
 */

const mongoose = require('mongoose');
const { startOfDay } = require('../../utils/dateHelpers');

const DAY_MS = 24 * 60 * 60 * 1000;
const _iso = (d) => new Date(d).toISOString().slice(0, 10);

// Skip Mongo reads entirely when the connection is not open --
// this keeps unit tests (and offline / probe-mode boots) from
// hanging on Mongoose's default 10 s buffering timeout.  In
// production the connection is open before the scheduler ever
// runs a tick, so this short-circuit is invisible.
const _mongoConnected = () => mongoose.connection && mongoose.connection.readyState === 1;

// Test harnesses (see services/compliance/__tests__/_stubMongo.js)
// install in-memory model shims that bypass Mongo entirely.  When
// present on a model, its `_stubbedByStubMongo` marker is truthy;
// we take the "connected" path and let the stub answer.  The
// broader `_testModeActive()` signal covers non-model services
// (e.g. eventOccurrences.holidayDaySet is monkey-patched, not
// stubbed).
const _isStubbed = (Model) => !!(Model && Model._stubbedByStubMongo);
const _testModeActive = () => {
  try {
    // Optional dep; only present under test.
    // eslint-disable-next-line global-require
    return require('./__tests__/_stubMongo').isTestMode();
  } catch (_) { return false; }
};

/**
 * Load the company-wide (employee-agnostic) portion of the
 * working-day context for one tick day.
 */
const loadGlobalWorkingDayContext = async (day) => {
  const d = startOfDay(day);
  let holidaySet = new Set();
  if (!_mongoConnected() && !_testModeActive()) return { day: d, holidaySet };
  try {
    const { holidayDaySet } = require('../eventOccurrences');
    holidaySet = await holidayDaySet(d, d);
  } catch (e) {
    console.error('[compliance/workingDayContext] holidaySet load failed:', e.message);
    holidaySet = new Set();
  }
  return { day: d, holidaySet };
};

/**
 * Load approved leaves for every in-scope employee in ONE query.
 * Returns Map<empIdString, Set<YYYY-MM-DD>>.  Employees with no
 * approved leave covering `day` are simply absent from the map --
 * `composeContext` treats that as an empty leaveDaySet.
 *
 * Splitting the map by employee at build time ensures a lookup for
 * employee B never yields employee A's Set.
 */
const loadEmployeeLeaveMap = async (empIds, day) => {
  const map = new Map();
  if (!empIds || !empIds.length) return map;
  const d = startOfDay(day);
  // Same short-circuit as the global loader: if the connection is
  // not open, return an empty map so detectors don't stall.  Test
  // harnesses that install a Leave stub on the model override this
  // path by monkey-patching Leave.find directly (readyState check
  // below still succeeds when the stub is installed on top of a
  // live connection, and the stub's find() bypasses Mongo entirely).
  const Leave = require('../../models/Leave');
  if (!_mongoConnected() && !_isStubbed(Leave)) return map;
  let leaves = [];
  try {
    leaves = await Leave.find({
      employee: { $in: empIds },
      status: 'approved',
      fromDate: { $lte: d },
      toDate:   { $gte: d },
    }).select('employee fromDate toDate').lean();
  } catch (e) {
    console.error('[compliance/workingDayContext] leave load failed:', e.message);
    return map;   // detectors fall back to "no leave data" -> conservative
  }
  for (const lv of leaves) {
    const k = String(lv.employee);
    let set = map.get(k);
    if (!set) { set = new Set(); map.set(k, set); }
    let t = startOfDay(lv.fromDate).getTime();
    const stop = startOfDay(lv.toDate).getTime();
    let hops = 0;
    while (t <= stop && hops++ < 366) {
      set.add(_iso(new Date(t)));
      t += DAY_MS;
    }
  }
  return map;
};

/**
 * Compose the per-employee ctx shape that `isWorkingDay(day, ctx)`
 * expects.  Reads leaveDaySet by EXPLICIT employeeId lookup --
 * never falls back to another employee's Set.
 */
const composeContext = ({ globalCtx, employee, employeeLeaveMap }) => {
  const weeklyOff = (employee && Array.isArray(employee.weeklyOff))
    ? employee.weeklyOff
    : [0];
  const holidaySet = (globalCtx && globalCtx.holidaySet) || new Set();
  const key = employee && employee._id ? String(employee._id) : null;
  const leaveDaySet = (key && employeeLeaveMap && employeeLeaveMap.get(key))
    || new Set();
  return { weeklyOff, holidaySet, leaveDaySet };
};

module.exports = {
  loadGlobalWorkingDayContext,
  loadEmployeeLeaveMap,
  composeContext,
};
