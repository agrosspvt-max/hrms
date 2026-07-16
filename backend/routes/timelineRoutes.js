const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/timelineController');

router.use(protect);

router.get('/mine',              c.mine);
router.get('/employee/:id',      c.forEmployee);

module.exports = router;
