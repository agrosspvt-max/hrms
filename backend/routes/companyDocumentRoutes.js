/**
 * companyDocumentRoutes.js -- CRUD for the Company Documents library.
 *
 * Read endpoints are open to every authenticated user; the controller
 * scopes the result set for non-admins.  Write endpoints are HR +
 * Super Admin only.
 *
 * File upload: multer memoryStorage capped at 10 MB.  Mimetype is
 * checked in the controller so we can return an actionable 400 rather
 * than a multer-level rejection.
 */
const router = require('express').Router();
const multer = require('multer');
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/companyDocumentController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(protect);

// Read -- any authenticated user.  Controller enforces visibility.
router.get('/',                c.list);
router.get('/:id/inline',      c.inline);

// Write -- HR + Super Admin only.
const adminOnly = authorize('hr');
router.post('/',               adminOnly, upload.single('file'), c.upload);
router.patch('/:id',           adminOnly, c.update);
router.put('/:id/file',        adminOnly, upload.single('file'), c.replaceFile);
router.delete('/:id',          adminOnly, c.remove);

module.exports = router;
