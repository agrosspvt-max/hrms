const router = require('express').Router();
const { protect, requireAnalyticsAccess } = require('../middleware/auth');
const c = require('../controllers/templateAnalyticsController');

router.use(protect);

// Sidebar / picker list -- one row per analytics-eligible template.
// HOD scope clamp lives inside the controller.
router.get('/',           requireAnalyticsAccess, c.list);
// Generate the full payload for one template.
router.get('/:templateId', requireAnalyticsAccess, c.generate);

module.exports = router;
