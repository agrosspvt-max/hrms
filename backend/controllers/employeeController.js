const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Department = require('../models/Department');
const Submission = require('../models/Submission');
const Leave = require('../models/Leave');
const DependencyTask = require('../models/DependencyTask');
const { sendCSV } = require('../utils/csvExporter');
const { logAudit } = require('../utils/audit');
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

module.exports = {
  listEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee,
  toggleStatus, resetPassword, exportCsv, teamList,
  workHistory, attendanceSummary, leaveHistory,
  addIncrement, editIncrement, deleteIncrement,
  adminAccounts,
};
