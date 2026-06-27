const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/departmentController');

// Phase 44.3 -- HR + Super Admin OR employee with `departments` permission.
const gate = requireRoleOrFeature('hr', 'departments');

router.use(protect);
router.get('/org-structure', gate, c.orgStructure);
router.get('/', c.list);
router.post('/', gate, c.create);
router.put('/:id', gate, c.update);
router.delete('/:id', gate, c.remove);

module.exports = router;
