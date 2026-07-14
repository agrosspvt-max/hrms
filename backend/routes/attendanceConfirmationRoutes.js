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
// Legacy confirmation-only path (Phase 29).  Kept for backward
// compatibility; the Attendance Review UI uses /act + /bulk-act
// instead so HR can also act on unconfirmed employees + revoke.
router.post('/:id/review', c.review);
// Phase 67 -- unified Attendance Review actions.  /act edits or
// revokes a single (employee, date); /bulk-act applies the same
// action to many employees on one date.  Both reuse the exact
// leave-accounting math of the HR manual override path.
router.post('/act',       c.actOne);
router.post('/bulk-act',  c.bulkAct);

module.exports = router;
