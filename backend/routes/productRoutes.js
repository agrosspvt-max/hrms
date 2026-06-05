const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/productController');

router.use(protect);

// Read endpoints: all authenticated users (employees need the dropdown).
router.get('/products',   c.listProducts);
router.get('/quantities', c.listQuantities);

// Write endpoints: HR / Super Admin only.
router.post('/products',           authorize('hr'), c.createProduct);
router.put('/products/:id',        authorize('hr'), c.updateProduct);
router.delete('/products/:id',     authorize('hr'), c.deactivateProduct);
router.post('/quantities',         authorize('hr'), c.createQuantity);
router.put('/quantities/:id',      authorize('hr'), c.updateQuantity);
router.delete('/quantities/:id',   authorize('hr'), c.deactivateQuantity);

module.exports = router;
