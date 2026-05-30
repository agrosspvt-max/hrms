const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/dependencyController');

router.use(protect);

// Picker + personal inbox / outbox (any authenticated user)
router.get('/assignable', c.assignable);
router.get('/mine', c.mine);
router.get('/mine/count', c.mineCount);
router.get('/created', c.created);

// HR / Super Admin oversight (declared before '/:id/...').
router.get('/', authorize('hr'), c.listAll);
router.get('/chain/:chainId', authorize('hr'), c.chain);

// Owner (or HR) lifecycle actions
router.post('/:id/status', c.setStatus);
router.post('/:id/resolve', c.resolve);

module.exports = router;
