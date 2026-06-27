const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/leaveController');

// Phase 44.3 -- HR + Super Admin OR employee with `leaveApprovals` permission.
// Extends (does not replace) the existing HR-only gate; underlying leave
// workflow, balance accounting, and notifications are unchanged.
const gate = requireRoleOrFeature('hr', 'leaveApprovals');

router.use(protect);

router.get('/mine', c.myLeaves);
router.post('/', c.apply);

router.get('/', gate, c.listAll);
router.get('/calendar', gate, c.calendar);
router.patch('/:id/decision', gate, c.decide);
router.post('/:id/revoke',    gate, c.revoke);
router.put('/balance/:id', gate, c.setBalance);

module.exports = router;
