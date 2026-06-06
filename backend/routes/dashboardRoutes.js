const router = require('express').Router();
const { protect, authorize, requireAnalyticsAccess } = require('../middleware/auth');
const c = require('../controllers/dashboardController');
const analytics = require('../controllers/analyticsController');

router.use(protect);

router.get('/employee/summary', c.employeeSummary);

router.get('/hr/today', authorize('hr'), c.hrToday);
router.get('/hr/backlog', authorize('hr'), c.hrBacklog);
router.get('/hr/performance', authorize('hr'), c.hrPerformance);
// Pendency + Completion analytics: HR / Super Admin see everything,
// HOD is auto-clamped to their own department inside the controller.
router.get('/hr/pendency',   requireAnalyticsAccess, analytics.pendency);
router.get('/hr/completion', requireAnalyticsAccess, analytics.completion);
router.get('/hr/assignment-analytics', authorize('hr'), analytics.assignmentAnalytics);
router.get('/hr/summary', authorize('hr'), c.hrSummary);

// Calling Analytics (HR / SA / HOD; the controller enforces the
// per-role employee-scope, including the HOD's department clamp).
router.get('/calling/analytics', requireAnalyticsAccess, analytics.callingAnalytics);
// Employee self-view of their own calling KPIs.
router.get('/calling/mine', analytics.myCallingAnalytics);

module.exports = router;
