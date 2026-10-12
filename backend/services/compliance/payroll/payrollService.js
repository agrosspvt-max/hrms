/**
 * payrollService.js -- financial_fine effects -> salary deduction bookkeeping.
 *
 * A financial effect is NEVER deducted automatically.  HR sees the pending
 * list, prepares the slip (the existing payroll engine takes HR-entered
 * deductionItems), and then records the deduction here:
 *
 *   pending  --markDeducted-->  deducted   (one-way, records slip id/month/who)
 *
 * Guarantees
 *   - only effects that are financial_fine, status 'active', payroll 'pending'
 *     can be deducted: cancelled / waived / recovered (resolved) fines cannot
 *   - each effect is claimed with an atomic compare-and-set, so concurrent or
 *     repeated requests deduct it once; the loser is reported, not applied
 *   - the slip must exist and belong to the same employee
 *   - the ledger is untouched (it already holds the debit); the effect carries
 *     the payroll state.  A deducted fine that is LATER cancelled / waived gets
 *     `payroll.refundDue = true` from the lifecycle layer for HR to refund.
 */
const mongoose = require('mongoose');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const lifecycle = require('../lifecycle');
const { logAudit } = require('../../../utils/audit');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthOf = (d) => new Date(d).toISOString().slice(0, 7);

const _emit = async (args) => {
  try {
    const ComplianceEvent = require('../../../models/ComplianceEvent');
    await ComplianceEvent.create({ ts: new Date(), ...args });
  } catch (e) { console.error('[compliance/payroll] event emit failed:', e.message); }
};

/** Fines HR can still take into a salary slip. */
const listPending = async ({ employeeId = null, asOf = new Date() } = {}) => {
  const where = {
    actionType: 'financial_fine', status: 'active', 'payroll.status': 'pending',
    amount: { $gt: 0 }, effectiveDate: { $lte: asOf },
  };
  if (employeeId) where.employee = employeeId;
  const effects = await ComplianceActionEffect.find(where).sort({ effectiveDate: 1, _id: 1 }).lean();
  const incs = effects.length
    ? await ComplianceIncident.find({ _id: { $in: [...new Set(effects.map((e) => String(e.incidentId)))] } })
      .select('_id ruleCode incidentDate detectorMeta status').lean()
    : [];
  const byId = new Map(incs.map((i) => [String(i._id), i]));
  return effects.map((e) => {
    const inc = byId.get(String(e.incidentId)) || {};
    return {
      effectId: e._id, incidentId: e.incidentId, employee: e.employee, amount: e.amount,
      date: e.effectiveDate, ruleCode: e.ruleCode || inc.ruleCode || '',
      reason: (inc.detectorMeta && inc.detectorMeta.reason) || '',
      status: e.status, payrollStatus: e.payroll && e.payroll.status,
      eligibleFromMonth: monthOf(e.effectiveDate),      // earliest salary month it can be taken in
    };
  });
};

/** Deducted fines that were later reversed: HR must refund them (nothing refunds automatically). */
const listRefundDue = async ({ employeeId = null } = {}) => {
  const where = { actionType: 'financial_fine', 'payroll.refundDue': true };
  if (employeeId) where.employee = employeeId;
  return ComplianceActionEffect.find(where).sort({ effectiveDate: 1 }).lean();
};

/** Deduction items for the slip form: [{amount, note}] -- pure helper, writes nothing. */
const asDeductionItems = (pending) => pending.map((p) => ({
  amount: p.amount, note: `Compliance fine ${new Date(p.date).toISOString().slice(0, 10)}${p.reason ? ` - ${p.reason}` : ''}`.slice(0, 120),
}));

/**
 * @returns {{results:Array<{effectId,outcome,reason?}>, deducted:number}}
 */
const markDeducted = async ({ effectIds, salarySlipId, salaryMonth, actor, req = null }) => {
  if (!Array.isArray(effectIds) || !effectIds.length) throw new lifecycle.LifecycleError('effectIds is required.', { httpStatus: 400, code: 'bad_request' });
  if (!salarySlipId || !mongoose.Types.ObjectId.isValid(salarySlipId)) throw new lifecycle.LifecycleError('A valid salarySlipId is required.', { httpStatus: 400, code: 'bad_request' });
  if (!MONTH_RE.test(String(salaryMonth || ''))) throw new lifecycle.LifecycleError('salaryMonth (YYYY-MM) is required.', { httpStatus: 400, code: 'bad_request' });
  if (!actor) throw new lifecycle.LifecycleError('actor is required.', { httpStatus: 401, code: 'unauthenticated' });

  const SalarySlip = require('../../../models/SalarySlip');
  const slip = await SalarySlip.findById(salarySlipId).select('_id employee').lean();
  if (!slip) throw new lifecycle.LifecycleError('Salary slip not found.', { httpStatus: 404, code: 'slip_not_found' });

  const results = [];
  const ids = [...new Set(effectIds.map(String))];
  for (const id of ids) {
    if (!mongoose.Types.ObjectId.isValid(id)) { results.push({ effectId: id, outcome: 'skipped', reason: 'invalid_id' }); continue; }
    const eff = await ComplianceActionEffect.findById(id).lean();
    if (!eff || eff.actionType !== 'financial_fine') { results.push({ effectId: id, outcome: 'skipped', reason: 'not_a_financial_fine' }); continue; }
    if (String(eff.employee) !== String(slip.employee)) { results.push({ effectId: id, outcome: 'skipped', reason: 'slip_belongs_to_another_employee' }); continue; }

    const won = await ComplianceActionEffect.findOneAndUpdate(
      { _id: id, actionType: 'financial_fine', status: 'active', 'payroll.status': 'pending', employee: slip.employee },
      { $set: {
        'payroll.status': 'deducted', 'payroll.salarySlipId': slip._id, 'payroll.salaryMonth': salaryMonth,
        'payroll.deductedBy': actor, 'payroll.deductedAt': new Date(),
      } },
      { new: true },
    );
    if (!won) {
      const cur = await ComplianceActionEffect.findById(id).lean();
      const reason = !cur ? 'not_found'
        : (cur.payroll && cur.payroll.status === 'deducted') ? 'already_deducted'
        : cur.status !== 'active' ? `effect_${cur.status}` : 'not_pending';
      results.push({ effectId: id, outcome: 'skipped', reason });
      continue;
    }
    results.push({ effectId: id, outcome: 'deducted' });
    await _emit({
      employee: eff.employee, incidentId: eff.incidentId, kind: 'payroll_deducted',
      payload: { effectId: id, amount: eff.amount, salarySlipId: String(slip._id), salaryMonth }, actor,
    });
    if (req) {
      logAudit(req, {
        action: 'compliance.payroll.deduct', targetType: 'ComplianceActionEffect', targetId: eff._id, targetLabel: 'financial_fine',
        meta: { amount: eff.amount, salarySlipId: String(slip._id), salaryMonth, employee: String(eff.employee) },
      });
    }
  }
  return { results, deducted: results.filter((r) => r.outcome === 'deducted').length };
};

module.exports = { listPending, listRefundDue, asDeductionItems, markDeducted, monthOf };
