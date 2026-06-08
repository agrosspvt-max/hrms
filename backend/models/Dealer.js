const mongoose = require('mongoose');

/**
 * Dealer Master.  HR/SA-maintained catalogue of dealer firms the
 * field force visits.
 *
 *   firmName    Business / shop name (e.g. "Agro Traders").  Required.
 *   place       Town / city the firm operates from (e.g. "Bhopal").
 *               Required.  The same firmName can exist in multiple
 *               places (each is a distinct dealer record).
 *   dealerName  Actual person at the firm (e.g. "Rajesh Sharma").
 *               Required.  Surfaced in HR / analytics ONLY -- employee
 *               dropdowns intentionally never expose the dealer name.
 *
 *   name        LEGACY mirror -- kept so older code that still reads
 *               `dealer.name` resolves to something meaningful.  Set
 *               to firmName by the controller on every write.
 *
 *   active      Soft-deactivate.  Inactive dealers are hidden from
 *               employee dropdowns but historical references still
 *               resolve to the snapshot stored on farmer records.
 *
 * Uniqueness: (firmName, place).  "Agro Traders" in Bhopal and
 * "Agro Traders" in Vidisha are two separate dealer rows.  The bulk
 * import uses this compound as its upsert key.
 */
const dealerSchema = new mongoose.Schema(
  {
    firmName:   { type: String, required: true, trim: true, index: true },
    place:      { type: String, required: true, trim: true, index: true },
    dealerName: { type: String, required: true, trim: true },

    // Legacy mirror -- kept populated for any old code that reads `name`.
    name:       { type: String, default: '', trim: true, index: true },

    active:     { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

// Compound uniqueness: same firm in two different places = two rows.
// `dealer.name` had a unique index in the prior schema; the boot
// migration in services/dealerMigration.js drops that legacy index
// before the new compound is built so existing tenants don't trip.
dealerSchema.index({ firmName: 1, place: 1 }, { unique: true });

module.exports = mongoose.model('Dealer', dealerSchema);
