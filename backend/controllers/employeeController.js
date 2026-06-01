const asyncHandler = require('express-async-handler');
const XLSX = require('xlsx');
const User = require('../models/User');
const Department = require('../models/Department');
const Designation = require('../models/Designation');
const Submission = require('../models/Submission');
const Leave = require('../models/Leave');
const DependencyTask = require('../models/DependencyTask');
const { sendCSV } = require('../utils/csvExporter');
const { logAudit } = require('../utils/audit');
const { sendWelcomeEmail } = require('../utils/emailService');
const { startOfDay, addDays, parseDay } = require('../utils/dateHelpers');
const { getBacklog, deriveAttendance } = require('../services/dailyEngine');

const HALFDAY_CUTOFF_HOUR = Number(process.env.ATTENDANCE_HALFDAY_CUTOFF_HOUR) || 16;

/**
 * Resolve an inclusive [from, to) window from query params for the
 * employee-detail analytics endpoints.  Accepts ?from=&to= (YYYY-MM-DD) or
 * ?range=<days> (default 30).
 */
const detailRange = (q = {}) => {
  const to = q.to ? addDays(parseDay(q.to), 1) : addDays(startOfDay(new Date()), 1);
  const from = q.from ? parseDay(q.from) : addDays(to, -(Number(q.range) > 0 ? Number(q.range) : 30));
  return { from, to };
};

const hoursBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 36e5 * 10) / 10;

/**
 * Coerce empty-string ObjectId-ish fields to undefined so Mongoose
 * doesn't choke trying to cast '' to an ObjectId.
 */
const cleanRefs = (body) => {
  ['department', 'designation', 'hodDepartment'].forEach((k) => {
    if (k in body && (body[k] === '' || body[k] === null)) body[k] = undefined;
  });
};

/**
 * Normalise an incoming hodPermissions object to the canonical short
 * keys the schema stores.  Accepts BOTH naming conventions so a payload
 * is never silently dropped (which would leave canReview=false and lock
 * the HOD out of reviews):
 *   canReview        | canReviewSubmissions | canReviewSubmission
 *   canRemark        | canAddRemarks        | canAddRemark
 *   canMarks         | canGiveMarks         | canGiveMark
 *   canRecommend     | canRecommendApproval
 */
const PERM_ALIASES = {
  canReview: ['canReview', 'canReviewSubmissions', 'canReviewSubmission'],
  canRemark: ['canRemark', 'canAddRemarks', 'canAddRemark'],
  canMarks: ['canMarks', 'canGiveMarks', 'canGiveMark'],
  canRecommend: ['canRecommend', 'canRecommendApproval'],
};
const normalizeHodPermissions = (input) => {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  for (const [canon, aliases] of Object.entries(PERM_ALIASES)) {
    const hit = aliases.find((a) => a in input);
    out[canon] = hit ? !!input[hit] : false;
  }
  return out;
};

/**
 * Keep Department.hodEmployeeId and User.isHOD/hodDepartment consistent.
 * Enforces "one active HOD per department": appointing a new HOD clears
 * the previous one.  Called after an employee is created/updated.
 */
const syncHodAssignment = async (user) => {
  if (user.isHOD && user.hodDepartment) {
    // Demote any other current HOD of this department.
    const others = await User.find({
      _id: { $ne: user._id },
      isHOD: true,
      hodDepartment: user.hodDepartment,
    });
    for (const o of others) {
      o.isHOD = false;
      o.hodDepartment = undefined;
      await o.save();
    }
    await Department.findByIdAndUpdate(user.hodDepartment, { hodEmployeeId: user._id });
  } else {
    // Not (or no longer) a HOD - clear any department that pointed here.
    await Department.updateMany({ hodEmployeeId: user._id }, { hodEmployeeId: null });
  }
};

// GET /api/employees  (HR / Super Admin)
const listEmployees = asyncHandler(async (req, res) => {
  const { q, department, designation, status, role } = req.query;
  const where = {};
  if (q) where.$or = [
    { name: { $regex: q, $options: 'i' } },
    { email: { $regex: q, $options: 'i' } },
    { employeeId: { $regex: q, $options: 'i' } },
  ];
  if (department) where.department = department;
  if (designation) where.designation = designation;
  if (status) where.status = status;
  if (role) where.role = role;

  // HR users can never see Super Admin accounts in the employee list.
  // If they explicitly filter by role=super_admin, return empty.
  if (req.user.role === 'hr') {
    if (role === 'super_admin') return res.json([]);
    where.role = where.role ? where.role : { $ne: 'super_admin' };
  }

  const users = await User.find(where)
    .populate('department', 'name')
    .populate('designation', 'title')
    .sort({ createdAt: -1 });
  res.json(users);
});

// GET /api/employees/:id  (HR / Super Admin) - single employee for the
// management dashboard.
const getEmployee = asyncHandler(async (req, res) => {
  const u = await User.findById(req.params.id)
    .populate('department', 'name')
    .populate('designation', 'title')
    .populate('hodDepartment', 'name');
  if (!u) { res.status(404); throw new Error('Employee not found'); }
  if (req.user.role === 'hr' && u.role === 'super_admin') {
    res.status(403); throw new Error('Only a Super Admin can view Super Admin accounts.');
  }
  res.json(u);
});

// POST /api/employees
const createEmployee = asyncHandler(async (req, res) => {
  const body = { ...req.body };
  if (!body.password) body.password = 'changeme123';
  if (!body.employeeId) {
    res.status(400);
    throw new Error('employeeId is required');
  }

  // HR can only create employees, never another HR or super_admin.
  // Only super_admin can create HR / super_admin accounts.
  if (req.user.role === 'hr' && body.role && body.role !== 'employee') {
    res.status(403);
    throw new Error('HR cannot create HR or Super Admin accounts. Ask a Super Admin.');
  }
  if (req.user.role !== 'super_admin' && body.role === 'super_admin') {
    res.status(403);
    throw new Error('Only a Super Admin can create another Super Admin.');
  }

  const existing = await User.findOne({ $or: [{ email: body.email }, { employeeId: body.employeeId }] });
  if (existing) {
    res.status(400);
    throw new Error('Email or Employee ID already in use');
  }
  cleanRefs(body);
  if ('hodPermissions' in body) body.hodPermissions = normalizeHodPermissions(body.hodPermissions);
  // Stamp the creator so the Manage Access table can show "Created By".
  body.createdByUser = req.user._id;
  const user = await User.create(body);
  await syncHodAssignment(user);
  logAudit(req, {
    action: user.role === 'hr' ? 'hr.create' : 'employee.create',
    targetType: 'User',
    targetId: user._id,
    targetLabel: `${user.name} <${user.email}>`,
    meta: { role: user.role, employeeId: user.employeeId },
  });

  // Fire-and-forget welcome email.  Must NEVER roll back creation.
  // We resolve the designation title separately so we don't require the
  // caller to .populate() before persisting.
  (async () => {
    console.log(`[WELCOME] employee created -> ${user.email} (${user.name})`);
    try {
      if (!user.email) {
        console.warn('[WELCOME] skipped: employee has no email address');
        return;
      }
      let designationTitle = '';
      if (user.designation) {
        const Designation = require('../models/Designation');
        const d = await Designation.findById(user.designation).select('title').lean();
        designationTitle = d?.title || '';
      }
      const loginUrl = process.env.HRMS_LOGIN_URL || 'https://hrms-alpha-weld.vercel.app';
      console.log(`[WELCOME] sending -> to=${user.email} designation="${designationTitle}" loginUrl=${loginUrl}`);
      await sendWelcomeEmail({
        to: user.email,
        employeeName: user.name,
        designationTitle,
        loginUrl,
      });
      console.log(`[WELCOME] sent OK -> ${user.email}`);
    } catch (err) {
      console.error(
        `[WELCOME] FAILED -> ${user.email} | ${err.message}`,
        err.code ? `code=${err.code}` : '',
        err.responseCode ? `responseCode=${err.responseCode}` : '',
      );
    }
  })();

  res.status(201).json(user);
});

// PUT /api/employees/:id
const updateEmployee = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) { res.status(404); throw new Error('Employee not found'); }

  // ---- HR restrictions ----
  if (req.user.role === 'hr') {
    if (String(target._id) === String(req.user._id)) {
      res.status(403); throw new Error('HR cannot edit their own account. Ask a Super Admin.');
    }
    if (target.role === 'hr' || target.role === 'super_admin') {
      res.status(403); throw new Error('Only a Super Admin can edit HR or Super Admin accounts.');
    }
    if (req.body.role && req.body.role !== 'employee') {
      res.status(403); throw new Error('HR cannot change a user\'s role to HR / Super Admin.');
    }
  }
  // Only super_admin can promote anyone to super_admin
  if (req.body.role === 'super_admin' && req.user.role !== 'super_admin') {
    res.status(403); throw new Error('Only a Super Admin can grant the Super Admin role.');
  }

  const updatable = [
    'name', 'email', 'phone', 'department', 'designation', 'role',
    'monthlySalary', 'salaryStructure', 'joiningDate', 'status', 'weeklyOff', 'leaveBalance',
    // Payslip payout details
    'bankName', 'bankAccount', 'uanNumber', 'panNumber',
    // HOD + review-routing fields
    'isHOD', 'hodDepartment', 'hodPermissions', 'reviewFlow',
    // Job context (employee management dashboard)
    'jobDescription', 'scopeOfWork', 'responsibilities', 'reportingManager', 'kpiNotes',
    // Date of birth (powers automatic birthday events)
    'dateOfBirth',
  ];
  const patch = {};
  updatable.forEach((k) => { if (k in req.body) patch[k] = req.body[k]; });
  cleanRefs(patch);
  if ('hodPermissions' in patch) patch.hodPermissions = normalizeHodPermissions(patch.hodPermissions);
  // A HOD must have a department they head; clearing the flag clears the dept.
  if (patch.isHOD === false) patch.hodDepartment = undefined;

  // Last-Super-Admin guard: prevent demotion / role-change that would
  // remove the only active Super Admin.
  if (patch.role && patch.role !== 'super_admin' && target.role === 'super_admin') {
    const remaining = await User.countDocuments({ role: 'super_admin', status: 'active', _id: { $ne: target._id } });
    if (remaining === 0) {
      res.status(400);
      throw new Error('Cannot demote the last remaining Super Admin. Promote another account first.');
    }
  }

  // ---- [HOD-DEBUG] incoming update (temporary; remove once verified) ----
  console.log('[HOD-DEBUG] updateEmployee by role=%s id=%s -> HOD fields:', req.user.role, String(req.user._id), {
    isHOD: patch.isHOD,
    hodDepartment: patch.hodDepartment ? String(patch.hodDepartment) : patch.hodDepartment,
    reviewFlow: patch.reviewFlow,
    hodPermissions: patch.hodPermissions,
  });

  const user = await User.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true })
    .populate('department', 'name')
    .populate('designation', 'title');

  // Keep Department.hodEmployeeId in sync when HOD assignment changed.
  if ('isHOD' in patch || 'hodDepartment' in patch) {
    await syncHodAssignment(user);
  }

  // Audit-log role transitions (promote / demote) so Manage Access has a
  // traceable record of who changed whose access level.
  if (patch.role && patch.role !== target.role) {
    logAudit(req, {
      action: 'admin.role_change',
      targetType: 'User',
      targetId: user._id,
      targetLabel: `${user.name} <${user.email}>`,
      meta: { from: target.role, to: patch.role },
    });
  }

  // ---- [HOD-DEBUG] persisted result (temporary; remove once verified) ----
  console.log('[HOD-DEBUG] saved employee %s -> isHOD=%s hodDepartment=%s reviewFlow=%s perms=%j',
    String(user._id), user.isHOD, user.hodDepartment ? String(user.hodDepartment) : null, user.reviewFlow, user.hodPermissions);

  res.json(user);
});

/**
 * GET /api/employees/team  (HOD)
 *
 * Returns the employees in the HOD's department with light-weight status:
 * today's submission/review stage and backlog count.  Read-only - a HOD
 * can view but never edit salaries, delete, or change roles here.
 */
const teamList = asyncHandler(async (req, res) => {
  const deptId = req.user.hodDepartment;
  if (!deptId) return res.json({ department: null, members: [] });

  const dept = await Department.findById(deptId).select('name');
  const members = await User.find({ department: deptId, role: 'employee' })
    .select('name employeeId email status reviewFlow isHOD designation department')
    .populate('designation', 'title')
    .sort({ name: 1 })
    .lean();

  const today = startOfDay(new Date());
  const todaySubs = await Submission.find({
    employee: { $in: members.map((m) => m._id) },
    date: today,
  }).select('employee submitted currentReviewStage reviewStatus').lean();
  const subByEmp = {};
  todaySubs.forEach((s) => {
    const k = String(s.employee);
    (subByEmp[k] = subByEmp[k] || []).push(s);
  });

  const out = [];
  for (const m of members) {
    const subs = subByEmp[String(m._id)] || [];
    const backlog = await getBacklog(m._id);
    out.push({
      ...m,
      submittedToday: subs.length > 0 && subs.every((s) => s.submitted),
      hasSubmissionToday: subs.length > 0,
      pendingHodReview: subs.some((s) => s.currentReviewStage === 'under_hod'),
      backlogCount: backlog.length,
    });
  }
  res.json({ department: dept, members: out });
});

// DELETE /api/employees/:id
const deleteEmployee = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) { res.status(404); throw new Error('Employee not found'); }

  if (String(target._id) === String(req.user._id)) {
    res.status(403); throw new Error('You cannot delete your own account.');
  }
  if (req.user.role === 'hr' && (target.role === 'hr' || target.role === 'super_admin')) {
    res.status(403); throw new Error('Only a Super Admin can delete HR or Super Admin accounts.');
  }
  if (target.role === 'super_admin' && req.user.role !== 'super_admin') {
    res.status(403); throw new Error('Only a Super Admin can delete another Super Admin.');
  }

  // A reason is mandatory for the audit trail.
  const reason = (req.body?.reason || '').trim();
  if (!reason) { res.status(400); throw new Error('A reason is required to delete an employee.'); }

  // At least one active Super Admin must always exist - never let the
  // system drift into an unmanageable state by deleting the last one.
  if (target.role === 'super_admin') {
    const remaining = await User.countDocuments({ role: 'super_admin', status: 'active', _id: { $ne: target._id } });
    if (remaining === 0) {
      res.status(400);
      throw new Error('Cannot delete the last remaining Super Admin. Promote another account to Super Admin first.');
    }
  }

  await User.findByIdAndDelete(req.params.id);
  logAudit(req, {
    action: target.role === 'hr' ? 'hr.delete' : 'employee.delete',
    targetType: 'User',
    targetId: target._id,
    targetLabel: `${target.name} <${target.email}>`,
    meta: { role: target.role, employeeId: target.employeeId, reason },
  });
  res.json({ message: 'Employee deleted' });
});

// PATCH /api/employees/:id/status
const toggleStatus = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) { res.status(404); throw new Error('Employee not found'); }
  if (String(target._id) === String(req.user._id)) {
    res.status(403); throw new Error('You cannot toggle your own status.');
  }
  if (req.user.role === 'hr' && (target.role === 'hr' || target.role === 'super_admin')) {
    res.status(403); throw new Error('Only a Super Admin can toggle HR / Super Admin status.');
  }
  // Deactivation requires a reason (kept in the audit trail).  Reactivation
  // is allowed without one.
  const goingInactive = target.status === 'active';
  const reason = (req.body?.reason || '').trim();
  if (goingInactive && !reason) {
    res.status(400); throw new Error('A reason is required to deactivate an employee.');
  }

  // Last-Super-Admin guard: never let the system drift to zero active
  // Super Admins by deactivating the only remaining one.
  if (goingInactive && target.role === 'super_admin') {
    const remaining = await User.countDocuments({ role: 'super_admin', status: 'active', _id: { $ne: target._id } });
    if (remaining === 0) {
      res.status(400);
      throw new Error('Cannot deactivate the last remaining Super Admin.');
    }
  }

  target.status = goingInactive ? 'inactive' : 'active';
  await target.save();
  logAudit(req, {
    action: 'employee.status',
    targetType: 'User',
    targetId: target._id,
    targetLabel: `${target.name} <${target.email}>`,
    meta: { status: target.status, reason },
  });
  res.json(target);
});

// POST /api/employees/:id/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    res.status(400);
    throw new Error('newPassword must be at least 6 characters');
  }
  const user = await User.findById(req.params.id).select('+password');
  if (!user) { res.status(404); throw new Error('Employee not found'); }
  if (req.user.role === 'hr' && (user.role === 'hr' || user.role === 'super_admin')) {
    res.status(403);
    throw new Error('Only a Super Admin can reset HR / Super Admin passwords.');
  }
  user.password = newPassword;
  await user.save();
  res.json({ message: 'Password reset' });
});

// GET /api/employees/export.csv
const exportCsv = asyncHandler(async (req, res) => {
  const users = await User.find({})
    .populate('department', 'name')
    .populate('designation', 'title');
  const rows = users.map((u) => ({
    employeeId: u.employeeId,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    department: u.department?.name || '',
    designation: u.designation?.title || '',
    monthlySalary: u.monthlySalary,
    joiningDate: u.joiningDate?.toISOString().substring(0, 10),
    status: u.status,
  }));
  sendCSV(res, 'employees.csv', rows);
});

/**
 * GET /api/employees/:id/work-history
 * Submissions (done/pending breakdown) + dependency chains given/received.
 * Filters: from, to, range, templateType, recurrence.
 */
const workHistory = asyncHandler(async (req, res) => {
  const emp = await User.findById(req.params.id).select('_id');
  if (!emp) { res.status(404); throw new Error('Employee not found'); }
  const { from, to } = detailRange(req.query);

  const where = { employee: emp._id, submitted: true, date: { $gte: from, $lt: to } };
  if (['task', 'excel', 'sheet'].includes(req.query.templateType)) where.templateType = req.query.templateType;
  if (['daily', 'weekly', 'monthly', 'one-time'].includes(req.query.recurrence)) where.frequency = req.query.recurrence;

  const subs = await Submission.find(where)
    .populate('template', 'title templateType')
    .sort({ date: -1 }).limit(120).lean();

  const submissions = [];
  const pendingItems = [];
  for (const s of subs) {
    let done = 0, pending = 0;
    const pushPending = (title, reason, since) => { pending += 1; pendingItems.push({ title, reason: reason || '', since: since || s.date, date: s.date, template: s.template?.title || '', type: s.templateType }); };
    if (s.templateType === 'excel') {
      (s.excelResponses || []).forEach((r) => { if (r.rowStatus === 'done') done += 1; else if (r.rowStatus === 'pending') pushPending(r.fieldName, r.dependencyRemark, s.date); });
    } else if (s.templateType === 'sheet') {
      ((s.sheet && s.sheet.scores) || []).forEach((sc) => { if (sc.rowStatus === 'done') done += 1; else if (sc.rowStatus === 'pending') pushPending(sc.label || sc.key, sc.pendingReason, s.date); });
    } else {
      (s.tasks || []).forEach((t) => { if (t.status === 'done') done += 1; else if (t.status === 'pending') pushPending(t.title, t.pendingReason, t.pendingSince); });
    }
    submissions.push({
      _id: s._id, date: s.date, template: s.template?.title || '', type: s.templateType,
      frequency: s.frequency, reviewStatus: s.reviewStatus, done, pending,
    });
  }

  const mapDep = (d, dir) => ({
    _id: d._id, originalTaskName: d.originalTaskName, remark: d.remark,
    status: d.currentStatus, priority: d.priority, chainId: d.chainId,
    assignedBy: d.assignedBy, assignedTo: d.assignedTo,
    createdAt: d.createdAt, resolvedAt: d.resolvedAt,
    resolutionHours: d.resolvedAt ? hoursBetween(d.waitingSince || d.createdAt, d.resolvedAt) : null,
    direction: dir,
  });
  const givenRaw = await DependencyTask.find({ assignedBy: emp._id }).populate('assignedTo', 'name employeeId').sort({ createdAt: -1 }).limit(60).lean();
  const receivedRaw = await DependencyTask.find({ assignedTo: emp._id }).populate('assignedBy', 'name employeeId').sort({ createdAt: -1 }).limit(60).lean();

  res.json({
    range: { from, to },
    submissions,
    pendingItems,
    dependencyGiven: givenRaw.map((d) => mapDep(d, 'given')),
    dependencyReceived: receivedRaw.map((d) => mapDep(d, 'received')),
  });
});

/**
 * GET /api/employees/:id/attendance
 * deriveAttendance summary + per-day trend + late-submission count.
 */
const attendanceSummary = asyncHandler(async (req, res) => {
  const emp = await User.findById(req.params.id);
  if (!emp) { res.status(404); throw new Error('Employee not found'); }
  const { from, to } = detailRange(req.query);
  const att = await deriveAttendance(emp, from, to);

  // Late submissions: submitted on/after the half-day cutoff hour (best-effort).
  const submitted = await Submission.find({ employee: emp._id, submitted: true, submittedAt: { $exists: true }, date: { $gte: from, $lt: to } }).select('submittedAt').lean();
  const lateSubmissions = submitted.filter((s) => new Date(s.submittedAt).getHours() >= HALFDAY_CUTOFF_HOUR).length;

  res.json({ range: { from, to }, ...att, lateSubmissions });
});

/**
 * GET /api/employees/:id/leaves - all leaves + current balance.
 */
const leaveHistory = asyncHandler(async (req, res) => {
  const emp = await User.findById(req.params.id).select('leaveBalance');
  if (!emp) { res.status(404); throw new Error('Employee not found'); }
  const leaves = await Leave.find({ employee: req.params.id })
    .populate('decidedBy', 'name')
    .sort({ fromDate: -1 }).limit(300).lean();
  res.json({ balance: emp.leaveBalance, leaves });
});

/* ---------------- Salary increment history ---------------- */
// POST /api/employees/:id/increments
const addIncrement = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) { res.status(404); throw new Error('Employee not found'); }
  if (req.user.role === 'hr' && (user.role === 'hr' || user.role === 'super_admin')) {
    res.status(403); throw new Error('Only a Super Admin can edit HR / Super Admin records.');
  }
  const { date, previousGross, newGross, note } = req.body;
  const rec = {
    date: date ? parseDay(date) : new Date(),
    previousGross: Number(previousGross) || 0,
    newGross: Number(newGross) || 0,
    note: (note || '').trim(),
    by: req.user._id,
  };
  user.salaryIncrements.push(rec);
  // lastIncrementDate = the latest effective date on record.
  user.lastIncrementDate = user.salaryIncrements
    .map((r) => new Date(r.date)).sort((a, b) => b - a)[0];
  await user.save();
  logAudit(req, { action: 'employee.increment', targetType: 'User', targetId: user._id, targetLabel: user.name, meta: { newGross: rec.newGross, previousGross: rec.previousGross } });
  res.status(201).json(user.salaryIncrements);
});

// PUT /api/employees/:id/increments/:incId
const editIncrement = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) { res.status(404); throw new Error('Employee not found'); }
  const rec = user.salaryIncrements.id(req.params.incId);
  if (!rec) { res.status(404); throw new Error('Increment record not found'); }
  if (req.body.date !== undefined) rec.date = parseDay(req.body.date);
  if (req.body.previousGross !== undefined) rec.previousGross = Number(req.body.previousGross) || 0;
  if (req.body.newGross !== undefined) rec.newGross = Number(req.body.newGross) || 0;
  if (req.body.note !== undefined) rec.note = String(req.body.note).trim();
  user.lastIncrementDate = user.salaryIncrements.map((r) => new Date(r.date)).sort((a, b) => b - a)[0];
  await user.save();
  res.json(user.salaryIncrements);
});

// DELETE /api/employees/:id/increments/:incId
const deleteIncrement = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) { res.status(404); throw new Error('Employee not found'); }
  const rec = user.salaryIncrements.id(req.params.incId);
  if (!rec) { res.status(404); throw new Error('Increment record not found'); }
  rec.deleteOne();
  user.lastIncrementDate = user.salaryIncrements.length
    ? user.salaryIncrements.map((r) => new Date(r.date)).sort((a, b) => b - a)[0]
    : undefined;
  await user.save();
  res.json(user.salaryIncrements);
});

/**
 * GET /api/admin-accounts  (Super Admin only)
 * Powers the Manage Access dashboard - returns every administrative
 * account (HR + Super Admin) with the columns that page needs, plus the
 * summary counts.  Per-row "Created By" is populated so HR can never see
 * Super Admin trail (this route is super-admin only via the route file).
 */
const adminAccounts = asyncHandler(async (req, res) => {
  // Only Super Admin should hit this; the route also enforces it.
  const ADMIN_ROLES = ['hr', 'super_admin'];
  const users = await User.find({ role: { $in: ADMIN_ROLES } })
    .select('name email phone role status createdAt updatedAt lastLoginAt createdByUser department designation employeeId')
    .populate('createdByUser', 'name email role')
    .populate('department', 'name')
    .populate('designation', 'title')
    .sort({ role: -1, createdAt: -1 })
    .lean();

  const summary = {
    totalSuperAdmins: users.filter((u) => u.role === 'super_admin').length,
    totalHR: users.filter((u) => u.role === 'hr').length,
    active: users.filter((u) => u.status === 'active').length,
    inactive: users.filter((u) => u.status === 'inactive').length,
  };

  res.json({ summary, accounts: users });
});

/* ============================================================
 * Bulk Excel import (template download + transactional create).
 * Required columns: Name, Employee ID, Email, Role, Department,
 * Designation. Optional: Phone, Joining Date, Monthly Salary,
 * Weekly Off, Initial Password.  All-or-nothing on errors.
 * ============================================================ */

const TEMPLATE_HEADER = [
  'Name *',
  'Employee ID *',
  'Email *',
  'Phone',
  'Role *',
  'Department *',
  'Designation *',
  'Joining Date (YYYY-MM-DD)',
  'Monthly Salary',
  'Weekly Off (e.g. Sun or Sun,Sat)',
  'Initial Password',
];

const DAY_NAME_TO_NUM = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// GET /api/employees/import-template
// Streams a pre-filled xlsx with one example row PLUS a Reference sheet
// listing every existing Department + Designation so HR copy-paste exact
// names (the importer matches by name, case-insensitive).
const importTemplate = asyncHandler(async (req, res) => {
  const [depts, desigs] = await Promise.all([
    Department.find({}).select('name').sort({ name: 1 }).lean(),
    Designation.find({}).select('title').sort({ title: 1 }).lean(),
  ]);

  const wb = XLSX.utils.book_new();

  const employeesAOA = [
    TEMPLATE_HEADER,
    [
      'Jane Doe',
      'EMP-1001',
      'jane.doe@example.com',
      '9000001234',
      'employee',
      depts[0]?.name || 'Accounts',
      desigs[0]?.title || 'Junior Associate',
      '2026-06-01',
      30000,
      'Sun',
      '',
    ],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(employeesAOA);
  ws1['!cols'] = TEMPLATE_HEADER.map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws1, 'Employees');

  const refRows = Math.max(depts.length, desigs.length);
  const refAOA = [['Departments', 'Designations']];
  for (let i = 0; i < refRows; i++) {
    refAOA.push([depts[i]?.name || '', desigs[i]?.title || '']);
  }
  const ws2 = XLSX.utils.aoa_to_sheet(refAOA);
  ws2['!cols'] = [{ wch: 32 }, { wch: 32 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Reference');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="hrms_employee_import_template.xlsx"');
  res.send(buf);
});

// POST /api/employees/import   (multer single file, field name "file")
// Two-phase: (1) parse + validate every row against the DB and itself,
// returning a 400 with a row-by-row error list on any failure (no writes).
// (2) Create all rows; on any mid-batch failure, delete every row we
// just created so the operation is effectively transactional.
const importBulk = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    res.status(400);
    throw new Error('No file uploaded. Pick the filled Excel template.');
  }

  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    res.status(400);
    throw new Error(`Could not read uploaded file: ${e.message}`);
  }
  const sheetName = wb.SheetNames.includes('Employees') ? 'Employees' : wb.SheetNames[0];
  if (!sheetName) { res.status(400); throw new Error('Workbook has no sheets'); }
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  if (aoa.length < 2) { res.status(400); throw new Error('Sheet has no data rows'); }

  const header = aoa[0].map((h) => String(h || '').trim());
  const dataRows = aoa.slice(1).filter((r) => r.some((c) => c !== '' && c !== null));
  if (dataRows.length === 0) { res.status(400); throw new Error('No data rows in the sheet'); }

  // Locate columns by prefix-match so users can rename "* Name" etc.
  const idxOf = (label) => header.findIndex((h) => h.toLowerCase().startsWith(label.toLowerCase()));
  const col = {
    name: idxOf('Name'),
    employeeId: idxOf('Employee ID'),
    email: idxOf('Email'),
    phone: idxOf('Phone'),
    role: idxOf('Role'),
    department: idxOf('Department'),
    designation: idxOf('Designation'),
    joiningDate: idxOf('Joining Date'),
    monthlySalary: idxOf('Monthly Salary'),
    weeklyOff: idxOf('Weekly Off'),
    password: idxOf('Initial Password'),
  };
  const requiredCols = ['name', 'employeeId', 'email', 'role', 'department', 'designation'];
  const missingCols = requiredCols.filter((k) => col[k] < 0);
  if (missingCols.length) {
    res.status(400);
    throw new Error(`Missing required column(s): ${missingCols.join(', ')}. Download a fresh template.`);
  }

  // Look-ups (case-insensitive match against existing dept/desig).
  const [depts, desigs, existingUsers] = await Promise.all([
    Department.find({}).select('name').lean(),
    Designation.find({}).select('title').lean(),
    User.find({}).select('email employeeId').lean(),
  ]);
  const deptByName = new Map(depts.map((d) => [d.name.toLowerCase(), d._id]));
  const desigByName = new Map(desigs.map((d) => [d.title.toLowerCase(), d._id]));
  const existingEmails = new Set(existingUsers.map((u) => (u.email || '').toLowerCase()));
  const existingIds = new Set(existingUsers.map((u) => u.employeeId));

  const errors = [];
  const parsed = [];
  const seenEmails = new Set();
  const seenIds = new Set();

  // Auto-provision plan: missing-name -> canonical-spelling (preserves the
  // first-seen casing so we don't end up creating "accounts" then needing
  // it as "Accounts").
  const deptsToCreate = new Map();          // lowerName -> displayName
  // Designation needs a department too.  If the same new designation title
  // is mapped to two different (new or existing) departments inside the
  // file we'll reject -- titles are unique system-wide.
  const desigsToCreate = new Map();         // lowerTitle -> { displayTitle, deptLowerName, deptDisplayName }
  const desigDeptConflicts = new Map();     // lowerTitle -> Set(deptLowerName) for clean error messages

  dataRows.forEach((raw, i) => {
    const sheetRow = i + 2; // 1-indexed + 1 header row
    const rowErrs = [];
    const get = (k) => (col[k] >= 0 && raw[col[k]] !== undefined ? raw[col[k]] : '');

    const name = String(get('name')).trim();
    const employeeId = String(get('employeeId')).trim();
    const email = String(get('email')).trim().toLowerCase();
    const phone = String(get('phone')).trim();
    const role = (String(get('role')).trim() || 'employee').toLowerCase();
    const deptName = String(get('department')).trim();
    const desigName = String(get('designation')).trim();
    const joiningRaw = get('joiningDate');
    const monthlySalary = Number(get('monthlySalary')) || 0;
    const offRaw = String(get('weeklyOff')).trim();
    const password = (String(get('password')).trim() || 'changeme123');

    if (!name) rowErrs.push('Name is required');
    if (!employeeId) rowErrs.push('Employee ID is required');
    if (!email) rowErrs.push('Email is required');
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) rowErrs.push('Email is not valid');

    if (!['employee', 'hr'].includes(role)) {
      rowErrs.push(`Role must be "employee" or "hr" (got "${role}")`);
    } else if (req.user.role === 'hr' && role !== 'employee') {
      rowErrs.push('HR can only create employees, not HR accounts');
    }

    if (!deptName) rowErrs.push('Department is required');
    if (!desigName) rowErrs.push('Designation is required');

    // Department: if not in DB, queue for auto-creation.
    const deptLower = deptName.toLowerCase();
    if (deptName && !deptByName.has(deptLower) && !deptsToCreate.has(deptLower)) {
      deptsToCreate.set(deptLower, deptName);
    }

    // Designation: if not in DB, queue for auto-creation AND remember
    // which department row asked for it.
    const desigLower = desigName.toLowerCase();
    if (desigName && !desigByName.has(desigLower)) {
      if (!desigsToCreate.has(desigLower)) {
        desigsToCreate.set(desigLower, {
          displayTitle: desigName,
          deptLowerName: deptLower,
          deptDisplayName: deptName,
        });
      } else {
        // Conflict check: same new designation appears with different
        // departments inside this file.
        const existing = desigsToCreate.get(desigLower);
        if (existing.deptLowerName !== deptLower) {
          if (!desigDeptConflicts.has(desigLower)) desigDeptConflicts.set(desigLower, new Set([existing.deptDisplayName]));
          desigDeptConflicts.get(desigLower).add(deptName);
        }
      }
    }

    if (email) {
      if (existingEmails.has(email)) rowErrs.push(`Email "${email}" already exists in the system`);
      if (seenEmails.has(email)) rowErrs.push(`Email "${email}" duplicated within file`);
      seenEmails.add(email);
    }
    if (employeeId) {
      if (existingIds.has(employeeId)) rowErrs.push(`Employee ID "${employeeId}" already exists in the system`);
      if (seenIds.has(employeeId)) rowErrs.push(`Employee ID "${employeeId}" duplicated within file`);
      seenIds.add(employeeId);
    }

    let joiningDate;
    if (joiningRaw instanceof Date) joiningDate = joiningRaw;
    else if (typeof joiningRaw === 'string' && joiningRaw.trim()) {
      const d = new Date(joiningRaw);
      if (Number.isNaN(d.getTime())) rowErrs.push(`Joining Date "${joiningRaw}" is not a valid date`);
      else joiningDate = d;
    }

    let weeklyOff = [0];
    if (offRaw) {
      const tokens = offRaw.split(/[,;\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
      const mapped = [];
      const bad = [];
      for (const t of tokens) {
        const n = DAY_NAME_TO_NUM[t.slice(0, 3)];
        if (n === undefined) bad.push(t); else mapped.push(n);
      }
      if (bad.length) rowErrs.push(`Weekly Off values not recognised: ${bad.join(', ')} (use Sun, Mon, ..., Sat)`);
      else weeklyOff = Array.from(new Set(mapped)).sort();
    }

    if (rowErrs.length) {
      errors.push({ row: sheetRow, name: name || '(blank)', errors: rowErrs });
      return;
    }
    parsed.push({
      sheetRow, name, employeeId, email, phone, role,
      deptLowerName: deptLower, desigLowerName: desigLower,
      joiningDate, monthlySalary, weeklyOff, password,
    });
  });

  // Designation -> Department conflicts are file-level errors (one
  // designation title can't be created twice with two different parents
  // because the title is unique system-wide).
  for (const [desigLower, deptSet] of desigDeptConflicts.entries()) {
    const meta = desigsToCreate.get(desigLower);
    errors.push({
      row: '-',
      name: meta?.displayTitle || desigLower,
      errors: [
        `Designation "${meta?.displayTitle || desigLower}" is mapped to multiple departments in this file (${[...deptSet].join(', ')}). A designation title is unique system-wide -- pick one parent department or pre-create the designation in Organization first.`,
      ],
    });
  }

  if (errors.length) {
    return res.status(400).json({
      message: `Import aborted: ${errors.length} row(s) failed validation. No employees were created.`,
      totalRows: dataRows.length,
      validRows: parsed.length,
      errors,
    });
  }

  // Phase 2: provision missing Departments + Designations, then create
  // Users.  Track every entity we created so we can roll EVERYTHING back
  // if user-creation fails mid-batch.
  const createdDepts = [];
  const createdDesigs = [];
  const created = [];

  try {
    // 2a. Auto-create departments.
    for (const [lower, displayName] of deptsToCreate.entries()) {
      const d = await Department.create({ name: displayName });
      createdDepts.push(d);
      deptByName.set(lower, d._id);
      logAudit(req, {
        action: 'department.create',
        targetType: 'Department',
        targetId: d._id,
        targetLabel: d.name,
        meta: { via: 'bulk-import' },
      });
    }

    // 2b. Auto-create designations, each mapped to the department it
    //     was requested under (might itself be auto-created above).
    for (const [lower, meta] of desigsToCreate.entries()) {
      const deptId = deptByName.get(meta.deptLowerName) || null;
      const d = await Designation.create({
        title: meta.displayTitle,
        department: deptId,
      });
      createdDesigs.push(d);
      desigByName.set(lower, d._id);
      logAudit(req, {
        action: 'designation.create',
        targetType: 'Designation',
        targetId: d._id,
        targetLabel: d.title,
        meta: { via: 'bulk-import', department: meta.deptDisplayName },
      });
    }

    // 2c. Create users using the resolved IDs (existing or just-created).
    for (const row of parsed) {
      const u = await User.create({
        name: row.name,
        employeeId: row.employeeId,
        email: row.email,
        phone: row.phone,
        password: row.password,
        role: row.role,
        department: deptByName.get(row.deptLowerName),
        designation: desigByName.get(row.desigLowerName),
        joiningDate: row.joiningDate,
        monthlySalary: row.monthlySalary,
        weeklyOff: row.weeklyOff,
        createdByUser: req.user._id,
      });
      created.push(u);
      logAudit(req, {
        action: u.role === 'hr' ? 'hr.create' : 'employee.create',
        targetType: 'User',
        targetId: u._id,
        targetLabel: `${u.name} <${u.email}>`,
        meta: { role: u.role, employeeId: u.employeeId, via: 'bulk-import' },
      });
    }
  } catch (err) {
    // Full rollback: users first, then designations, then departments.
    const undoneUsers = created.length;
    const undoneDesigs = createdDesigs.length;
    const undoneDepts = createdDepts.length;
    try { if (created.length)       await User.deleteMany({ _id: { $in: created.map((u) => u._id) } }); } catch (_) {}
    try { if (createdDesigs.length)  await Designation.deleteMany({ _id: { $in: createdDesigs.map((d) => d._id) } }); } catch (_) {}
    try { if (createdDepts.length)   await Department.deleteMany({ _id: { $in: createdDepts.map((d) => d._id) } }); } catch (_) {}
    res.status(500);
    throw new Error(
      `Import failed mid-batch and was rolled back (` +
      `${undoneUsers}/${parsed.length} users, ${undoneDesigs} new designations, ` +
      `${undoneDepts} new departments undone): ${err.message}`
    );
  }

  // Fire-and-forget welcome emails (one per created row).  Identical
  // semantics to single-employee creation -- failures only log.
  for (const u of created) {
    (async () => {
      try {
        if (!u.email) return;
        let designationTitle = '';
        if (u.designation) {
          const d = await Designation.findById(u.designation).select('title').lean();
          designationTitle = d?.title || '';
        }
        const loginUrl = process.env.HRMS_LOGIN_URL || 'https://hrms-alpha-weld.vercel.app';
        await sendWelcomeEmail({ to: u.email, employeeName: u.name, designationTitle, loginUrl });
      } catch (e) {
        console.error(`[WELCOME] bulk-import welcome failed for ${u.email}: ${e.message}`);
      }
    })();
  }

  res.status(201).json({
    message: `Imported ${created.length} employee(s) successfully.`,
    totalRows: dataRows.length,
    created: created.map((u) => ({
      _id: u._id, name: u.name, email: u.email, employeeId: u.employeeId, role: u.role,
    })),
    createdDepartments: createdDepts.map((d) => ({ _id: d._id, name: d.name })),
    createdDesignations: createdDesigs.map((d) => ({
      _id: d._id,
      title: d.title,
      // Look up the parent department name so the modal can show what
      // each new designation got mapped to.
      department: (() => {
        const parent = createdDepts.find((dp) => String(dp._id) === String(d.department))
          || depts.find((dp) => String(dp._id) === String(d.department));
        return parent ? parent.name : null;
      })(),
    })),
  });
});

module.exports = {
  listEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee,
  toggleStatus, resetPassword, exportCsv, teamList,
  workHistory, attendanceSummary, leaveHistory,
  addIncrement, editIncrement, deleteIncrement,
  adminAccounts,
  importTemplate, importBulk,
};
