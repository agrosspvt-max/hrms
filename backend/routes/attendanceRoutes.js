const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/attendanceController');

// Phase 44.3 -- migrate every HR-only attendance endpoint to
// requireRoleOrFeature so an employee granted the `attendance` feature
// permission can access the full Attendance module.  HR + Super Admin
// behaviour is unchanged.
const attGate = requireRoleOrFeature('hr', 'attendance');

router.use(protect);
router.get('/mine', c.mine);
router.get('/employee/:id', attGate, c.ofEmployee);

// HR manual attendance override (set / clear a single day's status).
router.put('/employee/:id/status', attGate, c.setStatus);
router.delete('/employee/:id/status', attGate, c.clearStatus);

// Bulk attendance override (HR / Super Admin): same per-row leave
// accounting + audit log as the single endpoint.
router.post('/bulk', attGate, c.bulkSetStatus);

// Phase 29.4: date-range bulk attendance with conflict detection.
router.post('/bulk-range/preview', attGate, c.bulkRangePreview);
router.post('/bulk-range/apply',   attGate, c.bulkRangeApply);

module.exports = router;
