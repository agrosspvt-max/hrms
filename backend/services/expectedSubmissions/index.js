/**
 * expectedSubmissions -- Single source of truth for HISTORICAL
 * submission expectation across the HRMS.
 *
 * ================================================================
 * HISTORICAL INVARIANT
 * ================================================================
 * Once Daily Engine creates a Submission stub, that Submission
 * becomes the immutable historical record of expected work.
 *
 * Historical reports must NEVER reconstruct expectation from
 * Assignment, Department, Designation or Template configuration.
 *
 *   Assignment  = configuration  (forward-looking)
 *   Submission  = history        (immutable per-day record)
 *
 * If an employee's department, designation, assignment cadence, or
 * template later changes, the historical Submission stubs are the
 * only authority on what work was actually expected on the day.
 * ================================================================
 *
 * MEMBERSHIP vs DISPLAY CONTEXT
 * ----------------------------------------------------------------
 * Consumers of this module (Penalty Engine, Submission Review,
 * historical audits) MUST separate the two:
 *
 *   Layer 1  Historical facts    -- this module (Submission-backed)
 *   Layer 2  Business overlays   -- Leave / Holiday / Weekly Off /
 *                                    Rollout / Attendance / Attendance
 *                                    Confirmation.  Also here.
 *   Layer 3  UI enrichment       -- Assignment title, Department name,
 *                                    Attendance badge, Leave badge,
 *                                    Penalty badge, Reopen badge.
 *                                    NOT in this module -- callers
 *                                    join the historical facts with
 *                                    their own display context.
 *
 * ATTENDANCE REVIEW
 * ----------------------------------------------------------------
 * Attendance-review employees remain a SEPARATE workflow keyed off
 * `AttendanceConfirmation`, not off Submission stubs.  This module
 * exposes helpers for them (`isAttendanceConfirmed`) so both branches
 * live behind one API, but the caller must dispatch based on
 * `employee.attendanceMode` -- do NOT merge them here.
 *
 * PUBLIC API
 * ----------------------------------------------------------------
 *   getSubmissionStubs({ employeeId, day, preloaded })
 *     -> [Submission]  (raw historical rows for the day)
 *
 *   classifySubmissionState(submission, { reopenPenaltiesByStubId })
 *     -> 'not_submitted' | 'draft' | 'reopened' |
 *        'submitted_pending_review' | 'under_hod' |
 *        'hod_reviewed' | 'under_hr' | 'returned' | 'finalized'
 *
 *   getMissedSubmissions({ employeeId, day, preloaded })
 *     -> [Submission]  (stubs the day treats as "not filed yet")
 *
 *   classifyEmployeeDay({ employee, day, preloaded })
 *     -> {
 *          expected, submitted, missed, missedStates,
 *          onLeave, halfDayLeave, holiday, weeklyOff, nonWorking,
 *          ignoredPreRollout, attendanceMode, attendanceConfirmed,
 *          attendanceRecord,
 *        }
 *
 *   isBeforeComplianceRollout(day)   -- re-export of the rollout gate
 */

const Submission              = require('../../models/Submission');
const Penalty                 = require('../../models/Penalty');
const Leave                   = require('../../models/Leave');
const Attendance              = require('../../models/Attendance');
const AttendanceConfirmation  = require('../../models/AttendanceConfirmation');
const { startOfDay }          = require('../../utils/dateHelpers');
const { liveSubmissionFilter }= require('../../utils/submissionFilter');
const { isBeforeRollout }     = require('../../config/complianceRollout');
const { isHolidayOn }         = require('../eventOccurrences');

/* ------------------------------------------------------------------ */
/* Layer 1 -- Historical facts                                         */
/* ------------------------------------------------------------------ */

/**
 * Return every LIVE (not soft-deleted / not test) Submission stub for
 * (employee, day).  This is the historical membership set for the
 * "Not Submitted" and "Missed Submission" workflows.
 *
 * `preloaded.submissionsByEmpDay` is a Map keyed `${empId}__${YYYY-MM-DD}`
 * whose value is an ARRAY of stubs.  When present the function is
 * pure and never touches Mongo -- required for range-mode callers to
 * avoid N+1.
 */
const getSubmissionStubs = async ({ employeeId, day, preloaded }) => {
  const target = startOfDay(day);
  if (preloaded && preloaded.submissionsByEmpDay) {
    const key = `${String(employeeId)}__${target.toISOString().slice(0, 10)}`;
    return preloaded.submissionsByEmpDay.get(key) || [];
  }
  return Submission.find({
    employee: employeeId,
    date: target,
    ...liveSubmissionFilter({}),
  }).lean();
};

/**
 * Classify one Submission stub's per-day state.  Derived purely from
 * fields on the Submission (and, for reopen, from a pre-batched
 * penalty index) so this is O(1) per stub with no extra reads when
 * the caller batches.
 *
 *   reopenPenaltiesByStubId : Map<stringSubmissionId, Penalty>
 *
 * State meanings (frozen contract):
 *
 *   not_submitted            submitted:false, no draft, no reopen
 *   draft                    submitted:false, lastDraftSavedAt set
 *   reopened                 submitted:false AND missed_submission
 *                             penalty exists with reopenRequest.decision
 *                             === 'approved' (employee owes a refile)
 *   submitted_pending_review submitted:true, stage='submitted'
 *   under_hod                submitted:true, stage='under_hod'
 *   hod_reviewed             submitted:true, stage='hod_reviewed'
 *   under_hr                 submitted:true, stage='under_hr' | 'under_super_admin'
 *   returned                 submitted:true, hodReview.recommend === 'needs_changes'
 *                             AND stage !== 'finalized'
 *   finalized                submitted:true, stage='finalized'
 *
 * NOTE ON `returned`: the codebase never flips `submitted` back to
 * false; a returned submission stays submitted:true and carries the
 * `needs_changes` recommendation.  Callers that treat Not Submitted
 * as "did the employee owe fresh work?" therefore see `returned` as
 * a variant of "submitted", NOT as missed -- matching current
 * behaviour of both Penalty Engine and Submission Review.
 */
const classifySubmissionState = (submission, { reopenPenaltiesByStubId } = {}) => {
  if (!submission) return 'not_submitted';

  if (!submission.submitted) {
    const rp = reopenPenaltiesByStubId && reopenPenaltiesByStubId.get(String(submission._id));
    if (rp && rp.reopenRequest && rp.reopenRequest.decision === 'approved') {
      return 'reopened';
    }
    if (submission.lastDraftSavedAt) return 'draft';
    return 'not_submitted';
  }

  const stage = submission.currentReviewStage || 'submitted';
  const recommend = submission.hodReview && submission.hodReview.recommend;

  if (stage === 'finalized') return 'finalized';
  if (recommend === 'needs_changes') return 'returned';
  if (stage === 'under_hod')    return 'under_hod';
  if (stage === 'hod_reviewed') return 'hod_reviewed';
  if (stage === 'under_hr' || stage === 'under_super_admin') return 'under_hr';
  return 'submitted_pending_review';
};

/**
 * Return only the stubs a historical caller should treat as "missed"
 * for that day.  Definition mirrors the Penalty Engine's existing
 * inline query (`submitted:false`, live, non-test), with the addition
 * of the shared soft-delete + test filter.
 *
 * Draft and reopened rows are INCLUDED here because they represent
 * unfilled work -- consistent with today's Penalty Engine behaviour
 * (a draft does not save the employee from a missed_submission
 * penalty; a reopened stub is by definition awaiting refile).
 */
const getMissedSubmissions = async ({ employeeId, day, preloaded }) => {
  const stubs = await getSubmissionStubs({ employeeId, day, preloaded });
  return stubs.filter((s) => !s.submitted);
};

/* ------------------------------------------------------------------ */
/* Reopen-penalty indexer (helper for Layer 3 enrichment)              */
/* ------------------------------------------------------------------ */

/**
 * Build the reopen-penalty index used by classifySubmissionState.
 * Pass in the stub list you're about to classify; returns a Map
 * `Submission._id -> Penalty` for missed_submission penalties whose
 * `submission` FK matches one of the stubs.
 *
 * Cheap even without a preloaded penalty set: one indexed find by
 * `{submission: {$in}, category, source:'automatic'}`.
 */
const buildReopenIndex = async (stubs, { preloadedPenalties } = {}) => {
  const out = new Map();
  if (!stubs.length) return out;
  const stubIds = stubs.filter((s) => !s.submitted).map((s) => s._id);
  if (!stubIds.length) return out;

  let pens;
  if (preloadedPenalties) {
    pens = preloadedPenalties.filter(
      (p) => stubIds.some((id) => String(id) === String(p.submission)),
    );
  } else {
    pens = await Penalty.find({
      submission: { $in: stubIds },
      category:   { $in: ['missed_submission', 'absent_submission'] },
      source:     'automatic',
      probable:   false,
    }).select('submission reopenRequest').lean();
  }
  for (const p of pens) {
    if (p.submission) out.set(String(p.submission), p);
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* Layer 2 -- Business overlays                                        */
/* ------------------------------------------------------------------ */

/**
 * Full-day approved leave overlapping `day`.  Half-day leaves are NOT
 * a suppressor -- the employee still owes the day's work.  Preloaded
 * caller passes a Map<empId, Leave|null>.
 */
const getApprovedLeaveForDay = async ({ employeeId, day, preloaded }) => {
  const target = startOfDay(day);
  if (preloaded && preloaded.leavesByEmpDay) {
    const key = `${String(employeeId)}__${target.toISOString().slice(0, 10)}`;
    return preloaded.leavesByEmpDay.get(key) || null;
  }
  if (preloaded && preloaded.leavesByEmp) {
    return preloaded.leavesByEmp.get(String(employeeId)) || null;
  }
  return Leave.findOne({
    employee: employeeId,
    status: 'approved',
    fromDate: { $lte: target },
    toDate:   { $gte: target },
  }).lean();
};

/** Attendance row for the day, if any. Preloaded via Map<empId, Attendance>. */
const getAttendanceRecord = async ({ employeeId, day, preloaded }) => {
  const target = startOfDay(day);
  if (preloaded && preloaded.attendanceByEmp) {
    return preloaded.attendanceByEmp.get(String(employeeId)) || null;
  }
  if (preloaded && preloaded.attendanceByEmpDay) {
    const key = `${String(employeeId)}__${target.toISOString().slice(0, 10)}`;
    return preloaded.attendanceByEmpDay.get(key) || null;
  }
  return Attendance.findOne({ employee: employeeId, date: target }).lean();
};

/** Attendance confirmation row (attendance_review employees only). */
const isAttendanceConfirmed = async ({ employeeId, day, preloaded }) => {
  const target = startOfDay(day);
  if (preloaded && preloaded.confirmedSet) {
    const key = `${String(employeeId)}__${target.toISOString().slice(0, 10)}`;
    return preloaded.confirmedSet.has(key);
  }
  const row = await AttendanceConfirmation.findOne({
    employee: employeeId,
    date: target,
  }).select('_id').lean();
  return !!row;
};

/** Weekly-off gate for the employee on `day`. */
const isWeeklyOffFor = (employee, day) => {
  const weeklyOff = employee && Array.isArray(employee.weeklyOff)
    ? employee.weeklyOff
    : [0];
  return weeklyOff.includes(startOfDay(day).getUTCDay());
};

/** Holiday for `day` (Holiday collection + Event.isHoliday=true). */
const getHoliday = async ({ day, preloaded }) => {
  const target = startOfDay(day);
  if (preloaded && preloaded.holidayByDay) {
    const key = target.toISOString().slice(0, 10);
    return preloaded.holidayByDay.get(key) || null;
  }
  return isHolidayOn(target);
};

/* ------------------------------------------------------------------ */
/* Aggregated per-employee-day classifier                              */
/* ------------------------------------------------------------------ */

/**
 * Combined Layer 1 + Layer 2 result for one (employee, day).  Returns
 * the primitives every downstream consumer needs; each consumer then
 * decides what to do with them (Penalty Engine issues penalties on
 * `missed` + attendance-present; Submission Review builds Not
 * Submitted cards from `missed` + `attendanceConfirmed`).
 *
 * Fields:
 *   ignoredPreRollout    Day is strictly before the compliance rollout
 *                        cutoff AND nothing was submitted.  Callers
 *                        must treat this day as invisible (no penalty,
 *                        no card, no counter).
 *   nonWorking           Weekly-off OR holiday for this employee.
 *                        Attends to the "Weekly Off (no override)"
 *                        rule via the underlying Submission stubs --
 *                        the stub simply doesn't exist on a plain
 *                        weekly-off, so `missed` will be empty.
 *   onLeave              Full-day approved leave overlaps `day`.
 *   halfDayLeave         Half-day approved leave overlaps `day`
 *                        (informational; does NOT suppress expectation).
 *   attendanceMode       Copied from the employee record.
 *   attendanceConfirmed  attendance_review only; null otherwise.
 *   attendanceRecord     Raw Attendance row (if any).
 *   stubs                Every LIVE Submission stub for the day.
 *   missed               Stubs where submitted:false.  Empty when
 *                        onLeave OR ignoredPreRollout.
 *   missedStates         Per-stub classifySubmissionState result,
 *                        parallel array to `missed`.
 *   expected             Convenience: !onLeave && !ignoredPreRollout
 *                        && stubs.length > 0.
 *   submitted            Convenience: expected && missed.length === 0.
 */
const classifyEmployeeDay = async ({ employee, day, preloaded }) => {
  const target = startOfDay(day);

  const [stubs, leave, holiday, attendanceRecord] = await Promise.all([
    getSubmissionStubs({ employeeId: employee._id, day: target, preloaded }),
    getApprovedLeaveForDay({ employeeId: employee._id, day: target, preloaded }),
    getHoliday({ day: target, preloaded }),
    getAttendanceRecord({ employeeId: employee._id, day: target, preloaded }),
  ]);

  const weeklyOff  = isWeeklyOffFor(employee, target);
  const onLeave    = !!(leave && leave.dayType !== 'half');
  const halfDayLeave = !!(leave && leave.dayType === 'half');
  const nonWorking = weeklyOff || !!holiday;

  // Attendance-review confirmation, only when the employee is in that
  // mode -- the two branches never share this field.
  const attendanceMode = employee.attendanceMode || 'submission_based';
  const attendanceConfirmed = attendanceMode === 'attendance_review'
    ? await isAttendanceConfirmed({ employeeId: employee._id, day: target, preloaded })
    : null;

  // Rollout gate: applied ONLY when nothing has been submitted for
  // the day (matches dailyReviewController._evaluateNotSubmittedForDay
  // and penaltyEngine.enforceAbsentSubmission).
  const anySubmitted = stubs.some((s) => s.submitted);
  const ignoredPreRollout = !anySubmitted && isBeforeRollout(target);

  // Compute the missed set + per-stub states.
  let missed = [];
  let missedStates = [];
  if (!onLeave && !ignoredPreRollout) {
    missed = stubs.filter((s) => !s.submitted);
    if (missed.length) {
      const reopenIdx = await buildReopenIndex(stubs, {
        preloadedPenalties: preloaded && preloaded.penalties,
      });
      missedStates = missed.map(
        (s) => classifySubmissionState(s, { reopenPenaltiesByStubId: reopenIdx }),
      );
    }
  }

  return {
    ignoredPreRollout,
    nonWorking,
    weeklyOff,
    holiday,
    onLeave,
    halfDayLeave,
    attendanceMode,
    attendanceConfirmed,
    attendanceRecord,
    stubs,
    missed,
    missedStates,
    expected: !onLeave && !ignoredPreRollout && stubs.length > 0,
    submitted: !onLeave && !ignoredPreRollout && stubs.length > 0 && missed.length === 0,
  };
};

module.exports = {
  // Layer 1
  getSubmissionStubs,
  getMissedSubmissions,
  classifySubmissionState,
  buildReopenIndex,
  // Layer 2 overlays (exposed for callers that need them piecewise)
  getApprovedLeaveForDay,
  getAttendanceRecord,
  isAttendanceConfirmed,
  isWeeklyOffFor,
  getHoliday,
  // Aggregated
  classifyEmployeeDay,
  // Rollout gate re-export (so callers only import one module)
  isBeforeComplianceRollout: isBeforeRollout,
};
