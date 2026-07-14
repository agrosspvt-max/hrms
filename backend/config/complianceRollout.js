/**
 * complianceRollout.js
 *
 * Single source of truth for the "Missed Submission Effective From"
 * cutoff.  Everything that touches missed_submission penalties
 * consults this module so the rollout stays consistent across the
 * engine, controllers, and boot cleanup.
 *
 *   env var: MISSED_SUBMISSION_EFFECTIVE_FROM (YYYY-MM-DD, local)
 *   default: 2026-07-14
 *
 * Rule:
 *   A Submission whose `date` is STRICTLY BEFORE the effective-from
 *   date must be completely invisible to the compliance workflow:
 *   no penalty, no notification, no dashboard warning, no reopen.
 */

/**
 * Parse a YYYY-MM-DD string into a UTC-midnight Date so it aligns
 * with how the rest of the codebase stores submission / targetDate
 * fields (via utils/dateHelpers.startOfDay, which uses UTC).
 */
const _parse = (raw, fallback) => {
  if (!raw) return fallback;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return fallback;
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const DEFAULT_EFFECTIVE_FROM = new Date('2026-07-14T00:00:00Z');

const MISSED_SUBMISSION_EFFECTIVE_FROM = _parse(
  process.env.MISSED_SUBMISSION_EFFECTIVE_FROM,
  DEFAULT_EFFECTIVE_FROM,
);

/** True when the given date is before the compliance rollout. */
const isBeforeRollout = (d) => {
  if (!d) return true;
  return new Date(d).getTime() < MISSED_SUBMISSION_EFFECTIVE_FROM.getTime();
};

/** Mongo query clause: exclude legacy pre-rollout penalties. */
const excludeLegacyClause = () => ({
  $or: [
    // Non-compliance categories are never affected by the cutoff.
    { category: { $nin: ['missed_submission', 'absent_submission'] } },
    // Compliance rows are only visible when they belong to the new
    // era AND the boot-time archiver hasn't marked them archived.
    {
      category: { $in: ['missed_submission', 'absent_submission'] },
      targetDate: { $gte: MISSED_SUBMISSION_EFFECTIVE_FROM },
      archivedPreRollout: { $ne: true },
    },
  ],
});

module.exports = {
  MISSED_SUBMISSION_EFFECTIVE_FROM,
  isBeforeRollout,
  excludeLegacyClause,
};
