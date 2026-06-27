const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');

/**
 * Verifies the JWT in the Authorization header (Bearer ...).
 * Loads the user (without password) onto req.user.
 */
const protect = asyncHandler(async (req, res, next) => {
  let token;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.split(' ')[1];
  } else if (req.query && req.query.token) {
    // Allow ?token=... for file-download anchor links (PDF / CSV exports)
    token = req.query.token;
  }

  if (!token) {
    res.status(401);
    throw new Error('Not authorized, no token');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) {
      res.status(401);
      throw new Error('User no longer exists');
    }
    if (req.user.status !== 'active') {
      res.status(403);
      throw new Error('Account is inactive');
    }
    next();
  } catch (err) {
    res.status(401);
    throw new Error('Not authorized, token invalid');
  }
});

/**
 * Restricts an endpoint to one or more roles.
 *
 * Role hierarchy: super_admin > hr > employee
 *
 * Any route that allows 'hr' is automatically allowed for 'super_admin'
 * as well, so we don't need to enumerate both everywhere.  Use
 * authorize('super_admin') explicitly for super-admin-only endpoints.
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) {
    res.status(401);
    throw new Error('Not authorized');
  }
  const allowed = new Set(roles);
  if (allowed.has('hr')) allowed.add('super_admin');
  if (!allowed.has(req.user.role)) {
    // [HOD-DEBUG] temporary - shows exactly who was blocked and why.
    console.warn('[HOD-DEBUG] authorize DENY role=%s needed=%j %s %s',
      req.user.role, [...allowed], req.method, req.originalUrl);
    res.status(403);
    throw new Error('Forbidden: insufficient permissions');
  }
  next();
};

/**
 * Restricts an endpoint to HOD (Head of Department) accounts.  A HOD is
 * an employee with `isHOD = true`.  Super Admin is also allowed through
 * for oversight.  Must run after `protect`.
 */
const requireHOD = (req, res, next) => {
  if (!req.user) {
    res.status(401);
    throw new Error('Not authorized');
  }
  if (req.user.isHOD || req.user.role === 'super_admin') return next();
  res.status(403);
  throw new Error('Forbidden: HOD access required');
};

/**
 * Authorizes access to submission-review endpoints.  Per spec, allowed:
 *   1. HR
 *   2. Super Admin
 *   3. Employee who is a HOD WITH the canReview permission.
 *
 * This deliberately does NOT require role === 'hr' - a HOD is an
 * employee with elevated permissions, never a separate role.
 */
const requireReviewer = (req, res, next) => {
  const u = req.user;
  if (!u) {
    res.status(401);
    throw new Error('Not authorized');
  }
  const ok =
    u.role === 'hr' ||
    u.role === 'super_admin' ||
    (u.isHOD && u.hodPermissions && u.hodPermissions.canReview);
  if (ok) return next();
  // [HOD-DEBUG] temporary - surfaces the exact reason a reviewer was blocked.
  console.warn('[HOD-DEBUG] requireReviewer DENY role=%s isHOD=%s canReview=%s %s',
    u.role, u.isHOD, u.hodPermissions && u.hodPermissions.canReview, req.originalUrl);
  res.status(403);
  throw new Error('Forbidden: review access required (need HR or a HOD with review permission)');
};

/**
 * Authorizes access to analytics endpoints (Performance dashboards).
 * Allowed:
 *   1. HR
 *   2. Super Admin
 *   3. Any HOD (an employee with isHOD=true).  Department scoping is
 *      enforced inside each controller -- the middleware just opens
 *      the door so a HOD can hit the URL.
 */
const requireAnalyticsAccess = (req, res, next) => {
  const u = req.user;
  if (!u) { res.status(401); throw new Error('Not authorized'); }
  // Phase 44.2 -- also allow employees who hold a relevant feature
  // permission.  `performance` covers /performance and the Performance
  // sub-tabs; `templateAnalytics` covers /template-analytics + its
  // detail pages.  HR / SA / HOD access is unchanged.
  const perms = (u.featurePermissions && (u.featurePermissions.toObject
    ? u.featurePermissions.toObject() : u.featurePermissions)) || {};
  const ok = u.role === 'hr' || u.role === 'super_admin' || u.isHOD === true
    || !!perms.performance?.enabled
    || !!perms.templateAnalytics?.enabled;
  if (ok) return next();
  res.status(403);
  throw new Error('Forbidden: analytics access requires HR, Super Admin, HOD, or the matching feature permission.');
};

/* ====================================================================
 * Phase 44.2 — requireRoleOrFeature
 *
 * Combines authorize(role) with an employee feature-permission gate.
 * Usage:
 *   router.get('/contacts', requireRoleOrFeature('hr', 'contacts'), c.list);
 *
 * HR + Super Admin pass via the role check exactly as before.
 * Employees pass when featurePermissions[feature].enabled is true.
 * Everyone else is rejected.  This is the backend twin of the
 * ProtectedRoute feature= prop on the frontend, so the two layers stay
 * in lock-step and a manually-crafted API call from an unauthorised
 * account is rejected with 403 even when the sidebar would have shown
 * the module.
 * ================================================================== */
const requireRoleOrFeature = (role, feature) => (req, res, next) => {
  const u = req.user;
  if (!u) { res.status(401); return next(new Error('Not authorized')); }
  if (u.role === 'super_admin') return next();
  if (role === 'hr' && u.role === 'hr') return next();
  if (role && u.role === role) return next();
  const perms = (u.featurePermissions && (u.featurePermissions.toObject
    ? u.featurePermissions.toObject() : u.featurePermissions)) || {};
  if (feature && perms[feature]?.enabled) return next();
  res.status(403);
  return next(new Error(`Forbidden: ${role || 'admin'} role or ${feature || ''} feature permission required.`));
};

module.exports = { protect, authorize, requireHOD, requireReviewer, requireAnalyticsAccess, requireRoleOrFeature };
