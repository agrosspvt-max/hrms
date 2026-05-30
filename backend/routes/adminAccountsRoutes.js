const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/employeeController');

// Super Admin only - this powers the Manage Access dashboard.
router.use(protect, authorize('super_admin'));

router.get('/', c.adminAccounts);

module.exports = router;
