import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { useAuth } from './context/AuthContext.jsx';

import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';

import HRDashboard from './pages/hr/HRDashboard.jsx';
import Employees from './pages/hr/Employees.jsx';
import EmployeeDetail from './pages/hr/EmployeeDetail.jsx';
import MyTasks from './pages/hr/MyTasks.jsx';
import Organization from './pages/hr/Organization.jsx';
import WorkAssignments from './pages/hr/WorkAssignments.jsx';
import Contacts from './pages/hr/Contacts.jsx';
import EventsCalendar from './pages/hr/EventsCalendar.jsx';
// Employee Interactions -- redesigned single-workspace entry point.
// The legacy pages (EmployeeInteractions.jsx, ManageInteractionTags.jsx)
// remain in the tree for reference but the router now points at the
// redesigned workspace at /interactions.  /interactions/tags falls
// through to the same workspace with the Tags tab pre-selected via
// localStorage.
import InteractionsWorkspace from './pages/hr/interactions/InteractionsWorkspace.jsx';
import MyInteractions from './pages/employee/MyInteractions.jsx';
import MyCompliance from './pages/employee/MyCompliance.jsx';
import ComplianceWorkspace from './pages/hr/compliance/ComplianceWorkspace.jsx';
import RuleBuilderPage from './pages/hr/compliance/RuleBuilderPage.jsx';
import ManageAccess from './pages/superadmin/ManageAccess.jsx';
import FeatureAccess from './pages/superadmin/FeatureAccess.jsx';
import Departments from './pages/hr/Departments.jsx';
import Designations from './pages/hr/Designations.jsx';
import Templates from './pages/hr/Templates.jsx';
import Assignments from './pages/hr/Assignments.jsx';
import Products from './pages/hr/Products.jsx';
import GlobalBacklog from './pages/hr/GlobalBacklog.jsx';
import SubmissionReviews from './pages/hr/SubmissionReviews.jsx';
import Performance from './pages/hr/Performance.jsx';
import HRLeaves from './pages/hr/HRLeaves.jsx';
import EmployeeAttendance from './pages/hr/EmployeeAttendance.jsx';
import SentAlerts from './pages/hr/SentAlerts.jsx';
// Phase 61 -- Fines & Penalties module.
import FinesPenalties from './pages/hr/FinesPenalties.jsx';
import HRHolidays from './pages/hr/Holidays.jsx';
import ResetRequests from './pages/hr/ResetRequests.jsx';
import HRManagement from './pages/superadmin/HRManagement.jsx';
import AuditLog from './pages/superadmin/AuditLog.jsx';
import HRSalary from './pages/hr/HRSalary.jsx';
import SubmissionControl from './pages/hr/SubmissionControl.jsx';
import TemplateAnalytics from './pages/hr/TemplateAnalytics.jsx';

import EmployeeDashboard from './pages/employee/EmployeeDashboard.jsx';
import MyAttendance from './pages/employee/MyAttendance.jsx';
import MyLeaves from './pages/employee/MyLeaves.jsx';
import MySalary from './pages/employee/MySalary.jsx';
import Notifications from './pages/employee/Notifications.jsx';

import HODEmployees from './pages/hod/HODEmployees.jsx';
// Phase 10: HOD Team Reviews renders the SAME page HR uses.  The
// underlying /api/daily-review/grouped endpoint already enforces the
// HOD department clamp, so display logic is identical -- only data
// scope changes.  Legacy HODReviews.jsx is preserved for reference
// but no longer wired into a route.
// import HODReviews from './pages/hod/HODReviews.jsx';

function HomeRouter() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // Super Admin sees the same enterprise dashboard HR sees - they have
  // strictly more access, not a different layout.
  return (user.role === 'hr' || user.role === 'super_admin')
    ? <HRDashboard />
    : <EmployeeDashboard />;
}

/**
 * /performance gate.  Open to HR / Super Admin (existing) AND any HOD
 * (an employee with isHOD=true).  Backend enforces the per-HOD
 * department clamp so a HOD can never see another department's data.
 */
function PerformanceGate({ children, feature = 'performance' }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // Phase 44.2 -- also let employees with the named feature permission
  // pass (defaults to 'performance' but template-analytics routes pass
  // feature='templateAnalytics').  Existing HR / SA / HOD access is
  // unchanged.
  const perms = (user.featurePermissions && typeof user.featurePermissions === 'object')
    ? user.featurePermissions : {};
  const ok = user.role === 'hr' || user.role === 'super_admin' || user.isHOD === true
    || (feature && perms[feature]?.enabled);
  if (!ok) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<HomeRouter />} />
        <Route path="/change-password" element={<ChangePassword />} />

        {/* HR routes */}
        <Route path="/employees" element={<ProtectedRoute role="hr"><Employees /></ProtectedRoute>} />
        <Route path="/employees/:id" element={<ProtectedRoute role="hr"><EmployeeDetail /></ProtectedRoute>} />
        <Route path="/my-tasks" element={<ProtectedRoute role="hr"><MyTasks /></ProtectedRoute>} />
        {/* Phase 44.2 -- the `feature` prop lets an employee with the
            matching featurePermissions entry through the role gate
            without changing existing HR / Super Admin / HOD access. */}
        <Route path="/organization" element={<ProtectedRoute role="hr" feature="departments"><Organization /></ProtectedRoute>} />
        {/* Legacy routes kept working; both now render the unified module. */}
        <Route path="/departments" element={<ProtectedRoute role="hr" feature="departments"><Organization /></ProtectedRoute>} />
        <Route path="/designations" element={<ProtectedRoute role="hr" feature="departments"><Organization /></ProtectedRoute>} />
        {/* Unified Work Assignment Management module - both legacy routes
            render the same tabbed page so existing deep links keep working. */}
        <Route path="/assignments" element={<ProtectedRoute role="hr" feature="assignments"><WorkAssignments /></ProtectedRoute>} />
        <Route path="/templates" element={<ProtectedRoute role="hr" feature="assignments"><WorkAssignments /></ProtectedRoute>} />
        <Route path="/products" element={<ProtectedRoute role="hr" feature="products"><Products /></ProtectedRoute>} />
        {/*
          Performance dashboard.  HR + Super Admin (existing) AND any
          HOD (employee with isHOD=true).  Backend enforces dept clamp
          for HODs so the route can stay permissive on the frontend.
        */}
        <Route path="/backlog" element={<ProtectedRoute role="hr" feature="globalPendency"><GlobalBacklog /></ProtectedRoute>} />
        <Route path="/reviews" element={<ProtectedRoute role="hr" feature="submissionReviews"><SubmissionReviews /></ProtectedRoute>} />
        <Route path="/submission-control" element={<ProtectedRoute role="hr" feature="submissionControl"><SubmissionControl /></ProtectedRoute>} />
        {/* Phase 11: Dynamic Analytics Engine.  Phase 44.2: also opens
            for employees with `templateAnalytics` feature permission. */}
        <Route path="/template-analytics"      element={<PerformanceGate feature="templateAnalytics"><TemplateAnalytics /></PerformanceGate>} />
        <Route path="/template-analytics/:templateId" element={<PerformanceGate feature="templateAnalytics"><TemplateAnalytics /></PerformanceGate>} />
        <Route path="/sent-alerts" element={<ProtectedRoute role="hr" feature="sendAlerts"><SentAlerts /></ProtectedRoute>} />
        <Route path="/reset-requests" element={<ProtectedRoute role="hr"><ResetRequests /></ProtectedRoute>} />

        {/* Super Admin only */}
        <Route path="/hr-management" element={<ProtectedRoute role="super_admin"><HRManagement /></ProtectedRoute>} />
        <Route path="/manage-access" element={<ProtectedRoute role="super_admin"><ManageAccess /></ProtectedRoute>} />
        {/* Phase 43 -- Feature Access management.  HR also gets in. */}
        <Route path="/feature-access" element={<ProtectedRoute role="hr"><FeatureAccess /></ProtectedRoute>} />
        <Route path="/audit" element={<ProtectedRoute role="super_admin" feature="auditLog"><AuditLog /></ProtectedRoute>} />
        <Route path="/performance" element={<PerformanceGate feature="performance"><Performance /></PerformanceGate>} />
        <Route path="/leaves" element={<ProtectedRoute role="hr" feature="leaveApprovals"><HRLeaves /></ProtectedRoute>} />
        <Route path="/attendance" element={<ProtectedRoute role="hr" feature="attendance"><EmployeeAttendance /></ProtectedRoute>} />
        <Route path="/holidays" element={<ProtectedRoute role="hr" feature="eventsHolidays"><HRHolidays /></ProtectedRoute>} />
        <Route path="/salary" element={<ProtectedRoute role="hr" feature="salary"><HRSalary /></ProtectedRoute>} />
        {/* Phase 61 -- Fines & Penalties module. */}
        <Route path="/penalties" element={<ProtectedRoute role="hr" feature="penalties"><FinesPenalties /></ProtectedRoute>} />
        {/* Compliance & Accountability v2 -- HR workspace.  Additive to
            the existing /penalties route while both live under the
            dual-write window. */}
        <Route path="/hr/compliance" element={<ProtectedRoute role="hr" feature="penalties"><ComplianceWorkspace /></ProtectedRoute>} />
        {/* Rule Builder -- full-page create / edit / clone form.
            Backend gate: `compliance.rules` flag; endpoint returns 404
            when off so the page shows an inline load error instead of
            crashing. */}
        <Route path="/hr/compliance/rules/new"        element={<ProtectedRoute role="hr" feature="penalties"><RuleBuilderPage /></ProtectedRoute>} />
        <Route path="/hr/compliance/rules/:id/edit"   element={<ProtectedRoute role="hr" feature="penalties"><RuleBuilderPage /></ProtectedRoute>} />
        <Route path="/hr/compliance/rules/:id/clone"  element={<ProtectedRoute role="hr" feature="penalties"><RuleBuilderPage /></ProtectedRoute>} />

        {/* HOD (Head of Department) routes - employee + isHOD */}
        <Route path="/team" element={<ProtectedRoute hod><HODEmployees /></ProtectedRoute>} />
        <Route path="/team-reviews" element={<ProtectedRoute hod><SubmissionReviews /></ProtectedRoute>} />

        {/* Employee routes */}
        <Route path="/my-attendance" element={<ProtectedRoute><MyAttendance /></ProtectedRoute>} />
        <Route path="/my-leaves" element={<ProtectedRoute><MyLeaves /></ProtectedRoute>} />
        <Route path="/my-salary" element={<ProtectedRoute><MySalary /></ProtectedRoute>} />
        <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
        <Route path="/contacts" element={<ProtectedRoute><Contacts /></ProtectedRoute>} />
        <Route path="/events" element={<ProtectedRoute><EventsCalendar /></ProtectedRoute>} />
        {/* Redesigned Employee Interactions workspace: Meetings + Notes + Manage Tags. */}
        <Route path="/interactions" element={<ProtectedRoute role="hr" feature="employeeInteractions"><InteractionsWorkspace /></ProtectedRoute>} />
        <Route path="/interactions/tags" element={<ProtectedRoute role="hr" feature="employeeInteractions"><InteractionsWorkspace /></ProtectedRoute>} />
        <Route path="/my-interactions" element={<ProtectedRoute><MyInteractions /></ProtectedRoute>} />
        {/* Compliance v2 -- My Compliance workspace.  The page loads
            /api/compliance/config on mount; when the feature flag is
            off the endpoints return empty payloads and the page shows
            an "Empty timeline / No incidents" state. */}
        <Route path="/my-compliance" element={<ProtectedRoute><MyCompliance /></ProtectedRoute>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
