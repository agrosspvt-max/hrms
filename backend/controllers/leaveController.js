const asyncHandler = require('express-async-handler');
const Leave = require('../models/Leave');
const User = require('../models/User');
const Department = require('../models/Department');
const Notification = require('../models/Notification');
const { startOfDay, daysBetween, addDays } = require('../utils/dateHelpers');
const { logAudit } = require('../utils/audit');

/**
 * Employee applies for a leave.
 */
const apply = asyncHandler(async (req, res) => {
  // Super Admin has no approver above them, so they cannot create
  // leave requests through the standard workflow.
  if (req.user.role === 'super_admin') {
    res.status(403);
    throw new Error('Super Admin accounts cannot raise leave requests.');
  }

  const { fromDate, toDate, leaveType, reason } = req.body;
  if (!fromDate || !toDate) {
    res.status(400);
    throw new Error('fromDate and toDate are required');
  }
  const from = startOfDay(new Date(fromDate));
  const to = startOfDay(new Date(toDate));
  if (to < from) {
    res.status(400);
    throw new Error('toDate must be after fromDate');
  }

  // Half-day leave is only valid for a single-day request.
  const isSingleDay = from.getTime() === to.getTime();
  const dayType = req.body.dayType === 'half' && isSingleDay ? 'half' : 'full';
  const days = dayType === 'half' ? 0.5 : daysBetween(from, addDays(to, 1));

  const lv = await Leave.create({
    employee: req.user._id,
    fromDate: from,
    toDate: to,
    leaveType,
    reason,
    days,
    dayType,
  });

  // Informational copy to the department HOD (approval still rests with HR).
  if (req.user.department) {
    const dept = await Department.findById(req.user.department).select('hodEmployeeId');
    if (dept?.hodEmployeeId && String(dept.hodEmployeeId) !== String(req.user._id)) {
      await Notification.create({
        recipient: dept.hodEmployeeId,
        sender: req.user._id,
        type: 'leave_info',
        title: 'Team leave request',
        message: `${req.user.name} applied for leave (${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}). Approval is handled by HR.`,
      }).catch(() => {});
    }
  }

  res.status(201).json(lv);
});

/**
 * Employee lists own leaves.
 */
const myLeaves = asyncHandler(async (req, res) => {
  const items = await Leave.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json(items);
});

/**
 * HR lists all leaves.
 */
const listAll = asyncHandler(async (req, res) => {
  const { status, employee, audience } = req.query;
  const where = {};
  if (status) where.status = status;
  if (employee) where.employee = employee;

  let items = await Leave.find(where)
    .populate('employee', 'name employeeId email role')
    .sort({ createdAt: -1 });

  // RBAC-aware scoping:
  //   - HR: only sees employee-role leaves (cannot decide HR leaves)
  //   - Super Admin: chooses audience (default = ALL, including legacy
  //                  leaves where the populated role might be missing)
  if (req.user.role === 'hr') {
    items = items.filter((l) => l.employee?.role === 'employee' || !l.employee?.role);
  } else if (audience === 'hr') {
    items = items.filter((l) => l.employee?.role === 'hr' || l.employee?.role === 'super_admin');
  } else if (audience === 'employee') {
    items = items.filter((l) => l.employee?.role === 'employee' || !l.employee?.role);
  }
  // audience omitted (or 'all') for Super Admin -> return everything

  res.json(items);
});

/**
 * HR approves / rejects.  Determines paid vs unpaid based on
 * current leave balance.
 */
const decide = asyncHandler(async (req, res) => {
  const { decision, hrNote } = req.body;
  if (!['approved', 'rejected'].includes(decision)) {
    res.status(400);
    throw new Error('decision must be approved or rejected');
  }
  const lv = await Leave.findById(req.params.id);
  if (!lv) { res.status(404); throw new Error('Leave not found'); }
  if (lv.status !== 'pending') { res.status(400); throw new Error('Leave already decided'); }

  // Role-aware routing: HR leaves can only be decided by a Super Admin.
  // HR cannot approve their own leave or another HR's leave.
  const requester = await User.findById(lv.employee).select('role');
  if (requester?.role === 'hr' && req.user.role !== 'super_admin') {
    res.status(403);
    throw new Error('Only a Super Admin can approve HR leave requests.');
  }
  if (String(lv.employee) === String(req.user._id)) {
    res.status(403);
    throw new Error('You cannot decide on your own leave request.');
  }

  if (decision === 'approved') {
    const user = await User.findById(lv.employee);
    const remaining = (user.leaveBalance?.yearlyAllowance || 0) - (user.leaveBalance?.used || 0);
    if (remaining >= lv.days) {
      lv.paid = true;
      user.leaveBalance.used = (user.leaveBalance.used || 0) + lv.days;
      await user.save();
    } else {
      // No balance left -> unpaid leave
      lv.paid = false;
      lv.leaveType = 'unpaid';
    }
  }

  lv.status = decision;
  lv.decidedBy = req.user._id;
  lv.decidedAt = new Date();
  lv.hrNote = hrNote;
  await lv.save();

  logAudit(req, {
    action: requester?.role === 'hr' ? 'leave.decide.hr' : 'leave.decide.employee',
    targetType: 'Leave',
    targetId: lv._id,
    targetLabel: `${requester?.role || 'user'} ${lv.fromDate.toISOString().slice(0, 10)} → ${lv.toDate.toISOString().slice(0, 10)}`,
    meta: { decision, paid: lv.paid, hrNote: hrNote || '' },
  });

  res.json(lv);
});

/**
 * HR updates leave-balance config for an employee.
 */
const setBalance = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) { res.status(404); throw new Error('Employee not found'); }
  const { yearlyAllowance, monthlyAllowance, used, resetDate } = req.body;
  if (yearlyAllowance !== undefined) user.leaveBalance.yearlyAllowance = yearlyAllowance;
  if (monthlyAllowance !== undefined) user.leaveBalance.monthlyAllowance = monthlyAllowance;
  if (used !== undefined) user.leaveBalance.used = used;
  if (resetDate !== undefined) user.leaveBalance.resetDate = resetDate;
  await user.save();
  res.json(user);
});

/**
 * Calendar view (HR): all approved leaves in a month.
 */
const calendar = asyncHandler(async (req, res) => {
  const { year, month } = req.query;
  const y = Number(year) || new Date().getFullYear();
  const m = Number(month) || new Date().getMonth() + 1;
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const items = await Leave.find({
    status: 'approved',
    fromDate: { $lt: to },
    toDate: { $gte: from },
  }).populate('employee', 'name employeeId');
  res.json(items);
});

module.exports = { apply, myLeaves, listAll, decide, setBalance, calendar };
