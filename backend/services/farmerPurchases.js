const mongoose = require('mongoose');
const Product = require('../models/Product');
const Quantity = require('../models/Quantity');

const number = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value);
const nameKey = (value) => String(value || '').trim().toUpperCase();
const validIds = (ids) => [...new Set(ids.filter((id) => mongoose.isObjectIdOrHexString(id)).map(String))];

// The original Farmer Records stored a single product and a Quantity Master
// ID. A populated products array supersedes those mirrors.
const purchaseInputs = (farmer) => {
  if (farmer.products?.length) return farmer.products;
  if ((farmer.productId || farmer.productName) && (farmer.quantityId || number(farmer.quantity) > 0)) return [farmer];
  return [];
};

const priceSnapshot = (product) => ({
  productPrice: product.pricePerUnit,
  productNbvPercentage: product.nbvPercentage,
});

const getRates = async (submissions) => {
  const inputs = submissions.flatMap((sub) => (sub.farmerRecords || []).flatMap(purchaseInputs));
  const productIds = validIds(inputs.map((row) => row.productId));
  const quantityIds = validIds(inputs.map((row) => row.quantityId));
  const needsNameLookup = inputs.some((row) => !row.productId && row.productName);
  const [products, quantities] = await Promise.all([
    productIds.length || needsNameLookup
      ? Product.find(needsNameLookup ? {} : { _id: { $in: productIds } }).select('name unit pricePerUnit nbvPercentage').lean() : [],
    quantityIds.length ? Quantity.find({ _id: { $in: quantityIds } }).select('value unit').lean() : [],
  ]);
  return {
    productsById: new Map(products.map((p) => [String(p._id), p])),
    productsByName: new Map(products.map((p) => [nameKey(p.name), p])),
    quantities: new Map(quantities.map((q) => [String(q._id), q])),
  };
};

const valueFarmerPurchases = async (submissions) => {
  const { productsById, productsByName, quantities } = await getRates(submissions);
  for (const sub of submissions) {
    // Old reports kept the product's historical pricing here. Use only price
    // metadata from these rows. Their quantities and totals never enter reports.
    const legacyRates = new Map();
    for (const row of sub.productSales || []) {
      if (!row.productId) continue;
      const key = String(row.productId);
      if (!legacyRates.has(key)) legacyRates.set(key, row);
    }
    for (const farmer of sub.farmerRecords || []) {
      farmer.products = purchaseInputs(farmer).flatMap((row) => {
        const product = row.productId
          ? productsById.get(String(row.productId))
          : productsByName.get(nameKey(row.productName));
        const legacyQty = quantities.get(String(row.quantityId));
        const quantity = number(row.quantity) ?? number(legacyQty?.value);
        if (!(quantity > 0) || (!row.productId && !row.productName)) return [];
        const productId = row.productId || product?._id;
        const unit = row.productUnit || legacyQty?.unit || product?.unit || '';
        const historical = legacyRates.get(String(productId));
        const compatible = (rate) => !rate?.unit || !unit || rate.unit === unit;
        const savedRate = compatible({ unit: historical?.productUnit }) ? historical : undefined;
        const catalog = compatible(product) ? product : undefined;
        const price = number(row.productPrice) ?? number(savedRate?.productPrice) ?? number(catalog?.pricePerUnit);
        const nbvPercentage = number(row.productNbvPercentage) ?? number(savedRate?.productNbvPercentage) ?? number(catalog?.nbvPercentage);
        const salesPaise = Math.round(quantity * (price ?? 0) * 100);
        const nbvPaise = Math.round(salesPaise * Math.max(0, Math.min(nbvPercentage ?? 0, 100)) / 100);
        return [{
          productId, productName: row.productName || savedRate?.productName || product?.name || '',
          productUnit: unit, quantity, salesValue: salesPaise / 100, nbvValue: nbvPaise / 100,
          pricingAvailable: price !== undefined && nbvPercentage !== undefined,
        }];
      });
    }
  }
};

module.exports = { priceSnapshot, valueFarmerPurchases };
