/**
 * payrollController.js -- HR-only endpoints for financial compliance effects
 * that are owed and not yet taken into a salary slip.
 *
 *   GET  /api/compliance/payroll/pending?employee=&asOf=   pending fines + prefilled deduction items
 *   GET  /api/compliance/payroll/refund-due?employee=      deducted fines later reversed
 *   POST /api/compliance/payroll/mark-deducted             { effectIds, salarySlipId, salaryMonth }
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const { isEnabled } = require('../../config/featureFlags');
const payroll = require('../../services/compliance/payroll/payrollService');

const _isAdmin = (u) => u && (u.role === 'hr' || u.role === 'super_admin');
const _gate = (req, res) => {
  if (!isEnabled('compliance.waiverRecovery')) { res.status(404); throw new Error('Compliance payroll is not enabled on this deployment.'); }
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
};
const _emp = (req, res) => {
  const e = req.query && req.query.employee;
  if (!e) return null;
  if (!mongoose.Types.ObjectId.isValid(e)) { res.status(400); throw new Error('Valid employee id is required.'); }
  return e;
};

const pending = asyncHandler(async (req, res) => {
  _gate(req, res);
  const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
  const rows = await payroll.listPending({ employeeId: _emp(req, res), asOf });
  res.json({ pending: rows, deductionItems: payroll.asDeductionItems(rows), total: rows.reduce((a, r) => a + r.amount, 0) });
});

const refundDue = asyncHandler(async (req, res) => {
  _gate(req, res);
  res.json(await payroll.listRefundDue({ employeeId: _emp(req, res) }));
});

const markDeducted = asyncHandler(async (req, res) => {
  _gate(req, res);
  try {
    const { effectIds, salarySlipId, salaryMonth } = req.body || {};
    res.json(await payroll.markDeducted({ effectIds, salarySlipId, salaryMonth, actor: req.user._id, req }));
  } catch (e) { res.status(e.httpStatus || 400); throw e; }
});

module.exports = { pending, refundDue, markDeducted };
