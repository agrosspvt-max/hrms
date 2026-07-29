/**
 * submissionFilter.js
 *
 * Single source of truth for the "which submissions count?" question
 * across analytics, salary, dashboards, and review queues.
 *
 *   liveSubmissionFilter({ includeTest, includeDeleted })
 *     -> Mongo where-clause that every read of the Submission
 *        collection should AND-in.
 *
 *   readReqFlags(req)
 *     -> Pulls the (?includeTest=true / ?includeDeleted=true) toggles
 *        off an Express request.  Only HR / Super Admin can flip them;
 *        every other caller is forced to the safe default (deleted out,
 *        test out) regardless of what they sent in the query string.
 *
 * Default behaviour: deleted=false AND isTestData=false.  Existing
 * documents written before Phase 4 don't carry these fields; Mongoose
 * schema defaults treat them as `false` on read so the filter still
 * matches them.  No migration is required.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

const liveSubmissionFilter = ({ includeTest = false, includeDeleted = false, onlyReviewed = false, includeHidden = false } = {}) => {
  const out = {};
  if (!includeDeleted) out.deleted = { $ne: true };
  if (!includeTest)    out.isTestData = { $ne: true };
  // Business-state suppression: rows the businessStateSync
  // orchestrator hid because a full-day leave now covers the day.
  // Preserved for audit; excluded from analytics / dashboards /
  // compliance detectors by default so a suppressed row can't
  // resurface a "pending" incident tomorrow.
  if (!includeHidden)  out.hidden = { $ne: true };
  // Phase 15: analytics endpoints AND-in reviewStatus='reviewed' so a
  // pending or rejected submission can't poison KPIs, leaderboards, or
  // trends.  Pendency / carry-forward / Submission Control intentionally
  // skip this gate -- they operate on unreviewed work by design.
  if (onlyReviewed) out.reviewStatus = 'reviewed';
  return out;
};

const readReqFlags = (req) => {
  const role = req?.user?.role;
  const canBypass = role === 'hr' || role === 'super_admin';
  if (!canBypass) return { includeTest: false, includeDeleted: false };
  return {
    includeTest:    TRUTHY.has(String(req?.query?.includeTest    || '').toLowerCase()),
    includeDeleted: TRUTHY.has(String(req?.query?.includeDeleted || '').toLowerCase()),
  };
};

module.exports = { liveSubmissionFilter, readReqFlags };
