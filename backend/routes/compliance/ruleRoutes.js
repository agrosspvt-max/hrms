/**
 * ComplianceRule CRUD routes.  Mounted under /api/compliance/rules
 * from routes/complianceRoutes.js so the base URL prefix is preserved.
 */
const router = require('express').Router();
const { protect } = require('../../middleware/auth');
const c = require('../../controllers/compliance/ruleController');

router.use(protect);

router.get('/',           c.list);
router.get('/:id',        c.get);
router.post('/',          c.create);
router.patch('/:id',      c.update);
router.post('/:id/enable', c.enable);
router.post('/:id/disable', c.disable);
router.get('/:id/history', c.history);

module.exports = router;
