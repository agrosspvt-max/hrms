const mongoose = require('mongoose');

/**
 * Quantity Master.  Standard sale-size dropdown entries HR maintains
 * (100 ml, 250 ml, 1 L, 25 KG, ...).  Employees pick one when filing a
 * Product Sales row; sales-value math uses `value` directly so the
 * label is purely cosmetic.
 *
 *   value   numeric canonical (always in the matching product's unit:
 *           Liters for an L-product, KG for a KG-product).
 *           So "500 ml" stores value=0.5; "25 KG" stores value=25.
 *
 *   unit    'L' or 'KG' -- pairs with Product.unit so the frontend can
 *           filter quantities by the chosen product's unit.
 */
const quantitySchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    value: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: ['L', 'KG'], default: 'L', index: true },
    active: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

quantitySchema.index({ unit: 1, label: 1 }, { unique: true });

module.exports = mongoose.model('Quantity', quantitySchema);
