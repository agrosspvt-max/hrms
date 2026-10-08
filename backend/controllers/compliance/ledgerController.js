/**
 * ledgerController.js -- read-only endpoints over the four
 * compliance ledgers.
 *
 *   GET /api/compliance/ledgers/:name   (marks|financial|percentage|attendance)
 *
 * Employees see their own rows only.  HR / Super Admin can pass
 * ?employee= to scope to another user; HODs are permitted when they
 * carry the compliance feature-permission.
 */

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const { isEnabled } = require('../../config/featureFlags');
const MODELS = {
  marks:      require('../../models/MarksLedger'),
  financial:  require('../../models/FinancialLedger'),
  percentage: require('../../models/PercentageLedger'),
  attendance: require('../../models/AttendanceLedger'),
};

const ledgerService = require('../../services/compliance/ledger/ledgerService');
const _isAdmin = (u) => u && (u.role === 'hr' || u.role === 'super_admin');
const _isHOD   = (u) => u && (u.role === 'hod' || u.isHOD === true);

const _flagGate = (res) => {
  if (!isEnabled('compliance.waiverRecovery')) {
    res.status(404);
    throw new Error('Compliance ledgers are not enabled on this deployment.');
  }
};

const get = asyncHandler(async (req, res) => {
  _flagGate(res);
  const name = req.params.name;
  const Model = MODELS[name];
  if (!Model) { res.status(404); throw new Error(`Unknown ledger: ${name}`); }

  let employee = req.user._id;
  if (_isAdmin(req.user) && req.query.employee
      && mongoose.Types.ObjectId.isValid(req.query.employee)) {
    employee = req.query.employee;
  }
  const where = { employee };
  if (req.query.from || req.query.to) {
    where.date = {};
    if (req.query.from) where.date.$gte = new Date(req.query.from);
    if (req.query.to)   where.date.$lte = new Date(req.query.to);
  }
  const rows = await Model.find(where)
    .sort({ date: 1, createdAt: 1 })
    .limit(Math.max(1, Math.min(1000, Number(req.query.limit) || 500)))
    .lean();
  // The stored `runningBalance` is an insertion-time snapshot and is wrong
  // for historical rows written out of date order, so the balance column is
  // recomputed from the rows themselves (opening balance = everything dated
  // before the window).  Response shape is unchanged: the last row's
  // `runningBalance` is the true total.  Nothing is written.
  const opening = req.query.from
    ? await ledgerService.balance({ ledger: name, employee, before: new Date(req.query.from) })
    : 0;
  res.json(ledgerService.withDisplayBalances(rows, opening));
});

module.exports = { get };
