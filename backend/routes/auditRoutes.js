const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/auditController');

router.use(protect, authorize('super_admin'));
router.get('/', c.list);

module.exports = router;
