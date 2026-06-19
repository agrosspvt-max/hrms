const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/attendanceConfirmationController');

router.use(protect);

// Employee endpoints
router.get('/today', c.todayMine);
router.post('/confirm', c.confirm);

// Reviewer endpoints (HR / Super Admin / scoped HOD).  The controller
// enforces the role gate so we don't duplicate the authorize() check
// here and accidentally drift from the controller's HOD-clamp logic.
router.get('/queue', c.queueForDay);
router.post('/:id/review', c.review);

module.exports = router;
