const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/notificationController');

// Phase 44.3 -- HR + Super Admin OR employee with `sendAlerts` permission.
const sendGate = requireRoleOrFeature('hr', 'sendAlerts');

router.use(protect);

// Employee inbox
router.get('/mine', c.myInbox);
// Phase 45 -- Priority Notices (Important + Urgent) for the Employee
// Dashboard collapsible panel.  Same read-receipt + delete endpoints
// power read/clear, this is just a filtered list.
router.get('/priority', c.myPriority);
router.get('/unread-count', c.unreadCount);
router.patch('/read-all', c.markAllRead);
router.patch('/:id/read', c.markRead);
router.delete('/:id', c.remove);

// HR sending -- also granted by `sendAlerts` feature permission.
router.post('/', sendGate, c.send);
router.get('/sent', sendGate, c.sentByMe);

module.exports = router;
