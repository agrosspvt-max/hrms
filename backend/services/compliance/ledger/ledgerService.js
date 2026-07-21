/**
 * ledgerService.js -- append-only writers for the four compliance
 * ledgers.  Every write:
 *
 *   1. Reads the most recent row for (employee, ledger) to derive
 *      the previous balance.
 *   2. Computes newBalance = prevBalance + direction * quantity.
 *   3. Inserts the new row (never mutates the previous one).
 *
 * `direction` convention:
 *    -1  debit  (against the employee)
 *    +1  credit (recovery / waiver / refund)
 *
 * The nightly reconciler (Phase 6) re-derives yesterday's balance
 * from the ordered row set and alerts on drift; balance drift is the
 * canonical "something wrote the ledger wrong" signal.
 */

const MarksLedger      = require('../../../models/MarksLedger');
const FinancialLedger  = require('../../../models/FinancialLedger');
const PercentageLedger = require('../../../models/PercentageLedger');
const AttendanceLedger = require('../../../models/AttendanceLedger');

const MODELS = {
  marks:      MarksLedger,
  financial:  FinancialLedger,
  percentage: PercentageLedger,
  attendance: AttendanceLedger,
};

/**
 * Append one row.  Args:
 *
 *   { ledger:       'marks' | 'financial' | 'percentage' | 'attendance'
 *     employee:     ObjectId  (required)
 *     date:         Date      (required -- when the entry affects)
 *     direction:    -1 | +1
 *     quantity:     Number    (>= 0)
 *     type:         'action' | 'recovery' | 'waiver' | 'manual' | 'salary_deduct' | 'reconciliation'
 *     reason:       String
 *     refIncidentId, refEffectId, refRecoveryId, refWaiverId, createdBy
 *     session:      Mongo session (optional -- passed by actionEngine
 *                    to make the entire effect+ledger insert atomic)
 *   }
 *
 * Returns the persisted row (with `runningBalance` materialised).
 *
 * Stabilization patch (C2): when `session` is provided we read the
 * previous row + insert the new row inside the same transaction.
 * On replica-set Mongo this closes the read-then-write race; on
 * standalone Mongo the caller falls through to the pre-patch
 * behaviour (single-node race remains but the reconciler catches
 * drift within 24 hours).
 */
const append = async (args) => {
  const {
    ledger, employee, date, direction, quantity, type,
    reason = '',
    refIncidentId = null, refEffectId = null,
    refRecoveryId = null, refWaiverId = null,
    createdBy = null,
    session = null,
  } = args || {};

  const Model = MODELS[ledger];
  if (!Model)       throw new Error(`ledgerService.append: unknown ledger "${ledger}"`);
  if (!employee)    throw new Error('ledgerService.append: employee is required');
  if (!date)        throw new Error('ledgerService.append: date is required');
  if (direction !== -1 && direction !== 1) {
    throw new Error('ledgerService.append: direction must be -1 or +1');
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error('ledgerService.append: quantity must be >= 0');
  }
  if (!type)        throw new Error('ledgerService.append: type is required');

  // Batch-3 fix #16 -- skip zero-quantity writes.
  //
  // A zero-quantity row moves the running balance by direction*0 = 0,
  // so its `runningBalance` equals the previous row's balance.  Such
  // rows contribute no signal but bloat the ledger, distort reconciler
  // scan volumes, and force downstream analytics to filter them.  We
  // no-op them here.  Semantic invariant: `balance(employee, ledger)`
  // is unchanged whether or not the caller invoked us with quantity=0.
  //
  // Idempotency of the caller is preserved: callers that guarded on
  // "did we already write?" via partial-unique keys still get their
  // uniqueness constraint enforced -- the compliance action executor
  // separately upserts a ComplianceActionEffect row keyed on
  // (incident, ruleAction, effectiveDate), which stays authoritative.
  // Skipping a zero ledger write does NOT let the same effect fire
  // twice with non-zero quantity, because the effect row itself is
  // the uniqueness anchor.
  if (quantity === 0) {
    return null;
  }

  // Read the most recent row.  Use both `date` and `createdAt` so
  // multiple entries on the same day preserve their intra-day order.
  const lastQ = Model.findOne({ employee })
    .sort({ date: -1, createdAt: -1 });
  if (session) lastQ.session(session);
  const last = await lastQ.lean();
  const prevBalance = last ? Number(last.runningBalance) || 0 : 0;
  const runningBalance = prevBalance + direction * quantity;

  const doc = {
    employee, date, direction, quantity, runningBalance,
    type, reason,
    refIncidentId, refEffectId, refRecoveryId, refWaiverId,
    createdBy,
  };
  if (session) {
    const created = await Model.create([doc], { session });
    return Array.isArray(created) ? created[0] : created;
  }
  return await Model.create(doc);
};

/** Current balance = most recent row's runningBalance, or 0. */
const balance = async ({ ledger, employee }) => {
  const Model = MODELS[ledger];
  if (!Model) throw new Error(`ledgerService.balance: unknown ledger "${ledger}"`);
  const last = await Model.findOne({ employee })
    .sort({ date: -1, createdAt: -1 })
    .lean();
  return last ? Number(last.runningBalance) || 0 : 0;
};

module.exports = { append, balance, MODELS };
