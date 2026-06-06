const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const generateToken = require('../utils/generateToken');

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400);
    throw new Error('Email and password are required');
  }

  const user = await User.findOne({ email: email.toLowerCase() })
    .select('+password')
    // analyticsType lives on the Department: the Performance page reads it
    // to decide which tabs a HOD sees, so login must surface it here.
    .populate('department', 'name analyticsType')
    .populate('hodDepartment', 'name analyticsType')
    .populate('designation', 'title');

  if (!user || !(await user.matchPassword(password))) {
    res.status(401);
    throw new Error('Invalid email or password');
  }
  if (user.status !== 'active') {
    res.status(403);
    throw new Error('Your account has been deactivated. Contact HR.');
  }

  // Stamp last-login (fire-and-forget; never block login on this).
  User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } }).catch(() => {});

  res.json({
    token: generateToken(user._id),
    user: {
      _id: user._id,
      name: user.name,
      employeeId: user.employeeId,
      email: user.email,
      role: user.role,
      department: user.department,
      designation: user.designation,
      monthlySalary: user.monthlySalary,
      joiningDate: user.joiningDate,
      weeklyOff: user.weeklyOff,
      leaveBalance: user.leaveBalance,
      isHOD: user.isHOD,
      hodDepartment: user.hodDepartment,
      hodPermissions: user.hodPermissions,
      reviewFlow: user.reviewFlow,
    },
  });
});

// GET /api/auth/me
const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id)
    .populate('department', 'name analyticsType')
    .populate('hodDepartment', 'name analyticsType')
    .populate('designation', 'title');
  res.json(user);
});

// POST /api/auth/change-password
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    res.status(400);
    throw new Error('Both current and new password are required');
  }
  if (newPassword.length < 6) {
    res.status(400);
    throw new Error('New password must be at least 6 characters');
  }
  const user = await User.findById(req.user._id).select('+password');
  if (!user || !(await user.matchPassword(currentPassword))) {
    res.status(401);
    throw new Error('Current password is incorrect');
  }
  user.password = newPassword;
  await user.save();
  res.json({ message: 'Password updated successfully' });
});

module.exports = { login, me, changePassword };
