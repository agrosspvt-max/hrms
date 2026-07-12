/**
 * Phase 62 -- Probation read-only endpoints.
 */
const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/probationController');

router.use(protect);

router.get('/mine', c.mine);
router.get('/employee/:id', c.ofEmployee);

module.exports = router;
