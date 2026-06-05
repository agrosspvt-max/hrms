const asyncHandler = require('express-async-handler');
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

module.exports = {
  listProducts, createProduct, updateProduct, deactivateProduct,
  listQuantities, createQuantity, updateQuantity, deactivateQuantity,
};
