const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/salaryController');

// Phase 44.3 -- HR + Super Admin OR employee with `salary` permission.
const gate = requireRoleOrFeature('hr', 'salary');

router.use(protect);

router.get('/mine', c.mySlips);
router.get('/:id/pdf', c.downloadPdf);

router.get('/export.csv', gate, c.exportCsv);
router.get('/', gate, c.listSlips);
router.post('/generate', gate, c.generate);
router.post('/generate-all', gate, c.generateAll);
router.patch('/:id', gate, c.updateSlip);
// Phase 32 — soft-delete retraction (HR / Super Admin only).
router.post('/:id/retract', gate, c.retract);
// Phase 34 — bulk retraction + bulk per-employee regeneration.
router.post('/retract-bulk', gate, c.bulkRetract);
router.post('/generate-bulk-selected', gate, c.bulkGenerateForEmployees);
// Phase 65 -- Salary Slip Publish workflow.
router.post('/publish', gate, c.publishSlips);

module.exports = router;
