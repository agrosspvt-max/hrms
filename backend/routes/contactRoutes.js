const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/contactController');

router.use(protect);

// Everyone authenticated: browse + favorites + view tracking + analytics (HR).
router.get('/export.csv', authorize('hr'), c.exportCsv);
router.get('/analytics', authorize('hr'), c.analytics);
router.get('/favorites', c.myFavorites);
router.get('/', c.list);
router.get('/:id', c.get);
router.post('/:id/view', c.view);
router.post('/:id/favorite', c.favorite);
router.delete('/:id/favorite', c.unfavorite);

// HR + Super Admin manage the directory.
router.post('/', authorize('hr'), c.create);
router.put('/:id', authorize('hr'), c.update);
router.patch('/:id/status', authorize('hr'), c.toggleStatus);
router.delete('/:id', authorize('hr'), c.remove);

module.exports = router;
