const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/holidayController');

// Phase 44.3 -- HR + Super Admin OR employee with `eventsHolidays` permission.
const gate = requireRoleOrFeature('hr', 'eventsHolidays');

router.use(protect);

router.get('/', c.list);                               // everyone can read
router.post('/', gate, c.create);
router.put('/:id', gate, c.update);
router.delete('/:id', gate, c.remove);

module.exports = router;
