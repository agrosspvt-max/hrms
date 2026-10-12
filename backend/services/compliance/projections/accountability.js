/**
 * accountability.js -- the employee's warning / penalty view, served from
 * Compliance (incident + effects) in the SAME shape the legacy
 * `GET /api/penalties/mine` returns ({active, probable, resolved} of
 * Penalty-shaped items), so the existing dashboard card renders it unchanged.
 *
 * One item per INCIDENT (the case).  Warnings:
 *   - a "warning" case = an incident whose only consequence is a `warning`
 *     effect (no marks / percentage / fine / leave / lock) -> `probable` bucket
 *   - everything else that is in force -> `active`
 *   - resolved / cancelled / waived / expired -> `resolved` (history)
 * Candidate incidents (not yet in force) are not shown to the employee.
 *
 * Read-only.
 */
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const { categoryOf } = require('./effectShape');

const DEDUCTING = new Set(['zero_daily_marks', 'add_daily_total', 'fixed_marks_reduction', 'percent_reduction',
  'financial_fine', 'half_day_lwp', 'full_day_lwp', 'performance_lock', 'suspend_incentive']);

const itemStatus = (inc) => ({
  active: 'active', resolved: 'resolved', waived: 'cancelled', cancelled: 'cancelled', expired: 'expired',
}[inc.status] || 'pending');

const toItem = (inc, effects) => {
  const live = effects.filter((e) => ['active', 'pending'].includes(e.status));
  const marks = live.filter((e) => ['zero_daily_marks', 'add_daily_total', 'fixed_marks_reduction'].includes(e.actionType))
    .reduce((a, e) => a + (Number(e.marks) || 0), 0);
  const fine = effects.find((e) => e.actionType === 'financial_fine' && Number(e.amount) > 0);
  const lock = effects.find((e) => e.actionType === 'performance_lock');
  const ref = (lock && lock.taskRef) || {};
  const isWarning = effects.some((e) => e.actionType === 'warning')
    && !effects.some((e) => DEDUCTING.has(e.actionType));
  return {
    _id: inc._id,
    incidentId: inc._id,
    category: categoryOf(inc.ruleCode),
    ruleCode: inc.ruleCode,
    probable: isWarning,
    status: itemStatus(inc),
    penaltyMarks: marks,
    amount: fine ? fine.amount : 0,
    financialStatus: fine ? (fine.payroll && fine.payroll.status === 'deducted' ? 'deducted' : (fine.status === 'active' ? 'pending' : 'resolved')) : '',
    targetDate: inc.incidentDate,
    effectiveDate: inc.effectiveDate,
    reason: (inc.detectorMeta && inc.detectorMeta.reason) || inc.ruleCode,
    employeeMessage: (inc.detectorMeta && inc.detectorMeta.employeeMessage) || '',
    submission: inc.context && inc.context.submissionId || null,
    overdueRef: lock ? { taskTitle: ref.taskTitle || '', pendingSince: ref.pendingSince || null, resolveBy: ref.resolveBy || null } : undefined,
    acknowledgedAt: inc.acknowledgedAt || null,
    // The UI posts here; the legacy card used /penalties/:id/acknowledge.
    acknowledgeUrl: `/compliance/incidents/${inc._id}/acknowledge`,
    source: inc.source,
  };
};

const forEmployee = async ({ employeeId, limit = 200 }) => {
  const incs = await ComplianceIncident.find({
    employee: employeeId, status: { $in: ['active', 'resolved', 'waived', 'cancelled', 'expired'] },
  }).sort({ effectiveDate: -1, createdAt: -1 }).limit(limit).lean();
  const ids = incs.map((i) => i._id);
  const effects = ids.length ? await ComplianceActionEffect.find({ incidentId: { $in: ids } }).lean() : [];
  const byInc = new Map();
  for (const e of effects) { const k = String(e.incidentId); (byInc.get(k) || byInc.set(k, []).get(k)).push(e); }
  const out = { active: [], probable: [], resolved: [] };
  for (const inc of incs) {
    const item = toItem(inc, byInc.get(String(inc._id)) || []);
    if (item.status === 'active' && item.probable) out.probable.push(item);
    else if (item.status === 'active' || item.status === 'pending') out.active.push(item);
    else out.resolved.push(item);
  }
  return out;
};

module.exports = { forEmployee, toItem };
