const router = require('express').Router();
const multer = require('multer');
const { protect, authorize, requireHOD, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/employeeController');

// Phase 44.4 -- Employee directory read.  Several feature pages (Attendance,
// Salary, Submission Reviews, Assignments, Leave Approvals, Send Alerts,
// Performance, Template Analytics, Contacts) need to populate an employee
// picker.  Any user who holds *any* of those grants -- or HR / Super Admin
// -- may list employees.  Write endpoints stay HR-only via router.use(authorize('hr')).
const directoryGate = requireRoleOrFeature('hr', [
  'attendance',
  'salary',
  'submissionReviews',
  'assignments',
  'leaveApprovals',
  'sendAlerts',
  'performance',
  'templateAnalytics',
  'contacts',
  'submissionControl',
  'globalPendency',
  'departments',
]);

// In-memory upload for bulk Excel imports.  5 MB cap is plenty for
// thousands of employee rows in xlsx and avoids any disk persistence.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(protect);

// HOD-only: read-only view of their department team (must be declared
// before the HR gate below so HOD employees can reach it).
router.get('/team', requireHOD, c.teamList);

// Phase 44.4 -- directory list is allowed to feature-granted employees
// so the various module pickers can populate.  Declared BEFORE the
// HR-only blanket gate below so write endpoints continue to require HR.
router.get('/', directoryGate, c.listEmployees);

router.use(authorize('hr'));

router.get('/export.csv', c.exportCsv);
router.get('/import-template', c.importTemplate);
router.post('/import', upload.single('file'), c.importBulk);
router.post('/bulk-action', c.bulkAction);
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
