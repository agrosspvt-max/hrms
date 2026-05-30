const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/eventController');

router.use(protect);

// Read endpoints: any authenticated user.
router.get('/', c.list);
router.get('/upcoming', c.upcoming);
router.get('/birthdays/today', c.birthdaysToday);
router.get('/analytics', authorize('hr'), c.analytics);
router.get('/:id', c.get);

// Idempotent notification firing — dashboards call this on load so birthday
// + event reminders are delivered without a separate cron service.
router.post('/process-due', c.processDue);

// HR / Super Admin manage events.
router.post('/', authorize('hr'), c.create);
router.put('/:id', authorize('hr'), c.update);
router.delete('/:id', authorize('hr'), c.remove);

module.exports = router;
