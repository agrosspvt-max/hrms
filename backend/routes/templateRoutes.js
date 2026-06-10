const router = require('express').Router();
const multer = require('multer');
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/templateController');

// In-memory upload, capped at 5 MB.  We never persist the file - we
// only need its parsed structure.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(protect);
router.get('/', c.list);
router.post('/excel/parse', authorize('hr'), upload.single('file'), c.excelParse);
router.post('/sheet/parse', authorize('hr'), upload.single('file'), c.sheetParse);
router.get('/:id', c.get);
router.post('/', authorize('hr'), c.create);
router.put('/:id', authorize('hr'), c.update);
router.delete('/:id', authorize('hr'), c.remove);
// Phase 12: clone a template (duplicates fields + sub-templates + metadata).
router.post('/:id/clone', authorize('hr'), c.clone);

module.exports = router;
