const router = require('express').Router();
const multer = require('multer');
const { protect, authorize } = require('../middleware/auth');
const c = require('../controllers/productController');
const d = require('../controllers/dealerController');

// In-memory upload for bulk Excel imports.  5 MB cap is plenty for
// thousands of product rows and avoids any disk persistence.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(protect);

// Read endpoints: all authenticated users (employees need the dropdown).
router.get('/products',   c.listProducts);
router.get('/quantities', c.listQuantities);

// Sample + export downloads (HR / SA).  These are GETs so the existing
// authUrl() helper (query-string token) works for anchor downloads.
router.get('/products/import-sample', authorize('hr'), c.importSample);
router.get('/products/export',        authorize('hr'), c.exportProducts);

// Bulk import (HR / SA, multipart upload field name "file").
router.post('/products/import', authorize('hr'), upload.single('file'), c.importBulk);

// Write endpoints: HR / Super Admin only.
router.post('/products',           authorize('hr'), c.createProduct);
router.put('/products/:id',        authorize('hr'), c.updateProduct);
router.delete('/products/:id',     authorize('hr'), c.deactivateProduct);
router.post('/quantities',         authorize('hr'), c.createQuantity);
router.put('/quantities/:id',      authorize('hr'), c.updateQuantity);
router.delete('/quantities/:id',   authorize('hr'), c.deactivateQuantity);

// Dealer Master.  Reads open to any authenticated user (employees need
// the dropdown when filing a Farmer Record); writes HR / Super Admin only.
router.get('/dealers',         d.listDealers);
router.post('/dealers',        authorize('hr'), d.createDealer);
router.put('/dealers/:id',     authorize('hr'), d.updateDealer);
router.delete('/dealers/:id',  authorize('hr'), d.deactivateDealer);

module.exports = router;
