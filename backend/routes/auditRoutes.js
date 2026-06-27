const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/auditController');

// Phase 44.3 -- Super Admin OR employee with `auditLog` permission.
router.use(protect);
router.use(requireRoleOrFeature('super_admin', 'auditLog'));
router.get('/', c.list);

module.exports = router;
