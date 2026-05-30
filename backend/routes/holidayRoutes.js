const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/holidayController');

router.use(protect);

router.get('/', c.list);                               // everyone can read
router.post('/', authorize('hr'), c.create);
router.put('/:id', authorize('hr'), c.update);
router.delete('/:id', authorize('hr'), c.remove);

module.exports = router;
