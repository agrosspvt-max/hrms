/**
 * configController.js -- lightweight "what does the frontend need to
 * know?" endpoint for the Compliance & Accountability v2 rollout.
 *
 *   GET /api/compliance/config
 *
 * Returns the subset of feature flags the frontend gates its UI on
 * (never the flags that control server-side behaviour like
 * `compliance.newEngine` or `compliance.dualWrite`).  Also returns
 * the compliance rollout cutoff so the employee timeline can badge
 * "legacy" days as ignored.
 *
 * Authenticated but roleless -- every logged-in user reads the same
 * snapshot.
 */

const asyncHandler = require('express-async-handler');
const { isEnabled } = require('../../config/featureFlags');
const { MISSED_SUBMISSION_EFFECTIVE_FROM } = require('../../config/complianceRollout');

const get = asyncHandler(async (req, res) => {
  res.json({
    features: {
      employeeCardV2:  isEnabled('compliance.employeeCardV2'),
      dashboardV2:     isEnabled('compliance.dashboardV2'),
      waiverRecovery:  isEnabled('compliance.waiverRecovery'),
      rules:           isEnabled('compliance.rules'),
    },
    rollout: {
      missedSubmissionEffectiveFrom: MISSED_SUBMISSION_EFFECTIVE_FROM,
    },
  });
});

module.exports = { get };
