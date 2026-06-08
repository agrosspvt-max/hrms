const mongoose = require('mongoose');

/**
 * Dealer Master.  HR/SA-maintained catalogue of dealers the field
 * force visits.  Employees pick a dealer from a dropdown when filing
 * a Farmer Record on the Product & Farmer Report; the dealer's name
 * + place are SNAPSHOTTED onto the submission so historical reports
 * stay correct even if the dealer is later renamed or deactivated.
 *
 *   name     Display name (e.g. "Raj Traders").  Unique.
 *   place    Town / city (e.g. "Bhopal").  Free-text so HR can mix
 *            "Bhopal", "Vidisha", "Sehore" without a place master.
 *   active   Soft-deactivate.  Inactive dealers are hidden from
 *            employee dropdowns but historical references still
 *            resolve.
 */
const dealerSchema = new mongoose.Schema(
  {
    name:   { type: String, required: true, unique: true, trim: true, index: true },
    place:  { type: String, default: '', trim: true, index: true },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Dealer', dealerSchema);
