/**
 * dailyEngine
 *
 * Centralises two pieces of business logic that the dashboard needs:
 *
 *  1. ensureDailySubmissions(employee, date)
 *     Generates today's submissions for all "daily" assignments and
 *     carries forward pending tasks from yesterday into a fresh
 *     submission row (so the employee dashboard always has the right
 *     work to do).  Idempotent thanks to a unique index on
 *     (employee, template, date).
 *
 *  2. deriveAttendance(employee, from, to)
 *     Walks every day in the [from, to) range and labels it:
 *       present / absent / paid_leave / unpaid_leave / weekly_off
 *     based on submissions, weekly offs and approved leaves.
 */

const Assignment = require('../models/Assignment');
const Template = require('../models/Template');
const Submission = require('../models/Submission');
const Leave = require('../models/Leave');
const Holiday = require('../models/Holiday');
const Attendance = require('../models/Attendance');
const { startOfDay, addDays, eachDay } = require('../utils/dateHelpers');
const { isScheduledOn, buildScheduleLabel } = require('../utils/scheduleHelpers');
const { getEventHolidayMap, isEventHolidayOn } = require('../utils/eventHolidays');
// Same filter analytics use -- excludes soft-deleted + test-marked
// submissions so historical rows HR has marked as Test Data don't
// poison tomorrow's carry-forward defaults (Calling yesterdayPending,
// task-template backlog, getBacklog widget).
const { liveSubmissionFilter } = require('../utils/submissionFilter');

/**
 * Returns true if `day` (UTC date) is a weekly off for this employee.
 */
const isWeeklyOff = (employee, day) => {
  const offs = employee.weeklyOff || [0];
  return offs.includes(day.getUTCDay());
};

/**
 * Returns the approved leave (if any) that covers `day` for the employee.
 */
const findApprovedLeave = async (employeeId, day) => {
  return Leave.findOne({
    employee: employeeId,
    status: 'approved',
    fromDate: { $lte: day },
    toDate: { $gte: day },
  });
};

/**
 * Find every active assignment that targets a given employee, either
 * directly or via their department / designation.
 */
const assignmentsForEmployee = async (employee) => {
  const orList = [
    { targetType: 'employee', targetRef: employee._id },
  ];
  if (employee.department) orList.push({ targetType: 'department', targetRef: employee.department });
  if (employee.designation) orList.push({ targetType: 'designation', targetRef: employee.designation });

  return Assignment.find({ active: true, $or: orList }).populate('template');
};

/**
 * Materialise the submission records for `day` for one employee.
 * - For each active daily assignment, ensure there's a submission row.
 * - Pending tasks from the most recent unfinished submission (same template)
 *   are carried forward as "pending" tasks on the new day's row so backlog
 *   stays visible.
 *
 * If `day` is a weekly off OR an approved leave, no submissions are generated.
 */
const ensureDailySubmissions = async (employee, day = new Date()) => {
  const today = startOfDay(day);

  // Full-day approved leave still ALWAYS suppresses the day's work.  This
  // is not affected by the manual override flag (we never push work onto
  // an employee who is on approved leave).
  const onLeave = await findApprovedLeave(employee._id, today);
  if (onLeave && onLeave.dayType !== 'half') return [];

  // Detect why this would be a non-working day.  Normal assignments are
  // skipped on these days; only assignments explicitly flagged
  // `holidayOverride=true` push through.
  const weeklyOff = isWeeklyOff(employee, today);
  const holiday = await Holiday.findOne({ date: today });
  const evHoliday = await isEventHolidayOn(today);
  const nonWorking = weeklyOff || !!holiday || !!evHoliday;

  const assignments = await assignmentsForEmployee(employee);
  // On working days, ALL assignments proceed (existing behavior).
  // On non-working days, only override assignments proceed — and the
  // 'once' scope (default) restricts the override to the assignment's
  // startDate so a recurring daily/weekly/monthly template doesn't bleed
  // onto every future Sunday/holiday.  Explicit 'all' keeps the old
  // permanent behavior for the rare repeating-override case.
  const eligibleAssignments = nonWorking
    ? assignments.filter((a) => {
      if (a.holidayOverride !== true) return false;
      if (a.overrideScope === 'all') return true;
      // 'once' (default): only on the assignment's startDate.
      const start = a.startDate ? startOfDay(a.startDate) : null;
      return !!start && start.getTime() === today.getTime();
    })
    : assignments;
  if (eligibleAssignments.length === 0) return [];

  const results = [];
  for (const a of eligibleAssignments) {
    if (!a.template) continue;

    // Recurrence gate: only generate when this assignment is scheduled for
    // `today` (handles one-time / daily / weekly / monthly + month-end
    // clamping + start/end bounds).
    if (!isScheduledOn(a, today)) continue;

    // already exists? (the unique index on (employee, template, date)
    // also guarantees we never duplicate a recurring task for a day.)
    let sub = await Submission.findOne({
      employee: employee._id,
      template: a.template._id,
      date: today,
    });
    if (sub) {
      results.push(sub);
      continue;
    }

    // Build new submission with fresh tasks from the template
    // (task templates) OR an empty grid of excelResponses (excel templates).
    const tplType = a.template.templateType || 'task';
    const fresh = tplType === 'task'
      ? a.template.tasks.map((t) => ({
          taskId: t._id,
          title: t.title,
          points: t.points,
          status: 'pending_submit',
        }))
      : [];
    const freshExcel = tplType === 'excel'
      ? a.template.excelColumns.map((col) => ({
          fieldName: col.fieldName,
          fieldType: col.fieldType,
          value: '',
          markEligible: !!col.markEligible,
          maxMarks: col.maxMarks || 0,
          marksAwarded: 0,
        }))
      : [];

    /* ---- Custom-template fresh state + Yesterday-Pending carry-forward ---- */
    let freshCustom = [];
    let customKind = '';
    if (tplType === 'custom') {
      customKind = a.template.customKind || '';
      // Phase 13: scope to the assignment's subTemplateIds[].  Empty
      // array = "all sub-templates" (preserves the legacy default for
      // assignments that never set a scope).  Single-id legacy
      // subTemplateId is folded in for back-compat with any document
      // the boot migration hasn't touched yet.  ROOT-level fields
      // (subTemplateId === '') are always included.
      const wantIds = Array.isArray(a.subTemplateIds) && a.subTemplateIds.length > 0
        ? a.subTemplateIds.map(String)
        : (a.subTemplateId ? [String(a.subTemplateId)] : []);
      const allSubs = wantIds.length === 0;
      const fieldsForScope = (a.template.customFields || []).filter((f) => {
        const sid = String(f.subTemplateId || '');
        if (!sid) return true;                  // template root always seeded
        return allSubs || wantIds.includes(sid);
      });
      freshCustom = fieldsForScope
        .slice()
        .sort((x, y) => (x.order || 0) - (y.order || 0))
        .map((f) => ({
          key: f.key,
          value: f.fieldType === 'number' || f.fieldType === 'currency' || f.fieldType === 'percentage' ? 0 : '',
        }));

      // Carry-forward: for the well-known Calling kind, copy the prior
      // day's `totalPending` (across the SAME employee + template) into
      // today's `yesterdayPending` field.  Generic mechanism so future
      // custom templates can opt in by declaring a `yesterdayPending`
      // system-generated field.
      const sysField = (a.template.customFields || []).find((f) => f.key === 'yesterdayPending' && f.systemGenerated);
      if (sysField) {
        // BUG-FIX: carry-forward must skip soft-deleted and test-marked
        // submissions so the Calling Report's `yesterdayPending` (and
        // every formula that derives from it -- oldPendingRemaining,
        // totalPending, pendingRate) matches what Calling Analytics
        // sees.  Without this guard, HR can mark a 30-pending row as
        // Test Data and analytics will read 0, while the next day's
        // form still shows yesterdayPending=30 -- exactly the desync
        // the user reported.
        const prior = await Submission.findOne({
          employee: employee._id,
          template: a.template._id,
          date: { $lt: today },
          submitted: true,
          ...liveSubmissionFilter({}),
        }).sort({ date: -1 }).select('customResponses');
        const priorTotal = (prior?.customResponses || []).find((r) => r.key === 'totalPending');
        const carry = Number(priorTotal?.value) || 0;
        const slot = freshCustom.find((r) => r.key === 'yesterdayPending');
        if (slot) slot.value = carry;
      }
    }

    // For 'sheet' templates, snapshot the entire grid onto the submission
    // so the report is self-contained.  Editable input cells start blank;
    // scoring targets are copied with marksAwarded = 0.
    let freshSheet;
    if (tplType === 'sheet' && a.template.sheet) {
      const ts = a.template.sheet.toObject ? a.template.sheet.toObject() : a.template.sheet;
      freshSheet = {
        sheetName: ts.sheetName,
        rowCount: ts.rowCount,
        colCount: ts.colCount,
        columns: ts.columns || [],
        rows: ts.rows || [],
        cells: (ts.cells || []).map((cell) => ({
          ...cell,
          // Clear employee-fillable cells; keep labels / preset values.
          value: cell.role === 'input' ? '' : cell.value,
        })),
        scores: (ts.scoring || []).map((sc) => ({
          key: sc.key,
          type: sc.type,
          rowIndex: sc.rowIndex,
          colIndex: sc.colIndex,
          label: sc.label,
          maxMarks: sc.maxMarks || 0,
          marksAwarded: 0,
          remark: '',
          // Carry the per-row status-tracking flag onto the submission
          // snapshot so the row behaves like a task for the employee.
          statusTracking: !!sc.statusTracking,
          rowStatus: '',
        })),
        allowEmployeeAddRows: !!ts.allowEmployeeAddRows,
      };
    }

    // Carry forward backlog: prior submissions (same template) where
    // any task is still 'pending' and not completed.  BUG-FIX: same
    // class of issue as the Calling yesterdayPending carry-forward --
    // submissions HR has soft-deleted or marked as Test Data must not
    // generate phantom backlog tasks for the employee tomorrow.
    const priorWithPending = await Submission.find({
      employee: employee._id,
      template: a.template._id,
      date: { $lt: today },
      'tasks.status': 'pending',
      ...liveSubmissionFilter({}),
    }).sort({ date: 1 });

    // Find pending tasks that haven't been completed yet
    const carry = [];
    for (const ps of priorWithPending) {
      for (const t of ps.tasks) {
        if (t.status === 'pending' && !t.completedAt) {
          // The task is still pending; keep it on its original submission.
          // We don't duplicate it into the new submission - the dashboard
          // queries pending tasks from all prior submissions directly.
          // (Implemented this way to preserve pendingSince and reason.)
          carry.push(t);
        }
      }
    }

    sub = await Submission.create({
      employee: employee._id,
      template: a.template._id,
      assignment: a._id,
      date: today,
      frequency: a.frequency || 'daily',
      scheduleLabel: a.scheduleLabel || buildScheduleLabel(a),
      // Stamp the manual-override audit so the UI can badge this card and
      // analytics can distinguish forced non-working-day work later.
      holidayOverride: nonWorking && !!a.holidayOverride,
      overrideReason: nonWorking && a.holidayOverride ? (a.overrideReason || '') : '',
      templateType: tplType,
      customKind,
      tasks: fresh,
      excelResponses: freshExcel,
      sheet: freshSheet,
      customResponses: freshCustom,
      totalPoints: 0,
      earnedPoints: 0,
    });

    results.push(sub);
  }

  return results;
};

/**
 * Aggregate the backlog (all still-pending tasks across all prior submissions).
 * Returns an array of { submissionId, taskId, title, pendingReason, pendingSince, daysPending }.
 */
const getBacklog = async (employeeId, asOf = new Date()) => {
  const today = startOfDay(asOf);
  // BUG-FIX: backlog widget must match the analytics view -- exclude
  // soft-deleted / test-marked submissions so the employee's "you
  // have N pending tasks" pill doesn't include rows HR has already
  // cleaned out of the live dataset.
  const subs = await Submission.find({
    employee: employeeId,
    'tasks.status': 'pending',
    ...liveSubmissionFilter({}),
  }).populate('template', 'title');

  const out = [];
  for (const s of subs) {
    for (const t of s.tasks) {
      if (t.status !== 'pending' || t.completedAt) continue;
      const since = t.pendingSince || s.date;
      const days = Math.max(0, Math.floor((today - startOfDay(since)) / (1000 * 60 * 60 * 24)));
      out.push({
        submissionId: s._id,
        taskId: t._id,
        templateId: s.template?._id,
        templateTitle: s.template?.title,
        frequency: s.frequency || 'daily',
        scheduleLabel: s.scheduleLabel || '',
        title: t.title,
        points: t.points,
        pendingReason: t.pendingReason,
        pendingSince: since,
        daysPending: days,
      });
    }
  }
  out.sort((a, b) => new Date(a.pendingSince) - new Date(b.pendingSince));
  return out;
};

/**
 * Walk a date range and label each day for one employee.
 * Returns { workingDays, presentDays, absentDays, paidLeaves, unpaidLeaves, weeklyOffDays, perDay[] }.
 */
const deriveAttendance = async (employee, from, to) => {
  const perDay = [];
  let presentDays = 0;
  let absentDays = 0;
  let paidLeaves = 0;      // FULL-day paid leaves
  let unpaidLeaves = 0;    // FULL-day unpaid leaves
  let halfPaidDays = 0;
  let halfUnpaidDays = 0;
  let weeklyOffDays = 0;
  let holidayDays = 0;

  // "Today" boundary.  Phase 16: today is no longer marked absent until
  // the day has fully ended.  A working day with no submission yet
  // resolves to 'ongoing' (work in progress) when day === todayMidnight,
  // 'future' when day > todayMidnight, and 'absent' only when
  // day < todayMidnight.  Submitting any assignment immediately flips
  // the day to 'present'.
  const todayMidnight = startOfDay(new Date());

  const submissionsInRange = await Submission.find({
    employee: employee._id,
    date: { $gte: startOfDay(from), $lt: startOfDay(to) },
    submitted: true,
  }).select('date');
  const submittedDays = new Set(submissionsInRange.map((s) => startOfDay(s.date).toISOString()));

  const leavesInRange = await Leave.find({
    employee: employee._id,
    status: 'approved',
    fromDate: { $lt: startOfDay(to) },
    toDate: { $gte: startOfDay(from) },
  });

  // Only FULL-day leaves drive the derived status; half-day leaves are
  // realised through an Attendance record at submission time.
  const fullDayLeaveOn = (day) =>
    leavesInRange.find((lv) =>
      lv.dayType !== 'half' && day >= startOfDay(lv.fromDate) && day <= startOfDay(lv.toDate));

  const holidaysInRange = await Holiday.find({
    date: { $gte: startOfDay(from), $lt: startOfDay(to) },
  });
  const holidayMap = new Map(
    holidaysInRange.map((h) => [startOfDay(h.date).toISOString(), h])
  );
  // Merge event-driven holidays (events with isHoliday=true, incl. yearly
  // recurrence).  Existing Holiday entries always win.
  const evMap = await getEventHolidayMap(startOfDay(from), startOfDay(to));
  for (const [iso, evt] of evMap.entries()) {
    if (!holidayMap.has(iso)) holidayMap.set(iso, { name: evt.name });
  }

  // Explicit attendance records (auto half-days + manual HR overrides)
  // take precedence over everything derived.
  const records = await Attendance.find({
    employee: employee._id,
    date: { $gte: startOfDay(from), $lt: startOfDay(to) },
  });
  const recordMap = new Map(records.map((r) => [startOfDay(r.date).toISOString(), r]));

  for (const day of eachDay(from, to)) {
    const iso = day.toISOString();
    const record = recordMap.get(iso);
    let status;
    let holidayName;

    if (record) {
      status = record.status; // manual / auto override wins
    } else if (isWeeklyOff(employee, day)) {
      status = 'weekly_off';
    } else {
      const holiday = holidayMap.get(iso);
      if (holiday) { status = 'holiday'; holidayName = holiday.name; }
      else {
        const lv = fullDayLeaveOn(day);
        if (lv) status = lv.paid ? 'full_paid' : 'full_unpaid';
        else if (submittedDays.has(iso)) status = 'present';
        // Phase 29 — mode-aware fallback (only kicks in AFTER all the
        // existing checks above, so the legacy submission-based path is
        // bit-for-bit identical for default-mode employees).  We branch
        // only when the day is a working day with no submission, no
        // record, no leave: that's exactly the spot mode 2 / 3 differ.
        //   auto_attendance     → Present every working day.
        //   attendance_review   → still 'absent' / 'ongoing' / 'future'
        //                          until HR reviews the confirmation and
        //                          writes a manual Attendance record
        //                          (handled by the `if (record)` branch
        //                          on the very next call).
        else if (employee.attendanceMode === 'auto_attendance') status = 'present';
        else if (day > todayMidnight) status = 'future';
        else if (day.getTime() === todayMidnight.getTime()) status = 'ongoing';
        else status = 'absent';
      }
    }

    const entry = { date: day, status, source: record?.source };
    if (holidayName) entry.holidayName = holidayName;
    if (record?.note) entry.note = record.note;
    // Surface the originating leave so the calendar can offer a Revoke
    // action directly on the day.  Only set when the record is leave-
    // linked (manual / auto records have leaveId=null).
    if (record?.leaveId) entry.leaveId = String(record.leaveId);
    perDay.push(entry);

    switch (status) {
      case 'present': presentDays += 1; break;
      case 'full_paid': paidLeaves += 1; break;
      case 'full_unpaid': unpaidLeaves += 1; break;
      case 'half_paid': halfPaidDays += 1; break;
      case 'half_unpaid': halfUnpaidDays += 1; break;
      case 'absent': absentDays += 1; break;
      case 'weekly_off': weeklyOffDays += 1; break;
      case 'holiday': holidayDays += 1; break;
      default: break; // 'future' / 'ongoing' -- not counted in any bucket.
                      // Salary counts payableDays only after the day
                      // resolves to present / leave / half_paid; an
                      // unresolved day cannot pay.
    }
  }

  // Weekly-offs and holidays are not working days.  Future working days
  // ARE counted so the per-day rate stays stable across the month.
  const workingDays = perDay.length - weeklyOffDays - holidayDays;

  // Paid day-units used for gross pay.  Half-paid days are fully paid
  // (worked half + half paid leave); half-unpaid days pay only the worked
  // half.  Future days are not yet payable.
  const payableDays =
    presentDays + paidLeaves + halfPaidDays + 0.5 * halfUnpaidDays;

  return {
    workingDays, presentDays, absentDays, paidLeaves, unpaidLeaves,
    halfPaidDays, halfUnpaidDays, weeklyOffDays, holidayDays,
    payableDays, perDay,
  };
};

module.exports = {
  isWeeklyOff,
  ensureDailySubmissions,
  getBacklog,
  deriveAttendance,
};
