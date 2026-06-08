const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const User = require('../models/User');
const { sendPasswordResetEmail } = require('../utils/emailService');
const { logAudit } = require('../utils/audit');
const notify = require('../services/notifyEvents');

const TOKEN_TTL_MIN = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MIN) || 30;

const secureToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/**
 * Light per-email rate limit.  If there's already a PENDING request
 * younger than this window, we return the existing row instead of
 * creating another one - that way employees can't spam HR.
 */
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * POST /api/password-reset/request
 * Public.  Body: { email }
 *
 * - Validates email exists.
 * - Creates a PENDING request (or returns the most recent one if a
 *   pending request was made very recently from the same email).
 * - Does NOT generate a reset link yet; that happens on HR approval.
 */
const requestReset = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }
  const normalised = String(email).toLowerCase().trim();

  const user = await User.findOne({ email: normalised });
  if (!user) {
    res.status(404);
    throw new Error('No employee found with this email.');
  }
  if (user.status !== 'active') {
    res.status(403);
    throw new Error('Account is inactive. Please contact HR.');
  }

  // Rate limit per email
  const recent = await PasswordResetRequest.findOne({
    employeeEmail: normalised,
    status: 'PENDING',
    requestedAt: { $gte: new Date(Date.now() - RATE_LIMIT_WINDOW_MS) },
  }).sort({ requestedAt: -1 });

  if (recent) {
    return res.status(200).json({
      message: 'Password reset request already pending with HR.',
      requestedAt: recent.requestedAt,
    });
  }

  const reqDoc = await PasswordResetRequest.create({
    employeeId: user._id,
    employeeEmail: normalised,
    requestToken: secureToken(16),
    status: 'PENDING',
    requestIp: req.ip,
    userAgent: req.get('user-agent') || '',
  });

  // Global notification: HR + Super Admin see new reset requests inbox-style.
  notify.notifyPasswordResetRequest({ employee: user });

  res.status(201).json({
    message: 'Password reset request sent to HR for approval.',
    requestId: reqDoc._id,
  });
});

/**
 * GET /api/password-reset
 * HR-only.  Query: ?status=PENDING|APPROVED|REJECTED|USED&q=name/email
 */
const listRequests = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.q) {
    where.$or = [
      { employeeEmail: { $regex: req.query.q, $options: 'i' } },
    ];
  }
  let items = await PasswordResetRequest.find(where)
    .populate('employeeId', 'name employeeId email role department designation')
    .populate('approvedByHrId', 'name')
    .sort({ requestedAt: -1 });

  // Role-based scoping:
  //  - HR sees only employee-role reset requests (so they don't try to
  //    approve another HR's reset).
  //  - Super Admin sees everything (default).
  if (req.user.role === 'hr') {
    items = items.filter((r) => r.employeeId?.role === 'employee');
  } else if (req.query.audience === 'hr') {
    items = items.filter((r) => r.employeeId?.role === 'hr' || r.employeeId?.role === 'super_admin');
  } else if (req.query.audience === 'employee') {
    items = items.filter((r) => r.employeeId?.role === 'employee');
  }

  res.json(items);
});

/**
 * GET /api/password-reset/pending-count
 * Small endpoint for the sidebar badge.
 */
const pendingCount = asyncHandler(async (req, res) => {
  // HR only counts employee-targeted requests; Super Admin sees all.
  const where = { status: 'PENDING' };
  let items = await PasswordResetRequest.find(where).populate('employeeId', 'role');
  if (req.user.role === 'hr') {
    items = items.filter((r) => r.employeeId?.role === 'employee');
  }
  res.json({ count: items.length });
});

/**
 * POST /api/password-reset/:id/approve
 * HR-only.  Generates reset token, dispatches email.
 */
const approve = asyncHandler(async (req, res) => {
  const reqDoc = await PasswordResetRequest.findById(req.params.id).populate('employeeId');
  if (!reqDoc) { res.status(404); throw new Error('Reset request not found'); }
  if (reqDoc.status !== 'PENDING') {
    res.status(400);
    throw new Error(`Cannot approve a ${reqDoc.status} request`);
  }
  const employee = reqDoc.employeeId;
  if (!employee) {
    res.status(400);
    throw new Error('Employee no longer exists');
  }

  // Role-aware routing: HR password resets must be approved by a
  // Super Admin.  HR cannot approve their own or another HR's reset.
  if ((employee.role === 'hr' || employee.role === 'super_admin') && req.user.role !== 'super_admin') {
    res.status(403);
    throw new Error('Only a Super Admin can approve password resets for HR / Super Admin accounts.');
  }
  if (String(employee._id) === String(req.user._id)) {
    res.status(403);
    throw new Error('You cannot approve your own password reset.');
  }

  const resetToken = secureToken(32);
  const expiry = new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000);

  reqDoc.status = 'APPROVED';
  reqDoc.approvedAt = new Date();
  reqDoc.approvedByHrId = req.user._id;
  reqDoc.resetToken = resetToken;
  reqDoc.resetTokenExpiry = expiry;
  reqDoc.isUsed = false;
  await reqDoc.save();
  console.log(`[RESET] token generated for ${employee.email} (request ${reqDoc._id})`);

  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  if (clientUrl.includes('localhost') && process.env.NODE_ENV === 'production') {
    console.warn(`[RESET] WARNING: CLIENT_URL still points to ${clientUrl} in production -- the reset link in the email will be broken. Set CLIENT_URL to your Vercel URL on Render.`);
  }
  const resetUrl = `${clientUrl}/reset-password?token=${resetToken}`;

  console.log(`[RESET] email send started -> ${employee.email}`);
  try {
    await sendPasswordResetEmail({
      to: employee.email,
      employeeName: employee.name,
      resetUrl,
      ttlMinutes: TOKEN_TTL_MIN,
    });
    console.log(`[RESET] email send success -> ${employee.email}`);
    reqDoc.emailSentAt = new Date();
    await reqDoc.save();
    logAudit(req, {
      action: employee.role === 'hr' ? 'password-reset.approve.hr' : 'password-reset.approve.employee',
      targetType: 'PasswordResetRequest',
      targetId: reqDoc._id,
      targetLabel: employee.email,
      meta: { ttlMin: TOKEN_TTL_MIN, role: employee.role },
    });
  } catch (err) {
    // Surface SMTP issues but keep the approval state so HR can retry.
    console.error(
      `[RESET] email send FAILED -> ${employee.email} | ${err.message}`,
      err.code ? `code=${err.code}` : '',
      err.responseCode ? `responseCode=${err.responseCode}` : '',
    );
    res.status(500);
    throw new Error(`Approved but email failed to send: ${err.message}`);
  }

  // Notify the user that their reset was approved (out-of-band channel
  // alongside the email so they get the heads-up next time they log in).
  notify.notifyPasswordResetApproved({ employeeId: employee._id, approvedBy: req.user });

  res.json({
    message: 'Approved and reset email sent.',
    request: reqDoc,
    resetUrl, // also returned so HR can copy/share manually if needed
  });
});

/**
 * POST /api/password-reset/:id/reject
 * HR-only.  Body: { reason? }
 */
const reject = asyncHandler(async (req, res) => {
  const reqDoc = await PasswordResetRequest.findById(req.params.id);
  if (!reqDoc) { res.status(404); throw new Error('Reset request not found'); }
  if (reqDoc.status !== 'PENDING') {
    res.status(400);
    throw new Error(`Cannot reject a ${reqDoc.status} request`);
  }
  reqDoc.status = 'REJECTED';
  reqDoc.rejectedAt = new Date();
  reqDoc.rejectReason = (req.body.reason || '').trim();
  await reqDoc.save();
  res.json({ message: 'Request rejected.', request: reqDoc });
});

/**
 * GET /api/password-reset/validate?token=...
 * Public.  Checks whether a token is still usable.
 */
const validateToken = asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) { res.status(400); throw new Error('Token is required'); }

  const reqDoc = await PasswordResetRequest.findOne({ resetToken: String(token) })
    .populate('employeeId', 'name email');

  if (!reqDoc) { res.status(404); throw new Error('Invalid or expired reset link.'); }
  if (reqDoc.isUsed) { res.status(400); throw new Error('This reset link has already been used.'); }
  if (reqDoc.status !== 'APPROVED') { res.status(400); throw new Error('Invalid or expired reset link.'); }
  if (!reqDoc.resetTokenExpiry || reqDoc.resetTokenExpiry < new Date()) {
    res.status(400);
    throw new Error('This reset link has expired.');
  }

  res.json({
    valid: true,
    employee: {
      name: reqDoc.employeeId?.name,
      email: reqDoc.employeeId?.email,
    },
  });
});

/**
 * POST /api/password-reset/reset
 * Public.  Body: { token, newPassword }
 *
 * Verifies token, updates User.password (hashing handled by User pre-save),
 * then marks the request as USED so the link can't be reused.
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    res.status(400);
    throw new Error('Token and new password are required');
  }
  if (String(newPassword).length < 6) {
    res.status(400);
    throw new Error('Password must be at least 6 characters');
  }

  const reqDoc = await PasswordResetRequest.findOne({ resetToken: String(token) });
  if (!reqDoc) { res.status(404); throw new Error('Invalid or expired reset link.'); }
  if (reqDoc.isUsed) { res.status(400); throw new Error('This reset link has already been used.'); }
  if (reqDoc.status !== 'APPROVED') { res.status(400); throw new Error('Invalid or expired reset link.'); }
  if (!reqDoc.resetTokenExpiry || reqDoc.resetTokenExpiry < new Date()) {
    res.status(400);
    throw new Error('This reset link has expired.');
  }

  const user = await User.findById(reqDoc.employeeId).select('+password');
  if (!user) { res.status(404); throw new Error('Employee not found'); }

  user.password = newPassword; // hashed by User pre-save hook
  await user.save();

  reqDoc.status = 'USED';
  reqDoc.isUsed = true;
  reqDoc.usedAt = new Date();
  // Invalidate the token so it can't be used again under any code path
  reqDoc.resetToken = undefined;
  await reqDoc.save();

  console.log(`[password-reset] ${user.email} reset their password via request ${reqDoc._id}`);

  res.json({ message: 'Password reset successful.' });
});

module.exports = {
  requestReset, listRequests, pendingCount, approve, reject, validateToken, resetPassword,
};
