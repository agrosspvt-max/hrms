const router = require('express').Router();
const multer = require('multer');
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/leaveController');
// Phase 54 -- supporting documents (medical certs, wedding invites,
// etc.).  Lives in its own controller + collection so the existing
// leave workflow, balances, and notifications are untouched.
const att = require('../controllers/leaveAttachmentController');

// Phase 44.3 -- HR + Super Admin OR employee with `leaveApprovals` permission.
// Extends (does not replace) the existing HR-only gate; underlying leave
// workflow, balance accounting, and notifications are unchanged.
const gate = requireRoleOrFeature('hr', 'leaveApprovals');

// Phase 54 -- multer for supporting-document uploads.  Memory storage
// so we never persist temp files to disk; 10 MB per file per spec;
// allowlist filter mirrors the server-side validation in
// leaveAttachmentController.  Rejected files short-circuit BEFORE the
// route handler runs, so the controller only sees pre-vetted rows.
const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: att.MAX_BYTES, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (att.ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    return cb(new Error(`Unsupported file type: ${file.originalname}. Allowed: ${att.ALLOWED_LABELS}.`));
  },
});

router.use(protect);

// ---- Phase 54: attachments.  Declared BEFORE `/:id` param routes
// so 'attachments' never collides with a leave id parse. ----
router.post('/attachments',           uploadMw.array('files', 20), att.upload);
router.get('/:leaveId/attachments',   att.listForLeave);
router.get('/attachments/:id',        att.getMeta);
router.get('/attachments/:id/download', att.download);
router.get('/attachments/:id/inline',   att.inline);

router.get('/mine', c.myLeaves);
router.post('/', c.apply);

router.get('/', gate, c.listAll);
router.get('/calendar', gate, c.calendar);
router.patch('/:id/decision', gate, c.decide);
router.post('/:id/revoke',    gate, c.revoke);
router.put('/balance/:id', gate, c.setBalance);

module.exports = router;
