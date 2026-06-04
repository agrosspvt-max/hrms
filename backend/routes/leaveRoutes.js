const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/leaveController');

router.use(protect);

router.get('/mine', c.myLeaves);
router.post('/', c.apply);

router.get('/', authorize('hr'), c.listAll);
router.get('/calendar', authorize('hr'), c.calendar);
router.patch('/:id/decision', authorize('hr'), c.decide);
router.post('/:id/revoke',    authorize('hr'), c.revoke);
router.put('/balance/:id', authorize('hr'), c.setBalance);

module.exports = router;
