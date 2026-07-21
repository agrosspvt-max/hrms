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
const ComplianceRule = require('../../models/ComplianceRule');
const ruleService    = require('../../services/compliance/rules/ruleService');
const detectorRegistry = require('../../services/compliance/registry/detectorRegistry');

/**
 * QA-fix H4 -- registry-driven metadata for the Rule Builder.
 *
 * The frontend used to hardcode enum values that duplicated the
 * backend's own enums (action types, marks strategies, detectors,
 * severities, categories, recovery modes, approver roles).  We now
 * expose them through the existing `/api/compliance/config` endpoint
 * so the frontend hydrates from the source of truth on load.  The
 * frontend keeps its local list as a fallback (see
 * hooks/useComplianceRegistry.js) so an outage of this endpoint
 * degrades gracefully.
 *
 * Detectors:  read live from the DetectorRegistry so custom
 *   detectors registered by plugins show up automatically.  When
 *   registerAll hasn't run yet (rare -- would mean the compliance
 *   barrel wasn't loaded) we fall through to the hard-coded list.
 */
const _KNOWN_DETECTOR_LABELS = {
  'built_in.missed_submission':  { label: 'Built-in — Missed Submission',  automatic: true  },
  'built_in.dependency_pending': { label: 'Built-in — Dependency Pending', automatic: true  },
  'built_in.performance_lock':   { label: 'Built-in — Performance Lock',   automatic: true  },
  'manual':                      { label: 'Manual (HR-initiated)',         automatic: false },
};

const _detectorList = () => {
  let codes = [];
  try { codes = detectorRegistry.list ? detectorRegistry.list() : []; } catch (_) { codes = []; }
  if (!codes || codes.length === 0) {
    codes = Object.keys(_KNOWN_DETECTOR_LABELS);
  }
  return codes.map((code) => ({
    value: code,
    label: (_KNOWN_DETECTOR_LABELS[code] && _KNOWN_DETECTOR_LABELS[code].label) || code,
    automatic: !!(_KNOWN_DETECTOR_LABELS[code] && _KNOWN_DETECTOR_LABELS[code].automatic),
  }));
};

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
    registry: {
      detectors:       _detectorList(),
      actionTypes:     Array.isArray(ComplianceRule.ACTION_TYPES) ? ComplianceRule.ACTION_TYPES.slice() : [],
      marksStrategies: Array.isArray(ComplianceRule.MARKS_STRATEGIES) ? ComplianceRule.MARKS_STRATEGIES.slice() : [],
      categories:      ruleService.CATEGORIES ? ruleService.CATEGORIES.slice() : [],
      severities:      ruleService.SEVERITIES ? ruleService.SEVERITIES.slice() : [],
      approverRoles:   ruleService.APPROVER_ROLES ? ruleService.APPROVER_ROLES.slice() : [],
      recoveryModes:   ruleService.RECOVERY_MODES ? ruleService.RECOVERY_MODES.slice() : [],
    },
  });
});

module.exports = { get };
