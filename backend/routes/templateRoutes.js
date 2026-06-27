const router = require('express').Router();
const multer = require('multer');
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');

// Phase 44.3 -- HR + Super Admin OR employee with `assignments` permission.
const gate = requireRoleOrFeature('hr', 'assignments');
const c = require('../controllers/templateController');

// In-memory upload, capped at 5 MB.  We never persist the file - we
// only need its parsed structure.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(protect);
router.get('/', c.list);
router.post('/excel/parse', gate, upload.single('file'), c.excelParse);
router.post('/sheet/parse', gate, upload.single('file'), c.sheetParse);
router.get('/:id', c.get);
router.post('/', gate, c.create);
router.put('/:id', gate, c.update);
router.delete('/:id', gate, c.remove);
// Phase 12: clone a template (duplicates fields + sub-templates + metadata).
router.post('/:id/clone', gate, c.clone);

module.exports = router;
