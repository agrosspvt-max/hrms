const router = require('express').Router();
const { protect, requireAnalyticsAccess, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/templateAnalyticsController');

// Phase 44.3 -- HR + Super Admin OR employee with `templateAnalytics`.
// Hide / delete still go through this gate; per-template filtering on
// `allowedTemplateIds` is enforced inside the controller (`_templateAnalyticsScope`).
const taGate = requireRoleOrFeature('hr', 'templateAnalytics');

router.use(protect);

// Sidebar / picker list -- one row per analytics-eligible template.
// HOD scope clamp lives inside the controller.
router.get('/',           requireAnalyticsAccess, c.list);
// Phase 41.2 -- bulk-hide BEFORE the param-suffixed routes so
// '/hide-bulk' isn't matched as a templateId.
router.post('/hide-bulk',  taGate, c.removeBulk);
// Phase 56 -- roster for the Employee dropdown on the Template
// Analytics page.  Returns only employees actually assigned this
// template.  Declared BEFORE '/:templateId' so the trailing segment
// isn't swallowed by the generate route's param parser.
router.get('/:templateId/assigned-employees', requireAnalyticsAccess, c.assignedEmployees);
// Generate the full payload for one template.
router.get('/:templateId', requireAnalyticsAccess, c.generate);
// Phase 41.2 -- delete (hide) one template's analytics entry.  Gated by
// the same Template Analytics feature; controller filters by allowedTemplateIds.
router.delete('/:templateId', taGate, c.remove);

module.exports = router;
