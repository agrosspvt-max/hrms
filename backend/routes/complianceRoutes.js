const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/complianceController');

router.use(protect);

// Phase-1 architecture: the compliance engine used to run inside
// GET /api/submissions/today.  It now runs only via the scheduler +
// this explicit action endpoint so read handlers stay pure.
router.post('/refresh',     c.refresh);
router.post('/refresh/all', c.refreshAll);

// Compliance & Accountability v2 -- Phase 3 CRUD for ComplianceRule.
// Sub-router keeps the URL prefix /api/compliance/rules/* stable.
// Every handler inside is guarded by the `compliance.rules` feature
// flag and returns 404 when the flag is off, so mounting the sub-router
// on a production deploy with the flag off is a true no-op.
router.use('/rules', require('./compliance/ruleRoutes'));

// Phase 6 -- Incidents + Timeline routes.  Handlers gate on the
// `compliance.waiverRecovery` flag; when off the endpoints 404.
router.use('/', require('./compliance/incidentRoutes'));

// Phase 8 -- HR Compliance dashboard aggregations.  Gated by
// `compliance.dashboardV2`.
router.use('/', require('./compliance/dashboardRoutes'));

module.exports = router;
