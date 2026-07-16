const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/complianceController');

router.use(protect);

// Phase-1 architecture: the compliance engine used to run inside
// GET /api/submissions/today.  It now runs only via the scheduler +
// this explicit action endpoint so read handlers stay pure.
router.post('/refresh',     c.refresh);
router.post('/refresh/all', c.refreshAll);

module.exports = router;
