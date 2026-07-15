const router = require('express').Router();
const { protect, requireAnalyticsAccess } = require('../middleware/auth');
const c = require('../controllers/dailySelfReviewController');

router.use(protect);

// Every endpoint reuses the existing analytics gate so HR / Super
// Admin / HOD / users with an analytics feature permission continue
// to see exactly what they can see on the other Performance tabs.
router.get('/overview',         requireAnalyticsAccess, c.overview);
// Phase 70 -- generic per-metric drill-down.  Feeds the DrillDownModal
// tables opened from every clickable card / chart cell on the tab.
router.get('/breakdown',        requireAnalyticsAccess, c.breakdown);
router.get('/employee/:id',     requireAnalyticsAccess, c.employeeDetail);
router.get('/ideas',            requireAnalyticsAccess, c.ideasLibrary);
router.get('/notes',            requireAnalyticsAccess, c.notesLibrary);
router.get('/export.csv',       requireAnalyticsAccess, c.exportCsv);

module.exports = router;
