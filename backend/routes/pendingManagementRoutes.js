const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/pendingManagementController');

router.use(protect);

// Both handlers do their own role check (super_admin + hr) so a
// controller-level bypass is a single point of enforcement.
router.get('/:employeeId',         c.list);
router.post('/:employeeId/resolve', c.resolve);

module.exports = router;
