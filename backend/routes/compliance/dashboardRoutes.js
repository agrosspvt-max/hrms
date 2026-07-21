const router = require('express').Router();
const { protect } = require('../../middleware/auth');
const d = require('../../controllers/compliance/dashboardController');

router.use(protect);

router.get('/dashboard/summary',            d.summary);
router.get('/dashboard/most-penalised',     d.mostPenalised);
router.get('/dashboard/common-violations',  d.commonViolations);
router.get('/dashboard/pending-waivers',    d.pendingWaivers);
router.get('/dashboard/financial-totals',   d.financialTotals);
router.get('/dashboard/trends',             d.trends);

module.exports = router;
