const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/featurePermissionsController');

// All routes HR + Super Admin only.  The controller mirrors the gate
// defensively so the audit log entries can't be forged by a route
// misconfiguration.
router.use(protect);
router.use(authorize('hr'));

router.get('/employees', c.listEmployees);
router.get('/:id', c.getOne);
router.put('/:id', c.update);
router.post('/:id/copy-from/:sourceId', c.copyFrom);
router.post('/:id/reset', c.reset);

module.exports = router;
