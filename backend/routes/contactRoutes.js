const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/contactController');

// Phase 44.3 -- HR + Super Admin OR employee with `contacts` permission.
const gate = requireRoleOrFeature('hr', 'contacts');

router.use(protect);

// Everyone authenticated: browse + favorites + view tracking + analytics (HR).
router.get('/export.csv', gate, c.exportCsv);
router.get('/analytics', gate, c.analytics);
router.get('/favorites', c.myFavorites);
router.get('/', c.list);
router.get('/:id', c.get);
router.post('/:id/view', c.view);
router.post('/:id/favorite', c.favorite);
router.delete('/:id/favorite', c.unfavorite);

// HR + Super Admin manage the directory.
router.post('/', gate, c.create);
router.put('/:id', gate, c.update);
router.patch('/:id/status', gate, c.toggleStatus);
router.delete('/:id', gate, c.remove);

module.exports = router;
