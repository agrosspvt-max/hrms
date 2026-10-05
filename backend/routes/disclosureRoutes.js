const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/disclosureController');

router.use(protect);

// Employee (any authenticated account) files / reads their OWN disclosure.
// The controller always scopes to req.user._id.
router.post('/', c.saveMine);
router.get('/mine', c.getMine);

// HR + Super Admin management listing (authorize('hr') admits super_admin).
router.get('/', authorize('hr'), c.list);

module.exports = router;
