const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/notificationController');

router.use(protect);

// Employee inbox
router.get('/mine', c.myInbox);
router.get('/unread-count', c.unreadCount);
router.patch('/read-all', c.markAllRead);
router.patch('/:id/read', c.markRead);
router.delete('/:id', c.remove);

// HR sending
router.post('/', authorize('hr'), c.send);
router.get('/sent', authorize('hr'), c.sentByMe);

module.exports = router;
