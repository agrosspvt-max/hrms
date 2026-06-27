const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/assignmentController');

// Phase 44.3 -- HR + Super Admin OR employee with `assignments` permission.
router.use(protect);
router.use(requireRoleOrFeature('hr', 'assignments'));

router.get('/', c.list);
router.get('/:id/stats', c.stats);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/:id', c.remove);
router.post('/:id/revoke', c.revoke);

module.exports = router;
