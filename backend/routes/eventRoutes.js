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

// Idempotent notification firing — dashboards call this on load so birthday
// + event reminders are delivered without a separate cron service.
router.post('/process-due', c.processDue);

// HR / Super Admin manage events.
router.post('/', gate, c.create);
router.put('/:id', gate, c.update);
router.delete('/:id', gate, c.remove);

module.exports = router;
