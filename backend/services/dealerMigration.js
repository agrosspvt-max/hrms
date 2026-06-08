/**
 * dealerMigration
 *
 * Boot-time migration for the Phase 3.1 Dealer schema refactor.
 *
 *   - Legacy schema  : { name, place, active }
 *   - New schema     : { firmName, dealerName, place, active, name (mirror) }
 *
 * Two passes, both idempotent:
 *
 *   1. Data backfill -- every dealer row that is missing `firmName`
 *      OR `dealerName` is upgraded with the legacy `name` value, so
 *      historic references (analytics snapshots, farmerRecords) keep
 *      resolving.  Only touches rows where the new fields aren't
 *      already populated, so re-runs are no-ops.
 *
 *   2. Index sync -- the prior schema declared a unique index on
 *      `name_1`.  The new schema's uniqueness lives on
 *      (firmName, place).  We drop the legacy name index (if still
 *      present) and call `syncIndexes()` so the compound index is
 *      built without colliding with the old one.  A dropIndex on an
 *      index that no longer exists is caught + logged at debug only.
 *
 * Re-runs on every boot.  Once converged, the data pass matches
 * zero rows and syncIndexes is a no-op.
 */

const Dealer = require('../models/Dealer');

const migrateDealerSchema = async () => {
  let backfilled = 0;

  // Pass 1: backfill firmName + dealerName from `name` on legacy rows.
  // updateMany with a filter that excludes already-converged rows so
  // re-runs are O(matched-rows-only).
  const legacy = await Dealer.find({
    $or: [
      { firmName:   { $in: [null, ''] } },
      { dealerName: { $in: [null, ''] } },
    ],
  }).select('_id name firmName dealerName place').lean();

  if (legacy.length > 0) {
    const ops = legacy.map((d) => {
      const fallback = (d.name || d.firmName || d.dealerName || '').trim();
      const $set = {};
      if (!d.firmName)   $set.firmName   = fallback;
      if (!d.dealerName) $set.dealerName = fallback;
      // Keep `name` populated to whichever value is most informative.
      if (!d.name && fallback) $set.name = fallback;
      return { updateOne: { filter: { _id: d._id }, update: { $set } } };
    });
    const r = await Dealer.bulkWrite(ops, { ordered: false });
    backfilled = r?.modifiedCount || ops.length;
  }

  // Pass 2: drop the legacy unique index on `name` if it's still there.
  // We swallow the "ns not found" error that Mongo raises when the
  // index has already been dropped (or never existed in this tenant).
  let droppedLegacyIndex = false;
  try {
    await Dealer.collection.dropIndex('name_1');
    droppedLegacyIndex = true;
  } catch (e) {
    // "index not found with name [name_1]" -> already migrated.  Anything
    // else is logged at warn so we notice if something's actually wrong.
    if (!/index not found/i.test(e.message)) {
      console.warn('[migrate] dealer dropIndex(name_1) unexpected:', e.message);
    }
  }

  // Pass 3: build the schema-declared indexes (compound + secondary).
  try { await Dealer.syncIndexes(); }
  catch (e) { console.error('[migrate] dealer syncIndexes failed:', e.message); }

  if (backfilled > 0 || droppedLegacyIndex) {
    console.log(`[migrate] dealers: backfilled ${backfilled} legacy row(s), legacy index dropped=${droppedLegacyIndex}`);
  } else {
    console.log('[migrate] dealers: schema already up to date');
  }
  return { backfilled, droppedLegacyIndex };
};

module.exports = { migrateDealerSchema };
