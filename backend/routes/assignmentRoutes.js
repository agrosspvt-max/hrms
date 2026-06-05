const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/assignmentController');

router.use(protect, authorize('hr'));

router.get('/', c.list);
router.get('/:id/stats', c.stats);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/:id', c.remove);
router.post('/:id/revoke', c.revoke);

module.exports = router;
