const router = require('express').Router();
const { protect, requireAnalyticsAccess, authorize } = require('../middleware/auth');
const c = require('../controllers/templateAnalyticsController');

router.use(protect);

// Sidebar / picker list -- one row per analytics-eligible template.
// HOD scope clamp lives inside the controller.
router.get('/',           requireAnalyticsAccess, c.list);
// Phase 41.2 -- bulk-hide BEFORE the param-suffixed routes so
// '/hide-bulk' isn't matched as a templateId.
router.post('/hide-bulk',  authorize('hr'), c.removeBulk);
// Generate the full payload for one template.
router.get('/:templateId', requireAnalyticsAccess, c.generate);
// Phase 41.2 -- delete (hide) one template's analytics entry.  HR + SA
// only; the controller enforces the same gate defensively.
router.delete('/:templateId', authorize('hr'), c.remove);

module.exports = router;
