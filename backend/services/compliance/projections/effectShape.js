/**
 * effectShape.js -- adapts a ComplianceActionEffect (+ rule code) into the
 * Penalty-shaped row that penaltyMath's pure functions understand.
 *
 * This lets the Compliance projections reuse the SAME math as the legacy
 * Final Marks / completion code (one implementation), instead of copying it.
 *
 * Status mapping (now = read time; nothing is written):
 *   active                    -> active      (expired when expiryDate <= now)
 *   pending                   -> active when effectiveDate <= now, else pending
 *   resolved                  -> resolved
 *   cancelled | waived        -> cancelled   (a waiver cancels the deduction)
 *   expired                   -> expired
 *   evaluationMode information|neutral on an active/resolved effect
 *                             -> stays 'active' + mode (legacy: those modes keep
 *                                the row active and change the day's projection)
 *   evaluationMode restore    -> resolved, penaltyMarks 0, restoredMarks kept
 */
const { MARKS_ACTION_TYPES } = require('../submissionLink');

const RULE_TO_CATEGORY = Object.freeze({
  missed_submission_v2:     'missed_submission',
  dependency_pending_v2:    'dependency_pending',
  performance_lock_v2:      'performance_lock',
  attendance_manual_v2:     'attendance_manual',
  manual_marks_v2:          'manual_marks',
  completion_adjustment_v2: 'completion_adjustment',
  financial_penalty_v2:     'financial_penalty',
  manual_warning_v2:        'manual_warning',
});
// Rules whose percent_reduction effects are completion-score ADJUSTMENTS
// (legacy completion_adjustment / manual_completion).  Percent effects from
// automatic rules (e.g. dependency 1%/day) are ledger-only unless HR adds
// their rule code here -- a business decision, see the Phase 4 report.
const COMPLETION_ADJUSTMENT_RULE_CODES = Object.freeze(['completion_adjustment_v2']);

const categoryOf = (ruleCode) => RULE_TO_CATEGORY[ruleCode] || 'manual_marks';

const legacyStatus = (e, now) => {
  const mode = e.evaluationMode || '';
  if (e.status === 'cancelled' || e.status === 'waived') return 'cancelled';
  if (e.status === 'expired') return 'expired';
  if (mode === 'restore') return 'resolved';
  if ((mode === 'information' || mode === 'neutral') && (e.status === 'active' || e.status === 'resolved')) return 'active';
  if (e.status === 'resolved') return 'resolved';
  if (e.status === 'pending') return (e.effectiveDate && new Date(e.effectiveDate) <= now) ? 'active' : 'pending';
  if (e.status === 'active') {
    if (e.expiryDate && new Date(e.expiryDate) <= now) return 'expired';
    return 'active';
  }
  return e.status;
};

const toPenaltyShape = (e, now = new Date()) => {
  const mode = e.evaluationMode || '';
  const isMarks = MARKS_ACTION_TYPES.includes(e.actionType);
  const ref = (e.taskRef && typeof e.taskRef === 'object') ? e.taskRef : {};
  return {
    _id: e._id,
    employee: e.employee,
    submission: e.submissionId || null,
    category: categoryOf(e.ruleCode),
    source: 'automatic',
    probable: false,
    status: legacyStatus(e, now),
    penaltyMarks: (isMarks && mode !== 'restore') ? (Number(e.marks) || 0) : 0,
    restoredMarks: mode === 'restore' ? (Number(e.restoredMarks) || 0) : 0,
    evaluationMode: mode,
    completionPercent: Number(e.percent) || 0,
    evaluationPeriod: e.evaluationPeriod && e.evaluationPeriod.startDate && e.evaluationPeriod.endDate
      ? { startDate: e.evaluationPeriod.startDate, endDate: e.evaluationPeriod.endDate } : undefined,
    effectiveDate: e.effectiveDate,
    expiryDate: e.expiryDate || null,
    createdAt: e.createdAt,
    resolvedAt: e.resolvedAt || null,
    resolvedBy: e.resolvedBy || null,
    restoredBy: mode === 'restore' ? (e.resolvedBy || null) : null,
    restorationReason: mode === 'restore' ? (e.resolvedReason || '') : '',
    reason: e.reason || '',
    overdueRef: { taskTitle: ref.taskTitle || '', pendingSince: ref.pendingSince || null, resolveBy: ref.resolveBy || null },
    actionType: e.actionType,
    incidentId: e.incidentId,
  };
};

module.exports = {
  RULE_TO_CATEGORY, COMPLETION_ADJUSTMENT_RULE_CODES, categoryOf, legacyStatus, toPenaltyShape,
};
