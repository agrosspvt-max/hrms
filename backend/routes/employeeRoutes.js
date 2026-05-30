const router = require('express').Router();
const { protect, authorize, requireHOD } = require('../middleware/auth');
const c = require('../controllers/employeeController');

router.use(protect);

// HOD-only: read-only view of their department team (must be declared
// before the HR gate below so HOD employees can reach it).
router.get('/team', requireHOD, c.teamList);

router.use(authorize('hr'));

router.get('/export.csv', c.exportCsv);
router.get('/', c.listEmployees);
router.get('/:id', c.getEmployee);
router.get('/:id/work-history', c.workHistory);
router.get('/:id/attendance', c.attendanceSummary);
router.get('/:id/leaves', c.leaveHistory);
router.post('/', c.createEmployee);
router.put('/:id', c.updateEmployee);
router.delete('/:id', c.deleteEmployee);
router.patch('/:id/status', c.toggleStatus);
router.post('/:id/reset-password', c.resetPassword);
router.post('/:id/increments', c.addIncrement);
router.put('/:id/increments/:incId', c.editIncrement);
router.delete('/:id/increments/:incId', c.deleteIncrement);

module.exports = router;
