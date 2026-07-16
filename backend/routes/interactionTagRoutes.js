const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/interactionTagController');

router.use(protect);

// Reads: any authenticated user (the tag picker appears wherever the
// mention / autocomplete UI is used).
router.get('/', c.list);

// Writes: HR + Super Admin only, per spec.
router.post('/',      authorize('hr', 'super_admin'), c.create);
router.put('/:id',    authorize('hr', 'super_admin'), c.update);
router.delete('/:id', authorize('hr', 'super_admin'), c.remove);

module.exports = router;
