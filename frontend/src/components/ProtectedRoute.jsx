import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Gate a route by role(s).  Usage:
 *   <ProtectedRoute>            ...auth required, any role
 *   <ProtectedRoute role="hr">  ...auth required, hr (super_admin also allowed by hierarchy)
 *   <ProtectedRoute roles={['hr', 'super_admin']}>   ...explicit list
 *
 * Super Admin auto-inherits HR permissions: a route allowing 'hr' is
 * automatically open to 'super_admin' too.
 */
export default function ProtectedRoute({ children, role, roles, hod }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;

  // HOD-gated route: a HOD is an employee with isHOD=true (super_admin
  // is allowed through for oversight).
  if (hod && !(user.isHOD || user.role === 'super_admin')) {
    return <Navigate to="/" replace />;
  }

  const allowed = roles || (role ? [role] : null);
  if (allowed) {
    const effective = new Set(allowed);
    if (effective.has('hr')) effective.add('super_admin');
    if (!effective.has(user.role)) return <Navigate to="/" replace />;
  }
  return children;
}
