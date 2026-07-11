const router = require('express').Router();
const { protect, authorize, requireAnalyticsAccess, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/dashboardController');
const analytics = require('../controllers/analyticsController');

// Phase 44.3 -- per-feature gates for grantable endpoints.
const backlogGate     = requireRoleOrFeature('hr', 'globalPendency');
const assignmentsGate = requireRoleOrFeature('hr', 'assignments');

router.use(protect);

router.get('/employee/summary', c.employeeSummary);

router.get('/hr/today', authorize('hr'), c.hrToday);
router.get('/hr/backlog', backlogGate, c.hrBacklog);
router.get('/hr/performance', authorize('hr'), c.hrPerformance);
// Pendency + Completion analytics: HR / Super Admin see everything,
// HOD is auto-clamped to their own department inside the controller.
router.get('/hr/pendency',   requireAnalyticsAccess, analytics.pendency);
router.get('/hr/completion', requireAnalyticsAccess, analytics.completion);
// Phase 57 -- populated-only scope-value lists for the Pendency /
// Completion "Analytics Scope" dropdown redesign.  Returns employees,
// templates, departments, designations that actually have submissions
// in the current period so dropdowns never contain dead options.
router.get('/hr/scope-options', requireAnalyticsAccess, analytics.scopeOptions);
router.get('/hr/assignment-analytics', assignmentsGate, analytics.assignmentAnalytics);
router.get('/hr/summary', authorize('hr'), c.hrSummary);

// Calling Analytics (HR / SA / HOD; the controller enforces the
// per-role employee-scope, including the HOD's department clamp).
router.get('/calling/analytics', requireAnalyticsAccess, analytics.callingAnalytics);
// Phase 24 -- xlsx export of the same dataset.  Same role gate, same
// scoping, same calculations as the JSON endpoint above.
router.get('/calling/analytics/export', requireAnalyticsAccess, analytics.exportCallingAnalytics);
// Phase 56 -- roster for the Employee dropdown on the Calling tab.
// Returns only employees who either submitted calling work in range
// OR are assigned to a calling template.  Kept lightweight so the
// dropdown can refresh on every range change without cost.
router.get('/calling/roster', requireAnalyticsAccess, analytics.callingRoster);
// Employee self-view of their own calling KPIs.
router.get('/calling/mine', analytics.myCallingAnalytics);

module.exports = router;
