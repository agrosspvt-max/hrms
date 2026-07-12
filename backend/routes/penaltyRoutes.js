/**
 * Phase 61 -- Fines & Penalties routes.
 *
 * Auth model:
 *   - Every route requires an authenticated user (protect).
 *   - /mine + /:id/acknowledge are the employee endpoints.
 *   - Dashboard + analytics scope is decided inside the controller
 *     based on role.
 *   - Manual create / cancel are HR / Super Admin only.
 *   - HOD may reach dashboard + analytics ONLY when HR grants them
 *     the 'penalties' feature-permission.
 */
const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/penaltyController');

router.use(protect);

// Employee-facing
router.get('/mine', c.mine);
router.post('/:id/acknowledge', c.acknowledge);

// HR / SA / permitted HOD
router.get('/dashboard', c.dashboard);
router.get('/analytics/summary', c.analyticsSummary);

// HR / SA only (controller enforces via role check)
router.post('/manual', c.createManual);
router.post('/:id/cancel', c.cancel);

module.exports = router;
