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
 * Phase 3B: `runningBalance` is the true ledger total at insertion time
 * (see `balance`).  It is a display/audit snapshot, NOT the source of
 * truth: current balance is always the sum of the rows.  Under concurrent
 * appends the snapshot of the second writer can omit the first writer's
 * row; `balance()` is unaffected.
 *
 * Stabilization patch (C2): when `session` is provided we read the
 * previous total + insert the new row inside the same transaction.
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

  // Balance after this row = the TRUE total of every row already in the
  // ledger + this one.  It must not be chained from "the newest row by
  // date": a backdated entry (a recurring debit carries the incident's
  // effectiveDate, a reversal carries `now`) would then continue from an
  // older chain and fork the stored balance away from the real sum.
  const prevBalance = await balance({ ledger, employee, session });
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

/**
 * Signed contribution of one ledger row (-1 debit / +1 credit).  The single
 * definition of the ledger's sign convention; `balance`, the employee ledger
 * view and the dashboards all derive from it (the dashboard's aggregation
 * pipeline expresses the same thing, see `NET_OWED_EXPR`).
 */
const signed = (r) => (Number(r.direction) || 0) * (Number(r.quantity) || 0);

/**
 * Mongo expression for "net amount OWED" of a row: debit counts +quantity,
 * credit counts -quantity.  Equals `-signed(row)`.
 */
const NET_OWED_EXPR = Object.freeze({
  $multiply: [{ $subtract: [0, '$direction'] }, '$quantity'],
});

/**
 * Current balance = SUM of every row's signed quantity.  Independent of
 * insertion order and of row dates, and it never trusts a stored
 * `runningBalance` (which is only an insertion-time snapshot).  Negative
 * means the employee is net debited.  `before` restricts to rows dated
 * strictly earlier than that date (opening balance of a date window).
 */
const balance = async ({ ledger, employee, before = null, session = null }) => {
  const Model = MODELS[ledger];
  if (!Model) throw new Error(`ledgerService.balance: unknown ledger "${ledger}"`);
  const where = { employee };
  if (before) where.date = { $lt: before };
  const q = Model.find(where).select('direction quantity');
  if (session) q.session(session);
  const rows = await q.lean();
  return rows.reduce((sum, r) => sum + signed(r), 0);
};

/**
 * Display view of a ledger window: rows in (date, createdAt) order with
 * `runningBalance` recomputed as opening + cumulative sum in that order, so
 * the last row always equals the true total.  The stored value is kept as
 * `storedRunningBalance`.  Pure; never writes.
 */
const withDisplayBalances = (rows, opening = 0) => {
  let bal = Number(opening) || 0;
  return rows.map((r) => {
    bal += signed(r);
    return { ...r, storedRunningBalance: r.runningBalance, runningBalance: bal };
  });
};

/**
 * True when a compensating credit (recovery / waiver) already exists for
 * the effect.  Lets lifecycle callers refuse to write a second reversal
 * for the same original effect.
 */
const hasReversal = async ({ ledger, effectId, session = null }) => {
  const Model = MODELS[ledger];
  if (!Model || !effectId) return false;
  const q = Model.findOne({ refEffectId: effectId, direction: 1, type: { $in: ['recovery', 'waiver'] } })
    .select('_id');
  if (session) q.session(session);
  return !!(await q.lean());
};

module.exports = { append, balance, signed, withDisplayBalances, NET_OWED_EXPR, hasReversal, MODELS };
