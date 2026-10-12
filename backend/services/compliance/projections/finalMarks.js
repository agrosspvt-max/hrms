/**
 * finalMarks.js -- Compliance-based Final Marks projection.
 *
 * Replaces `penaltyMath.attachFinalMarks`'s data source (Penalty rows) with
 * ComplianceActionEffect rows while keeping ONE implementation of the math:
 * effects are adapted to the Penalty shape (effectShape) and fed to the same
 * pure `deriveFinalMarksForSubmission`.  Read-only: unlike the legacy sweep it
 * never writes status transitions (grace / expiry are evaluated at read time).
 *
 * Which effects count: only those linked to the submission
 * (`submissionId`, set by submissionLink) -- marks effects deduct, a
 * performance_lock effect only contributes the explanatory metadata.  Effects
 * for deleted / test / hidden submissions are never reached because the caller
 * passes live submissions.
 */
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const penaltyMath = require('../../penaltyMath');
const { LINKED_ACTION_TYPES } = require('../submissionLink');
const { toPenaltyShape } = require('./effectShape');


const _day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/**
 * A performance lock is ONE legacy Penalty row (it zeroes the day AND explains
 * why).  In Compliance it is two effects of the same incident-day: the lock
 * (metadata) and a marks effect (the deduction).  Merge them back into a single
 * row so the breakdown / performanceLocks list match the legacy shape.
 */
const mergeLockRows = (rows) => {
  const groups = new Map();
  const out = [];
  for (const r of rows) {
    if (r.category !== 'performance_lock') { out.push(r); continue; }
    const k = `${r.incidentId}|${_day(r.effectiveDate)}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  for (const g of groups.values()) {
    const lock = g.find((r) => r.actionType === 'performance_lock');
    const marks = g.filter((r) => r.actionType !== 'performance_lock');
    if (!lock) { out.push(...marks); continue; }
    if (!marks.length) { out.push(lock); continue; }
    const base = marks[0];
    out.push({
      ...base,
      penaltyMarks: marks.reduce((a, r) => a + (Number(r.penaltyMarks) || 0), 0),
      restoredMarks: marks.reduce((a, r) => a + (Number(r.restoredMarks) || 0), 0),
      overdueRef: lock.overdueRef, reason: lock.reason || base.reason,
    });
  }
  return out;
};

const attachFinalMarks = async (subs, { now = new Date() } = {}) => {
  const list = Array.isArray(subs) ? subs : [subs];
  const ids = list.map((s) => s && (s._id || s.id)).filter(Boolean);
  if (!ids.length) return subs;

  const effects = await ComplianceActionEffect.find({
    submissionId: { $in: ids },
    actionType: { $in: LINKED_ACTION_TYPES },
  }).lean();

  const bySub = {};
  for (const e of effects) {
    const k = String(e.submissionId);
    (bySub[k] = bySub[k] || []).push(toPenaltyShape(e, now));
  }
  for (const k of Object.keys(bySub)) bySub[k] = mergeLockRows(bySub[k]);
  for (const s of list) {
    penaltyMath.deriveFinalMarksForSubmission(s, bySub[String(s._id || s.id)] || []);
  }
  return subs;
};

module.exports = { attachFinalMarks, mergeLockRows };
