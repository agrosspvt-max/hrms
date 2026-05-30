const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/dashboardController');
const analytics = require('../controllers/analyticsController');

router.use(protect);

router.get('/employee/summary', c.employeeSummary);

router.get('/hr/today', authorize('hr'), c.hrToday);
router.get('/hr/backlog', authorize('hr'), c.hrBacklog);
router.get('/hr/performance', authorize('hr'), c.hrPerformance);
router.get('/hr/pendency', authorize('hr'), analytics.pendency);
router.get('/hr/completion', authorize('hr'), analytics.completion);
router.get('/hr/assignment-analytics', authorize('hr'), analytics.assignmentAnalytics);
router.get('/hr/summary', authorize('hr'), c.hrSummary);

module.exports = router;
