/**
 * businessStateSync.js -- SINGLE orchestration point that keeps an
 * employee's working-day state consistent across:
 *
 *     Attendance   (via services/leaveAttendance.js)
 *     Assignment / Submission (via services/dailyEngine.ensureDailySubmissions)
 *     Compliance   (via services/compliance/incidents/incidentService)
 *     Pending state (via services/pendingStateService)
 *     Realtime nudges (via services/realtime)
 *
 * Every domain-facing controller that changes a working-day fact
 * (leave decide/revoke/edit today; assignment change tomorrow;
 * holiday declaration next quarter; department transfer, etc.)
 * calls into this service instead of duplicating the fan-out.
 * Existing services are reused verbatim -- no new business logic is
 * introduced here, only orchestration.
 *
 * Public API
 * ----------
 *   syncEmployeeDay({ employeeId, date, trigger, actor, force,
 *                     dryRun, reason })
 *     Bring one employee's ONE calendar day back to consistency.
 *     Returns a rich result document:
 *
 *       {
 *         employeeId, date,
 *         trigger,
 *         attendance: { status, unchanged: bool },
 *         submissions: [{ _id, template, action:'created|kept|suppressed', hasWork }],
 *         compliance:  { performanceLockResolved, dependencyResolved,
 *                        submissionIncidentsResolved },
 *         conflicts:   [{ code, message, submissionId?, ... }],
 *         changed:     bool,
 *       }
 *
 *     `trigger` values understood today:
 *       - 'leave_changed'          (approve / revoke / edit)
 *       - 'assignment_changed'     (future)
 *       - 'holiday_declared'       (future)
 *       - 'manual'                 (HR-triggered force sync)
 *
 *   syncEmployeeRange({ employeeId, from, to, trigger, ... })
 *     Convenience: walks from..to (inclusive) calling syncEmployeeDay.
 *     Returns { days: [...], conflicts: [...] } aggregated.
 *
 *   syncForLeave(leave, { trigger, actor, force })
 *     Convenience wrapper for the Leave lifecycle -- walks every
 *     day covered by the leave (or, when revoked, by leave.fromDate..
 *     leave.toDate stored on the doc) and returns aggregated results.
 *
 * Design principles
 * -----------------
 * * IDEMPOTENT.  Every downstream helper is idempotent; calling
 *   syncEmployeeDay repeatedly for the same (employee, day) never
 *   creates duplicates.  Attendance rows upsert by (employee, date);
 *   Submissions upsert by (employee, template, date); compliance
 *   incidents dedupe on naturalKey; ledger writes short-circuit on
 *   zero quantity.
 * * NON-DESTRUCTIVE BY DEFAULT.  When a leave transitions from
 *   half-day (or none) to full-day and any Submission already has
 *   employee-authored content, we NEVER auto-delete or hide it.
 *   Instead the sync returns a `conflict:'submission_has_work'` for
 *   the caller.  HR can re-invoke with `force: true` to hide it
 *   (soft flag; the document is preserved for audit).
 * * REUSE, DO NOT REBUILD.  Every mutation delegates to an existing
 *   service.  This file owns orchestration ONLY -- attendance
 *   semantics live in leaveAttendance.js, submission materialisation
 *   lives in dailyEngine.js, compliance auto-resolve lives in
 *   incidentService.js.
 * * EVENT-FRIENDLY.  The `syncEmployeeDay` return shape is stable
 *   so the caller can also `events.publish('working_day.synced', ...)`
 *   for downstream subscribers.  A no-op subscriber can be added
 *   without touching this file.
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const Leave = require('../models/Leave');
const Submission = require('../models/Submission');
const Holiday = require('../models/Holiday');
const Attendance = require('../models/Attendance');
const { startOfDay, addDays, formatYMD } = require('../utils/dateHelpers');

/* --------------------------------------------------------------- */
/* helpers                                                          */
/* --------------------------------------------------------------- */

const _dayEq = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();

/**
 * "Has the employee actually started work on this submission?"
 *
 * True iff the submission is already submitted OR any task /
 * response carries employee-authored content.  Used to decide
 * whether a Full-Day-Leave transition can safely suppress the
 * submission or must return a conflict for HR to resolve.
 */
const _hasEmployeeWork = (sub) => {
  if (!sub) return false;
  if (sub.submitted) return true;
  if (sub.lastDraftSavedAt) return true;
  for (const t of (sub.tasks || [])) {
    // Any task the employee has touched (marked Done / Ongoing /
    // Pending with a reason / Work N/A) or that carries an award
    // counts as work.  `pending_submit` is the untouched initial
    // state and DOESN'T count.
    if (t && t.status && t.status !== 'pending_submit') return true;
    if (t && (t.awardedMarks || 0) > 0) return true;
    if (t && t.addedByEmployee) return true;
  }
  for (const r of (sub.customResponses || [])) {
    const v = r && r.value;
    if (v === 0) continue;              // default coercion, not user intent
    if (v === '' || v == null) continue;
    return true;
  }
  for (const r of (sub.excelResponses || [])) {
    const v = r && r.value;
    if (v === '' || v == null) continue;
    return true;
  }
  return false;
};

/**
 * Load the authoritative Leave doc covering this day (approved-only).
 * Returns null when the employee is not on any approved leave.
 */
const _findApprovedLeave = async (employeeId, day) => {
  return Leave.findOne({
    employee: employeeId,
    status: 'approved',
    fromDate: { $lte: day },
    toDate:   { $gte: day },
  }).lean();
};

/* --------------------------------------------------------------- */
/*  syncEmployeeDay                                                  */
/* --------------------------------------------------------------- */

/**
 * @param {Object} opts
 * @param {ObjectId|string} opts.employeeId
 * @param {Date|string}     opts.date
 * @param {string}          opts.trigger  e.g. 'leave_changed'
 * @param {ObjectId|string} [opts.actor]  who caused the change
 * @param {boolean}         [opts.force]  if true, will hide/suppress
 *                                        submissions with employee work
 *                                        when a full-day leave now covers
 *                                        the day (audit-only; no deletes).
 * @param {string}          [opts.reason]
 * @param {boolean}         [opts.dryRun] evaluate only; don't mutate
 * @returns Promise<object>
 */
const syncEmployeeDay = async ({
  employeeId, date, trigger = 'manual',
  actor = null, force = false, dryRun = false, reason = '',
} = {}) => {
  if (!employeeId) throw new Error('syncEmployeeDay: employeeId is required');
  if (!date)       throw new Error('syncEmployeeDay: date is required');
  const day = startOfDay(date);

  const result = {
    employeeId: String(employeeId),
    date: formatYMD(day),
    trigger,
    attendance: null,
    submissions: [],
    compliance: {
      performanceLockResolved: 0,
      dependencyResolved: 0,
      submissionIncidentsResolved: 0,
    },
    conflicts: [],
    changed: false,
    dryRun,
  };

  const employee = await User.findById(employeeId).lean();
  if (!employee) {
    result.conflicts.push({ code: 'employee_not_found', message: 'Employee not found.' });
    return result;
  }

  const activeLeave = await _findApprovedLeave(employeeId, day);
  const holidayHit = await Holiday.findOne({ date: day }).lean();

  const isFullDay = !!(activeLeave && activeLeave.dayType !== 'half');
  const isHalfDay = !!(activeLeave && activeLeave.dayType === 'half');
  const isNonWorking = !!holidayHit;

  /* ---- 1. Attendance sync (reuse leaveAttendance) ---- */
  if (!dryRun) {
    try {
      const leaveAtt = require('./leaveAttendance');
      if (activeLeave) {
        // Rehydrate a full Mongoose-ish doc for the helper.
        const lvDoc = await Leave.findById(activeLeave._id);
        if (lvDoc) {
          const r = await leaveAtt.syncAttendanceForLeave(lvDoc);
          result.attendance = { syncedFromLeave: true, created: r.created, kept: r.kept };
        }
      } else {
        // No approved leave -- if there is a leave-linked Attendance row
        // for this day that no longer has a matching leave, remove it so
        // the day falls back to derived Present/Absent.  Manual overrides
        // (source='manual') are always respected.
        const dangling = await Attendance.findOne({
          employee: employeeId, date: day, source: 'leave',
        });
        if (dangling) {
          const stillHasLeave = !!(await _findApprovedLeave(employeeId, day));
          if (!stillHasLeave) {
            // deleteMany over a single-id filter is equivalent to
            // deleteOne here but is stubbed in the test harness.
            await Attendance.deleteMany({ _id: dangling._id });
            result.attendance = { removedDangling: true };
            result.changed = true;
          }
        }
      }
    } catch (e) { console.error('[businessStateSync] attendance:', e.message); }
  }

  /* ---- 2. Submissions ---- */
  // Any existing rows for today (used for both paths so we don't
  // double-materialise and so we know whether "work has started").
  const existingSubs = await Submission.find({
    employee: employeeId,
    date: day,
    deleted: { $ne: true },
  });

  if (isFullDay) {
    // FULL-DAY LEAVE -- no Submission should exist.  Handle any that
    // are already there.  Never delete permanently.
    for (const sub of existingSubs) {
      const hasWork = _hasEmployeeWork(sub);
      if (!hasWork) {
        // Safe to hide.  `hidden:true` already exists on the schema
        // and is the least-invasive audit-preserving suppression.
        if (!dryRun && !sub.hidden) {
          sub.hidden = true;
          sub.hiddenReason = `Suppressed by ${trigger}: ${reason || 'full-day leave now covers this day'}`.slice(0, 500);
          sub.hiddenSource = 'leave';
          if (actor) sub.hiddenBy = actor;
          sub.hiddenAt = new Date();
          try { await sub.save(); } catch (_) { /* schema may not carry hiddenReason -- non-fatal */ }
          result.changed = true;
        }
        result.submissions.push({
          _id: sub._id, template: sub.template, action: 'suppressed', hasWork: false,
        });
      } else if (force) {
        // HR explicitly acknowledged the conflict and force-hides the sub.
        if (!dryRun && !sub.hidden) {
          sub.hidden = true;
          sub.hiddenReason = `Force-suppressed by ${trigger}: ${reason || 'HR override'}`.slice(0, 500);
          sub.hiddenSource = 'leave';
          if (actor) sub.hiddenBy = actor;
          sub.hiddenAt = new Date();
          try { await sub.save(); } catch (_) { /* non-fatal */ }
          result.changed = true;
        }
        result.submissions.push({
          _id: sub._id, template: sub.template, action: 'force_suppressed', hasWork: true,
        });
      } else {
        // Employee has started work.  Report conflict; do not touch.
        result.conflicts.push({
          code: 'submission_has_work',
          submissionId: sub._id,
          template: sub.template,
          message: 'Employee has already started work on this submission. Full-day leave suppression requires HR force + reason.',
        });
        result.submissions.push({
          _id: sub._id, template: sub.template, action: 'kept', hasWork: true,
        });
      }
    }
    // Compliance: any incidents scoped to a submission on this day
    // should be resolved (the submission is being retired).
    if (!dryRun) {
      for (const sub of existingSubs) {
        try {
          const incidentService = require('./compliance/incidents/incidentService');
          const r = await incidentService.resolveIncidentsBySubmission({
            submissionId: sub._id,
            reason: `auto: ${trigger} -> full-day leave, submission suppressed`,
            actor,
          });
          result.compliance.submissionIncidentsResolved += r.resolved || 0;
        } catch (e) { console.error('[businessStateSync] resolveIncidentsBySubmission:', e.message); }
      }
    }
  } else {
    // NO leave, HALF-DAY leave, or HOLIDAY -- materialise Submissions
    // via the existing dailyEngine.  ensureDailySubmissions honours
    // holidays / weekly-off internally so we don't need to.
    if (!dryRun) {
      try {
        const dailyEngine = require('./dailyEngine');
        const fullEmp = await User.findById(employeeId);
        const created = await dailyEngine.ensureDailySubmissions(fullEmp, day);
        for (const sub of (created || [])) {
          const already = existingSubs.some((s) => String(s._id) === String(sub._id));
          result.submissions.push({
            _id: sub._id, template: sub.template,
            action: already ? 'kept' : 'created',
            hasWork: _hasEmployeeWork(sub),
          });
          if (!already) result.changed = true;
        }
      } catch (e) { console.error('[businessStateSync] ensureDailySubmissions:', e.message); }
    } else {
      for (const sub of existingSubs) {
        result.submissions.push({
          _id: sub._id, template: sub.template, action: 'kept',
          hasWork: _hasEmployeeWork(sub),
        });
      }
    }

    // Un-hide Submissions that were suppressed BY LEAVE -- the leave no
    // longer applies, so work should resume.  Rows hidden for a
    // different reason (e.g. their ASSIGNMENT was revoked) must stay
    // hidden: a leave change must not resurrect work whose assignment
    // is gone.  Legacy rows with no `hiddenSource` are treated as
    // leave-origin (that was the only suppressor before this change).
    if (!dryRun) {
      for (const sub of existingSubs) {
        if (sub.hidden && (!sub.hiddenSource || sub.hiddenSource === 'leave')) {
          sub.hidden = false;
          sub.hiddenReason = '';
          sub.hiddenSource = '';
          sub.hiddenBy = null;
          sub.hiddenAt = null;
          try { await sub.save(); result.changed = true; }
          catch (_) { /* non-fatal */ }
        }
      }
    }
  }

  /* ---- 3. Compliance: employee-level re-evaluation ---- */
  if (!dryRun) {
    try {
      const pendingState = require('./pendingStateService');
      const incidentService = require('./compliance/incidents/incidentService');
      // If no overdue pending tasks remain for this employee, close
      // any open performance_lock incident.  Mirrors what
      // penaltyEngine.onPendingTaskResolved does but scoped through
      // the same helper so cancel/waiver semantics stay unchanged.
      const overdue = await pendingState.overduePendingTasksForEmployee(employeeId, day);
      if (overdue.length === 0) {
        const r = await incidentService.resolvePerformanceLockIncidentsForEmployee({
          employeeId, reason: `auto: ${trigger} -> no overdue pending remains`,
        });
        result.compliance.performanceLockResolved = r.resolved || 0;
      }
      // Same guard for dependency_pending.
      const openDeps = await pendingState.listOpenDependencies({ employeeId });
      if (openDeps.length === 0) {
        const r = await incidentService.resolveDependencyIncidentsForEmployee({
          employeeId, reason: `auto: ${trigger} -> no open dependencies remain`,
        });
        result.compliance.dependencyResolved = r.resolved || 0;
      }
    } catch (e) { console.error('[businessStateSync] compliance re-eval:', e.message); }
  }

  /* ---- 4. Realtime nudge ---- */
  if (!dryRun && result.changed) {
    try {
      const rt = require('./realtime');
      rt.publish(employeeId, 'working_day:changed', {
        date: formatYMD(day), trigger,
      });
    } catch (_) { /* silent -- realtime is best-effort */ }
  }

  /* ---- 5. Event bus fan-out (subscribers can hook in later) ---- */
  if (!dryRun && result.changed) {
    try {
      const events = require('./events');
      events.publish('working_day.synced', {
        employeeId: String(employeeId),
        date: formatYMD(day),
        trigger,
        conflicts: result.conflicts,
      });
    } catch (_) { /* silent */ }
  }

  result.isFullDayLeave = isFullDay;
  result.isHalfDayLeave = isHalfDay;
  result.isHoliday = isNonWorking;
  return result;
};

/* --------------------------------------------------------------- */
/*  syncEmployeeRange                                                */
/* --------------------------------------------------------------- */

const syncEmployeeRange = async ({
  employeeId, from, to, trigger = 'manual', actor = null, force = false,
  dryRun = false, reason = '',
} = {}) => {
  const start = startOfDay(from);
  const end   = startOfDay(to);
  const days = [];
  const conflicts = [];
  let cursor = new Date(start.getTime());
  // Guard against pathological ranges.
  const MAX_DAYS = 400;
  let i = 0;
  while (cursor.getTime() <= end.getTime() && i < MAX_DAYS) {
    const r = await syncEmployeeDay({
      employeeId, date: cursor, trigger, actor, force, dryRun, reason,
    });
    days.push(r);
    if (Array.isArray(r.conflicts)) conflicts.push(...r.conflicts.map((c) => ({ ...c, date: r.date })));
    cursor = addDays(cursor, 1);
    i += 1;
  }
  return { days, conflicts };
};

/* --------------------------------------------------------------- */
/*  syncForLeave -- Leave-lifecycle helper                           */
/* --------------------------------------------------------------- */

/**
 * Iterate over the UNION of a leave's PREVIOUS date range and its
 * NEW date range so a shrunk / expanded / date-moved leave clears
 * the days it no longer covers AND covers the days it now includes.
 * The `previous` argument (optional) carries the pre-edit fromDate /
 * toDate; when omitted we assume the current leave dates.
 */
const syncForLeave = async (leave, { trigger = 'leave_changed', actor = null, force = false, reason = '', previous = null } = {}) => {
  if (!leave) return { days: [], conflicts: [] };
  const from = startOfDay(previous?.fromDate || leave.fromDate);
  const to   = startOfDay(previous?.toDate   || leave.toDate);
  const fromNew = startOfDay(leave.fromDate);
  const toNew   = startOfDay(leave.toDate);
  const start = new Date(Math.min(from.getTime(), fromNew.getTime()));
  const end   = new Date(Math.max(to.getTime(),   toNew.getTime()));
  return syncEmployeeRange({
    employeeId: leave.employee, from: start, to: end,
    trigger, actor, force, reason,
  });
};

/* --------------------------------------------------------------- */
/*  syncForAssignment -- Assignment-lifecycle helper                 */
/* --------------------------------------------------------------- */

/**
 * Called when HR creates / edits / reactivates an assignment so it
 * becomes effective today.  Materialises today's Submission(s) for
 * every covered employee via the SAME syncEmployeeDay path used by
 * the leave flow -- which runs ensureDailySubmissions (respecting
 * approved leave + working-day rules), is idempotent on
 * (employee, template, date), and publishes 'working_day:changed'.
 *
 * @param {Object} opts
 * @param {ObjectId[]} opts.employeeIds  covered employees
 * @param {Date}   [opts.date]           defaults to today
 * @param {string} [opts.trigger]        default 'assignment_changed'
 * @param {ObjectId}[opts.actor]
 * @returns { days: [...perEmployee syncEmployeeDay results] }
 */
const syncForAssignment = async ({ employeeIds = [], date = new Date(), trigger = 'assignment_changed', actor = null } = {}) => {
  const day = startOfDay(date);
  const days = [];
  for (const empId of employeeIds) {
    // eslint-disable-next-line no-await-in-loop
    const r = await syncEmployeeDay({ employeeId: empId, date: day, trigger, actor });
    days.push(r);
  }
  return { days };
};

/**
 * Non-destructive suppression of the submissions belonging to an
 * assignment that is being revoked / disabled.  Mirrors the leave
 * full-day suppression semantics:
 *
 *   - UNSUBMITTED + no employee work  -> hidden (source 'assignment').
 *   - UNSUBMITTED + employee started  -> conflict (kept visible) unless
 *                                        `force`, in which case hidden.
 *   - SUBMITTED                        -> never touched (immutable history).
 *
 * Never hard-deletes.  Publishes 'working_day:changed' to each affected
 * employee.  Returns { hidden:[], conflicts:[] }.
 *
 * @param {Object} opts
 * @param {ObjectId} opts.assignmentId
 * @param {Date}   [opts.fromDate]  only suppress submissions on/after
 *                                  this date (defaults to today, so
 *                                  past history is left as-is); pass
 *                                  null to cover all dates.
 * @param {boolean}[opts.force]
 * @param {ObjectId}[opts.actor]
 * @param {string} [opts.reason]
 */
const suppressAssignmentSubmissions = async ({ assignmentId, fromDate = new Date(), force = false, actor = null, reason = '' } = {}) => {
  const out = { hidden: [], conflicts: [] };
  if (!assignmentId) return out;
  // `submitted: {$ne:true}` (not `submitted:false`) so a legacy row
  // that never had the flag written is still treated as unsubmitted.
  const q = { assignment: assignmentId, submitted: { $ne: true }, hidden: { $ne: true }, deleted: { $ne: true } };
  if (fromDate) q.date = { $gte: startOfDay(fromDate) };
  const subs = await Submission.find(q);
  const touchedEmployees = new Set();

  for (const sub of subs) {
    const hasWork = _hasEmployeeWork(sub);
    if (hasWork && !force) {
      out.conflicts.push({
        code: 'submission_has_work',
        submissionId: sub._id,
        employee: sub.employee,
        date: formatYMD(sub.date),
        message: 'Employee has already started work on this submission. Revoke suppression requires HR force + reason.',
      });
      continue;
    }
    sub.hidden = true;
    sub.hiddenReason = `Suppressed by assignment_revoked: ${reason || (hasWork ? 'HR force override' : 'assignment revoked')}`.slice(0, 500);
    sub.hiddenSource = 'assignment';
    if (actor) sub.hiddenBy = actor;
    sub.hiddenAt = new Date();
    try {
      await sub.save();
      out.hidden.push({ submissionId: sub._id, employee: sub.employee, date: formatYMD(sub.date), forced: hasWork });
      touchedEmployees.add(String(sub.employee));
      // Compliance: retire any incident scoped to this submission.
      try {
        const incidentService = require('./compliance/incidents/incidentService');
        await incidentService.resolveIncidentsBySubmission({
          submissionId: sub._id,
          reason: 'auto: assignment revoked, submission suppressed',
          actor,
        });
      } catch (_) { /* best-effort */ }
    } catch (e) { console.error('[businessStateSync] suppressAssignment save:', e.message); }
  }

  // Realtime nudge per affected employee so the dashboard drops the
  // suppressed work without a manual refresh.
  for (const empId of touchedEmployees) {
    try {
      require('./realtime').publish(empId, 'working_day:changed', { trigger: 'assignment_changed' });
    } catch (_) { /* best-effort */ }
  }
  return out;
};

module.exports = {
  syncEmployeeDay,
  syncEmployeeRange,
  syncForLeave,
  syncForAssignment,
  suppressAssignmentSubmissions,
  // Test helpers
  _hasEmployeeWork,
};
