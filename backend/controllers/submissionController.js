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

// Submissions logged before this hour (server local time) trigger the
// automatic half-day attendance rule.  Configurable via env.
const HALFDAY_CUTOFF_HOUR = Number(process.env.ATTENDANCE_HALFDAY_CUTOFF_HOUR) || 16;

/**
 * Apply the automatic half-day attendance rule for `employee` on `day`,
 * driven by the time of submission.  Runs on every daily submit:
 *   - submitted BEFORE the cutoff -> half day
 *       * half_paid   if an approved half-day leave covers the day
 *       * half_unpaid otherwise (0.5 day salary cut, no leave used)
 *   - submitted AFTER the cutoff  -> full working day (no record needed)
 * A manual HR override is never touched.
 */
const applyAutoHalfDay = async (employee, day) => {
  const existing = await Attendance.findOne({ employee: employee._id, date: day });
  if (existing && existing.source === 'manual') return; // HR override wins

  const beforeCutoff = new Date().getHours() < HALFDAY_CUTOFF_HOUR;
  if (!beforeCutoff) return; // full day - derivation handles "present"

  const halfLeave = await Leave.findOne({
    employee: employee._id,
    status: 'approved',
    dayType: 'half',
    fromDate: { $lte: day },
    toDate: { $gte: day },
  });
  const status = halfLeave ? 'half_paid' : 'half_unpaid';

  await Attendance.findOneAndUpdate(
    { employee: employee._id, date: day },
    { employee: employee._id, date: day, status, source: 'auto', setBy: employee._id },
    { upsert: true, new: true, setDefaultsOnInsert: true }
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

  // Holiday + leave + weekly-off short-circuits
  const holiday = await Holiday.findOne({ date: today });
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

  const submissions = await Submission.find({
    employee: employee._id,
    date: today,
  }).populate('template', 'title');

  // Effective working status: if HR pushed override work onto a weekly-off
  // or holiday, today is a working day for the employee -- otherwise the
  // dashboard would still show "Enjoy your day!" and hide the tasks.
  const hasOverrideWork = (weeklyOff || !!holiday) && submissions.length > 0;

  const backlog = await getBacklog(employee._id, today);

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
  const { tasks = [], addedTasks = [], excelResponses = [], sheet, selfRating, selfNote, idea } = req.body;
  const sub = await Submission.findOne({ _id: req.params.id, employee: req.user._id });
  if (!sub) { res.status(404); throw new Error('Submission not found'); }
  if (sub.submitted) { res.status(400); throw new Error('Submission already submitted for today'); }

  const today = startOfDay(new Date());

  // Block submission on a holiday (in case the row was created earlier
  // and HR added a holiday after the fact).
  const holidayToday = await Holiday.findOne({ date: today });
  if (holidayToday) {
    res.status(400);
    throw new Error(`Today is a holiday: ${holidayToday.name}. No submissions are required.`);
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
  } else {
    const updateMap = new Map(tasks.map((t) => [String(t.taskId), t]));

    sub.tasks.forEach((t) => {
      const upd = updateMap.get(String(t._id));
      if (!upd) return;
      const status = upd.status;

      if (status === 'done') {
        t.status = 'done';
        earned += t.points;
        total += t.points;
      } else if (status === 'pending') {
        t.status = 'pending';
        t.pendingReason = upd.pendingReason || '';
        t.pendingSince = today;
        total += t.points;
        if (!t.pendingReason) {
          res.status(400);
          throw new Error(`Reason required for pending task: ${t.title}`);
        }
      } else if (status === 'work_not_available') {
        t.status = 'work_not_available';
        // not counted at all
      }

      // Dependency hand-off is only meaningful for done / pending work.
      if (status === 'done' || status === 'pending') {
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
    if (Array.isArray(addedTasks) && addedTasks.length > 0) {
      addedTasks.forEach((at) => {
        const title = String(at?.title || '').trim();
        if (!title) return;
        sub.tasks.push({
          title,
          points: 0,
          status: 'done',
          addedByEmployee: true,
          awardedMarks: 0,
        });
      });
    }
  }

  // Snapshot the pure work scoring (immutable). Final earned/total may
  // grow when HR adds discipline + innovation marks during review.
  sub.workEarnedPoints = earned;
  sub.workTotalPoints = total;
  sub.earnedPoints = earned;
  sub.totalPoints = total;
  sub.completionPercentage = total > 0 ? (earned / total) * 100 : 0;
  sub.submitted = true;
  sub.submittedAt = new Date();
  sub.reviewStatus = 'pending';
  if (selfRating !== undefined) sub.selfRating = selfRating;
  if (selfNote !== undefined) sub.selfNote = selfNote;
  if (idea !== undefined) sub.idea = idea;

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

  // Notify the HOD that a submission is waiting for their review.
  if (hod) {
    await Notification.create({
      recipient: hod._id,
      sender: req.user._id,
      type: 'review_pending',
      title: 'Submission awaiting your review',
      message: `${req.user.name} submitted a report that needs your review.`,
    }).catch(() => {});
  }

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
  res.json({ message: 'Backlog task completed', task });
});

/**
 * GET /api/submissions/history?from=&to=
 * Past submissions for the current employee.
 */
const history = asyncHandler(async (req, res) => {
  const where = { employee: req.user._id };
  if (req.query.from || req.query.to) {
    where.date = {};
    if (req.query.from) where.date.$gte = startOfDay(new Date(req.query.from));
    if (req.query.to) where.date.$lte = startOfDay(new Date(req.query.to));
  }
  const items = await Submission.find(where).populate('template', 'title').sort({ date: -1 });
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
  const where = { submitted: true };
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
    .populate('template', 'title')
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
    { $match: { employee: { $in: empIds.map((id) => new (require('mongoose').Types.ObjectId)(id)) } } },
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
  res.json(out);
});

/**
 * POST /api/submissions/:id/review
 * Body: { disciplineMarks, maxDisciplineMarks?, disciplineNote?,
 *         ideaMarks,       maxIdeaMarks?,       ideaFeedback? }
 *
 * Stores HR's discipline + innovation marks and recomputes the final
 * earned/total/percentage as:
 *   earned = workEarned + disciplineMarks + ideaMarks
 *   total  = workTotal  + maxDisciplineMarks + maxIdeaMarks
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

  const maxD = req.body.maxDisciplineMarks !== undefined
    ? Math.max(0, Number(req.body.maxDisciplineMarks))
    : sub.maxDisciplineMarks;
  const maxI = req.body.maxIdeaMarks !== undefined
    ? Math.max(0, Number(req.body.maxIdeaMarks))
    : sub.maxIdeaMarks;

  const dM = Math.max(0, Math.min(Number(req.body.disciplineMarks) || 0, maxD));
  const iM = Math.max(0, Math.min(Number(req.body.ideaMarks) || 0, maxI));

  sub.maxDisciplineMarks = maxD;
  sub.disciplineMarks = dM;
  sub.disciplineNote = req.body.disciplineNote || '';

  sub.maxIdeaMarks = maxI;
  sub.ideaMarks = iM;
  sub.ideaFeedback = req.body.ideaFeedback || '';

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
        if (t.status === 'done') earnedT += Number(t.points) || 0;
        if (t.status === 'done' || t.status === 'pending') totalT += Number(t.points) || 0;
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

  // Recalculate final scores
  sub.earnedPoints = sub.workEarnedPoints + dM + iM;
  sub.totalPoints = sub.workTotalPoints + maxD + maxI;
  sub.completionPercentage = sub.totalPoints > 0 ? (sub.earnedPoints / sub.totalPoints) * 100 : 0;

  sub.reviewHistory.push({
    reviewedBy: req.user._id,
    reviewerName: req.user.name,
    role: req.user.role,
    stage: 'finalized',
    action: 'hr_finalize',
    marks: sub.earnedPoints,
    remarks: req.body.disciplineNote || '',
    timestamp: new Date(),
  });

  await sub.save();
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

  const where = { submitted: true, employee: { $in: memberIds } };
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
    .populate('template', 'title')
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
  res.json(out);
});

/**
 * POST /api/submissions/:id/hod-review
 *
 * HOD records their (permission-gated) review.  Marks are stored as a
 * RECOMMENDATION only - they prefill HR's screen and do NOT commit final
 * earned/total (HR remains the final authority).
 *
 * Body: { remarks?, recommend?, disciplineMarks?, ideaMarks?,
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
    // NOTE: discipline & innovation marks are HR/Super-Admin ONLY and are
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

  await sub.save();
  res.json(sub);
});

module.exports = {
  getToday, submitOne, completeBacklogTask, history,
  listForReview, reviewSubmission,
  listForHodReview, hodReviewSubmission,
};
