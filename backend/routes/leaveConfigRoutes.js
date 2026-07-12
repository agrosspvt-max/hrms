/**
 * Phase 62 -- Leave Configuration routes (org-wide settings).
 */
const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/leaveConfigController');

router.use(protect);

router.get('/', c.get);
router.put('/', c.update);

module.exports = router;
