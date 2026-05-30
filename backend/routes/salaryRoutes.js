const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/salaryController');

router.use(protect);

router.get('/mine', c.mySlips);
router.get('/:id/pdf', c.downloadPdf);

router.get('/export.csv', authorize('hr'), c.exportCsv);
router.get('/', authorize('hr'), c.listSlips);
router.post('/generate', authorize('hr'), c.generate);
router.post('/generate-all', authorize('hr'), c.generateAll);
router.patch('/:id', authorize('hr'), c.updateSlip);

module.exports = router;
