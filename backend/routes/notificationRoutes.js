const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/notificationController');

// Phase 44.3 -- HR + Super Admin OR employee with `sendAlerts` permission.
const sendGate = requireRoleOrFeature('hr', 'sendAlerts');

router.use(protect);

// Employee inbox
router.get('/mine', c.myInbox);
// Phase 45 -- Priority Notices (Important + Urgent) for the Employee
// Dashboard collapsible panel.  Same read-receipt endpoint powers read,
// dedicated dismiss-dashboard / resolve endpoints handle the rest.
router.get('/priority', c.myPriority);
router.get('/unread-count', c.unreadCount);
router.patch('/read-all', c.markAllRead);
router.patch('/:id/read', c.markRead);
// Phase 46 -- time-bound resolve.  Distinct from `read`; the controller
// rejects non-urgent notices so the action is unambiguous.
router.post('/:id/resolve', c.resolve);
// Phase 46 -- dashboard-only dismissal.  Hides the notice from the
// Dashboard panel; the underlying Notification stays in the inbox as
// permanent proof of delivery.
router.post('/:id/dismiss-dashboard', c.dismissDashboard);
// Phase 46 -- the legacy DELETE endpoint now refuses for employees
// (returns 403 with a helpful message).  Super Admin retained for
// admin-tool use only.
router.delete('/:id', c.remove);

// HR sending -- also granted by `sendAlerts` feature permission.
router.post('/', sendGate, c.send);
router.get('/sent', sendGate, c.sentByMe);

module.exports = router;
