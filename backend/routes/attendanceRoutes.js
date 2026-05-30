const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/attendanceController');

router.use(protect);
router.get('/mine', c.mine);
router.get('/employee/:id', authorize('hr'), c.ofEmployee);

// HR manual attendance override (set / clear a single day's status).
router.put('/employee/:id/status', authorize('hr'), c.setStatus);
router.delete('/employee/:id/status', authorize('hr'), c.clearStatus);

module.exports = router;
