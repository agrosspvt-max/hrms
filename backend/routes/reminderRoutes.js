const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/reminderController');

router.use(protect);

// Employee reads own reminders + acts on them.
router.get('/mine',            c.mine);
router.patch('/:id/done',      c.done);
router.patch('/:id/dismiss',   c.dismiss);
router.patch('/:id/snooze',    c.snooze);

// HR / Super Admin write path.
router.post('/',               c.create);
router.patch('/:id',           c.update);
router.post('/:id/cancel',     c.cancel);
router.post('/:id/complete',   c.complete);

module.exports = router;
