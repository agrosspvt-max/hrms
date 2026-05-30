const router = require('express').Router();
const { login, me, changePassword } = require('../controllers/authController');
const { protect } = require('../middleware/auth');

router.post('/login', login);
router.get('/me', protect, me);
router.post('/change-password', protect, changePassword);

module.exports = router;
