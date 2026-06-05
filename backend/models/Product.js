const mongoose = require('mongoose');

/**
 * Product Master.  Each row is the catalogue entry HR maintains for
 * every product the field force sells.  Employees never edit this --
 * they pick a product from the dropdown when filing a Product Sales
 * row on a custom assignment submission.
 *
 *   unit             'L' or 'KG'  -- governs how Quantity entries map to
 *                                    the canonical sales-value formula.
 *   pricePerUnit     ₹ per L (or per KG)
 *   nbvPercentage    fraction of sales value that counts as NBV.
 *                    e.g. NBV=25 on a ₹1000 sale -> ₹250 of NBV.
 *
 * Soft-deactivate via `active=false` so analytics / history keep
 * resolving the snapshot stored on past submissions.
 */
const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, index: true },
    pricePerUnit: { type: Number, required: true, min: 0 },
    nbvPercentage: { type: Number, required: true, min: 0, max: 100, default: 0 },
    unit: { type: String, enum: ['L', 'KG'], default: 'L' },
    description: { type: String, default: '', trim: true },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Product', productSchema);
