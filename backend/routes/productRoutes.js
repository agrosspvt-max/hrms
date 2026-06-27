const router = require('express').Router();
const multer = require('multer');
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');

// Phase 44.3 -- HR + Super Admin OR employee with `products` permission.
const gate = requireRoleOrFeature('hr', 'products');
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
router.get('/products/import-sample', gate, c.importSample);
router.get('/products/export',        gate, c.exportProducts);

// Bulk import (HR / SA, multipart upload field name "file").
router.post('/products/import', gate, upload.single('file'), c.importBulk);

// Write endpoints: HR / Super Admin only.
router.post('/products',           gate, c.createProduct);
router.put('/products/:id',        gate, c.updateProduct);
router.delete('/products/:id',     gate, c.deactivateProduct);
router.post('/quantities',         gate, c.createQuantity);
router.put('/quantities/:id',      gate, c.updateQuantity);
router.delete('/quantities/:id',   gate, c.deactivateQuantity);

// Dealer Master.  Reads open to any authenticated user (employees need
// the dropdown when filing a Farmer Record); writes HR / Super Admin only.
router.get('/dealers',         d.listDealers);
// Bulk: download sample + export full catalogue (HR / SA).  GETs so the
// existing authUrl() anchor-download helper works.
router.get('/dealers/import-sample', gate, d.importSample);
router.get('/dealers/export',        gate, d.exportDealers);
// Bulk import (HR / SA, multipart "file").  Reuses the Products multer
// instance defined at the top of this file (memory storage, 5 MB cap).
router.post('/dealers/import',  gate, upload.single('file'), d.importBulk);
router.post('/dealers',         gate, d.createDealer);
router.put('/dealers/:id',      gate, d.updateDealer);
router.delete('/dealers/:id',   gate, d.deactivateDealer);

module.exports = router;
