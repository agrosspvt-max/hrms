const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/passwordResetController');

// PUBLIC endpoints (no auth)
router.post('/request', c.requestReset);
router.get('/validate', c.validateToken);
router.post('/reset', c.resetPassword);

// HR-only endpoints
router.get('/', protect, authorize('hr'), c.listRequests);
router.get('/pending-count', protect, authorize('hr'), c.pendingCount);
router.post('/:id/approve', protect, authorize('hr'), c.approve);
router.post('/:id/reject', protect, authorize('hr'), c.reject);

module.exports = router;
