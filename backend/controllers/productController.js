const asyncHandler = require('express-async-handler');
const XLSX     = require('xlsx');
const Product  = require('../models/Product');
const Quantity = require('../models/Quantity');
const { logAudit } = require('../utils/audit');

/* ------------------------------------------------------------------ */
/* Product                                                            */
/* ------------------------------------------------------------------ */

// GET /api/products?activeOnly=true
const listProducts = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.activeOnly === 'true') where.active = true;
  if (req.query.unit) where.unit = req.query.unit;
  res.json(await Product.find(where).sort({ active: -1, name: 1 }));
});

// POST /api/products  (HR/SA)
const createProduct = asyncHandler(async (req, res) => {
  const { name, pricePerUnit, nbvPercentage, unit, description, active } = req.body;
  if (!name) { res.status(400); throw new Error('name is required'); }
  const exists = await Product.findOne({ name: name.trim() });
  if (exists) { res.status(400); throw new Error('A product with that name already exists'); }
  const p = await Product.create({
    name: name.trim(),
    pricePerUnit: Number(pricePerUnit) || 0,
    nbvPercentage: Math.max(0, Math.min(Number(nbvPercentage) || 0, 100)),
    unit: ['L', 'KG'].includes(unit) ? unit : 'L',
    description: description || '',
    active: active !== false,
  });
  logAudit(req, { action: 'product.create', targetType: 'Product', targetId: p._id, targetLabel: p.name, meta: { price: p.pricePerUnit, nbv: p.nbvPercentage, unit: p.unit } });
  res.status(201).json(p);
});

// PUT /api/products/:id  (HR/SA)
const updateProduct = asyncHandler(async (req, res) => {
  const p = await Product.findById(req.params.id);
  if (!p) { res.status(404); throw new Error('Product not found'); }
  const { name, pricePerUnit, nbvPercentage, unit, description, active } = req.body;
  if (name !== undefined) p.name = String(name).trim();
  if (pricePerUnit !== undefined) p.pricePerUnit = Number(pricePerUnit) || 0;
  if (nbvPercentage !== undefined) p.nbvPercentage = Math.max(0, Math.min(Number(nbvPercentage) || 0, 100));
  if (unit !== undefined && ['L', 'KG'].includes(unit)) p.unit = unit;
  if (description !== undefined) p.description = String(description);
  if (active !== undefined) p.active = !!active;
  await p.save();
  logAudit(req, { action: 'product.update', targetType: 'Product', targetId: p._id, targetLabel: p.name });
  res.json(p);
});

// DELETE /api/products/:id  (HR/SA) -- soft-deactivate to preserve history
const deactivateProduct = asyncHandler(async (req, res) => {
  const p = await Product.findById(req.params.id);
  if (!p) { res.status(404); throw new Error('Product not found'); }
  p.active = false;
  await p.save();
  logAudit(req, { action: 'product.deactivate', targetType: 'Product', targetId: p._id, targetLabel: p.name });
  res.json(p);
});

/* ------------------------------------------------------------------ */
/* Quantity                                                           */
/* ------------------------------------------------------------------ */

// GET /api/quantities?activeOnly=true&unit=L
const listQuantities = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.activeOnly === 'true') where.active = true;
  if (req.query.unit) where.unit = req.query.unit;
  res.json(await Quantity.find(where).sort({ unit: 1, value: 1 }));
});

// POST /api/quantities  (HR/SA)
const createQuantity = asyncHandler(async (req, res) => {
  const { label, value, unit, active, order } = req.body;
  if (!label) { res.status(400); throw new Error('label is required'); }
  if (value === undefined || value === null) { res.status(400); throw new Error('value is required'); }
  const u = ['L', 'KG'].includes(unit) ? unit : 'L';
  const dup = await Quantity.findOne({ label: String(label).trim(), unit: u });
  if (dup) { res.status(400); throw new Error('A quantity with that label already exists for this unit'); }
  const q = await Quantity.create({
    label: String(label).trim(),
    value: Math.max(0, Number(value) || 0),
    unit: u,
    active: active !== false,
    order: Number(order) || 0,
  });
  logAudit(req, { action: 'quantity.create', targetType: 'Quantity', targetId: q._id, targetLabel: q.label });
  res.status(201).json(q);
});

// PUT /api/quantities/:id  (HR/SA)
const updateQuantity = asyncHandler(async (req, res) => {
  const q = await Quantity.findById(req.params.id);
  if (!q) { res.status(404); throw new Error('Quantity not found'); }
  const { label, value, unit, active, order } = req.body;
  if (label !== undefined) q.label = String(label).trim();
  if (value !== undefined) q.value = Math.max(0, Number(value) || 0);
  if (unit !== undefined && ['L', 'KG'].includes(unit)) q.unit = unit;
  if (active !== undefined) q.active = !!active;
  if (order !== undefined) q.order = Number(order) || 0;
  await q.save();
  logAudit(req, { action: 'quantity.update', targetType: 'Quantity', targetId: q._id, targetLabel: q.label });
  res.json(q);
});

// DELETE /api/quantities/:id  (HR/SA) -- soft-deactivate
const deactivateQuantity = asyncHandler(async (req, res) => {
  const q = await Quantity.findById(req.params.id);
  if (!q) { res.status(404); throw new Error('Quantity not found'); }
  q.active = false;
  await q.save();
  logAudit(req, { action: 'quantity.deactivate', targetType: 'Quantity', targetId: q._id, targetLabel: q.label });
  res.json(q);
});

/* ============================================================
 * Product bulk-import (xlsx / csv) + sample download + export.
 * ============================================================ */

const SAMPLE_HEADER = ['Product Name', 'Unit', 'Price Per Unit', 'NBV %'];
const SAMPLE_ROWS = [
  ['JANTA GOLD', 'L',  2000, 25],
  ['ROTOMAXX',   'L',  1500, 20],
  ['HERCULES',   'KG', 100,  15],
];
const INSTRUCTIONS_LINES = [
  ['Product Bulk Import — Instructions'],
  [''],
  ['• Product Name is REQUIRED.  Duplicate Product Names update existing products (matched case-insensitively).'],
  ['• Unit must be exactly  L  or  KG  (case-insensitive in the file, normalised to uppercase on save).'],
  ['• Price Per Unit must be numeric and greater than 0 (₹ per Liter for L-products, ₹ per KG for KG-products).'],
  ['• NBV % must be numeric and between 0 and 100 inclusive.'],
  ['• Rows with empty Product Name or any invalid value are skipped.  A row-by-row error report is returned to the importer.'],
  ['• A successful import never deletes existing products.  To deactivate a product use the regular Products table.'],
  ['• The Products sheet is read; this Instructions sheet is ignored.'],
];

// GET /api/products/import-sample   (HR / SA, served via authUrl()).
const importSample = asyncHandler(async (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([SAMPLE_HEADER, ...SAMPLE_ROWS]);
  ws1['!cols'] = [{ wch: 22 }, { wch: 8 }, { wch: 16 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Products');
  const ws2 = XLSX.utils.aoa_to_sheet(INSTRUCTIONS_LINES);
  ws2['!cols'] = [{ wch: 110 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Instructions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="product_import_sample.xlsx"');
  res.send(buf);
});

// GET /api/products/export   (HR / SA) -- full catalogue as xlsx.
const exportProducts = asyncHandler(async (req, res) => {
  const rows = await Product.find({}).sort({ active: -1, name: 1 }).lean();
  const aoa = [SAMPLE_HEADER, ...rows.map((p) => [p.name, p.unit, p.pricePerUnit, p.nbvPercentage])];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 24 }, { wch: 8 }, { wch: 16 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Products');
  // Re-attach the same Instructions sheet so the exported file is a
  // perfect drop-in for the importer.
  const ws2 = XLSX.utils.aoa_to_sheet(INSTRUCTIONS_LINES);
  ws2['!cols'] = [{ wch: 110 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Instructions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="products_export_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buf);
});

/**
 * Locate a column index in the parsed header row by fuzzy match.
 * Lowercases + strips non-alphanumeric before comparing so HR can
 * rename headers like "Price/Unit" / "Price (₹)" without breaking
 * the import.  Returns -1 when not found.
 */
const normHeader = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%]+/g, '');
const findCol = (headerRow, candidates) => {
  const normRow = headerRow.map(normHeader);
  for (const c of candidates) {
    const n = normHeader(c);
    const i = normRow.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
};

// POST /api/products/import   (HR / SA, multer upload field name "file").
const importBulk = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    res.status(400); throw new Error('No file uploaded. Pick the filled sample.');
  }
  let wb;
  try { wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true }); }
  catch (e) { res.status(400); throw new Error(`Could not read uploaded file: ${e.message}`); }

  const sheetName = wb.SheetNames.includes('Products') ? 'Products' : wb.SheetNames[0];
  if (!sheetName) { res.status(400); throw new Error('Workbook has no sheets'); }
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  if (aoa.length < 2) { res.status(400); throw new Error('Sheet has no data rows'); }

  const header = aoa[0];
  const colName  = findCol(header, ['Product Name', 'name', 'product']);
  const colUnit  = findCol(header, ['Unit']);
  const colPrice = findCol(header, ['Price Per Unit', 'price', 'price/unit']);
  const colNbv   = findCol(header, ['NBV %', 'NBV', 'nbvPercentage']);

  if (colName < 0)  { res.status(400); throw new Error('Missing required column: Product Name'); }
  if (colUnit < 0)  { res.status(400); throw new Error('Missing required column: Unit'); }
  if (colPrice < 0) { res.status(400); throw new Error('Missing required column: Price Per Unit'); }
  if (colNbv < 0)   { res.status(400); throw new Error('Missing required column: NBV %'); }

  const dataRows = aoa.slice(1).filter((r) => r.some((c) => c !== '' && c !== null));

  // Pull every existing product once so the upsert loop is O(N) and
  // case-insensitive name matching uses a fast Map lookup.
  const existing = await Product.find({}).select('_id name').lean();
  const byLowerName = new Map(existing.map((p) => [String(p.name).toLowerCase().trim(), p._id]));

  let createdCount = 0;
  let updatedCount = 0;
  const failed = []; // { row, name, reason }

  for (let i = 0; i < dataRows.length; i++) {
    const raw = dataRows[i];
    const sheetRow = i + 2; // 1-indexed + 1 header row
    const name = String(raw[colName] ?? '').trim();
    if (!name) { failed.push({ row: sheetRow, name: '(blank)', reason: 'Product Name is required' }); continue; }

    const unitRaw = String(raw[colUnit] ?? '').trim().toUpperCase();
    if (!['L', 'KG'].includes(unitRaw)) {
      failed.push({ row: sheetRow, name, reason: `Unit must be L or KG (got "${raw[colUnit]}")` });
      continue;
    }
    const price = Number(raw[colPrice]);
    if (!Number.isFinite(price) || price <= 0) {
      failed.push({ row: sheetRow, name, reason: `Price Per Unit must be a number > 0 (got "${raw[colPrice]}")` });
      continue;
    }
    const nbv = Number(raw[colNbv]);
    if (!Number.isFinite(nbv) || nbv < 0 || nbv > 100) {
      failed.push({ row: sheetRow, name, reason: `NBV % must be between 0 and 100 (got "${raw[colNbv]}")` });
      continue;
    }

    try {
      const lowerKey = name.toLowerCase();
      const existingId = byLowerName.get(lowerKey);
      if (existingId) {
        await Product.findByIdAndUpdate(existingId, {
          pricePerUnit: price,
          nbvPercentage: nbv,
          unit: unitRaw,
          // Keep `active=true` on update so reactivating happens naturally.
          active: true,
        });
        updatedCount += 1;
      } else {
        const created = await Product.create({
          name,
          pricePerUnit: price,
          nbvPercentage: nbv,
          unit: unitRaw,
          active: true,
        });
        byLowerName.set(lowerKey, created._id);
        createdCount += 1;
      }
    } catch (e) {
      failed.push({ row: sheetRow, name, reason: e.message });
    }
  }

  logAudit(req, {
    action: 'product.bulk-import',
    targetType: 'Product',
    targetLabel: req.file.originalname || 'products.xlsx',
    meta: {
      file: req.file.originalname || 'products.xlsx',
      createdCount,
      updatedCount,
      failedCount: failed.length,
      totalRows: dataRows.length,
    },
  });

  res.json({
    file: req.file.originalname || 'products.xlsx',
    totalRows: dataRows.length,
    createdCount,
    updatedCount,
    failedCount: failed.length,
    failed,
  });
});

module.exports = {
  listProducts, createProduct, updateProduct, deactivateProduct,
  listQuantities, createQuantity, updateQuantity, deactivateQuantity,
  importSample, importBulk, exportProducts,
};
