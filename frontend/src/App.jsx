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
import ManageAccess from './pages/superadmin/ManageAccess.jsx';
import Departments from './pages/hr/Departments.jsx';
import Designations from './pages/hr/Designations.jsx';
import Templates from './pages/hr/Templates.jsx';
import Assignments from './pages/hr/Assignments.jsx';
import GlobalBacklog from './pages/hr/GlobalBacklog.jsx';
import SubmissionReviews from './pages/hr/SubmissionReviews.jsx';
import Performance from './pages/hr/Performance.jsx';
import HRLeaves from './pages/hr/HRLeaves.jsx';
import EmployeeAttendance from './pages/hr/EmployeeAttendance.jsx';
import SentAlerts from './pages/hr/SentAlerts.jsx';
import HRHolidays from './pages/hr/Holidays.jsx';
import ResetRequests from './pages/hr/ResetRequests.jsx';
import HRManagement from './pages/superadmin/HRManagement.jsx';
import AuditLog from './pages/superadmin/AuditLog.jsx';
import HRSalary from './pages/hr/HRSalary.jsx';

import EmployeeDashboard from './pages/employee/EmployeeDashboard.jsx';
import MyAttendance from './pages/employee/MyAttendance.jsx';
import MyLeaves from './pages/employee/MyLeaves.jsx';
import MySalary from './pages/employee/MySalary.jsx';
import Notifications from './pages/employee/Notifications.jsx';

import HODEmployees from './pages/hod/HODEmployees.jsx';
import HODReviews from './pages/hod/HODReviews.jsx';

function HomeRouter() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // Super Admin sees the same enterprise dashboard HR sees - they have
  // strictly more access, not a different layout.
  return (user.role === 'hr' || user.role === 'super_admin')
    ? <HRDashboard />
    : <EmployeeDashboard />;
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
        <Route path="/organization" element={<ProtectedRoute role="hr"><Organization /></ProtectedRoute>} />
        {/* Legacy routes kept working; both now render the unified module. */}
        <Route path="/departments" element={<ProtectedRoute role="hr"><Organization /></ProtectedRoute>} />
        <Route path="/designations" element={<ProtectedRoute role="hr"><Organization /></ProtectedRoute>} />
        {/* Unified Work Assignment Management module - both legacy routes
            render the same tabbed page so existing deep links keep working. */}
        <Route path="/assignments" element={<ProtectedRoute role="hr"><WorkAssignments /></ProtectedRoute>} />
        <Route path="/templates" element={<ProtectedRoute role="hr"><WorkAssignments /></ProtectedRoute>} />
        <Route path="/backlog" element={<ProtectedRoute role="hr"><GlobalBacklog /></ProtectedRoute>} />
        <Route path="/reviews" element={<ProtectedRoute role="hr"><SubmissionReviews /></ProtectedRoute>} />
        <Route path="/sent-alerts" element={<ProtectedRoute role="hr"><SentAlerts /></ProtectedRoute>} />
        <Route path="/reset-requests" element={<ProtectedRoute role="hr"><ResetRequests /></ProtectedRoute>} />

        {/* Super Admin only */}
        <Route path="/hr-management" element={<ProtectedRoute role="super_admin"><HRManagement /></ProtectedRoute>} />
        <Route path="/manage-access" element={<ProtectedRoute role="super_admin"><ManageAccess /></ProtectedRoute>} />
        <Route path="/audit" element={<ProtectedRoute role="super_admin"><AuditLog /></ProtectedRoute>} />
        <Route path="/performance" element={<ProtectedRoute role="hr"><Performance /></ProtectedRoute>} />
        <Route path="/leaves" element={<ProtectedRoute role="hr"><HRLeaves /></ProtectedRoute>} />
        <Route path="/attendance" element={<ProtectedRoute role="hr"><EmployeeAttendance /></ProtectedRoute>} />
        <Route path="/holidays" element={<ProtectedRoute role="hr"><HRHolidays /></ProtectedRoute>} />
        <Route path="/salary" element={<ProtectedRoute role="hr"><HRSalary /></ProtectedRoute>} />

        {/* HOD (Head of Department) routes - employee + isHOD */}
        <Route path="/team" element={<ProtectedRoute hod><HODEmployees /></ProtectedRoute>} />
        <Route path="/team-reviews" element={<ProtectedRoute hod><HODReviews /></ProtectedRoute>} />

        {/* Employee routes */}
        <Route path="/my-attendance" element={<ProtectedRoute><MyAttendance /></ProtectedRoute>} />
        <Route path="/my-leaves" element={<ProtectedRoute><MyLeaves /></ProtectedRoute>} />
        <Route path="/my-salary" element={<ProtectedRoute><MySalary /></ProtectedRoute>} />
        <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
        <Route path="/contacts" element={<ProtectedRoute><Contacts /></ProtectedRoute>} />
        <Route path="/events" element={<ProtectedRoute><EventsCalendar /></ProtectedRoute>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
