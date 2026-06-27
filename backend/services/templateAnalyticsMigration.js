/**
 * templateAnalyticsMigration
 *
 * Phase 11 boot migration.  Backfills the new Template fields so any
 * template HR created before Phase 11 still surfaces a sensible
 * analytics label on the dynamic analytics page.
 *
 *   - analyticsName: if blank, derive from `title` by replacing
 *     trailing " Template" / " Report" / " Form" with " Analytics".
 *     E.g. "Accounts Template" -> "Accounts Analytics".
 *
 *   - reviewFlow: default 'direct_hr'.
 *
 *   - department: left null; HR can wire it later via the (future)
 *     template builder UI.  HOD scoping treats null-department
 *     templates as global (visible to every HOD).
 *
 * Idempotent: the filter only matches rows where any of the new
 * fields are missing / blank, so subsequent boots touch zero rows.
 */

const Template = require('../models/Template');

const _deriveAnalyticsName = (title) => {
  const t = String(title || '').trim();
  if (!t) return 'Analytics';
  const stripped = t.replace(/\s*(Template|Report|Form)s?\s*$/i, '');
  return `${stripped} Analytics`;
};

const migrateTemplateAnalytics = async () => {
  const candidates = await Template.find({
    $or: [
      { analyticsName:    { $in: [null, ''] } },
      { reviewFlow:       { $exists: false } },
      // Phase 42 -- legacy Template documents created before these
      // fields were added to the schema have them as `undefined` on
      // disk, NOT as the schema's default value (Mongoose only applies
      // defaults on document create).  An `undefined` isActive made
      // the analytics `generate` endpoint return 404 ("template not
      // found or inactive") and the picker hid the row entirely.
      // Backfilling both flags here makes every legacy template
      // behave exactly like a newly-created one for the analytics
      // engine -- no separate code path required.
      { isActive:         { $exists: false } },
      { analyticsHidden:  { $exists: false } },
    ],
  }).select('_id title analyticsName reviewFlow isActive analyticsHidden');

  if (candidates.length === 0) {
    console.log('[migrate] template analytics: schema already up to date');
    return { touched: 0 };
  }

  const ops = candidates.map((t) => {
    const $set = {};
    if (!t.analyticsName) $set.analyticsName = _deriveAnalyticsName(t.title);
    if (!t.reviewFlow)    $set.reviewFlow    = 'direct_hr';
    // Phase 42 -- isActive defaults to true (matches the schema
    // default).  analyticsHidden defaults to false.  Persisting these
    // explicitly removes the "field is undefined on disk" ambiguity
    // that broke the analytics generate endpoint.
    if (t.isActive === undefined)        $set.isActive = true;
    if (t.analyticsHidden === undefined) $set.analyticsHidden = false;
    return { updateOne: { filter: { _id: t._id }, update: { $set } } };
  });
  const r = await Template.bulkWrite(ops, { ordered: false });
  const touched = r?.modifiedCount || ops.length;
  console.log(`[migrate] template analytics: backfilled ${touched} template(s) with analyticsName + reviewFlow + isActive defaults`);
  return { touched };
};

module.exports = { migrateTemplateAnalytics };
