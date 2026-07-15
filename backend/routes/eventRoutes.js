const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/eventController');

// Phase 44.3 -- HR + Super Admin OR employee with `eventsHolidays` permission.
const gate = requireRoleOrFeature('hr', 'eventsHolidays');

router.use(protect);

// Read endpoints: any authenticated user.
router.get('/', c.list);
router.get('/upcoming', c.upcoming);
router.get('/birthdays/today', c.birthdaysToday);
router.get('/analytics', gate, c.analytics);
router.get('/:id', c.get);

// Phase 45 disabled birthday / event reminder notifications; Phase 73
// removed the dead processDue scaffold and its /events/process-due
// route.  Notifications are intentionally OFF for this module -- the
// resolver has no notify side-effects.

// HR / Super Admin manage events.
router.post('/', gate, c.create);
router.put('/:id', gate, c.update);
router.delete('/:id', gate, c.remove);

module.exports = router;
