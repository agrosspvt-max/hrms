const asyncHandler = require('express-async-handler');
const Submission = require('../models/Submission');
const User = require('../models/User');
const Leave = require('../models/Leave');
const Holiday = require('../models/Holiday');
const Department = require('../models/Department');
const Notification = require('../models/Notification');
const Attendance = require('../models/Attendance');
const Template = require('../models/Template');
const DependencyTask = require('../models/DependencyTask');
const { ensureDailySubmissions, getBacklog, isWeeklyOff } = require('../services/dailyEngine');
const { createDependencyTask } = require('../services/dependencyEngine');
const { startOfDay } = require('../utils/dateHelpers');
const { liveSubmissionFilter } = require('../utils/submissionFilter');
// Phase 47 -- realtime fan-out to HR/SA/HOD reviewers.
const rt = require('../services/realtime');
// Phase 60 -- Employee Private Remark visibility gate.
const { scrubPrivateRemark } = require('../utils/privateRemark');
// HOD Recommendation for HR is HR / SA / HOD-author only.  Same
// scrub-in-one-place pattern as scrubPrivateRemark; called alongside
// every existing scrubPrivateRemark call so no future endpoint can
// leak the note.
const { scrubHodRecommendation } = require('../utils/hodRecommendation');
// Phase 61 -- Penalty Engine hooks.
const penaltyEngine = require('../services/penaltyEngine');
const { attachFinalMarks } = require('../services/penaltyMath');
// Phase 64.4 Gap 2 -- late-submission gate consults the Penalty
// collection before accepting a submit for a past date.
const Penalty = require('../models/Penalty');

/**
 * Validate + stamp dependency fields onto a scorable unit (task / excel
 * row / sheet score) from an incoming payload.  Returns a descriptor to
 * actually create the linked DependencyTask AFTER the submission is saved
 * (so we have a persisted _id), or null for independent / no hand-off.
 *
 * Throws (400-style) when 'dependent' is chosen without an assignee+remark.
 */
const stampDependency = (unit, payload, { kind, sourceTaskId, originalTaskName, byUserId }, res) => {
  const type = payload?.dependencyType === 'dependent' ? 'dependent' : 'independent';
  unit.dependencyType = type;
  if (type !== 'dependent') return null;

  const assignedTo = payload.dependencyAssignedTo;
  const remark = (payload.dependencyRemark || '').trim();
  if (!assignedTo) { res.status(400); throw new Error(`Select who to assign the dependent work to for: ${originalTaskName}`); }
  if (!remark) { res.status(400); throw new Error(`Dependency remark is required for: ${originalTaskName}`); }

  unit.dependencyAssignedTo = assignedTo;
  unit.dependencyAssignedBy = byUserId;
  unit.dependencyRemark = remark;
  unit.dependencyCreatedAt = new Date();
  unit.dependencyStatus = 'open';

  return {
    unit, kind, sourceTaskId, originalTaskName,
    assignedToId: assignedTo, remark,
    priority: payload.priority,
  };
};

// Submissions logged BEFORE this hour (server local time) trigger the
// automatic half-day attendance rule.  Default 17 (5 PM) per spec --
// configurable via env so tenants can shift it without code changes.
const HALFDAY_CUTOFF_HOUR = Number(process.env.ATTENDANCE_HALFDAY_CUTOFF_HOUR) || 17;

/**
 * Apply the automatic attendance rule for `employee` on `day`.
 *
 * Phase 16: the previous "submitted before 5 PM = half_unpaid" rule is
 * GONE.  Submitting any valid assignment now always means Present.
 * deriveAttendance() resolves the absence of an explicit Attendance
 * record to 'present' the moment a submission lands for the day.
 *
 * What this helper still does: when an approved HALF-DAY LEAVE covers
 * the day and the employee submits the worked half, stamp the
 * half_paid record so payroll knows to pay both halves (worked +
 * paid leave).  Every other path is a no-op.
 *
 * Guards: NEVER create / overwrite a record when the day is already
 * owned by something else --
 *   - manual HR override   (existing.source === 'manual')
 *   - leave-linked record  (existing.source === 'leave')
 *   - approved full-day leave covering the day
 *   - employee weekly off
 *   - holiday
 */
const applyAutoHalfDay = async (employee, day) => {
  const existing = await Attendance.findOne({ employee: employee._id, date: day });
  if (existing && existing.source === 'manual') return; // HR override wins
  if (existing && existing.source === 'leave')  return; // leave-linked wins

  // Guard 1: employee's weekly off -- never touch.
  const { isWeeklyOff } = require('../services/dailyEngine');
  if (isWeeklyOff(employee, day)) return;

  // Guard 2: any kind of holiday on this date.
  // Phase 73 -- unified check: Holiday collection OR Event.isHoliday=true.
  const { isHolidayOn } = require('../services/eventOccurrences');
  const holidayToday = await isHolidayOn(day);
  if (holidayToday) return;

  // Guard 3: an approved FULL-day leave already owns this day (derive
  // will surface full_paid / full_unpaid -- we must not stamp half_X
  // on top).
  const fullDayLeave = await Leave.findOne({
    employee: employee._id,
    status: 'approved',
    dayType: { $ne: 'half' },
    fromDate: { $lte: day },
    toDate:   { $gte: day },
  });
  if (fullDayLeave) return;

  // Phase 16: the only auto-record we still stamp is `half_paid` for
  // the worked half on a half-day leave.  No half_unpaid, no time-of-
  // day cutoff -- any submission = Present unless half-day leave is
  // overlaying it.
  const halfLeave = await Leave.findOne({
    employee: employee._id,
    status: 'approved',
    dayType: 'half',
    fromDate: { $lte: day },
    toDate:   { $gte: day },
  });
  if (!halfLeave) return; // no half-day leave -> employee is fully Present

  await Attendance.findOneAndUpdate(
    { employee: employee._id, date: day },
    { employee: employee._id, date: day, status: 'half_paid', source: 'auto', setBy: employee._id },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

/**
 * Resolve the active HOD for an employee's department, if the employee's
 * review flow routes through a HOD.  Returns the HOD User doc or null.
 */
const resolveHodFor = async (employee) => {
  if (employee.reviewFlow !== 'hod_first' || !employee.department) return null;
  const dept = await Department.findById(employee.department).select('hodEmployeeId');
  if (!dept || !dept.hodEmployeeId) return null;
  if (String(dept.hodEmployeeId) === String(employee._id)) return null; // can't review self
  const hod = await User.findById(dept.hodEmployeeId);
  if (!hod || hod.status !== 'active' || !hod.isHOD) return null;
  if (!hod.hodPermissions?.canReview) return null;
  return hod;
};

/**
 * GET /api/submissions/today
 *
 * Employee dashboard entry-point.  Generates today's submissions on the
 * fly (idempotent), returns:
 *   - todayTasks: per-template list with editable tasks
 *   - backlog:    pending tasks from past days
 *   - onLeave:    true if employee has approved leave today
 *   - weeklyOff:  true if today is configured weekly off
 */
const getToday = asyncHandler(async (req, res) => {
  const employee = await User.findById(req.user._id);
  const today = startOfDay(new Date());

  // Holiday + leave + weekly-off short-circuits (Phase 73 unified).
  const { isHolidayOn: _isHolidayOn2 } = require('../services/eventOccurrences');
  const holiday = await _isHolidayOn2(today);
  const leaveToday = await Leave.findOne({
    employee: employee._id,
    status: 'approved',
    fromDate: { $lte: today },
    toDate: { $gte: today },
  });
  // Only a FULL-day leave suppresses the day's tasks.  A half-day leave
  // still requires the employee to work (and submit) the other half.
  const fullDayLeave = leaveToday && leaveToday.dayType !== 'half' ? leaveToday : null;
  const halfDayLeave = leaveToday && leaveToday.dayType === 'half' ? leaveToday : null;
  const weeklyOff = isWeeklyOff(employee, today);

  // Always invoke the engine UNLESS today is a full-day approved leave
  // (which truly suppresses work).  On a weekly-off / holiday the engine
  // itself only emits assignments with `holidayOverride === true` (honouring
  // overrideScope), so this is what makes the "Assign Work on Non-Working
  // Day" toggle actually surface on the employee's dashboard.
  if (!fullDayLeave) {
    await ensureDailySubmissions(employee, today);
  }

  // Submission Review UI integration -- also surface any PAST-day
  // unsubmitted submissions whose missed_submission penalty has an
  // APPROVED reopen request.  The employee fills those exactly like
  // a normal same-day submission; the existing late-submission gate
  // (Phase 64.4 Gap 2) allows the POST because the reopen was
  // approved.  Uses ONLY existing collections + fields; no schema
  // changes.
  let reopenedIds = [];
  try {
    const approvedReopens = await Penalty.find({
      employee: employee._id,
      category: { $in: ['missed_submission', 'absent_submission'] },
      'reopenRequest.decision': 'approved',
    }).select('submission').lean();
    reopenedIds = approvedReopens.map((p) => p.submission).filter(Boolean);
  } catch (e) { console.error('[getToday] reopen lookup:', e.message); }
  // Business-state suppression: a submission hidden by businessStateSync
  // (e.g. a full-day leave was approved for today AFTER the submission
  // was generated) must NOT be surfaced to the employee.  The row is
  // preserved for audit but excluded from the working view.  Reopened
  // rows are HR-driven and never hidden, so the guard is safe there too.
  const subWhere = reopenedIds.length > 0
    ? { employee: employee._id, hidden: { $ne: true }, $or: [{ date: today }, { _id: { $in: reopenedIds }, submitted: false }] }
    : { employee: employee._id, date: today, hidden: { $ne: true } };
  const submissions = await Submission.find(subWhere)
    .populate('template', 'title customFields customKind customSections privateRemarkEnabled privateRemarkLabel privateRemarkRequired');

  // Defensive log: surface what the employee form will actually receive,
  // so a missing populate field shows up the moment we serve a request.
  for (const s of submissions) {
    if (s.templateType === 'custom') {
      console.log(`[getToday] custom submission ${s._id} -> template "${s.template?.title}" kind=${s.template?.customKind || '-'} sections=${JSON.stringify(s.template?.customSections || [])} fields=${(s.template?.customFields || []).length}`);
    }
  }

  /* ------------------------------------------------------------------
   * Phase 58 — automatic template synchronization for UNSUBMITTED
   * custom submissions.  If HR edited the template AFTER the daily
   * engine seeded today's submission, the seeded `customResponses`
   * won't include the new field's key -- the employee form's
   * `seededKeys` filter would then hide it.  Here we splice any
   * template-defined fields that aren't yet in customResponses,
   * respecting the assignment's sub-template scope, so the form
   * reflects the LATEST template config without requiring HR to
   * revoke + reassign.  Historical (submitted) rows are never touched.
   * ------------------------------------------------------------------ */
  for (const s of submissions) {
    if (s.templateType !== 'custom' || s.submitted) continue;
    const tplFields = s.template?.customFields || [];
    if (tplFields.length === 0) continue;
    // Assignment sub-template scope (matches dailyEngine.fieldsForScope).
    const wantIds = Array.isArray(s.subTemplateIds) && s.subTemplateIds.length > 0
      ? s.subTemplateIds.map(String)
      : (s.subTemplateId ? [String(s.subTemplateId)] : []);
    const allSubs = wantIds.length === 0;
    const scopeMatch = (f) => {
      const sid = String(f.subTemplateId || '');
      if (!sid) return true;
      return allSubs || wantIds.includes(sid);
    };
    const have = new Set((s.customResponses || []).map((r) => r.key));
    const missing = tplFields.filter(scopeMatch).filter((f) => !have.has(f.key));
    if (missing.length === 0) continue;
    // Persist the newly-appended rows so the next reload also has them
    // (avoids a live-form flash while the day rolls over).
    const added = missing.map((f) => ({
      key: f.key,
      value: f.fieldType === 'number' || f.fieldType === 'currency' || f.fieldType === 'percentage' ? 0 : '',
      status: '', remark: '', outOfValue: 0,
      availableMarks: 0, earnedMarks: 0, penaltyMarks: 0,
    }));
    s.customResponses = [...(s.customResponses || []), ...added];
    try {
      await Submission.updateOne(
        { _id: s._id },
        { $set: { customResponses: s.customResponses } },
      );
    } catch (e) {
      // Non-fatal: even if the write fails, the client still sees the
      // spliced rows for this request.
      console.error('[getToday] template-sync splice failed:', e.message);
    }
  }

  // Effective working status: if HR pushed override work onto a weekly-off
  // or holiday, today is a working day for the employee -- otherwise the
  // dashboard would still show "Enjoy your day!" and hide the tasks.
  const hasOverrideWork = (weeklyOff || !!holiday) && submissions.length > 0;

  const backlog = await getBacklog(employee._id, today);

  // Phase-1 architecture (read/write separation): GET handlers must
  // never mutate business state.  The compliance sweep now runs only
  // via (a) the boot + daily 00:15 local scheduler in
  // `services/dailyComplianceScheduler.js` and (b) the explicit
  // `POST /api/compliance/refresh` action the client can call from
  // a button once per session if they want an immediate re-scan.
  // GET /submissions/today is a pure read.

  // Phase 61 -- attach Final Marks + penalty breakdown for the UI.
  try { await attachFinalMarks(submissions); }
  catch (e) { console.error('[getToday] attachFinalMarks:', e.message); }

  // Phase 60 -- getToday is the employee's own view, so scrub is a
  // no-op for self.  Call it anyway in case a future endpoint reuses
  // this handler with a non-owning caller.
  scrubPrivateRemark(submissions, req.user);
  scrubHodRecommendation(submissions, req.user);

  res.json({
    date: today,
    onLeave: !!fullDayLeave,
    // Effective flags drive the UI banner + the Today's Tasks gate.
    weeklyOff: weeklyOff && !hasOverrideWork,
    holiday: holiday && !hasOverrideWork
      ? { name: holiday.name, description: holiday.description, type: holiday.type }
      : null,
    // Surface the raw (calendar) status + override flag so the UI can
    // badge the day even when it shows the task list.
    weeklyOffOriginal: weeklyOff,
    holidayOriginal: holiday ? { name: holiday.name } : null,
    workingDespiteOff: hasOverrideWork,
    leaveInfo: fullDayLeave ? { fromDate: fullDayLeave.fromDate, toDate: fullDayLeave.toDate, leaveType: fullDayLeave.leaveType } : null,
    halfDayLeave: halfDayLeave ? { fromDate: halfDayLeave.fromDate, toDate: halfDayLeave.toDate, leaveType: halfDayLeave.leaveType } : null,
    submissions,
    backlog,
  });
});

/**
 * POST /api/submissions/:id/submit
 *
 * Body: { tasks: [{ taskId, status, pendingReason? }], selfRating?, selfNote? }
 *
 * Applies scoring rules and freezes the submission.
 */
const VALID_FIELD_TYPES = ['text', 'number', 'textarea', 'dropdown', 'date'];

const submitOne = asyncHandler(async (req, res) => {
  const { tasks = [], addedTasks = [], excelResponses = [], sheet, customResponses = [], extraTasks = [], productSales = [], farmerRecords = [], selfRating, selfNote, idea, privateRemark } = req.body;
  const sub = await Submission.findOne({ _id: req.params.id, employee: req.user._id });
  if (!sub) { res.status(404); throw new Error('Submission not found'); }
  if (sub.submitted) { res.status(400); throw new Error('Submission already submitted for today'); }

  const today = startOfDay(new Date());

  // Phase 64.4 Gap 2 -- late-submission workflow gate.  When the
  // submission's date is in the past AND a missed_submission /
  // absent_submission penalty exists for it, the employee must have
  // an APPROVED reopen request before we accept the submit.  This
  // enforces the spec's "Request Reopening -> HR Approves ->
  // Employee Submits" order at the API layer so a client cannot
  // bypass the workflow by POSTing directly.  Same-day submissions
  // are untouched (that's the normal flow).
  if (sub.date && startOfDay(sub.date).getTime() < today.getTime()) {
    const missPenalty = await Penalty.findOne({
      submission: sub._id,
      category: { $in: ['missed_submission', 'absent_submission'] },
      status: { $in: ['active', 'pending', 'scheduled'] },
    }).select('reopenRequest').lean();
    if (missPenalty) {
      const decision = missPenalty.reopenRequest?.decision || '';
      if (decision !== 'approved') {
        res.status(400);
        throw new Error(
          decision === 'pending'
            ? 'A reopen request is still pending HR review.  You cannot re-submit until it is approved.'
            : decision === 'rejected'
              ? 'HR rejected your reopen request.  Contact HR to raise a new request.'
              : 'This day\'s submission window has closed.  Open Fines & Penalties to request reopening from HR.'
        );
      }
    }
  }

  // Block submission on a holiday (in case the row was created earlier
  // and HR added a holiday after the fact).  Phase 73 -- unified check
  // so an Event.isHoliday=true event also blocks submission.
  const { isHolidayOn: _isHolidayOn3 } = require('../services/eventOccurrences');
  const holidayToday = await _isHolidayOn3(today);
  if (holidayToday) {
    res.status(400);
    throw new Error(`Today is a holiday: ${holidayToday.name}. No submissions are required.`);
  }

  // Phase 69 -- Self Rating is now required before ANY assignment can
  // be submitted.  Accept the rating inline (upsert onto the day's
  // DailyReflection) OR require an existing reflection with a valid
  // rating.  The Daily Self Review analytics module treats every
  // reflection as authoritative -- enforcing this here keeps the data
  // set clean without duplicating rating storage.
  {
    const DailyReflection = require('../models/DailyReflection');
    const subDay = sub.date ? startOfDay(sub.date) : today;
    const inlineRatingRaw = selfRating;
    let inlineRating = null;
    if (inlineRatingRaw !== undefined && inlineRatingRaw !== null && inlineRatingRaw !== '') {
      const n = Number(inlineRatingRaw);
      if (!Number.isFinite(n) || n < 0 || n > 10) {
        res.status(400);
        throw new Error('Self Rating must be a number between 0 and 10.');
      }
      inlineRating = n;
    }
    if (inlineRating !== null) {
      await DailyReflection.findOneAndUpdate(
        { employee: req.user._id, date: subDay },
        {
          $set: {
            selfRating: inlineRating,
            lastEditedBy: req.user._id,
            ...(selfNote !== undefined ? { selfNote: String(selfNote || '') } : {}),
            ...(idea     !== undefined ? { idea:     String(idea     || '') } : {}),
          },
          $setOnInsert: { employee: req.user._id, date: subDay },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
    } else {
      const existing = await DailyReflection.findOne({ employee: req.user._id, date: subDay })
        .select('selfRating').lean();
      const ok = existing && typeof existing.selfRating === 'number'
        && existing.selfRating >= 0 && existing.selfRating <= 10;
      if (!ok) {
        res.status(400);
        throw new Error('Please fill your Daily Self Rating (0-10) before submitting today\'s assignments.');
      }
    }
  }
  let earned = 0;
  let total = 0;

  // Dependency hand-offs to create once the submission is persisted.
  const pendingDeps = [];
  const tpl = await Template.findById(sub.template).select('title statusTracking');
  const templateTitle = tpl?.title || '';

  if (sub.templateType === 'excel') {
    // Excel report: we only collect VALUES at submit time.  HR awards
    // per-field marks during review, so workEarnedPoints starts at 0
    // and workTotalPoints is the sum of maxMarks for mark-eligible
    // fields.
    const incoming = new Map(
      excelResponses.map((r) => [String(r.fieldName || ''), r])
    );
    sub.excelResponses.forEach((r) => {
      const inc = incoming.get(r.fieldName);
      if (inc) {
        r.value = inc.value === undefined ? r.value : inc.value;
        // Optional per-row status (only when the template enables tracking).
        if (tpl?.statusTracking && ['done', 'pending', 'work_not_available'].includes(inc.rowStatus)) {
          r.rowStatus = inc.rowStatus;
        }
        // Dependency hand-off for done / pending rows.
        if (tpl?.statusTracking && (r.rowStatus === 'done' || r.rowStatus === 'pending')) {
          const dep = stampDependency(r, inc, {
            kind: 'excel', sourceTaskId: r.fieldName, originalTaskName: r.fieldName, byUserId: req.user._id,
          }, res);
          if (dep) pendingDeps.push(dep);
        }
      }
      if (r.markEligible) total += r.maxMarks || 0;
    });
    earned = 0;
  } else if (sub.templateType === 'sheet') {
    // Spreadsheet report: collect employee-entered VALUES now.  HR awards
    // per-target (cell/row/column) marks on review, so workEarned starts
    // at 0 and workTotal is the sum of all scoring maxMarks.
    if (!sub.sheet) { res.status(400); throw new Error('Submission has no sheet structure'); }

    const incomingCells = Array.isArray(sheet?.cells) ? sheet.cells : [];
    // Index our authoritative snapshot cells by "r:c"
    const cellMap = new Map(sub.sheet.cells.map((cell) => [`${cell.r}:${cell.c}`, cell]));
    const allowAdd = !!sub.sheet.allowEmployeeAddRows;
    let maxRow = sub.sheet.rowCount - 1;

    incomingCells.forEach((inc) => {
      const r = Number(inc.r);
      const c = Number(inc.c);
      if (!Number.isFinite(r) || !Number.isFinite(c)) return;
      const key = `${r}:${c}`;
      const existing = cellMap.get(key);
      if (existing) {
        // Only employee-fillable cells accept new values; structure is
        // authoritative and never overwritten by the client.
        if (existing.editable && existing.role === 'input') {
          existing.value = inc.value === undefined ? '' : inc.value;
        }
      } else if (allowAdd && r >= sub.sheet.rowCount) {
        // A row the employee appended.  Accept as a sanitised new cell.
        const role = inc.role === 'label' ? 'label' : 'input';
        const newCell = {
          r,
          c,
          value: inc.value === undefined ? '' : inc.value,
          role,
          fieldType: VALID_FIELD_TYPES.includes(inc.fieldType) ? inc.fieldType : 'text',
          editable: role === 'input',
          hidden: false,
          options: Array.isArray(inc.options) ? inc.options.map((o) => String(o)).filter(Boolean) : [],
          addedByEmployee: true,
        };
        sub.sheet.cells.push(newCell);
        cellMap.set(key, newCell);
        if (r > maxRow) maxRow = r;
      }
    });

    // Register row metadata for any appended rows + bump rowCount.
    if (allowAdd && maxRow >= sub.sheet.rowCount) {
      const existingRowIdx = new Set(sub.sheet.rows.map((rw) => rw.index));
      for (let r = sub.sheet.rowCount; r <= maxRow; r++) {
        if (!existingRowIdx.has(r)) {
          const labelCell = sub.sheet.cells.find((cell) => cell.r === r && cell.c === 0);
          sub.sheet.rows.push({ index: r, label: String(labelCell?.value || r + 1), hidden: false });
        }
      }
      sub.sheet.rowCount = maxRow + 1;
    }

    total = (sub.sheet.scores || []).reduce((s, sc) => s + (sc.maxMarks || 0), 0);
    earned = 0;

    // Per-row status + dependency hand-off.  ROW-WISE: only scores that HR
    // flagged with statusTracking behave like task rows.  Keyed by the
    // stable score `key`.
    if (Array.isArray(sheet?.scores)) {
      const byKey = new Map(sheet.scores.map((s) => [String(s.key || ''), s]));
      sub.sheet.scores.forEach((sc) => {
        if (!sc.statusTracking) return; // not a task row
        const inc = byKey.get(sc.key);
        if (!inc) return;
        if (['done', 'pending', 'work_not_available'].includes(inc.rowStatus)) {
          sc.rowStatus = inc.rowStatus;
        }
        if (sc.rowStatus === 'pending') {
          sc.pendingReason = (inc.pendingReason || '').trim();
          if (!sc.pendingReason) {
            res.status(400);
            throw new Error(`Reason required for pending row: ${sc.label || sc.key}`);
          }
        }
        if (sc.rowStatus === 'done' || sc.rowStatus === 'pending') {
          const dep = stampDependency(sc, inc, {
            kind: 'sheet', sourceTaskId: sc.key, originalTaskName: sc.label || sc.key, byUserId: req.user._id,
          }, res);
          if (dep) pendingDeps.push(dep);
        }
      });
    }
    sub.markModified('sheet');
  } else if (sub.templateType === 'custom') {
    /* ---- Custom Assignment submit ----
       Reads the employee-entered values, validates required fields,
       resolves all `auto` formulas server-side, and persists the full
       responses array.  Scoring follows the existing pattern: workEarned
       starts at 0 (HR awards innovation marks during review).
       The `yesterdayPending` field is system-generated -- always
       preserved from what the daily engine seeded, never overwritten by
       the client. */
    const { computeAutoFields } = require('../services/customTemplate');
    // customSections MUST be in this projection -- the productSales /
    // farmerRecords persistence blocks below are guarded on
    // tpl.customSections.includes(...).  Without this field projected,
    // the guard silently evaluates false on every submit and the
    // employee's product/farmer rows are dropped, leaving submissions
    // with empty productSales[] / farmerRecords[] and Product & Farmer
    // Analytics permanently at zero.  (This was the cause of the
    // "submissions exist but analytics shows 0/₹0" bug.)
    const tpl = await Template.findById(sub.template).select('customFields customKind customSections');
    if (!tpl || !Array.isArray(tpl.customFields)) {
      res.status(400);
      throw new Error('Custom template is missing field definitions.');
    }
    // Build a working map from the incoming responses; only preserve
    // the seeded value when the field is structurally read-only on
    // the template (fieldType === 'readonly').  Earlier this loop
    // gated on `def.systemGenerated`, which silently overwrote
    // employee-typed values on every field where HR had accidentally
    // ticked the (since-removed) System-generated checkbox in the
    // builder.  Result: employee types 100, backend ignores 100 and
    // writes the seeded 0.  Aligning the gate with fieldType matches
    // what the frontend renderer treats as read-only and prevents
    // future drift between the two layers.
    const incoming = {};
    const incomingMeta = {}; // Phase 14: per-key { status, remark }
    (customResponses || []).forEach((r) => {
      if (!r || !r.key) return;
      incoming[r.key] = r.value;
      incomingMeta[r.key] = {
        status: r.status || '',
        remark: typeof r.remark === 'string' ? r.remark : '',
      };
    });
    (sub.customResponses || []).forEach((r) => {
      const def = tpl.customFields.find((f) => f.key === r.key);
      // Only structurally read-only fields (carry-forward sentinels
      // like Calling Report's yesterdayPending) keep the seeded value
      // -- those are populated by the daily engine and never edited.
      // 'auto' fields don't need this guard because computeAutoFields
      // re-evaluates their formulas at submit time anyway.
      if (def && def.fieldType === 'readonly') {
        incoming[r.key] = r.value;
        incomingMeta[r.key] = { status: r.status || '', remark: r.remark || '' };
      }
    });
    // Validate: required + employee-editable fields must be present.
    for (const f of tpl.customFields) {
      if (!f.required) continue;
      if (f.systemGenerated || f.fieldType === 'auto' || f.fieldType === 'readonly') continue;
      // Phase 53 -- 'none' is a status-only field.  It carries no
      // value column, so `required` applies to the status pick
      // (validated below), not to `incoming[f.key]`.
      if (f.fieldType === 'none') {
        const meta = incomingMeta[f.key] || {};
        if (!meta.status) {
          res.status(400);
          throw new Error(`Required status missing: ${f.label}`);
        }
        continue;
      }
      const v = incoming[f.key];
      if (v === undefined || v === null || v === '') {
        res.status(400);
        throw new Error(`Required field missing: ${f.label}`);
      }
    }
    // Phase 14: dependency + pending => remark is mandatory.  Mirrors
    // the existing task / excel / sheet semantics so analytics can
    // trust that every pending row carries a reason.
    for (const f of tpl.customFields) {
      const meta = incomingMeta[f.key];
      if (!meta) continue;
      if (meta.status === 'pending' && !(meta.remark || '').trim()) {
        res.status(400);
        throw new Error(`Pending reason is required for "${f.label}".`);
      }
    }
    // Phase 52 -- per-field "Remark Required".  Applies only when
    // the field also has Remark Enabled (`supportsRemark`).  The
    // check is per-field, not per-template: only the flagged fields
    // must carry a non-empty remark; every other field is unaffected.
    for (const f of tpl.customFields) {
      if (!f.supportsRemark || !f.remarkRequired) continue;
      if (f.systemGenerated || f.fieldType === 'auto' || f.fieldType === 'readonly') continue;
      const meta = incomingMeta[f.key] || {};
      if (!(meta.remark || '').trim()) {
        res.status(400);
        throw new Error(`Remark is required for "${f.label}".`);
      }
    }
    const evaluated = computeAutoFields(tpl, incoming);
    // Phase 58 — capture Number-tasks' second value ("Out Of").  The
    // client sends it in the response row alongside `value`; we lift
    // it into a keyed lookup so the marks calculator + persisted
    // response both see the same number.
    const incomingOutOf = {};
    (customResponses || []).forEach((r) => {
      if (r && r.key && r.outOfValue !== undefined) incomingOutOf[r.key] = Number(r.outOfValue) || 0;
    });
    // Phase 58 — compute the per-field marks + totals BEFORE writing
    // customResponses, so we can splice the marks back onto each row.
    const { computeCustomMarks } = require('../services/customMarks');
    const marksResult = computeCustomMarks(
      tpl.customFields || [],
      incoming,
      incomingOutOf,
      Object.fromEntries(Object.entries(incomingMeta).map(([k, v]) => [k, v?.status || ''])),
    );
    const marksByKey = new Map(marksResult.perField.map((m) => [m.key, m]));

    // Phase 14: re-attach status + remark per row.  computeAutoFields
    // returns the canonical [{ key, value }] shape; we layer the
    // incoming { status, remark } back on so the storage matches the
    // new schema.
    sub.customResponses = evaluated.map((row) => {
      const meta = incomingMeta[row.key] || { status: '', remark: '' };
      const m = marksByKey.get(row.key);
      return {
        key: row.key,
        value: row.value,
        status: meta.status,
        remark: meta.remark,
        // Phase 58 -- persist marks snapshot on every row so historical
        // analytics are stable even if HR later edits the template.
        outOfValue: incomingOutOf[row.key] || 0,
        availableMarks: m ? m.availableMarks : 0,
        earnedMarks:    m ? m.earnedMarks    : 0,
        penaltyMarks:   m ? m.penaltyMarks   : 0,
      };
    });
    sub.customKind = tpl.customKind || sub.customKind || '';
    // Phase 58 — Marks roll-up on the submission itself.  Never
    // negative; zeroed for legacy templates with no marks enabled.
    sub.customAvailableMarks = marksResult.available;
    sub.customEarnedMarks    = marksResult.earned;
    sub.customPenaltyMarks   = marksResult.penalty;
    sub.customFinalMarks     = marksResult.final;
    sub.markModified('customResponses');

    /* ---- Phase 53: Extra Tasks + catalog upsert ----
       The employee may submit ad-hoc "Extra Tasks" alongside the
       template's predefined customFields.  Each row is normalised
       (slugged key, trimmed label, validated responseType), and any
       key that isn't already in tpl.extraTaskCatalog is upserted so
       the next employee can pick it from the catalog dropdown.

       Extra tasks live in their own array so predefined-task
       analytics, scoring, and innovation flows are untouched. */
    const _slug = (s) => String(s || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
    const RESP_TYPES = new Set(['none', 'number', 'status', 'number_status']);
    const cleanedExtras = [];
    const catalogAdditions = [];
    const seenKeys = new Set();
    // Snapshot existing catalog keys ONCE so the loop is O(N).  We
    // upsert directly on the tpl document (loaded above) and persist
    // via the batched Template.findByIdAndUpdate call below.
    const existingKeys = new Set((tpl.extraTaskCatalog || []).map((c) => c.key));
    for (const raw of (extraTasks || [])) {
      if (!raw || (!raw.label && !raw.key)) continue;
      const label = String(raw.label || '').trim();
      if (!label) continue;
      const key = raw.key ? _slug(raw.key) : _slug(label);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      const responseType = RESP_TYPES.has(raw.responseType) ? raw.responseType : 'none';
      const wantsValue  = responseType === 'number' || responseType === 'number_status';
      const wantsStatus = responseType === 'status' || responseType === 'number_status';
      const value = wantsValue
        ? (raw.value === '' || raw.value === null || raw.value === undefined
            ? '' : Number(raw.value))
        : '';
      const status = wantsStatus
        ? (['done', 'ongoing', 'pending', 'work_not_available'].includes(raw.status) ? raw.status : '')
        : '';
      // Phase 59 — snapshot the marks config from the catalog (or the
      // client-provided config for a brand-new task) so the row is
      // scoreable + re-editable independently of the catalog.
      const catalogRow = (tpl.extraTaskCatalog || []).find((c) => c.key === key);
      const marksCfg = catalogRow || raw || {};
      const optionMarksClean = Array.isArray(marksCfg.optionMarks)
        ? marksCfg.optionMarks
            .filter((o) => o && typeof o.option === 'string')
            .map((o) => ({
              option: String(o.option).trim(),
              percent: Math.max(0, Math.min(100, Number(o.percent) || 0)),
              penalty: Math.max(0, Number(o.penalty) || 0),
            }))
        : [];
      cleanedExtras.push({
        key,
        label,
        description: String(raw.description || '').trim(),
        responseType,
        value,
        status,
        remark: String(raw.remark || '').trim(),
        outOfValue:      Number(raw.outOfValue) || 0,
        maxMarks:        Math.max(0, Number(marksCfg.maxMarks) || 0),
        isCritical:      !!marksCfg.isCritical,
        penaltyMarksCfg: Math.max(0, Number(marksCfg.penaltyMarks) || 0),
        threshold:       Math.max(0, Number(marksCfg.threshold) || 0),
        optionMarks:     optionMarksClean,
        availableMarks:  0, earnedMarks: 0, penaltyMarks: 0,
      });
      if (!existingKeys.has(key)) {
        catalogAdditions.push({
          key, label,
          description: String(raw.description || '').trim(),
          responseType,
          // Persist marks config on brand-new catalog entries so
          // future submissions of the same extra task inherit them.
          maxMarks:      Math.max(0, Number(raw.maxMarks) || 0),
          isCritical:    !!raw.isCritical,
          penaltyMarks:  Math.max(0, Number(raw.penaltyMarks) || 0),
          threshold:     Math.max(0, Number(raw.threshold) || 0),
          optionMarks:   optionMarksClean,
          createdBy: req.user._id,
          createdAt: new Date(),
        });
        existingKeys.add(key);
      }
    }
    // Phase 59 — score every extra task through the SAME engine that
    // scores predefined customFields, then splice per-row marks back.
    if (cleanedExtras.length > 0) {
      const { computeExtraTaskMarks } = require('../services/customMarks');
      const extraMarks = computeExtraTaskMarks(cleanedExtras);
      const marksByKey = new Map(extraMarks.perField.map((m) => [m.key, m]));
      for (const row of cleanedExtras) {
        const m = marksByKey.get(row.key);
        if (m) {
          row.availableMarks = m.availableMarks;
          row.earnedMarks    = m.earnedMarks;
          row.penaltyMarks   = m.penaltyMarks;
        }
      }
      // Fold Extra Task marks into the submission totals so Marks
      // Analytics + Score % include both buckets.  Final never negative.
      sub.customAvailableMarks = (sub.customAvailableMarks || 0) + extraMarks.available;
      sub.customEarnedMarks    = (sub.customEarnedMarks    || 0) + extraMarks.earned;
      sub.customPenaltyMarks   = (sub.customPenaltyMarks   || 0) + extraMarks.penalty;
      sub.customFinalMarks     = Math.max(0, sub.customEarnedMarks - sub.customPenaltyMarks);
    }
    sub.extraTasks = cleanedExtras;
    sub.markModified('extraTasks');
    if (catalogAdditions.length > 0) {
      // Persist catalog additions on the parent template with an atomic
      // $push + $each so parallel submissions from different employees
      // don't clobber each other.  Uniqueness is guarded by our own
      // existingKeys check + a duplicate-key skip in the model layer.
      try {
        await Template.findByIdAndUpdate(
          tpl._id,
          { $push: { extraTaskCatalog: { $each: catalogAdditions } } },
        );
      } catch (e) {
        // Non-fatal: submission proceeds even if catalog write fails.
        console.error('[extraTaskCatalog] append failed:', e.message);
      }
    }

    /* ---- Product Sales sub-table (templates that opt in) ----
       Master-data IDs are validated, fields snapshotted at submit time,
       Sales Value + NBV recomputed server-side from the snapshot so the
       client can never inflate the numbers. */
    if (Array.isArray(tpl.customSections) && tpl.customSections.includes('productSales')) {
      const Product  = require('../models/Product');
      const Quantity = require('../models/Quantity');
      const cleanedSales = [];
      for (const row of (productSales || [])) {
        // Accept a row that carries EITHER:
        //   - a raw canonical `quantity` (new flow: employee types 0.5 / 25 / etc.)
        //   - a legacy `quantityId` pointing into Quantity Master
        // Must also reference a Product.
        if (!row || !row.productId) continue;
        const prod = await Product.findById(row.productId).lean();
        if (!prod) continue; // silently drop invalid rows

        // Resolve quantity: raw input wins; fall back to Quantity Master
        // snapshot so older clients keep working.
        let qty = null;
        let qval = Number(row.quantity);
        if (!Number.isFinite(qval) || qval <= 0) {
          if (row.quantityId) qty = await Quantity.findById(row.quantityId).lean();
          qval = Number(qty?.value) || 0;
        }
        if (qval <= 0) continue; // no quantity = nothing to score

        const price  = Number(prod.pricePerUnit) || 0;
        const nbvPct = Math.max(0, Math.min(Number(prod.nbvPercentage) || 0, 100));
        const sales  = Math.round(price * qval * 100) / 100;
        const nbv    = Math.round(sales * nbvPct) / 100;
        cleanedSales.push({
          productId: prod._id,
          productName: prod.name,
          productUnit: prod.unit,
          productPrice: price,
          productNbvPercentage: nbvPct,
          quantityId: qty?._id,
          quantityLabel: qty?.label || '',
          quantityValue: qty ? (Number(qty.value) || 0) : qval, // mirror raw qty when no master row
          quantity:     qval,
          salesValue: sales,
          nbvValue: nbv,
        });
      }
      sub.productSales = cleanedSales;
      sub.markModified('productSales');
    }

    /* ---- Farmer Records sub-table (templates that opt in) ----
       v2 schema: each farmer carries an optional Dealer Master
       reference + a products[] array.  Legacy single-product fields
       are kept and mirrored from products[0] so historical analytics
       paths keep working.  Dealer name + place are SNAPSHOTTED so
       Dealer Analytics survives later renames / deactivations. */
    if (Array.isArray(tpl.customSections) && tpl.customSections.includes('farmerRecords')) {
      const Product  = require('../models/Product');
      const Dealer   = require('../models/Dealer');
      const cleanedFarmers = [];
      for (const row of (farmerRecords || [])) {
        if (!row) continue;
        const name = String(row.name || '').trim();
        if (!name) continue; // require at least a name

        // Resolve dealer (optional).
        let dealer = null;
        if (row.dealerId) dealer = await Dealer.findById(row.dealerId).lean();

        // Resolve products[] -- snapshot product master at submit time.
        const rawProducts = Array.isArray(row.products) ? row.products
                          : (row.productId ? [{ productId: row.productId, quantity: Number(row.quantity) || 0 }] : []);
        const cleanedProducts = [];
        for (const pr of rawProducts) {
          if (!pr || !pr.productId) continue;
          const prod = await Product.findById(pr.productId).lean();
          if (!prod) continue;
          const q = Number(pr.quantity);
          cleanedProducts.push({
            productId:   prod._id,
            productName: prod.name,
            productUnit: prod.unit,
            quantity:    Number.isFinite(q) && q > 0 ? q : 0,
          });
        }

        // Legacy mirrors -- first product wins so the existing analytics
        // path (productName count) keeps producing meaningful numbers.
        const first = cleanedProducts[0];

        cleanedFarmers.push({
          name,
          mobile:         String(row.mobile || '').trim(),
          village:        String(row.village || '').trim(),

          // Preserve original free-text dealer (if employee typed one
          // before Dealer Master existed, or for legacy clients).
          dealerLocation: String(row.dealerLocation || '').trim(),

          // New dealer snapshot (Phase 3 split).  We mirror firmName
          // into the legacy dealerNameSnapshot field so any older
          // analytics path that reads it keeps producing the same
          // bucket labels it did before the rename.
          dealerId:             dealer?._id,
          dealerNameSnapshot:   dealer?.firmName || dealer?.name || '',  // legacy = firm
          dealerPlaceSnapshot:  dealer?.place || '',
          dealerFirmSnapshot:   dealer?.firmName || dealer?.name || '',
          dealerPersonSnapshot: dealer?.dealerName || '',

          // Legacy single-product mirror.
          productId:     first?.productId,
          productName:   first?.productName || '',
          quantityLabel: '',     // legacy; not used by new flow
          quantityId:    undefined,

          // New repeating products list.
          products: cleanedProducts,
        });
      }
      sub.farmerRecords = cleanedFarmers;
      sub.markModified('farmerRecords');
    }

    total = 0; // custom templates earn marks via HR review (innovation only)
    earned = 0;
  } else {
    const updateMap = new Map(tasks.map((t) => [String(t.taskId), t]));

    // Phase 64 Part 3 -- pre-load the working-day context ONCE outside
    // the forEach callback (forEach can't await) so any pending task
    // in this submission can stamp resolveBy synchronously below.
    let _wdCtx = null;
    let _addWorkingDays = null;
    try {
      const { addWorkingDays, loadWorkingDayContext } = require('../utils/workingDays');
      _addWorkingDays = addWorkingDays;
      _wdCtx = await loadWorkingDayContext({
        employee: { _id: sub.employee, weeklyOff: req.user.weeklyOff || [0] },
        from: today,
        to: new Date(today.getTime() + 90 * 86400000),
      });
    } catch (_) { /* fallback: resolveBy stays null on the tasks */ }

    sub.tasks.forEach((t) => {
      const upd = updateMap.get(String(t._id));
      if (!upd) return;
      const status = upd.status;

      if (status === 'done' || status === 'ongoing') {
        t.status = status;
        // The "Remark" field on the task form is optional for Done /
        // Ongoing; if the employee wrote one, persist it on the same
        // `pendingReason` string that Pending uses -- one field, one
        // storage slot, label just reads as "Remark" on display.
        t.pendingReason = upd.pendingReason || '';
        earned += t.points;
        total += t.points;
      } else if (status === 'pending') {
        t.status = 'pending';
        t.pendingReason = upd.pendingReason || '';
        t.pendingSince = today;
        // Phase 64 Part 3 -- default 3 working days to resolve.  We
        // stamp `resolveBy` ONCE at submit time so the frontend never
        // has to redo the working-day arithmetic on each page load.
        // HR can later override `resolveWithin` inside Submission
        // Review; the override handler recomputes resolveBy.
        if (!t.resolveWithin || t.resolveWithin <= 0) t.resolveWithin = 3;
        // Uses the pre-loaded working-day context so the forEach
        // stays synchronous.  Falls back to null when the context
        // couldn't be built (e.g. Mongo hiccup) -- the UI degrades
        // gracefully.
        try {
          t.resolveBy = (_addWorkingDays && _wdCtx)
            ? _addWorkingDays(today, t.resolveWithin, _wdCtx)
            : null;
        } catch (_) {
          t.resolveBy = null;
        }
        total += t.points;
        if (!t.pendingReason) {
          res.status(400);
          throw new Error(`Reason required for pending task: ${t.title}`);
        }
      } else if (status === 'work_not_available') {
        t.status = 'work_not_available';
        // not counted at all
      }

      // Dependency hand-off is meaningful for any non-WNA work the
      // employee actually engaged with: done / ongoing / pending.
      if (status === 'done' || status === 'ongoing' || status === 'pending') {
        const dep = stampDependency(t, upd, {
          kind: 'task', sourceTaskId: String(t._id), originalTaskName: t.title, byUserId: req.user._id,
        }, res);
        if (dep) pendingDeps.push(dep);
      }
    });

    // Employee-added tasks: extra work the employee wrote in.  Stored
    // with status='done' and awardedMarks=0; HR awards marks during
    // review.  They contribute 0 to earned/total at submit time -- the
    // review step recomputes earned/total to include awardedMarks.
    //
    // Phase 27 — IMPORTANT: drop any previously-saved addedByEmployee
    // rows BEFORE pushing the submit payload.  The draft endpoint
    // (saveDraft, see below) also stores employee-added rows on
    // sub.tasks (typically with status='pending_submit' = "Not filled")
    // so a normal "save draft → submit" sequence used to leave the
    // draft copies in place and then push fresh "Done" copies on top,
    // surfacing every extra task twice in HR's Submission Reviews
    // (once as NOT FILLED, once as DONE).  Mirroring the draft path's
    // own filter-and-replace pattern fixes the duplication without
    // touching any scoring or workflow logic.
    if (Array.isArray(addedTasks)) {
      sub.tasks = sub.tasks.filter((t) => !t.addedByEmployee);
      for (const at of addedTasks) {
        const title = String(at?.title || '').trim();
        if (!title) continue;
        sub.tasks.push({
          title,
          points: 0,
          status: 'done',
          addedByEmployee: true,
          awardedMarks: 0,
        });
      }
      sub.markModified('tasks');
    }
  }

  // Snapshot the pure work scoring (immutable). Final earned/total may
  // grow when HR adds innovation marks during review.
  sub.workEarnedPoints = earned;
  sub.workTotalPoints = total;
  sub.earnedPoints = earned;
  sub.totalPoints = total;
  sub.completionPercentage = total > 0 ? (earned / total) * 100 : 0;
  sub.submitted = true;
  sub.submittedAt = new Date();
  // Phase 61 -- clear any absent_submission penalty (probable or
  // enforced) attached to this exact submission the moment it lands.
  try { await penaltyEngine.resolveAbsentSubmissionOnSubmit({ submissionId: sub._id }); }
  catch (e) { console.error('[submit] penaltyEngine resolve:', e.message); }
  sub.reviewStatus = 'pending';
  if (selfRating !== undefined) sub.selfRating = selfRating;
  if (selfNote !== undefined) sub.selfNote = selfNote;
  if (idea !== undefined) sub.idea = idea;

  // Phase 60 -- Employee Private Remark.  Enabled at the template level.
  // Only persisted when the template has the feature turned on so a
  // rogue client can't stash an "invisible" note on a template that
  // doesn't advertise the field.  Required-mode short-circuits the
  // submit if the string is empty.
  const tplPRE = await (async () => {
    if (!sub.template) return { enabled: false, required: false };
    const t = await Template.findById(sub.template).select('privateRemarkEnabled privateRemarkRequired').lean();
    return { enabled: !!t?.privateRemarkEnabled, required: !!t?.privateRemarkRequired };
  })();
  if (tplPRE.enabled) {
    const remarkTxt = typeof privateRemark === 'string' ? privateRemark.trim() : '';
    if (tplPRE.required && !remarkTxt) {
      res.status(400);
      throw new Error('This template requires a private remark before submission.');
    }
    if (remarkTxt || sub.privateRemark) {
      sub.privateRemark = remarkTxt;
      sub.privateRemarkSubmittedAt = new Date();
      // Phase 60 -- audit trail note.  For now we simply record that a
      // remark was attached to this submission; the contents are NOT
      // captured (they're private and would leak into audit exports).
      try {
        const { logAudit } = require('../utils/audit');
        logAudit(req, {
          action: 'submission.privateRemark.submit',
          targetType: 'Submission',
          targetId: sub._id,
          targetLabel: `${req.user.name || req.user._id} attached a private remark`,
          meta: { hasContent: remarkTxt.length > 0, length: remarkTxt.length },
        });
      } catch (_) { /* audit failures never block a submit */ }
    }
  } else if (privateRemark) {
    // Template doesn't have the field enabled -- ignore any incoming
    // value so no back-door data can be smuggled through.
  }

  // ---- Review routing (role-aware) ----
  //   employee / HOD  -> HR  (optionally HOD-first when configured)
  //   HR              -> Super Admin (HR never reviews HR submissions)
  //   Super Admin     -> Final (no review layer)
  const submitterRole = req.user.role;
  const hod = submitterRole === 'employee' ? await resolveHodFor(req.user) : null;
  sub.currentReviewStage = submitterRole === 'super_admin'
    ? 'finalized'
    : submitterRole === 'hr'
      ? 'under_super_admin'
      : (hod ? 'under_hod' : 'submitted');
  // Super Admin submissions auto-finalize (no review layer).  Marks remain
  // whatever the work scoring yielded; no reviewer adjusts them.
  if (submitterRole === 'super_admin') sub.reviewStatus = 'reviewed';
  sub.reviewHistory.push({
    reviewedBy: req.user._id,
    reviewerName: req.user.name,
    role: submitterRole,
    stage: sub.currentReviewStage,
    action: 'submitted',
    timestamp: new Date(),
  });

  // Remove tasks that are 'done' or 'work_not_available' since they are
  // no longer relevant for the dashboard view (spec: "removed after submission").
  // We keep them on the submission record for analytics but they are
  // already represented in earned/total counts.

  await sub.save();

  // ---- Auto-resolve carry-forward backlog ----
  // When today's report closes a task (Done / Ongoing), older
  // still-pending Submission.tasks[] rows on the same template are
  // closed automatically so employees don't have to click
  // "Complete backlog" for every yesterday-pending row that today's
  // submission already covered.  Never touches unrelated templates,
  // future-dated submissions, or ad-hoc employee-added rows that
  // don't share a title.  Failure never rolls back the submit.
  try {
    if (sub.templateType === 'task' || !sub.templateType) {
      const pendingState = require('../services/pendingStateService');
      await pendingState.autoResolveBacklog({
        employee:     sub.employee,
        template:     sub.template,
        submissionId: sub._id,
        incomingTasks: (sub.tasks || []).map((t) => ({
          taskId: t.taskId,
          title:  t.title,
          status: t.status,
        })),
      });
    }
  } catch (e) { console.error('[submit] auto-resolve backlog:', e.message); }

  // ---- Create linked dependency follow-up tasks (after persistence) ----
  // Each dependent unit spawns a DependencyTask + notification, then we
  // write the created task id + chain id back onto the source unit.
  if (pendingDeps.length) {
    for (const d of pendingDeps) {
      try {
        const depTask = await createDependencyTask({
          submission: sub,
          sourceKind: d.kind,
          sourceTaskId: d.sourceTaskId,
          originalTaskName: d.originalTaskName,
          assignedToId: d.assignedToId,
          assignedBy: req.user,
          remark: d.remark,
          priority: d.priority,
          templateTitle,
        });
        d.unit.dependencyTaskId = depTask._id;
        d.unit.chainId = depTask.chainId;
      } catch (e) {
        console.error('[dependency] create failed:', e.message);
      }
    }
    if (sub.templateType === 'sheet') sub.markModified('sheet');
    await sub.save();
  }

  // Automatic submission-time half-day attendance (non-fatal).
  try {
    await applyAutoHalfDay(req.user, today);
  } catch (e) {
    console.error('[attendance] auto half-day failed:', e.message);
  }

  // Phase 45 -- DISABLED.  "Submission awaiting review" was
  // reclassified as a daily-submission update; the HOD sees pending
  // reviews on their Submission Reviews page directly.

  // Phase 47 -- realtime: tell HR, Super Admin and the matching HOD
  // their review queue has a new card.  No notification row created;
  // this is purely a UI-refresh signal so the open Submission Reviews
  // page re-fetches without a manual reload.
  try {
    const reviewers = await User.find({
      role: { $in: ['hr', 'super_admin'] },
      status: 'active',
    }).select('_id').lean();
    const reviewerIds = reviewers.map((u) => u._id);
    if (hod?._id) reviewerIds.push(hod._id);
    rt.publishMany(reviewerIds, 'submission:submitted', {
      submissionId: String(sub._id),
      employeeId: String(req.user._id),
    });
  } catch (_) { /* never blocks the response */ }

  res.json(sub);
});

/**
 * POST /api/submissions/backlog/complete
 * Body: { submissionId, taskId }
 *
 * Marks a backlog task as completed.  Spec: no marks awarded.
 */
const completeBacklogTask = asyncHandler(async (req, res) => {
  const { submissionId, taskId } = req.body;
  const sub = await Submission.findOne({ _id: submissionId, employee: req.user._id });
  if (!sub) { res.status(404); throw new Error('Submission not found'); }

  const task = sub.tasks.id(taskId);
  if (!task) { res.status(404); throw new Error('Task not found'); }
  if (task.status !== 'pending') { res.status(400); throw new Error('Task is not in pending state'); }

  task.status = 'done';
  task.completedAt = new Date();
  // No marks adjustment per spec - late completion gives no points.
  await sub.save();
  // Phase 64 Part 3 -- the Performance Lock automatically ends when
  // every overdue pending task clears.  Never blocks the response.
  try { await penaltyEngine.onPendingTaskResolved({ employeeId: req.user._id }); }
  catch (e) { console.error('[completeBacklog] onPendingTaskResolved:', e.message); }
  res.json({ message: 'Backlog task completed', task });
});

/**
 * GET /api/submissions/history?from=&to=
 * Past submissions for the current employee.
 */
const history = asyncHandler(async (req, res) => {
  // Soft-deleted / test-marked submissions are hidden from the employee's
  // own history view -- HR sees them through the Submission Control page.
  const where = { employee: req.user._id, ...liveSubmissionFilter({}) };
  if (req.query.from || req.query.to) {
    where.date = {};
    if (req.query.from) where.date.$gte = startOfDay(new Date(req.query.from));
    if (req.query.to) where.date.$lte = startOfDay(new Date(req.query.to));
  }
  const items = await Submission.find(where)
    .populate('template', 'title customFields customKind customSections privateRemarkEnabled privateRemarkLabel privateRemarkRequired')
    .sort({ date: -1 });
  // Phase 60 -- employee history is self-view, scrub is a no-op but
  // is called for consistency across every submission read path.
  scrubPrivateRemark(items, req.user);
  scrubHodRecommendation(items, req.user);
  res.json(items);
});

/**
 * Attach a `dependencies` array to each mapped review object so the review
 * UI can show forwarded-to / resolved status, remarks, timestamps and the
 * turnaround duration inline beside each row.  Read-only enrichment - it
 * never touches scoring or the review pipeline.
 */
const attachDependencies = async (out) => {
  const ids = out.map((o) => o._id).filter(Boolean);
  if (!ids.length) return;
  const deps = await DependencyTask.find({ sourceSubmissionId: { $in: ids } })
    .populate('assignedTo', 'name employeeId')
    .populate('assignedBy', 'name employeeId')
    .lean();
  const bySub = {};
  for (const d of deps) {
    const k = String(d.sourceSubmissionId);
    (bySub[k] = bySub[k] || []).push({
      sourceTaskId: d.sourceTaskId,
      sourceKind: d.sourceKind,
      originalTaskName: d.originalTaskName,
      status: d.currentStatus,
      remark: d.remark,
      priority: d.priority,
      chainId: d.chainId,
      assignedToName: d.assignedTo?.name || d.assignedToName || '',
      assignedById: d.assignedBy?._id,
      assignedByName: d.assignedBy?.name || d.assignedByName || '',
      createdAt: d.createdAt,
      resolvedAt: d.resolvedAt,
      resolutionHours: d.resolvedAt
        ? Math.round((new Date(d.resolvedAt) - new Date(d.waitingSince || d.createdAt)) / 36e5 * 10) / 10
        : null,
    });
  }
  out.forEach((o) => { o.dependencies = bySub[String(o._id)] || []; });
};

/**
 * GET /api/submissions/reviews?date=YYYY-MM-DD&status=pending|reviewed
 *
 * HR review-panel feed. Returns every submitted (and not yet
 * deleted) submission for the chosen date with the employee + template
 * populated, plus an aggregated per-employee backlogCount so the table
 * can show backlog totals without extra round-trips.
 */
const listForReview = asyncHandler(async (req, res) => {
  // Review queue intentionally hides soft-deleted + test-marked rows so
  // HR doesn't waste cycles scoring data that won't affect anything.
  const where = { submitted: true, ...liveSubmissionFilter({}) };
  const day = req.query.date ? startOfDay(new Date(req.query.date)) : startOfDay(new Date());
  where.date = day;
  if (req.query.status) where.reviewStatus = req.query.status;

  const itemsRaw = await Submission.find(where)
    .populate({
      path: 'employee',
      select: 'name employeeId department designation role',
      populate: [
        { path: 'department', select: 'name' },
        { path: 'designation', select: 'title' },
      ],
    })
    .populate('template', 'title customFields customKind customSections privateRemarkEnabled privateRemarkLabel privateRemarkRequired')
    .sort({ submittedAt: -1 });

  // Role-aware visibility:
  //   - HR viewers see employee + HOD submissions only (NOT HR submissions
  //     and NOT their own).
  //   - Super Admin sees employee + HR submissions (Super Admin's own
  //     submissions auto-finalize, so they don't surface here).
  const allowedOwnerRoles = req.user.role === 'super_admin' ? ['employee', 'hr'] : ['employee'];
  const items = itemsRaw.filter((it) => {
    const r = it.employee?.role;
    return r && allowedOwnerRoles.includes(r) && String(it.employee._id) !== String(req.user._id);
  });

  // Compute backlog count per unique employee in one aggregation
  const empIds = [...new Set(items.map((i) => String(i.employee?._id)).filter(Boolean))];
  const backlogAgg = await Submission.aggregate([
    { $match: { employee: { $in: empIds.map((id) => new (require('mongoose').Types.ObjectId)(id)) }, ...liveSubmissionFilter({}) } },
    { $unwind: '$tasks' },
    { $match: { 'tasks.status': 'pending' } },
    { $group: { _id: '$employee', count: { $sum: 1 } } },
  ]);
  const backlogMap = Object.fromEntries(backlogAgg.map((b) => [String(b._id), b.count]));

  const out = items.map((it) => {
    const o = it.toObject();
    o.backlogCount = backlogMap[String(it.employee?._id)] || 0;
    // Per-task breakdowns (task templates)
    o.doneTasks = it.tasks.filter((t) => t.status === 'done');
    o.pendingTasks = it.tasks.filter((t) => t.status === 'pending');
    o.wnaTasks = it.tasks.filter((t) => t.status === 'work_not_available');
    // Excel responses ride along verbatim
    o.excelResponses = it.excelResponses || [];
    return o;
  });
  await attachDependencies(out);
  // Phase 61 -- surface Final Marks + penalty breakdown so the
  // reviewer sees Earned / Penalty / Final without an extra fetch.
  try { await attachFinalMarks(out); }
  catch (e) { console.error('[listForReview] attachFinalMarks:', e.message); }
  // Phase 60 -- HR review feed.  HR/SA see the field; anyone else
  // (feature-permission grants) gets it scrubbed.
  scrubPrivateRemark(out, req.user);
  scrubHodRecommendation(out, req.user);
  res.json(out);
});

/**
 * POST /api/submissions/:id/review
 * Body: { ideaMarks, maxIdeaMarks?, ideaFeedback? }
 *
 * Stores HR's innovation (idea) marks and recomputes the final
 * earned/total/percentage as:
 *   earned = workEarned + ideaMarks
 *   total  = workTotal  + maxIdeaMarks
 *
 * Re-running the endpoint for the same submission updates the review
 * in-place (HR can correct mistakes).
 */
const reviewSubmission = asyncHandler(async (req, res) => {
  const sub = await Submission.findById(req.params.id);
  if (!sub) { res.status(404); throw new Error('Submission not found'); }
  if (!sub.submitted) {
    res.status(400);
    throw new Error('Cannot review: submission has not been submitted yet');
  }

  // Authority gate: HR reviewers cannot review HR submissions or their own.
  // Super Admin reviews everything (including HR submissions).
  if (req.user.role !== 'super_admin') {
    if (String(sub.employee) === String(req.user._id)) {
      res.status(403); throw new Error('You cannot review your own submission.');
    }
    const owner = await User.findById(sub.employee).select('role');
    if (owner?.role === 'hr' || owner?.role === 'super_admin') {
      res.status(403); throw new Error('Only Super Admin can review HR submissions.');
    }
  }

  // Phase 6: innovation (idea) marks live on DailyReview only.
  // Any body fields named ideaMarks / ideaFeedback are ignored here;
  // HR sets them via POST /api/daily-review/finalize.  Per-sub review
  // only handles work scoring (excel per-field, task per-row, sheet
  // per-cell).
  sub.ideaMarks = 0;
  sub.maxIdeaMarks = 0;
  sub.ideaFeedback = '';

  // Excel templates: HR awards per-field marks during review.  Update
  // each response's marksAwarded then recompute workEarnedPoints from
  // the sum.  workTotalPoints is already the sum of maxMarks set at
  // submit time, so it doesn't change here.
  if (sub.templateType === 'excel' && Array.isArray(req.body.excelResponses)) {
    const marksByName = new Map(
      req.body.excelResponses.map((r) => [String(r.fieldName || ''), Number(r.marksAwarded) || 0])
    );
    let excelEarned = 0;
    sub.excelResponses.forEach((r) => {
      if (!r.markEligible) return;
      const m = Math.max(0, Math.min(marksByName.get(r.fieldName) ?? 0, r.maxMarks || 0));
      r.marksAwarded = m;
      excelEarned += m;
    });
    sub.workEarnedPoints = excelEarned;
  }

  // Task templates: most rows are HR-defined (points fixed at template
  // time) -- those stay scored exactly as before.  Employee-added rows
  // (addedByEmployee=true) had no template points; HR awards marks for
  // them here via `taskMarks: [{ taskId, awardedMarks }]`.  We then
  // recompute workEarned / workTotal so the employee-added marks flow
  // into the final percentage.
  if (sub.templateType === 'task') {
    const marksByTaskId = new Map(
      (Array.isArray(req.body.taskMarks) ? req.body.taskMarks : []).map(
        (m) => [String(m.taskId), Math.max(0, Number(m.awardedMarks) || 0)],
      ),
    );
    let earnedT = 0;
    let totalT = 0;
    sub.tasks.forEach((t) => {
      if (t.addedByEmployee) {
        if (marksByTaskId.has(String(t._id))) t.awardedMarks = marksByTaskId.get(String(t._id));
        const awarded = Number(t.awardedMarks) || 0;
        earnedT += awarded;
        totalT  += awarded; // grows the denominator with the numerator
      } else {
        // Ongoing earns + counts exactly like Done.  Pending still
        // contributes to the denominator only (employee owes the work).
        if (t.status === 'done' || t.status === 'ongoing') earnedT += Number(t.points) || 0;
        if (t.status === 'done' || t.status === 'ongoing' || t.status === 'pending') {
          totalT += Number(t.points) || 0;
        }
      }
    });
    sub.workEarnedPoints = earnedT;
    sub.workTotalPoints  = totalT;
  }

  // Sheet templates: HR awards marks per scoring target (cell/row/column).
  // workEarned = sum of marksAwarded; workTotal stays the sum of maxMarks
  // captured at submit time.
  if (sub.templateType === 'sheet' && sub.sheet && Array.isArray(req.body.scores)) {
    const marksByKey = new Map(
      req.body.scores.map((s) => [String(s.key || ''), {
        marks: Number(s.marksAwarded) || 0,
        remark: s.remark !== undefined ? String(s.remark) : undefined,
      }])
    );
    let sheetEarned = 0;
    sub.sheet.scores.forEach((sc) => {
      const incoming = marksByKey.get(sc.key);
      if (incoming) {
        sc.marksAwarded = Math.max(0, Math.min(incoming.marks, sc.maxMarks || 0));
        if (incoming.remark !== undefined) sc.remark = incoming.remark;
      }
      sheetEarned += sc.marksAwarded || 0;
    });
    sub.workEarnedPoints = sheetEarned;
    sub.markModified('sheet');
  }

  sub.reviewedBy = req.user._id;
  sub.reviewedAt = new Date();
  sub.reviewStatus = 'reviewed';
  sub.currentReviewStage = 'finalized';

  // Phase 6: cached scores are WORK-ONLY now.  Innovation (idea) lives
  // on DailyReview; analytics + salary + dashboards join that
  // collection to surface the true day-level total.
  sub.earnedPoints = Number(sub.workEarnedPoints) || 0;
  sub.totalPoints  = Number(sub.workTotalPoints)  || 0;
  sub.completionPercentage = sub.totalPoints > 0 ? (sub.earnedPoints / sub.totalPoints) * 100 : 0;

  sub.reviewHistory.push({
    reviewedBy: req.user._id,
    reviewerName: req.user.name,
    role: req.user.role,
    stage: 'finalized',
    action: 'hr_finalize',
    marks: sub.earnedPoints,
    remarks: '',
    timestamp: new Date(),
  });

  await sub.save();

  // Notify the submission owner that their work was reviewed.
  try {
    const notify = require('../services/notifyEvents');
    notify.notifySubmissionReviewed({
      employeeId: sub.employee,
      submission: { date: sub.date },
      reviewedBy: req.user,
    });
  } catch (_) { /* notify never blocks the response */ }

  // Phase 60 -- reviewSubmission is HR/SA-only; scrub is a no-op but
  // keeps the call site symmetrical with the HOD path.
  scrubPrivateRemark(sub, req.user);
  scrubHodRecommendation(sub, req.user);
  res.json(sub);
});

/**
 * GET /api/submissions/hod/reviews?date=YYYY-MM-DD&status=
 *
 * HOD review feed - submissions from the HOD's own department whose
 * employees route through the HOD (reviewFlow = 'hod_first').  Mirrors
 * the HR feed but scoped to the department.
 */
const listForHodReview = asyncHandler(async (req, res) => {
  // HR / Super Admin may reach this endpoint (requireReviewer) but they
  // have no hodDepartment - they use the HR review panel - so return empty.
  const deptId = req.user.hodDepartment;
  if (!deptId) return res.json([]);

  // Department members who route through the HOD.
  const members = await User.find({
    department: deptId, role: 'employee', reviewFlow: 'hod_first',
    _id: { $ne: req.user._id },
  }).select('_id');
  const memberIds = members.map((m) => m._id);

  const where = { submitted: true, employee: { $in: memberIds }, ...liveSubmissionFilter({}) };
  const day = req.query.date ? startOfDay(new Date(req.query.date)) : startOfDay(new Date());
  where.date = day;
  if (req.query.status) where.currentReviewStage = req.query.status;

  const items = await Submission.find(where)
    .populate({
      path: 'employee',
      select: 'name employeeId department designation',
      populate: [
        { path: 'department', select: 'name' },
        { path: 'designation', select: 'title' },
      ],
    })
    .populate('template', 'title customFields customKind customSections privateRemarkEnabled privateRemarkLabel privateRemarkRequired')
    .sort({ submittedAt: -1 });

  const out = items.map((it) => {
    const o = it.toObject();
    o.doneTasks = it.tasks.filter((t) => t.status === 'done');
    o.pendingTasks = it.tasks.filter((t) => t.status === 'pending');
    o.wnaTasks = it.tasks.filter((t) => t.status === 'work_not_available');
    o.excelResponses = it.excelResponses || [];
    return o;
  });
  await attachDependencies(out);
  // Phase 61 -- Final Marks for the HOD feed too.
  try { await attachFinalMarks(out); }
  catch (e) { console.error('[listForHodReview] attachFinalMarks:', e.message); }
  // Phase 60 -- HOD review feed: ALWAYS scrub. The remark is off-
  // limits to HOD reviewers per the Phase 60 visibility rule.
  scrubPrivateRemark(out, req.user);
  scrubHodRecommendation(out, req.user);
  res.json(out);
});

/**
 * POST /api/submissions/:id/hod-review
 *
 * HOD records their (permission-gated) review.  Marks are stored as a
 * RECOMMENDATION only - they prefill HR's screen and do NOT commit final
 * earned/total (HR remains the final authority).
 *
 * Body: { remarks?, recommend?, ideaMarks?,
 *         excelResponses?: [{fieldName, marksAwarded}],
 *         scores?: [{key, marksAwarded, remark}] }
 */
const hodReviewSubmission = asyncHandler(async (req, res) => {
  const perms = req.user.hodPermissions || {};
  if (!perms.canReview) {
    res.status(403);
    throw new Error('You do not have permission to review submissions.');
  }

  const sub = await Submission.findById(req.params.id);
  if (!sub) { res.status(404); throw new Error('Submission not found'); }
  if (!sub.submitted) { res.status(400); throw new Error('Submission not submitted yet'); }

  // The employee must belong to this HOD's department and route via HOD.
  const employee = await User.findById(sub.employee).select('department reviewFlow');
  if (!employee || String(employee.department) !== String(req.user.hodDepartment) || employee.reviewFlow !== 'hod_first') {
    res.status(403);
    throw new Error('This submission is not in your department review queue.');
  }

  // Draft marks (only if the HOD may give marks).  Stored on the same
  // per-target fields so HR sees them prefilled; earned/total are NOT
  // recomputed here.
  let marksGiven = false;
  if (perms.canMarks) {
    if (sub.templateType === 'sheet' && sub.sheet && Array.isArray(req.body.scores)) {
      const byKey = new Map(req.body.scores.map((s) => [String(s.key || ''), s]));
      sub.sheet.scores.forEach((sc) => {
        const inc = byKey.get(sc.key);
        if (inc) {
          sc.marksAwarded = Math.max(0, Math.min(Number(inc.marksAwarded) || 0, sc.maxMarks || 0));
          if (inc.remark !== undefined) sc.remark = String(inc.remark);
          marksGiven = true;
        }
      });
      sub.markModified('sheet');
    }
    if (sub.templateType === 'excel' && Array.isArray(req.body.excelResponses)) {
      const byName = new Map(req.body.excelResponses.map((r) => [String(r.fieldName || ''), Number(r.marksAwarded) || 0]));
      sub.excelResponses.forEach((r) => {
        if (!r.markEligible) return;
        if (byName.has(r.fieldName)) {
          r.marksAwarded = Math.max(0, Math.min(byName.get(r.fieldName), r.maxMarks || 0));
          marksGiven = true;
        }
      });
    }
    // NOTE: innovation marks are HR/Super-Admin ONLY and are
    // deliberately NOT accepted from a HOD here, even with canMarks.  A HOD
    // may only score task completion / report values.
  }

  sub.hodReview = {
    reviewedBy: req.user._id,
    reviewedAt: new Date(),
    remarks: perms.canRemark && req.body.remarks !== undefined ? String(req.body.remarks) : (sub.hodReview?.remarks || ''),
    marksGiven,
    recommend: perms.canRecommend && ['approve', 'needs_changes'].includes(req.body.recommend) ? req.body.recommend : '',
  };
  sub.currentReviewStage = 'hod_reviewed';
  sub.reviewHistory.push({
    reviewedBy: req.user._id,
    reviewerName: req.user.name,
    role: 'hod',
    stage: 'hod_reviewed',
    action: 'hod_review',
    marks: marksGiven ? sub.workEarnedPoints : undefined,
    remarks: sub.hodReview.remarks,
    timestamp: new Date(),
  });

  // HOD Recommendation for HR (optional, informational only).  Editable
  // until HR finalises (reviewStatus !== 'reviewed').  Never triggers
  // notifications / reminders / timeline / realtime -- purely passive
  // information HR sees on the review screen.
  if (req.body.hodRecommendation !== undefined) {
    if (sub.reviewStatus === 'reviewed') {
      res.status(400);
      throw new Error('HOD Recommendation is locked once HR has completed the review.');
    }
    const { logAudit } = require('../utils/audit');
    const nextText = String(req.body.hodRecommendation || '').trim();
    const prev = sub.hodRecommendation || {};
    const hadPrev = !!(prev && prev.text);
    const now = new Date();
    if (nextText.length === 0 && hadPrev) {
      // Explicit clear -- treat as an update to empty; keep the audit
      // trail so HR can see the note was removed.
      sub.hodRecommendation = {
        text: '',
        createdBy: prev.createdBy || req.user._id,
        createdAt: prev.createdAt || now,
        updatedBy: req.user._id,
        updatedAt: now,
      };
      logAudit(req, {
        action: 'hod.recommendation.updated',
        targetType: 'Submission',
        targetId: sub._id,
        targetLabel: `Recommendation cleared on ${new Date(sub.date).toISOString().slice(0, 10)}`,
        meta: { cleared: true },
      });
    } else if (nextText.length > 0) {
      sub.hodRecommendation = {
        text: nextText,
        createdBy: prev.createdBy || req.user._id,
        createdAt: prev.createdAt || now,
        updatedBy: req.user._id,
        updatedAt: now,
      };
      logAudit(req, {
        action: hadPrev ? 'hod.recommendation.updated' : 'hod.recommendation.created',
        targetType: 'Submission',
        targetId: sub._id,
        targetLabel: `Recommendation on ${new Date(sub.date).toISOString().slice(0, 10)}`,
        meta: { length: nextText.length },
      });
    }
    // If both prev and nextText are empty, nothing to do.
  }

  await sub.save();
  // Phase 60 -- HOD review path.  Scrub the Private Remark before
  // returning the submission JSON so the HOD can never see it, not
  // even in the response to their own review action.
  scrubPrivateRemark(sub, req.user);
  scrubHodRecommendation(sub, req.user);
  res.json(sub);
});

/**
 * POST /api/submissions/review/bulk     (HR / Super Admin)
 *
 * Apply innovation (idea) marks to many already-submitted submissions
 * in one call.  Only the idea mark fields are touched -- task / excel
 * / sheet / per-row marks are NEVER modified.  Each submission still
 * goes through the same role guard the single-row reviewSubmission
 * uses (HR can't review HR / SA, can't review own).
 *
 * Body: {
 *   ids: [String],
 *   ideaMarks?, maxIdeaMarks?, ideaFeedback?
 * }
 *
 * Returns: { requested, succeeded: [{ id, name }], failed: [{ id, reason }] }
 */
const bulkReview = asyncHandler(async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400);
    throw new Error('No submissions selected');
  }
  // Inputs are optional; if omitted, the existing value on the doc is kept.
  const i  = req.body.ideaMarks;
  const mi = req.body.maxIdeaMarks;
  const iFb = req.body.ideaFeedback;

  if ([i, mi].every((x) => x === undefined || x === null || x === '')) {
    res.status(400);
    throw new Error('Provide at least one of the innovation mark fields.');
  }

  const succeeded = [];
  const failed = [];
  for (const id of ids) {
    try {
      const sub = await Submission.findById(id);
      if (!sub) { failed.push({ id, reason: 'Not found' }); continue; }
      if (!sub.submitted) { failed.push({ id, reason: 'Not yet submitted' }); continue; }
      // Same role guard as reviewSubmission.
      if (req.user.role !== 'super_admin') {
        if (String(sub.employee) === String(req.user._id)) { failed.push({ id, reason: 'Cannot review own submission' }); continue; }
        const owner = await User.findById(sub.employee).select('role name');
        if (owner?.role === 'hr' || owner?.role === 'super_admin') { failed.push({ id, reason: 'HR / SA submissions require Super Admin' }); continue; }
      }

      // Apply (only fields provided are updated).
      const maxI = mi !== undefined && mi !== '' ? Math.max(0, Number(mi)) : sub.maxIdeaMarks;
      const iM   = i !== undefined && i !== ''   ? Math.max(0, Math.min(Number(i) || 0, maxI)) : sub.ideaMarks;

      sub.maxIdeaMarks = maxI;
      sub.ideaMarks    = iM;
      if (iFb !== undefined) sub.ideaFeedback = String(iFb);

      // Recompute final scores from the cached work points.
      sub.earnedPoints = (Number(sub.workEarnedPoints) || 0) + Number(iM);
      sub.totalPoints  = (Number(sub.workTotalPoints)  || 0) + Number(maxI);
      sub.completionPercentage = sub.totalPoints > 0 ? (sub.earnedPoints / sub.totalPoints) * 100 : 0;

      sub.reviewedBy = req.user._id;
      sub.reviewedAt = new Date();
      sub.reviewStatus = 'reviewed';
      sub.currentReviewStage = 'finalized';
      sub.reviewHistory.push({
        reviewedBy: req.user._id,
        reviewerName: req.user.name,
        role: req.user.role,
        stage: 'finalized',
        action: 'bulk_review',
        marks: sub.earnedPoints,
        remarks: iFb || '',
        timestamp: new Date(),
      });
      await sub.save();

      // Audit per row so the audit log keeps full per-submission trail.
      const { logAudit } = require('../utils/audit');
      logAudit(req, {
        action: 'submission.review.bulk',
        targetType: 'Submission',
        targetId: sub._id,
        targetLabel: `bulk idea=${iM}/${maxI}`,
        meta: { ideaMarks: iM, maxIdeaMarks: maxI },
      });

      const e = await User.findById(sub.employee).select('name');
      succeeded.push({ id: String(sub._id), name: e?.name || '' });
    } catch (err) {
      failed.push({ id, reason: err.message });
    }
  }
  res.json({ requested: ids.length, succeededCount: succeeded.length, failedCount: failed.length, succeeded, failed });
});

/* ------------------------------------------------------------------ */
/* Phase 19: Draft auto-save                                          */
/* ------------------------------------------------------------------ */
/**
 * PUT /api/submissions/:id/draft
 *
 * Persists a partial work-in-progress payload onto the existing
 * unsubmitted Submission document.  Accepts the SAME shape the submit
 * endpoint accepts (tasks / excelResponses / sheet / customResponses
 * / productSales / farmerRecords / selfRating / selfNote / idea /
 * addedTasks) -- the frontend builds one payload and routes it to
 * either /draft or /submit depending on the user's intent.
 *
 * Architectural guarantees (so drafts can't touch business processes):
 *   - This handler NEVER flips `submitted` to true.
 *   - It NEVER validates required fields, NEVER evaluates auto
 *     formulas, NEVER scores work, NEVER touches reviewStatus, NEVER
 *     creates dependency tasks, NEVER applies attendance, NEVER fires
 *     notifications.
 *   - Because every analytics / attendance / salary / pendency /
 *     leaderboard / review query in the codebase filters on
 *     `submitted: true` (Phases 4 + 8 + 15), an unsubmitted draft is
 *     architecturally invisible to all of them.  No extra wiring
 *     needed to honour the "drafts do not affect KPIs" rule.
 *   - Auth: only the owning employee may save a draft.  HR / SA edits
 *     to submitted rows still go through Submission Control's
 *     freeze-mode editor.
 *
 * Idempotent / safe to spam from the autosave loop.
 */
const saveDraft = asyncHandler(async (req, res) => {
  const sub = await Submission.findOne({ _id: req.params.id, employee: req.user._id });
  if (!sub) { res.status(404); throw new Error('Submission not found'); }
  if (sub.submitted) {
    res.status(400);
    throw new Error('Cannot save a draft on a submission that is already submitted.');
  }

  const { tasks, addedTasks, excelResponses, sheet, customResponses, extraTasks, productSales, farmerRecords, selfRating, selfNote, idea, privateRemark } = req.body || {};

  /* ---- Tasks ---- */
  if (Array.isArray(tasks)) {
    const incoming = new Map(tasks.map((t) => [String(t.taskId || t._id || ''), t]));
    sub.tasks.forEach((t) => {
      const upd = incoming.get(String(t._id));
      if (!upd) return;
      if (upd.status !== undefined)        t.status = upd.status;
      if (upd.pendingReason !== undefined) t.pendingReason = upd.pendingReason;
    });
    // Employee-added rows on task templates -- carry them as drafts too
    // so they survive reload without being lost.
    if (Array.isArray(addedTasks)) {
      // Drop existing addedByEmployee rows then re-append from the body.
      sub.tasks = sub.tasks.filter((t) => !t.addedByEmployee);
      for (const at of addedTasks) {
        const title = String(at?.title || '').trim();
        if (!title) continue;
        sub.tasks.push({
          title, points: 0, status: at.status || 'pending_submit',
          pendingReason: at.pendingReason || '', addedByEmployee: true, awardedMarks: 0,
        });
      }
    }
    sub.markModified('tasks');
  }

  /* ---- Excel responses ---- */
  if (Array.isArray(excelResponses)) {
    const incoming = new Map(excelResponses.map((r) => [String(r.fieldName || ''), r]));
    sub.excelResponses.forEach((r) => {
      const inc = incoming.get(r.fieldName);
      if (!inc) return;
      if (inc.value     !== undefined) r.value = inc.value;
      if (inc.rowStatus !== undefined) r.rowStatus = inc.rowStatus;
    });
    sub.markModified('excelResponses');
  }

  /* ---- Sheet (cells + scores) ---- */
  if (sheet && sub.sheet) {
    if (Array.isArray(sheet.cells)) {
      const map = new Map(sub.sheet.cells.map((c) => [`${c.r}:${c.c}`, c]));
      for (const inc of sheet.cells) {
        const key = `${Number(inc.r)}:${Number(inc.c)}`;
        const cell = map.get(key);
        if (cell && cell.editable && cell.role === 'input' && inc.value !== undefined) {
          cell.value = inc.value;
        }
      }
    }
    if (Array.isArray(sheet.scores)) {
      const byKey = new Map(sheet.scores.map((s) => [String(s.key || ''), s]));
      sub.sheet.scores.forEach((sc) => {
        const inc = byKey.get(sc.key);
        if (!inc) return;
        if (inc.rowStatus     !== undefined) sc.rowStatus = inc.rowStatus;
        if (inc.pendingReason !== undefined) sc.pendingReason = inc.pendingReason;
      });
    }
    sub.markModified('sheet');
  }

  /* ---- Custom responses ----
     Raw passthrough.  Do NOT run computeAutoFields here -- auto fields
     are recomputed by the submit handler from the final responses.
     A draft must store exactly what the employee typed, including
     blanks. */
  if (Array.isArray(customResponses)) {
    // Preserve system-generated values that the daily engine seeded.
    const tpl = await Template.findById(sub.template).select('customFields');
    const sysKeys = new Set(
      (tpl?.customFields || []).filter((f) => f.fieldType === 'readonly').map((f) => f.key),
    );
    const seededByKey = new Map((sub.customResponses || []).map((r) => [r.key, r]));
    const next = customResponses.map((r) => {
      if (!r || !r.key) return null;
      if (sysKeys.has(r.key)) {
        // Carry-forward / readonly: always use the seeded value.
        const seeded = seededByKey.get(r.key);
        return seeded ? { key: r.key, value: seeded.value, status: seeded.status || '', remark: seeded.remark || '' } : null;
      }
      return {
        key:    r.key,
        value:  r.value,
        status: r.status || '',
        remark: typeof r.remark === 'string' ? r.remark : '',
      };
    }).filter(Boolean);
    sub.customResponses = next;
    sub.markModified('customResponses');
  }

  /* ---- Phase 53: Extra Tasks (draft passthrough) ----
     Raw persist so autosave doesn't lose half-typed rows.  The
     submit endpoint is where new keys get folded into the template
     catalog — draft only touches the submission document. */
  if (Array.isArray(extraTasks)) {
    const RESP = new Set(['none', 'number', 'status', 'number_status']);
    sub.extraTasks = extraTasks
      .filter((r) => r && (r.label || r.key))
      .map((r) => ({
        key: String(r.key || '').trim(),
        label: String(r.label || '').trim(),
        description: String(r.description || '').trim(),
        responseType: RESP.has(r.responseType) ? r.responseType : 'none',
        value: r.value ?? '',
        status: ['done', 'ongoing', 'pending', 'work_not_available'].includes(r.status) ? r.status : '',
        remark: typeof r.remark === 'string' ? r.remark : '',
      }));
    sub.markModified('extraTasks');
  }

  /* ---- Product Sales ---- */
  if (Array.isArray(productSales)) {
    const Product  = require('../models/Product');
    const Quantity = require('../models/Quantity');
    const cleaned = [];
    for (const row of productSales) {
      if (!row || !row.productId) continue;
      const prod = await Product.findById(row.productId).lean();
      if (!prod) continue;
      let qval = Number(row.quantity);
      let qty = null;
      if (!Number.isFinite(qval) || qval <= 0) {
        if (row.quantityId) qty = await Quantity.findById(row.quantityId).lean();
        qval = Number(qty?.value) || 0;
      }
      const price  = Number(prod.pricePerUnit) || 0;
      const nbvPct = Math.max(0, Math.min(Number(prod.nbvPercentage) || 0, 100));
      const sales  = qval > 0 ? Math.round(price * qval * 100) / 100 : 0;
      const nbv    = qval > 0 ? Math.round(sales * nbvPct) / 100 : 0;
      cleaned.push({
        productId: prod._id, productName: prod.name, productUnit: prod.unit,
        productPrice: price, productNbvPercentage: nbvPct,
        quantityId: qty?._id, quantityLabel: qty?.label || '',
        quantityValue: qty ? (Number(qty.value) || 0) : qval,
        quantity: qval, salesValue: sales, nbvValue: nbv,
      });
    }
    sub.productSales = cleaned;
    sub.markModified('productSales');
  }

  /* ---- Farmer Records ---- */
  if (Array.isArray(farmerRecords)) {
    const Product = require('../models/Product');
    const Dealer  = require('../models/Dealer');
    const cleaned = [];
    for (const row of farmerRecords) {
      if (!row || !(row.name || '').trim()) continue;
      let dealer = null;
      if (row.dealerId) dealer = await Dealer.findById(row.dealerId).lean();
      const rawProducts = Array.isArray(row.products) ? row.products : [];
      const cleanedProducts = [];
      for (const pr of rawProducts) {
        if (!pr || !pr.productId) continue;
        const prod = await Product.findById(pr.productId).lean();
        if (!prod) continue;
        const q = Number(pr.quantity);
        cleanedProducts.push({
          productId: prod._id, productName: prod.name, productUnit: prod.unit,
          quantity: Number.isFinite(q) && q > 0 ? q : 0,
        });
      }
      const first = cleanedProducts[0];
      cleaned.push({
        name: row.name.trim(),
        mobile:  String(row.mobile || '').trim(),
        village: String(row.village || '').trim(),
        dealerLocation: String(row.dealerLocation || '').trim(),
        dealerId: dealer?._id,
        dealerNameSnapshot:  dealer?.firmName || dealer?.name || '',
        dealerPlaceSnapshot: dealer?.place || '',
        dealerFirmSnapshot:  dealer?.firmName || dealer?.name || '',
        dealerPersonSnapshot:dealer?.dealerName || '',
        productId: first?.productId, productName: first?.productName || '',
        products: cleanedProducts,
      });
    }
    sub.farmerRecords = cleaned;
    sub.markModified('farmerRecords');
  }

  /* ---- Self observation + idea (kept for back-compat, even though
         Phase 5 moved daily reflection to its own collection) ---- */
  if (selfRating !== undefined) sub.selfRating = selfRating === '' ? undefined : Number(selfRating);
  if (selfNote   !== undefined) sub.selfNote   = String(selfNote || '');
  if (idea       !== undefined) sub.idea       = String(idea || '');

  // Phase 60 -- draft passthrough for the Private Remark so autosave
  // doesn't discard partial keystrokes.  Same defensive check as the
  // submit path: the template must have privateRemarkEnabled true.
  if (typeof privateRemark === 'string') {
    const tpl = await Template.findById(sub.template).select('privateRemarkEnabled').lean();
    if (tpl?.privateRemarkEnabled) sub.privateRemark = String(privateRemark);
  }

  sub.lastDraftSavedAt = new Date();
  await sub.save();

  res.json({ ok: true, _id: sub._id, lastDraftSavedAt: sub.lastDraftSavedAt });
});

module.exports = {
  getToday, submitOne, completeBacklogTask, history,
  listForReview, reviewSubmission, bulkReview,
  listForHodReview, hodReviewSubmission,
  saveDraft,
};
