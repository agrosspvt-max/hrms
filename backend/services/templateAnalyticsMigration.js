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
      { analyticsName: { $in: [null, ''] } },
      { reviewFlow:    { $exists: false } },
    ],
  }).select('_id title analyticsName reviewFlow');

  if (candidates.length === 0) {
    console.log('[migrate] template analytics: schema already up to date');
    return { touched: 0 };
  }

  const ops = candidates.map((t) => {
    const $set = {};
    if (!t.analyticsName) $set.analyticsName = _deriveAnalyticsName(t.title);
    if (!t.reviewFlow)    $set.reviewFlow    = 'direct_hr';
    return { updateOne: { filter: { _id: t._id }, update: { $set } } };
  });
  const r = await Template.bulkWrite(ops, { ordered: false });
  const touched = r?.modifiedCount || ops.length;
  console.log(`[migrate] template analytics: backfilled ${touched} template(s) with analyticsName + reviewFlow defaults`);
  return { touched };
};

module.exports = { migrateTemplateAnalytics };
