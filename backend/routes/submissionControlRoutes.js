const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/submissionControlController');

router.use(protect);
// Every endpoint is HR / Super Admin only.  `authorize('hr')` already
// admits Super Admin (super_admin is a superset role in this codebase).
router.use(authorize('hr'));

// Filter dropdown options for the page header.
router.get('/filter-options', c.filterOptions);

// Bulk actions FIRST so /:id doesn't shadow them.
router.post('/bulk/delete',     c.bulkDelete);
router.post('/bulk/restore',    c.bulkRestore);
router.post('/bulk/mark-test',  c.bulkMarkTest);

// Admin tool endpoints.
router.post('/rebuild-scores',         c.rebuildScores);
router.post('/rebuild-analytics',      c.rebuildAnalytics);
router.post('/rebuild-carry-forward',  c.rebuildCarryForward);

// Export (GET so the existing authUrl() anchor-download helper works).
router.get('/export', c.exportFiltered);

// Per-id CRUD-ish endpoints.
router.get('/:id',             c.get);
router.put('/:id',             c.update);
router.post('/:id/delete',     c.remove);
router.post('/:id/restore',    c.restore);
router.post('/:id/mark-test',  c.markTest);

// Paginated list -- comes last so /export, /bulk, etc. don't collide.
router.get('/', c.list);

module.exports = router;
