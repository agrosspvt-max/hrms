/**
 * dailyReviewController.js
 *
 * Phase 5 grouped-review backend.
 *
 *   - GET  /api/daily-review/grouped?date=YYYY-MM-DD&status=
 *           HR / SA / HOD feed.  Returns one card per (employee, date)
 *           with every submission + the day's reflection + review state.
 *
 *   - GET  /api/daily-review/day?employeeId=...&date=YYYY-MM-DD
 *           Full payload for one employee-day: every submission with
 *           its templateType-specific data, the reflection, the review.
 *
 *   - POST /api/daily-reflection
 *           Employee saves / updates their own day's reflection.
 *           Body: { date, selfRating, selfNote, idea }
 *
 *   - POST /api/daily-review/finalize
 *           HR / SA / HOD writes idea + notes for a day
 *           and flips every same-day submission to reviewStatus=reviewed.
 *           Body: { employeeId, date, ideaMarks,
 *                   maxIdeaMarks?,
 *                   ideaFeedback? }
 */

const asyncHandler   = require('express-async-handler');
const mongoose       = require('mongoose');
const Submission     = require('../models/Submission');
const User           = require('../models/User');
const DailyReflection= require('../models/DailyReflection');
const DailyReview    = require('../models/DailyReview');
const DependencyTask = require('../models/DependencyTask');
const Leave          = require('../models/Leave');
const Attendance     = require('../models/Attendance');
const Assignment     = require('../models/Assignment');
const Holiday        = require('../models/Holiday');
const { startOfDay } = require('../utils/dateHelpers');
const { liveSubmissionFilter } = require('../utils/submissionFilter');
const { isScheduledOn } = require('../utils/scheduleHelpers');
const { logAudit }   = require('../utils/audit');
const notify         = require('../services/notifyEvents');
// Phase 60 -- HOD visibility gate for the Employee Private Remark.
const { scrubPrivateRemark } = require('../utils/privateRemark');
// Phase 65.2 -- Submission Review honours the SAME rollout cutoff used
// by the Missed Submission compliance engine.  Any day before the
// cutoff is ignored entirely (no Expected / Submitted / Not Submitted
// counters, no cards, no missing days).  Single source of truth --
// never introduce a second date here.
const { isBeforeRollout } = require('../config/complianceRollout');

/**
 * Phase 23.3 — Attach dependent-task hand-offs to each submission so the
 * Submission Reviews UI can render "transferred to / on / status" inline
 * under the relevant task section.  Mirrors submissionController
 * .attachDependencies but keeps the keys the grouped review UI expects
 * (sourceTaskId, originalTaskName, assignedToName, transferredAt,
 * resolvedAt, currentStatus).  Read-only enrichment — never touches
 * scoring or the review pipeline.
 */
const _attachDependencies = async (submissions) => {
  if (!submissions.length) return;
  const subIds = submissions.map((s) => s._id);
  const deps = await DependencyTask.find({ sourceSubmissionId: { $in: subIds } })
    .populate('assignedTo', 'name employeeId')
    .populate('assignedBy', 'name employeeId')
    .sort({ createdAt: 1 })
    .lean();
  const bySub = new Map();
  for (const d of deps) {
    const k = String(d.sourceSubmissionId);
    if (!bySub.has(k)) bySub.set(k, []);
    bySub.get(k).push({
      _id: d._id,
      sourceTaskId: d.sourceTaskId,
      sourceKind: d.sourceKind,
      originalTaskName: d.originalTaskName || '',
      assignedToName: d.assignedTo?.name || d.assignedToName || '',
      assignedToEmployeeId: d.assignedTo?.employeeId || '',
      assignedByName: d.assignedBy?.name || d.assignedByName || '',
      assignedByEmployeeId: d.assignedBy?.employeeId || '',
      currentStatus: d.currentStatus,
      remark: d.remark || '',
      transferredAt: d.createdAt,
      resolvedAt: d.resolvedAt || null,
      resolutionHours: d.resolvedAt
        ? Math.round((new Date(d.resolvedAt) - new Date(d.waitingSince || d.createdAt)) / 36e5 * 10) / 10
        : null,
      chainId: d.chainId,
    });
  }
  submissions.forEach((s) => { s.dependencies = bySub.get(String(s._id)) || []; });
};

const _resolveDay = (raw) => startOfDay(raw ? new Date(raw) : new Date());

/**
 * Phase 63 -- Not Submitted eligibility for ONE (employee, day) pair.
 *
 * Encodes the seven-condition spec from Phase 28 in a single pure
 * function so BOTH the single-date branch (unchanged behaviour) and
 * the new range branch reuse the exact same rules.  Never touches the
 * DB itself -- the caller pre-fetches everything and passes it via
 * `ctx`.
 *
 *   ctx = {
 *     day:            Date  (UTC midnight)
 *     employee:       full employee row (weeklyOff, attendanceMode, department, designation, ...)
 *     holiday:        Holiday for `day` (or null)
 *     submitted:      boolean  -- did the employee submit for `day`?
 *     confirmed:      boolean  -- attendance_review only: did they file confirmation?
 *     leave:          approved Leave overlapping `day` (or null)
 *     assignments:    Array of Assignment docs already populated with `template`
 *     attendance:     Attendance row for `day` (or null)
 *   }
 *
 * Returns:
 *   {
 *     eligible:        boolean -- should we surface a "Not Submitted" card?
 *     onLeave:         boolean
 *     hasAssignments:  boolean -- employee was expected to submit
 *     submitted:       boolean -- alias so callers avoid re-checking
 *     scheduledToday:  Array of Assignment docs actually scheduled on `day`
 *     attendanceLabel: string  -- for the card badge
 *   }
 *
 * "Reuse the same validation logic" per spec item 12 (backward compat).
 */
const _evaluateNotSubmittedForDay = (ctx) => {
  const { day, employee: e, holiday, submitted, confirmed, leave, assignments, attendance } = ctx;

  const submittedToday = e.attendanceMode === 'attendance_review'
    ? !!confirmed
    : !!submitted;

  // Phase 65.2 -- Effective From cutoff.  Per spec the evaluation order
  // is:
  //   1. Submission exists                    -> Submitted
  //   2. Else day < Effective From            -> Ignore  (return here)
  //   3. Else Attendance says Present         -> Not Submitted
  //   4. Else if Leave                        -> On Leave
  //   5. Else                                 -> Ignore
  //
  // "Ignore" means the day contributes NOTHING to Expected Submission /
  // Submitted / Not Submitted / On Leave / cards / statistics.  The
  // callers already short-circuit when hasAssignments/onLeave/eligible
  // are all false, so returning a fully-zeroed result naturally skips
  // the day everywhere without touching either call site.
  if (!submittedToday && isBeforeRollout(day)) {
    return {
      eligible: false,
      onLeave: false,
      hasAssignments: false,
      submitted: false,
      scheduledToday: [],
      attendanceLabel: '',
      ignoredPreRollout: true,
    };
  }

  const isWeeklyOff = (e.weeklyOff || [0]).includes(day.getUTCDay());
  const nonWorking  = isWeeklyOff || !!holiday;

  const scheduledToday = (assignments || []).filter((a) => {
    if (!a.template) return false;
    if (nonWorking) {
      if (a.holidayOverride !== true) return false;
      if (a.overrideScope !== 'all') {
        const start = a.startDate ? startOfDay(a.startDate) : null;
        if (!start || start.getTime() !== day.getTime()) return false;
      }
    }
    return isScheduledOn(a, day);
  });

  // attendance_review employees don't need template assignments to
  // qualify -- their daily attendance confirmation is the work item.
  const hasAssignments = e.attendanceMode === 'attendance_review'
    ? true
    : scheduledToday.length > 0;

  const onLeave = !!leave;
  const eligible = !onLeave && !submittedToday && hasAssignments;

  const attendanceLabel = attendance
    ? attendance.status
    : (isWeeklyOff ? 'weekly_off' : (holiday ? 'holiday' : 'absent'));

  return {
    eligible,
    onLeave,
    hasAssignments,
    submitted: submittedToday,
    scheduledToday,
    attendanceLabel,
  };
};

// Phase 44.3 -- helper used by every role gate in this controller so an
// employee granted the named feature passes through the same path as
// HR / Super Admin / HOD without needing parallel branches.
const _hasFeature = (req, key) => {
  const perms = (req.user?.featurePermissions && (req.user.featurePermissions.toObject
    ? req.user.featurePermissions.toObject() : req.user.featurePermissions)) || {};
  return !!perms[key]?.enabled;
};

/* ------------------------------------------------------------------ */
/* Grouped review feed                                                 */
/* ------------------------------------------------------------------ */
/**
 * GET /api/daily-review/grouped
 *
 * Returns one card per (employee, date) for the chosen day.  Each
 * card holds every live submission for that employee, their daily
 * reflection (if any), and the daily review (if any).  HR sees
 * employee + HR submissions; SA sees everything; HOD sees their
 * own department.
 */
const listGrouped = asyncHandler(async (req, res) => {
  // Phase 49 — the endpoint accepts EITHER a single ?date OR an
  // inclusive ?from + ?to pair.  Range mode returns one card per
  // (employee, submission-date) so a 30-day range renders as N cards
  // per employee (one per submitting day) rather than a single merged
  // card.  The Mongo filter is a proper $gte/$lte range so the DB
  // never scans outside the requested window.
  const fromRaw = req.query.from;
  const toRaw   = req.query.to;
  const isRange = !!(fromRaw && toRaw);
  const dayStart = _resolveDay(isRange ? fromRaw : req.query.date);
  const dayEnd   = _resolveDay(isRange ? toRaw   : req.query.date);
  // Guard against a swapped from/to (e.g. user picked to before from).
  if (isRange && dayEnd < dayStart) {
    res.status(400);
    throw new Error('Date range: "to" must be on or after "from".');
  }
  // Cap the range at 366 days so a runaway picker can't OOM the server.
  if (isRange && (dayEnd - dayStart) / 86400000 > 366) {
    res.status(400);
    throw new Error('Date range cannot exceed 366 days.');
  }
  const status = req.query.status; // 'pending' | 'reviewed' | 'not_submitted'
  // Convenience: the Mongo clause is reused everywhere the query joins
  // on Submission.date / DailyReflection.date / DailyReview.date.
  const dateClause = isRange
    ? { $gte: dayStart, $lte: dayEnd }
    : dayStart;

  // ----- Employee scope (role-aware) -----
  const empWhere = { status: 'active' };
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role === 'super_admin') {
    // full org
  } else if (role === 'hr') {
    // full org (HR may filter via query.department)
    if (req.query.department && mongoose.Types.ObjectId.isValid(req.query.department)) {
      empWhere.department = req.query.department;
    }
  } else if (isHOD) {
    empWhere.department = req.user.hodDepartment;
  } else if (_hasFeature(req, 'submissionReviews')) {
    // Phase 44.3 -- employees granted the Submission Reviews feature
    // permission get HR-equivalent visibility.  HR may further narrow
    // via ?department; the feature-granted employee has the same
    // capability.  No department clamp is applied -- that's the HOD
    // path's job and isn't appropriate here.
    if (req.query.department && mongoose.Types.ObjectId.isValid(req.query.department)) {
      empWhere.department = req.query.department;
    }
  } else {
    res.status(403);
    throw new Error('Grouped review is restricted to HR / Super Admin / HOD / Submission Reviews feature.');
  }

  // ----- Submissions for the day OR range -----
  const subWhere = {
    submitted: true,
    date: dateClause,
    ...liveSubmissionFilter({}),
  };

  // Pull employee list first so we can scope the submission query.
  const employees = await User.find(empWhere).select('_id name employeeId role department')
    .populate('department', 'name').lean();
  const empMap = new Map(employees.map((e) => [String(e._id), e]));
  subWhere.employee = { $in: employees.map((e) => e._id) };

  // Role visibility: HR shouldn't see other HR's review queue, etc.
  // Mirror the existing listForReview role gates.
  const allowedOwnerRoles = role === 'super_admin' ? ['employee', 'hr'] : (role === 'hr' ? ['employee'] : ['employee']);

  const subs = await Submission.find(subWhere)
    .populate('template', 'title templateType customKind customSections customFields privateRemarkEnabled privateRemarkLabel privateRemarkRequired')
    .populate('assignment', 'frequency scheduleLabel')
    // Phase 16: surface the HOD reviewer's identity so HR sees who
    // approved / returned each submission without an extra round-trip.
    .populate('hodReview.reviewedBy', 'name role')
    .sort({ employee: 1, submittedAt: 1, _id: 1 })
    .lean();

  // Phase 23.3: enrich each submission with its dependent-task hand-offs.
  await _attachDependencies(subs);

  // Pre-fetch reflections + reviews for the range for the scoped employees.
  const empIds = [...new Set(subs.map((s) => String(s.employee)))];
  const [reflections, reviews] = await Promise.all([
    DailyReflection.find({ employee: { $in: empIds }, date: dateClause }).lean(),
    DailyReview.find({ employee: { $in: empIds }, date: dateClause })
      .populate('reviewedBy', 'name role').lean(),
  ]);
  // Phase 49 -- maps are keyed by (employee, date) so a range containing
  // multiple days for the same employee doesn't collapse their days
  // together.  ISO day-string is a stable, timezone-safe key.
  const _dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const refMap = new Map(reflections.map((r) => [`${String(r.employee)}__${_dayKey(r.date)}`, r]));
  const revMap = new Map(reviews.map((r)     => [`${String(r.employee)}__${_dayKey(r.date)}`, r]));

  // Group by (employee, date).
  const cards = new Map();
  for (const s of subs) {
    const e = empMap.get(String(s.employee));
    if (!e || !allowedOwnerRoles.includes(e.role)) continue;
    if (String(e._id) === String(req.user._id)) continue; // never review yourself
    const dk = _dayKey(s.date);
    const key = `${String(e._id)}__${dk}`;
    if (!cards.has(key)) {
      cards.set(key, {
        employee: { _id: e._id, name: e.name, employeeId: e.employeeId, department: e.department?.name || '' },
        date: s.date,
        submissions: [],
        reflection: refMap.get(key) || null,
        review:     revMap.get(key) || null,
      });
    }
    cards.get(key).submissions.push(s);
  }

  // Sort: newest day first, then employee name.  Single-day mode
  // degrades to just the name ordering (all cards share the same date).
  let out = [...cards.values()].sort((a, b) => {
    const dd = new Date(b.date) - new Date(a.date);
    if (dd) return dd;
    return (a.employee.name || '').localeCompare(b.employee.name || '');
  });
  if (status === 'pending')  out = out.filter((c) => !c.review || c.review.reviewStatus !== 'reviewed');
  if (status === 'reviewed') out = out.filter((c) =>  c.review && c.review.reviewStatus === 'reviewed');

  /* ====================================================================
   * Phase 28 -- Not Submitted filter
   *
   * Surface employees who were expected to submit work on this day but
   * didn't, with leave-aware exclusion and HOD scope respect.  An
   * employee qualifies as "Not Submitted" when ALL of these hold for the
   * selected date:
   *   - Active (already enforced by empWhere).
   *   - role !== 'super_admin' (filtered below).
   *   - Has at least one active assignment scheduled for the day.
   *   - Did NOT submit anything for the day.
   *   - Has NO approved leave (full OR half day) covering the day.
   *   - The day isn't a weekly off + has no holiday override (skipped by
   *     the assignment scheduling check via dailyEngine semantics).
   *
   * The response shape is intentionally an object { cards, summary } for
   * this status only -- other statuses still return a plain array for
   * backward compatibility with the existing frontend.
   * ================================================================== */
  if (status === 'not_submitted') {
    // Phase 29.5: 'auto_attendance' employees never appear in Not
    // Submitted because they don't need submissions to be marked
    // Present.  'attendance_review' employees still appear here when
    // they haven't filed their Attendance Confirmation yet.
    const empWhereNS = {
      ...empWhere,
      role: { $ne: 'super_admin' },
      attendanceMode: { $ne: 'auto_attendance' },
    };
    const fullEmployees = await User.find(empWhereNS)
      .select('_id name employeeId role department designation weeklyOff attendanceMode')
      .populate('department', 'name')
      .lean();
    const empIdList = fullEmployees.map((e) => e._id);

    // Pre-load assignments ONCE per employee, then filter per day
    // inside the evaluator -- the same input the dailyEngine uses.
    const assignmentsByEmp = new Map();
    for (const e of fullEmployees) {
      const orList = [{ targetType: 'employee', targetRef: e._id }];
      if (e.department) orList.push({ targetType: 'department', targetRef: e.department._id || e.department });
      if (e.designation) orList.push({ targetType: 'designation', targetRef: e.designation });
      const rows = await Assignment.find({ active: true, $or: orList })
        .populate('template', 'title customKind templateType privateRemarkEnabled privateRemarkLabel privateRemarkRequired').lean();
      assignmentsByEmp.set(String(e._id), rows);
    }

    const AttendanceConfirmation = require('../models/AttendanceConfirmation');
    const _dayKeyStr = (d) => new Date(d).toISOString().slice(0, 10);

    // ================================================================
    // Phase 63 -- Range branch.  When the caller is in Date Range mode
    // we iterate every day in [dayStart, dayEnd], run the SAME per-day
    // eligibility check as single-date, then aggregate per employee.
    // Single-date path (below) uses the same helper for a single day
    // so the two branches never drift.
    // ================================================================
    if (isRange) {
      // Batch-load everything we need for the whole window.
      const submissionsRange = await Submission.find({
        employee: { $in: empIdList },
        date: { $gte: dayStart, $lte: dayEnd },
        submitted: true,
        ...liveSubmissionFilter({}),
      }).select('employee date').lean();
      const submittedByEmpDay = new Set(
        submissionsRange.map((s) => `${String(s.employee)}__${_dayKeyStr(s.date)}`)
      );

      const confsRange = await AttendanceConfirmation.find({
        employee: { $in: fullEmployees.filter((e) => e.attendanceMode === 'attendance_review').map((e) => e._id) },
        date: { $gte: dayStart, $lte: dayEnd },
      }).select('employee date status').lean();
      const confirmedByEmpDay = new Set(
        confsRange.map((c) => `${String(c.employee)}__${_dayKeyStr(c.date)}`)
      );

      const leavesRange = await Leave.find({
        employee: { $in: empIdList },
        status: 'approved',
        fromDate: { $lte: dayEnd },
        toDate:   { $gte: dayStart },
      }).lean();

      const holidaysRange = await Holiday.find({
        date: { $gte: dayStart, $lte: dayEnd },
      }).lean();
      const holidayByDay = new Map(holidaysRange.map((h) => [_dayKeyStr(h.date), h]));

      // Aggregate per employee across the range.
      const perEmp = new Map(); // empId -> { employee, missingDates:[], assignmentsUnion:Map(id -> a) }
      // Range-wide summary (per-employee-day counts, not per-employee).
      const summary = { expectedToSubmit: 0, submitted: 0, notSubmitted: 0, onApprovedLeave: 0 };

      const DAY_MS = 86400000;
      for (let t = dayStart.getTime(); t <= dayEnd.getTime(); t += DAY_MS) {
        const day = new Date(t);
        const dk = _dayKeyStr(day);
        // Slice per-day inputs from the batched sets.
        const dayHoliday = holidayByDay.get(dk) || null;

        for (const e of fullEmployees) {
          if (String(e._id) === String(req.user._id)) continue;

          // Approved leave overlapping THIS day for this employee.
          const empId = String(e._id);
          const leave = leavesRange.find((lv) =>
            String(lv.employee) === empId
            && new Date(lv.fromDate) <= day
            && new Date(lv.toDate)   >= day
          ) || null;

          const result = _evaluateNotSubmittedForDay({
            day,
            employee: e,
            holiday: dayHoliday,
            submitted:  submittedByEmpDay.has(`${empId}__${dk}`),
            confirmed:  confirmedByEmpDay.has(`${empId}__${dk}`),
            leave,
            assignments: assignmentsByEmp.get(empId) || [],
            attendance: null, // range cards don't show per-day badge
          });

          // Summary buckets tally per-employee-day, matching the
          // single-date semantics extended to the window.
          if (result.onLeave) summary.onApprovedLeave += 1;
          if (!result.onLeave && result.hasAssignments) {
            summary.expectedToSubmit += 1;
            if (result.submitted) summary.submitted += 1;
            else summary.notSubmitted += 1;
          }

          if (!result.eligible) continue;

          // First time we see this employee in the range -- open bucket.
          if (!perEmp.has(empId)) {
            perEmp.set(empId, {
              employee: {
                _id: e._id,
                name: e.name,
                employeeId: e.employeeId,
                department: e.department?.name || '',
              },
              missingDates: [],
              assignmentsUnion: new Map(),
            });
          }
          const bucket = perEmp.get(empId);
          bucket.missingDates.push(day);
          // Union the assignments that were expected on any missing
          // day so the card shows the full scope.
          for (const a of result.scheduledToday) {
            bucket.assignmentsUnion.set(String(a._id), a);
          }
        }
      }

      // Build cards; sort by highest missing count first (spec).
      const cards = [...perEmp.values()]
        .map((b) => ({
          notSubmitted: true,
          isRange: true,
          employee: b.employee,
          // Preserve the first missing day as `date` so the frontend
          // (which uses `card.date` as a React key) keeps working.
          date: b.missingDates[0],
          from: dayStart,
          to:   dayEnd,
          missingCount: b.missingDates.length,
          missingDates: b.missingDates,
          assignments: [...b.assignmentsUnion.values()].map((a) => ({
            _id: a._id,
            title: a.template?.title || '(untitled)',
            templateType: a.template?.templateType || '',
            customKind: a.template?.customKind || '',
            scheduleLabel: a.scheduleLabel || '',
          })),
          attendance: null,
          leave: null,
        }))
        .sort((a, b) => (b.missingCount - a.missingCount)
                     || (a.employee.name || '').localeCompare(b.employee.name || ''));

      // Submission Review UI integration -- attach the per-day
      // missed_submission penalty IDs onto each range card so HR
      // can Send Back individual days from the aggregated view.
      try {
        const Penalty = require('../models/Penalty');
        const empIds = [...new Set(cards.map((c) => String(c.employee._id)))];
        const allDates = [...new Set(cards.flatMap((c) => (c.missingDates || []).map((d) => new Date(d).getTime())))]
          .map((t) => new Date(t));
        // Phase 65.1 rollout gate -- legacy pre-cutoff rows are
        // filtered out so the Send Back button is never shown for
        // historical missed days.
        const { MISSED_SUBMISSION_EFFECTIVE_FROM } = require('../config/complianceRollout');
        const pens = await Penalty.find({
          employee: { $in: empIds },
          category: { $in: ['missed_submission', 'absent_submission'] },
          targetDate: { $in: allDates, $gte: MISSED_SUBMISSION_EFFECTIVE_FROM },
          source: 'automatic',
          probable: false,
          archivedPreRollout: { $ne: true },
        }).select('employee targetDate reopenRequest').lean();
        const _key = (empId, d) => `${String(empId)}|${new Date(d).toISOString().slice(0, 10)}`;
        const byKey = new Map(pens.map((p) => [_key(p.employee, p.targetDate), p]));
        for (const c of cards) {
          c.missingPenalties = (c.missingDates || []).map((d) => {
            const m = byKey.get(_key(c.employee._id, d));
            return {
              date: d,
              penaltyId: m ? m._id : null,
              reopenDecision: m?.reopenRequest?.decision || '',
            };
          });
        }
      } catch (e) {
        console.error('[dailyReview] range penalty enrich:', e.message);
      }

      // Range-level summary tiles the spec calls for.
      const employeesWithMissing = cards.length;
      const totalMissingDays = cards.reduce((s, c) => s + c.missingCount, 0);
      const avgMissingDays = employeesWithMissing > 0
        ? Math.round((totalMissingDays / employeesWithMissing) * 10) / 10
        : 0;

      return res.json({
        cards,
        summary: {
          ...summary,
          // Range-specific tiles used by the top summary strip.
          employeesWithMissing,
          totalMissingDays,
          avgMissingDays,
        },
      });
    }

    // ================================================================
    // Single-date path (behaviour preserved 1:1 -- spec item 11).
    // Uses the same helper as the range branch above; the output
    // shape has never changed, so the existing UI still works.
    // ================================================================
    const day = dayEnd;
    const submittedRows = await Submission.find({
      employee: { $in: empIdList },
      date: day,
      submitted: true,
      ...liveSubmissionFilter({}),
    }).select('employee').lean();
    const submittedEmpIds = new Set(submittedRows.map((s) => String(s.employee)));

    const reviewModeConfs = await AttendanceConfirmation.find({
      employee: { $in: fullEmployees.filter((e) => e.attendanceMode === 'attendance_review').map((e) => e._id) },
      date: day,
    }).select('employee status').lean();
    const confirmedEmpIds = new Set(reviewModeConfs.map((c) => String(c.employee)));

    const leavesToday = await Leave.find({
      employee: { $in: empIdList },
      status: 'approved',
      fromDate: { $lte: day },
      toDate:   { $gte: day },
    }).lean();
    const leaveByEmp = new Map();
    for (const lv of leavesToday) {
      const k = String(lv.employee);
      if (!leaveByEmp.has(k)) leaveByEmp.set(k, lv);
    }

    const attRecords = await Attendance.find({
      employee: { $in: empIdList },
      date: day,
    }).lean();
    const attByEmp = new Map(attRecords.map((a) => [String(a.employee), a]));
    const holiday = await Holiday.findOne({ date: day });

    const notSubmittedCards = [];
    const summary = { expectedToSubmit: 0, submitted: 0, notSubmitted: 0, onApprovedLeave: 0 };
    for (const e of fullEmployees) {
      if (String(e._id) === String(req.user._id)) continue;
      const empId = String(e._id);
      const result = _evaluateNotSubmittedForDay({
        day,
        employee: e,
        holiday,
        submitted:  submittedEmpIds.has(empId),
        confirmed:  confirmedEmpIds.has(empId),
        leave:      leaveByEmp.get(empId) || null,
        assignments: assignmentsByEmp.get(empId) || [],
        attendance:  attByEmp.get(empId) || null,
      });

      if (result.onLeave) summary.onApprovedLeave += 1;
      if (!result.onLeave && result.hasAssignments) {
        summary.expectedToSubmit += 1;
        if (result.submitted) summary.submitted += 1;
        else summary.notSubmitted += 1;
      }
      if (!result.eligible) continue;
      notSubmittedCards.push({
        notSubmitted: true,
        employee: {
          _id: e._id,
          name: e.name,
          employeeId: e.employeeId,
          department: e.department?.name || '',
        },
        date: day,
        assignments: result.scheduledToday.map((a) => ({
          _id: a._id,
          title: a.template?.title || '(untitled)',
          templateType: a.template?.templateType || '',
          customKind: a.template?.customKind || '',
          scheduleLabel: a.scheduleLabel || '',
        })),
        attendance: result.attendanceLabel,
        leave: null,
      });
    }

    // Submission Review UI integration -- enrich every Not-Submitted
    // card with the (employee, date) missed_submission penalty ID +
    // reopen state so HR can click "Send Back to Employee" without
    // a second round-trip.  Uses the EXISTING Penalty collection --
    // no new schema, no new endpoint.  Card gets:
    //   penaltyId          -- the ObjectId of the missed_submission row
    //   reopenDecision     -- '' | 'pending' | 'approved' | 'rejected' |
    //                         'completed' | 'cancelled'
    // Both fields are `null` / '' when the compliance engine hasn't
    // materialised a penalty for that (employee, date) yet, in which
    // case the frontend disables the Send Back button.
    try {
      const Penalty = require('../models/Penalty');
      const empIds = [...new Set(notSubmittedCards.map((c) => String(c.employee._id)))];
      const days = [...new Set(notSubmittedCards.map((c) => new Date(c.date).getTime()))]
        .map((t) => new Date(t));
      // Phase 65.1 rollout gate.
      const { MISSED_SUBMISSION_EFFECTIVE_FROM } = require('../config/complianceRollout');
      const pens = await Penalty.find({
        employee: { $in: empIds },
        category: { $in: ['missed_submission', 'absent_submission'] },
        targetDate: { $in: days, $gte: MISSED_SUBMISSION_EFFECTIVE_FROM },
        source: 'automatic',
        probable: false,
        archivedPreRollout: { $ne: true },
      }).select('employee targetDate reopenRequest').lean();
      const _key = (empId, d) => `${String(empId)}|${new Date(d).toISOString().slice(0, 10)}`;
      const byKey = new Map(pens.map((p) => [_key(p.employee, p.targetDate), p]));
      for (const c of notSubmittedCards) {
        const match = byKey.get(_key(c.employee._id, c.date));
        c.penaltyId      = match ? match._id : null;
        c.reopenDecision = match?.reopenRequest?.decision || '';
      }
    } catch (e) {
      console.error('[dailyReview] penalty enrich:', e.message);
    }

    return res.json({ cards: notSubmittedCards, summary });
  }

  // Phase 60 -- scrub Private Remark from every submission in every
  // card before responding.  HR/SA see everything; HOD + feature-
  // granted reviewers get the field zeroed out.  Self-view isn't a
  // concern here because the grouped feed never returns cards for the
  // current caller.
  for (const c of out) scrubPrivateRemark(c.submissions || [], req.user);
  res.json(out);
});

/* ------------------------------------------------------------------ */
/* Full payload for one (employee, date)                               */
/* ------------------------------------------------------------------ */
const getDay = asyncHandler(async (req, res) => {
  const { employeeId, date } = req.query;
  if (!mongoose.Types.ObjectId.isValid(employeeId)) {
    res.status(400); throw new Error('Valid employeeId is required.');
  }
  const day = _resolveDay(date);

  const employee = await User.findById(employeeId).populate('department', 'name').lean();
  if (!employee) { res.status(404); throw new Error('Employee not found.'); }

  // HOD clamp: HOD can only fetch their own department.
  if (req.user.role !== 'hr' && req.user.role !== 'super_admin') {
    if (!req.user.isHOD || String(employee.department?._id || employee.department) !== String(req.user.hodDepartment)) {
      res.status(403); throw new Error('You may not view this employee.');
    }
  }

  const [submissions, reflection, review] = await Promise.all([
    Submission.find({ employee: employee._id, date: day, ...liveSubmissionFilter({}) })
      .populate('template', 'title templateType customKind customSections customFields privateRemarkEnabled privateRemarkLabel privateRemarkRequired')
      .populate('assignment', 'frequency scheduleLabel')
      .populate('hodReview.reviewedBy', 'name role')
      .sort({ submittedAt: 1, _id: 1 }).lean(),
    DailyReflection.findOne({ employee: employee._id, date: day }).lean(),
    DailyReview.findOne({ employee: employee._id, date: day }).populate('reviewedBy', 'name role').lean(),
  ]);

  // Phase 23.3: enrich submissions with dependent-task hand-offs.
  await _attachDependencies(submissions);

  // Phase 60 -- HOD scrub before responding.
  scrubPrivateRemark(submissions, req.user);
  res.json({ employee, date: day, submissions, reflection: reflection || null, review: review || null });
});

/* ------------------------------------------------------------------ */
/* Employee saves their own day's reflection                           */
/* ------------------------------------------------------------------ */
const saveReflection = asyncHandler(async (req, res) => {
  const { date, selfRating, selfNote, idea } = req.body || {};
  const day = _resolveDay(date);
  const $set = { lastEditedBy: req.user._id };
  if (selfRating !== undefined) $set.selfRating = selfRating === '' ? undefined : Number(selfRating);
  if (selfNote   !== undefined) $set.selfNote   = String(selfNote || '');
  if (idea       !== undefined) $set.idea       = String(idea || '');
  const doc = await DailyReflection.findOneAndUpdate(
    { employee: req.user._id, date: day },
    { $set, $setOnInsert: { employee: req.user._id, date: day } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  res.json(doc);
});

/* ------------------------------------------------------------------ */
/* HR finalises a day's idea                              */
/* ------------------------------------------------------------------ */
const finalizeDay = asyncHandler(async (req, res) => {
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin' && !isHOD && !_hasFeature(req, 'submissionReviews')) {
    res.status(403); throw new Error('Only HR / Super Admin / HOD / Submission Reviews feature may finalise a daily review.');
  }
  const { employeeId, date } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(employeeId)) {
    res.status(400); throw new Error('Valid employeeId is required.');
  }
  const day = _resolveDay(date);
  if (String(employeeId) === String(req.user._id)) {
    res.status(403); throw new Error('You cannot finalise your own review.');
  }
  const employee = await User.findById(employeeId).select('department role').lean();
  if (!employee) { res.status(404); throw new Error('Employee not found.'); }

  // HOD clamp + role gates (mirror existing reviewSubmission semantics).
  if (isHOD && role !== 'hr' && role !== 'super_admin') {
    if (String(employee.department) !== String(req.user.hodDepartment)) {
      res.status(403); throw new Error('Department clamp: not your department.');
    }
  }
  if (role === 'hr' && employee.role === 'hr') {
    res.status(403); throw new Error('Only a Super Admin can finalise HR reviews.');
  }
  if (employee.role === 'super_admin') {
    res.status(403); throw new Error('Super Admin submissions are auto-finalised.');
  }

  const subs = await Submission.find({
    employee: employee._id, date: day, submitted: true, ...liveSubmissionFilter({}),
  }).sort({ submittedAt: 1, _id: 1 });
  if (subs.length === 0) {
    res.status(400); throw new Error('No submissions found for this employee on the given day.');
  }

  // Clamp the awarded marks to the configured maxima.
  const maxIdea = Number(req.body.maxIdeaMarks ?? 2);
  const idea    = Math.max(0, Math.min(Number(req.body.ideaMarks) || 0, maxIdea));
  const ideaFeedback = String(req.body.ideaFeedback || '').trim();

  // Primary submission = first chronological (already sorted).
  const primary = subs[0];

  // Phase 26 — workflow gating.  A "pure HOD" is a HOD account that is
  // NOT also HR or Super Admin.  Their finalisation is a recommendation
  // step (hodReview), not the real HR finalisation: it must NOT flip the
  // submission to reviewStatus='reviewed' or stage='finalized', because
  // doing so would surface the day as "HR Reviewed" on HR / SA accounts
  // before HR has actually acted.  HR + SA paths keep the existing
  // finalisation behaviour exactly as it was.
  const isPureHOD = isHOD && role !== 'hr' && role !== 'super_admin';

  // Persist the DailyReview doc.  This is the SINGLE SOURCE OF TRUTH
  // for the day.s innovation marks.  Per-submission rows
  // are NEVER touched -- they carry only their own work scoring.
  // Analytics, salary, employee history all read DailyReview directly
  // for the day-level marks (see analyticsController.completion,
  // salaryController.computeSlip, dashboardController.employeeSummary).
  // For HOD recommendations we save the marks (so HR can see what was
  // proposed and override if needed) but keep reviewStatus='pending'
  // so analytics / dashboards don't treat the day as finalised.
  const review = await DailyReview.findOneAndUpdate(
    { employee: employee._id, date: day },
    {
      $set: {
        ideaMarks: idea, maxIdeaMarks: maxIdea, ideaFeedback: ideaFeedback,
        reviewedBy: req.user._id, reviewedAt: new Date(),
        reviewStatus: isPureHOD ? 'pending' : 'reviewed',
        // Kept for the rare audit-trail use case; not used by any
        // analytics path anymore.
        primarySubmissionId: primary._id,
      },
      $setOnInsert: { employee: employee._id, date: day },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // ---- Per-submission updates -------------------------------------
  // HR / SA path (unchanged): flip to reviewed + finalized so the
  // existing review pipeline + Submission Control's reviewStatus
  // filters reflect the finalised day.
  //
  // HOD path (Phase 26): write hodReview block + set stage to
  // 'hod_reviewed' so HR / SA see "HOD Approved — Awaiting HR".  Leave
  // reviewStatus untouched (stays pending) and never write to the
  // top-level reviewedBy / reviewedAt — those are HR-only audit fields.
  for (const s of subs) {
    if (isPureHOD) {
      s.hodReview = {
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        recommend:  'approve',
        marksGiven: true,
        remarks:    ideaFeedback || s.hodReview?.remarks || '',
      };
      s.currentReviewStage = 'hod_reviewed';
      // Do NOT touch reviewStatus / reviewedBy / reviewedAt / earned -
      // those reflect HR finalisation only.
      s.reviewHistory = s.reviewHistory || [];
      s.reviewHistory.push({
        reviewedBy: req.user._id,
        reviewerName: req.user.name,
        role,
        stage: 'hod_reviewed',
        action: 'daily_hod_review',
        marks: idea,
        remarks: ideaFeedback || '',
        timestamp: new Date(),
      });
      await s.save();
      continue;
    }
    // HR / SA path -- existing behaviour.
    s.reviewStatus = 'reviewed';
    s.currentReviewStage = 'finalized';
    s.reviewedBy = req.user._id;
    s.reviewedAt = new Date();
    // Re-derive cached scores as work-only so re-finalising stays
    // idempotent even if a prior version of the code wrote daily
    // marks into per-sub fields.  The migration backfill (pass 3)
    // does the same collapse for historical rows.
    s.earnedPoints = Number(s.workEarnedPoints) || 0;
    s.totalPoints  = Number(s.workTotalPoints)  || 0;
    s.completionPercentage = s.totalPoints > 0 ? (s.earnedPoints / s.totalPoints) * 100 : 0;
    s.reviewHistory = s.reviewHistory || [];
    s.reviewHistory.push({
      reviewedBy: req.user._id,
      reviewerName: req.user.name,
      role: role,
      stage: 'finalized',
      action: 'daily_finalize',
      // Marks audit field captures the DAY-LEVEL total, not per-sub.
      marks: idea,
      remarks: ideaFeedback || '',
      timestamp: new Date(),
    });
    await s.save();
  }

  // Notify the employee ONLY when HR / SA truly finalises the day.
  // HOD action is a recommendation -- firing a "review complete"
  // notification at that point would misrepresent the workflow stage.
  if (!isPureHOD) {
    try {
      notify.notifySubmissionReviewed({
        employeeId: employee._id,
        submission: { date: day },
        reviewedBy: req.user,
      });
    } catch (_) { /* notify never blocks */ }
  }

  logAudit(req, {
    action: 'daily-review.finalize',
    targetType: 'DailyReview',
    targetId: review._id,
    targetLabel: `${employee._id} · ${day.toISOString().slice(0, 10)}`,
    meta: { ideaMarks: idea, submissionCount: subs.length, primarySubmissionId: primary._id },
  });

  res.json({ ok: true, review, submissionCount: subs.length, primarySubmissionId: primary._id });
});

/* ------------------------------------------------------------------ */
/* Per-task status edit (HR / SA / HOD)                                */
/*                                                                     */
/* Phase 10: reviewers need to flip a single task's status (e.g. an   */
/* employee marked "Done" on a task they didn't actually complete).    */
/* This endpoint patches the row, optionally captures a pending        */
/* reason, recomputes workEarnedPoints + workTotalPoints + cached      */
/* earnedPoints / completionPercentage, and audits the change.         */
/*                                                                     */
/* Marks pipeline preserved:                                           */
/*   - Same scoring formula the existing reviewSubmission uses:        */
/*     done/ongoing earn points + count toward total; pending counts   */
/*     toward total only; work_not_available counts neither.           */
/*   - HR-defined rows use their template `points`; employee-added     */
/*     rows use `awardedMarks`.                                        */
/*                                                                     */
/* Idea (innovation) marks live exclusively on DailyReview, so this endpoint */
/* never touches them.                                                 */
/* ------------------------------------------------------------------ */
const ALLOWED_TASK_STATUSES = ['done', 'ongoing', 'pending', 'work_not_available', 'pending_submit'];

const editTaskStatus = asyncHandler(async (req, res) => {
  const { submissionId, taskId, status, pendingReason } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    res.status(400); throw new Error('Valid submissionId is required.');
  }
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    res.status(400); throw new Error('Valid taskId is required.');
  }
  if (!ALLOWED_TASK_STATUSES.includes(status)) {
    res.status(400); throw new Error(`status must be one of: ${ALLOWED_TASK_STATUSES.join(', ')}`);
  }
  const sub = await Submission.findById(submissionId);
  if (!sub) { res.status(404); throw new Error('Submission not found.'); }
  if (sub.templateType !== 'task') {
    res.status(400); throw new Error('This endpoint only edits task-template submissions.');
  }

  // Role gate -- mirror the finalizeDay rules so HOD can only edit
  // their own department's submissions.
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin' && !isHOD && !_hasFeature(req, 'submissionReviews')) {
    res.status(403); throw new Error('Only HR / Super Admin / HOD / Submission Reviews feature may edit task status.');
  }
  if (String(sub.employee) === String(req.user._id)) {
    res.status(403); throw new Error('You cannot edit your own submission.');
  }
  const owner = await User.findById(sub.employee).select('role department').lean();
  if (!owner) { res.status(404); throw new Error('Submission owner not found.'); }
  if (role === 'hr' && (owner.role === 'hr' || owner.role === 'super_admin')) {
    res.status(403); throw new Error('Only Super Admin can edit HR submissions.');
  }
  if (isHOD && role !== 'hr' && role !== 'super_admin') {
    if (String(owner.department) !== String(req.user.hodDepartment)) {
      res.status(403); throw new Error('Department clamp: not your department.');
    }
  }

  const task = (sub.tasks || []).id(taskId);
  if (!task) { res.status(404); throw new Error('Task row not found on this submission.'); }

  const oldStatus = task.status;
  const oldReason = task.pendingReason || '';

  // Pending-since stamping: if we're flipping INTO pending, set
  // pendingSince now (matches the daily engine's first-seen semantic).
  if (status === 'pending' && oldStatus !== 'pending') {
    task.pendingSince = task.pendingSince || new Date();
  }
  // Clear completedAt when moving out of done/ongoing back to pending.
  if (status !== 'done' && status !== 'ongoing') {
    task.completedAt = undefined;
  } else if (!task.completedAt && (status === 'done' || status === 'ongoing')) {
    task.completedAt = new Date();
  }
  task.status = status;
  task.pendingReason = status === 'pending'
    ? String(pendingReason || oldReason || '').trim()
    : '';

  sub.markModified('tasks');

  // Recompute work scoring -- same formula reviewSubmission uses.
  let earned = 0, total = 0;
  for (const t of sub.tasks) {
    if (t.addedByEmployee) {
      const awarded = Number(t.awardedMarks) || 0;
      earned += awarded;
      total  += awarded;
    } else {
      if (t.status === 'done' || t.status === 'ongoing') earned += Number(t.points) || 0;
      if (t.status === 'done' || t.status === 'ongoing' || t.status === 'pending') {
        total += Number(t.points) || 0;
      }
    }
  }
  sub.workEarnedPoints = earned;
  sub.workTotalPoints  = total;
  // Cached earned/total are WORK-ONLY (Phase 6 -- idea
  // live on DailyReview).  Daily totals fold in at analytics time.
  sub.earnedPoints = earned;
  sub.totalPoints  = total;
  sub.completionPercentage = total > 0 ? (earned / total) * 100 : 0;

  // Edit history -- captures who/what/when so HR audit log + edit
  // history surface the change.
  sub.editHistory = sub.editHistory || [];
  sub.editHistory.push({
    editedBy: req.user._id,
    editorName: req.user.name,
    role,
    fields: [`tasks.${taskId}.status`],
    note: `${oldStatus} → ${status}${status === 'pending' && task.pendingReason ? ` · reason: ${task.pendingReason}` : ''}`,
    timestamp: new Date(),
  });

  await sub.save();

  logAudit(req, {
    action: 'submission.task-status-edit',
    targetType: 'Submission',
    targetId: sub._id,
    targetLabel: `${owner._id} · ${String(sub.date).slice(0, 10)}`,
    meta: { taskId: String(taskId), from: oldStatus, to: status, pendingReason: task.pendingReason || '' },
  });

  res.json({ ok: true, submission: sub });
});

/* ------------------------------------------------------------------ */
/* Phase 23.7 — Extra work scoring                                      */
/*                                                                      */
/* Lets HR / SA / HOD assign / edit `awardedMarks` on an employee-added */
/* task row.  Mirrors editTaskStatus's role gates + audit logging.  The */
/* points flow through the same scoring pipeline:                       */
/*   - employee-added rows: total += awardedMarks; earned += awardedMarks*/
/*   - HR-defined rows are untouched (this endpoint refuses to touch    */
/*     `points` on system-generated rows).                              */
/*                                                                      */
/* Body shape:                                                          */
/*   { submissionId, taskId, awardedMarks }                              */
/* ------------------------------------------------------------------ */
const editTaskMarks = asyncHandler(async (req, res) => {
  const { submissionId, taskId, awardedMarks } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    res.status(400); throw new Error('Valid submissionId is required.');
  }
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    res.status(400); throw new Error('Valid taskId is required.');
  }
  const marksNum = Number(awardedMarks);
  if (!Number.isFinite(marksNum) || marksNum < 0) {
    res.status(400); throw new Error('awardedMarks must be a number >= 0.');
  }

  const sub = await Submission.findById(submissionId);
  if (!sub) { res.status(404); throw new Error('Submission not found.'); }
  if (sub.templateType !== 'task') {
    res.status(400); throw new Error('Marks edit currently supports task-template submissions only.');
  }

  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin' && !isHOD && !_hasFeature(req, 'submissionReviews')) {
    res.status(403); throw new Error('Only HR / Super Admin / HOD / Submission Reviews feature may edit task marks.');
  }
  if (String(sub.employee) === String(req.user._id)) {
    res.status(403); throw new Error('You cannot edit your own submission.');
  }
  const owner = await User.findById(sub.employee).select('role department').lean();
  if (!owner) { res.status(404); throw new Error('Submission owner not found.'); }
  if (role === 'hr' && (owner.role === 'hr' || owner.role === 'super_admin')) {
    res.status(403); throw new Error('Only Super Admin can edit HR submissions.');
  }
  if (isHOD && role !== 'hr' && role !== 'super_admin') {
    if (String(owner.department) !== String(req.user.hodDepartment)) {
      res.status(403); throw new Error('Department clamp: not your department.');
    }
  }

  const task = (sub.tasks || []).id(taskId);
  if (!task) { res.status(404); throw new Error('Task row not found on this submission.'); }
  if (!task.addedByEmployee) {
    res.status(400); throw new Error('Marks can only be edited on employee-added extra work rows.');
  }

  const oldMarks = Number(task.awardedMarks) || 0;
  task.awardedMarks = marksNum;
  sub.markModified('tasks');

  // Recompute work scoring -- same formula reviewSubmission / editTaskStatus uses.
  let earned = 0, total = 0;
  for (const t of sub.tasks) {
    if (t.addedByEmployee) {
      const awarded = Number(t.awardedMarks) || 0;
      earned += awarded;
      total  += awarded;
    } else {
      if (t.status === 'done' || t.status === 'ongoing') earned += Number(t.points) || 0;
      if (t.status === 'done' || t.status === 'ongoing' || t.status === 'pending') {
        total += Number(t.points) || 0;
      }
    }
  }
  sub.workEarnedPoints = earned;
  sub.workTotalPoints  = total;
  sub.earnedPoints = earned;
  sub.totalPoints  = total;
  sub.completionPercentage = total > 0 ? (earned / total) * 100 : 0;

  sub.editHistory = sub.editHistory || [];
  sub.editHistory.push({
    editedBy: req.user._id,
    editorName: req.user.name,
    role,
    fields: [`tasks.${taskId}.awardedMarks`],
    note: `extra-work marks ${oldMarks} → ${marksNum}`,
    timestamp: new Date(),
  });

  await sub.save();

  logAudit(req, {
    action: 'submission.task-marks-edit',
    targetType: 'Submission',
    targetId: sub._id,
    targetLabel: `${owner._id} · ${String(sub.date).slice(0, 10)}`,
    meta: { taskId: String(taskId), from: oldMarks, to: marksNum, title: task.title || '' },
  });

  res.json({ ok: true, submission: sub });
});

/* ------------------------------------------------------------------ */
/* Phase 23.6 — Bulk innovation scoring                   */
/*                                                                     */
/* Lets HR / SA / HOD apply the SAME idea marks to a set  */
/* of (employee, date) pairs in one round-trip.  Internally just loops */
/* the per-day finalise pipeline -- nothing about the business rules,  */
/* role gates, audit logging, scoring formula or notification flow     */
/* changes.  Items that fail validation (forbidden / missing) are      */
/* skipped and reported back to the UI; successful items finalise.    */
/*                                                                     */
/* Body shape:                                                         */
/*   {                                                                 */
/*     items: [{ employeeId, date }, ...],                              */
/*     ideaMarks,       maxIdeaMarks?,                                  */
/*     ideaFeedback?,                                  */
/*   }                                                                  */
/* ------------------------------------------------------------------ */
const bulkFinalize = asyncHandler(async (req, res) => {
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  if (role !== 'hr' && role !== 'super_admin' && !isHOD && !_hasFeature(req, 'submissionReviews')) {
    res.status(403); throw new Error('Only HR / Super Admin / HOD / Submission Reviews feature may finalise daily reviews.');
  }

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (items.length === 0) {
    res.status(400); throw new Error('items[] is required.');
  }

  // Phase 26 — same workflow gating as finalizeDay.  HOD-only callers
  // recommend; HR / SA finalise.
  const isPureHOD = isHOD && role !== 'hr' && role !== 'super_admin';

  const maxIdea = Number(req.body.maxIdeaMarks ?? 2);
  const idea    = Math.max(0, Math.min(Number(req.body.ideaMarks) || 0, maxIdea));
  const ideaFeedback = String(req.body.ideaFeedback || '').trim();

  const out = { ok: 0, failed: [], reviews: [] };

  for (const it of items) {
    const employeeId = it.employeeId;
    const dayRaw = it.date;
    try {
      if (!mongoose.Types.ObjectId.isValid(employeeId)) {
        out.failed.push({ employeeId, date: dayRaw, error: 'Invalid employeeId' });
        continue;
      }
      const day = _resolveDay(dayRaw);
      if (String(employeeId) === String(req.user._id)) {
        out.failed.push({ employeeId, date: dayRaw, error: 'Cannot finalise your own review.' });
        continue;
      }
      const employee = await User.findById(employeeId).select('department role').lean();
      if (!employee) {
        out.failed.push({ employeeId, date: dayRaw, error: 'Employee not found.' });
        continue;
      }
      if (isHOD && role !== 'hr' && role !== 'super_admin') {
        if (String(employee.department) !== String(req.user.hodDepartment)) {
          out.failed.push({ employeeId, date: dayRaw, error: 'Department clamp: not your department.' });
          continue;
        }
      }
      if (role === 'hr' && employee.role === 'hr') {
        out.failed.push({ employeeId, date: dayRaw, error: 'Only a Super Admin can finalise HR reviews.' });
        continue;
      }
      if (employee.role === 'super_admin') {
        out.failed.push({ employeeId, date: dayRaw, error: 'Super Admin submissions are auto-finalised.' });
        continue;
      }
      const subs = await Submission.find({
        employee: employee._id, date: day, submitted: true, ...liveSubmissionFilter({}),
      }).sort({ submittedAt: 1, _id: 1 });
      if (subs.length === 0) {
        out.failed.push({ employeeId, date: dayRaw, error: 'No submissions for that day.' });
        continue;
      }
      const primary = subs[0];

      const review = await DailyReview.findOneAndUpdate(
        { employee: employee._id, date: day },
        {
          $set: {
            ideaMarks: idea, maxIdeaMarks: maxIdea, ideaFeedback,
            reviewedBy: req.user._id, reviewedAt: new Date(),
            // Phase 26 — HOD bulk recommendation stays 'pending' on the
            // DailyReview so analytics + dashboards continue treating the
            // day as "not yet finalised by HR".
            reviewStatus: isPureHOD ? 'pending' : 'reviewed',
            primarySubmissionId: primary._id,
          },
          $setOnInsert: { employee: employee._id, date: day },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      // Phase 26 — same workflow gating as finalizeDay.  HOD path writes
      // the per-submission hodReview block + stage='hod_reviewed' only;
      // HR / SA path keeps the existing reviewed + finalized flip.
      for (const s of subs) {
        if (isPureHOD) {
          s.hodReview = {
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
            recommend:  'approve',
            marksGiven: true,
            remarks:    ideaFeedback || s.hodReview?.remarks || '',
          };
          s.currentReviewStage = 'hod_reviewed';
          s.reviewHistory = s.reviewHistory || [];
          s.reviewHistory.push({
            reviewedBy: req.user._id, reviewerName: req.user.name, role,
            stage: 'hod_reviewed', action: 'daily_hod_review_bulk',
            marks: idea, remarks: ideaFeedback || '',
            timestamp: new Date(),
          });
          await s.save();
          continue;
        }
        s.reviewStatus = 'reviewed';
        s.currentReviewStage = 'finalized';
        s.reviewedBy = req.user._id;
        s.reviewedAt = new Date();
        s.earnedPoints = Number(s.workEarnedPoints) || 0;
        s.totalPoints  = Number(s.workTotalPoints)  || 0;
        s.completionPercentage = s.totalPoints > 0 ? (s.earnedPoints / s.totalPoints) * 100 : 0;
        s.reviewHistory = s.reviewHistory || [];
        s.reviewHistory.push({
          reviewedBy: req.user._id, reviewerName: req.user.name, role,
          stage: 'finalized', action: 'daily_finalize_bulk',
          marks: idea, remarks: ideaFeedback || '',
          timestamp: new Date(),
        });
        await s.save();
      }

      // Phase 26 — only notify the employee on real HR / SA finalisation.
      if (!isPureHOD) {
        try {
          notify.notifySubmissionReviewed({
            employeeId: employee._id, submission: { date: day }, reviewedBy: req.user,
          });
        } catch (_) { /* notify never blocks */ }
      }

      logAudit(req, {
        action: 'daily-review.bulk-finalize',
        targetType: 'DailyReview',
        targetId: review._id,
        targetLabel: `${employee._id} · ${day.toISOString().slice(0, 10)}`,
        meta: { ideaMarks: idea, submissionCount: subs.length, bulk: true },
      });
      out.ok += 1;
      out.reviews.push({ employeeId: String(employee._id), date: day, reviewId: review._id });
    } catch (err) {
      out.failed.push({ employeeId, date: dayRaw, error: err.message || 'Unknown error' });
    }
  }

  res.json(out);
});

/* ------------------------------------------------------------------ */
/* Phase 59 — Full-edit for Custom Assignment submissions              */
/*                                                                     */
/* HR / Super Admin can always edit; HOD can edit ONLY when their      */
/* hodPermissions.canEditSubmissions flag is on AND the submission     */
/* owner is in their own department.  All edits automatically re-run   */
/* the Marks engine so Available / Earned / Penalty / Final all update */
/* atomically.  Every edit lands in the Submission.editHistory AND the */
/* org-wide audit log with old→new + marks-delta captured.             */
/*                                                                     */
/* Body:                                                               */
/*   { submissionId, kind: 'custom'|'extra',                           */
/*     key,                                                            */
/*     value?, outOfValue?, status?, remark?,                           */
/*     reason? }                                                       */
/* ------------------------------------------------------------------ */
const editSubmissionValue = asyncHandler(async (req, res) => {
  const { submissionId, kind, key, value, outOfValue, status, remark, reason } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    res.status(400); throw new Error('Valid submissionId is required.');
  }
  if (kind !== 'custom' && kind !== 'extra') {
    res.status(400); throw new Error('kind must be "custom" or "extra".');
  }
  if (!key || typeof key !== 'string') {
    res.status(400); throw new Error('key is required.');
  }
  const sub = await Submission.findById(submissionId).populate('template', 'title customFields customKind customSections privateRemarkEnabled privateRemarkLabel privateRemarkRequired');
  if (!sub) { res.status(404); throw new Error('Submission not found.'); }
  if (sub.templateType !== 'custom') {
    res.status(400); throw new Error('This endpoint only edits Custom Assignment submissions.');
  }

  // ---- Role gate + department clamp for HOD ----
  const role = req.user.role;
  const isHOD = !!(req.user.isHOD && req.user.hodDepartment);
  const owner = await User.findById(sub.employee).select('role department name').lean();
  if (!owner) { res.status(404); throw new Error('Submission owner not found.'); }
  if (String(sub.employee) === String(req.user._id)) {
    res.status(403); throw new Error('You cannot edit your own submission.');
  }
  const canEdit = role === 'super_admin'
    || role === 'hr'
    || (isHOD && req.user.hodPermissions?.canEditSubmissions === true
        && String(owner.department) === String(req.user.hodDepartment))
    || _hasFeature(req, 'submissionReviews');
  if (!canEdit) {
    res.status(403);
    throw new Error(isHOD
      ? 'HOD edit permission not granted, or not your department.'
      : 'Only HR / Super Admin / authorised HOD may edit submission values.');
  }
  if (role === 'hr' && (owner.role === 'hr' || owner.role === 'super_admin')) {
    res.status(403); throw new Error('Only Super Admin can edit HR submissions.');
  }

  // ---- Locate the target row ----
  const listName = kind === 'custom' ? 'customResponses' : 'extraTasks';
  const rows = Array.isArray(sub[listName]) ? sub[listName] : [];
  const idx = rows.findIndex((r) => r.key === key);
  if (idx === -1) {
    res.status(404); throw new Error(`Row with key "${key}" not found in ${listName}.`);
  }
  const before = { ...rows[idx].toObject ? rows[idx].toObject() : rows[idx] };

  // Old marks snapshot for delta logging.
  const oldTotals = {
    available: Number(sub.customAvailableMarks) || 0,
    earned:    Number(sub.customEarnedMarks)    || 0,
    penalty:   Number(sub.customPenaltyMarks)   || 0,
    final:     Number(sub.customFinalMarks)     || 0,
  };

  // ---- Apply patch (only fields explicitly provided) ----
  const editedFields = [];
  const setIfProvided = (field, next, valid = () => true) => {
    if (next === undefined) return;
    const cur = rows[idx][field];
    if (!valid(next)) return;
    if (String(cur ?? '') === String(next ?? '')) return;
    rows[idx][field] = next;
    editedFields.push({ field, oldValue: cur, newValue: next });
  };
  setIfProvided('value',      value);
  setIfProvided('outOfValue', outOfValue !== undefined ? Number(outOfValue) || 0 : undefined);
  setIfProvided('status',     status, (v) => ['', 'done', 'ongoing', 'pending', 'work_not_available'].includes(v));
  setIfProvided('remark',     remark !== undefined ? String(remark) : undefined);
  if (editedFields.length === 0) {
    res.status(200).json({ ok: true, unchanged: true, submission: sub });
    return;
  }

  // ---- Re-run the Marks engine over the FULL slice + splice per-row marks ----
  const { computeCustomMarks, computeExtraTaskMarks } = require('../services/customMarks');
  // Custom side
  const cValueByKey  = Object.fromEntries((sub.customResponses || []).map((r) => [r.key, r.value]));
  const cOutOfByKey  = Object.fromEntries((sub.customResponses || []).map((r) => [r.key, Number(r.outOfValue) || 0]));
  const cStatusByKey = Object.fromEntries((sub.customResponses || []).map((r) => [r.key, r.status || '']));
  const customMarks = computeCustomMarks(sub.template?.customFields || [], cValueByKey, cOutOfByKey, cStatusByKey);
  const cMap = new Map(customMarks.perField.map((m) => [m.key, m]));
  for (const r of (sub.customResponses || [])) {
    const m = cMap.get(r.key);
    if (m) { r.availableMarks = m.availableMarks; r.earnedMarks = m.earnedMarks; r.penaltyMarks = m.penaltyMarks; }
  }
  // Extra side
  const extraMarks = computeExtraTaskMarks(sub.extraTasks || []);
  const eMap = new Map(extraMarks.perField.map((m) => [m.key, m]));
  for (const r of (sub.extraTasks || [])) {
    const m = eMap.get(r.key);
    if (m) { r.availableMarks = m.availableMarks; r.earnedMarks = m.earnedMarks; r.penaltyMarks = m.penaltyMarks; }
  }
  const totAvail = customMarks.available + extraMarks.available;
  const totEarn  = customMarks.earned    + extraMarks.earned;
  const totPen   = customMarks.penalty   + extraMarks.penalty;
  sub.customAvailableMarks = totAvail;
  sub.customEarnedMarks    = totEarn;
  sub.customPenaltyMarks   = totPen;
  sub.customFinalMarks     = Math.max(0, totEarn - totPen);
  sub.markModified(listName);
  sub.markModified('customResponses');
  sub.markModified('extraTasks');

  const after = { ...rows[idx].toObject ? rows[idx].toObject() : rows[idx] };
  const newTotals = {
    available: sub.customAvailableMarks,
    earned:    sub.customEarnedMarks,
    penalty:   sub.customPenaltyMarks,
    final:     sub.customFinalMarks,
  };

  // ---- Edit history + audit log ----
  sub.editHistory = sub.editHistory || [];
  sub.editHistory.push({
    editedBy: req.user._id,
    editorName: req.user.name,
    role,
    fields: editedFields.map((f) => `${listName}.${key}.${f.field}`),
    note: `${editedFields.map((f) => `${f.field}: ${f.oldValue} → ${f.newValue}`).join('; ')}${reason ? ` · reason: ${reason}` : ''}`,
    timestamp: new Date(),
  });
  await sub.save();

  logAudit(req, {
    action: `submission.${kind}-edit`,
    targetType: 'Submission',
    targetId: sub._id,
    targetLabel: `${owner.name || sub.employee} · ${String(sub.date).slice(0, 10)} · ${sub.template?.title || ''}`,
    meta: {
      submissionId: String(sub._id),
      employeeId:   String(sub.employee),
      template:     sub.template?.title || '',
      taskKind:     kind,
      taskKey:      key,
      taskLabel:    after.label || before.label || key,
      taskType:     after.responseType || after.fieldType || (kind === 'extra' ? 'extra' : 'custom'),
      fieldEdits:   editedFields,   // [{ field, oldValue, newValue }]
      oldRow:       before,
      newRow:       after,
      oldMarks:     oldTotals,
      newMarks:     newTotals,
      reason:       String(reason || ''),
    },
  });

  res.json({ ok: true, submission: sub });
});

module.exports = { listGrouped, getDay, saveReflection, finalizeDay, bulkFinalize, editTaskStatus, editTaskMarks, editSubmissionValue };
