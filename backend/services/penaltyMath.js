/**
 * penaltyMath.js  --  Phase 61 Final-Marks derivation.
 *
 * Every read path that surfaces a submission's total should route
 * through here so we compute Final Marks the same way in every UI
 * (dashboards, reviews, salary, analytics).
 *
 * Historical earned marks are NEVER overwritten.  Final Marks are
 * derived on the fly from Earned - Σ active penalties, clamped at 0.
 *
 *   Final = max(0, Earned − ΣP_active)
 *
 * P_active means: status === 'active' AND probable === false.
 *   - 'pending' / 'scheduled' penalties are grace-period holds
 *     that don't affect Final Marks yet.
 *   - 'probable' penalties are warnings only.
 *   - 'resolved' / 'cancelled' / 'expired' don't count.
 *
 * The helper is written as pure functions so tests can pass in
 * arrays without hitting the DB.
 */
const Penalty = require('../models/Penalty');

/**
 * Verification-audit fix -- state-transition sweep.
 * Grace-period penalties (status 'scheduled' / 'pending') must
 * auto-activate when their effectiveDate passes, and active
 * penalties with an expiryDate must auto-expire when it passes.
 * Nothing else in the app runs a cron for this today, so we do
 * it lazily on every read that touches penalties.  Idempotent:
 * each call only writes when the state actually changes.
 */
const _sweepStateTransitions = async (penalties = []) => {
  const now = new Date();
  const toActivate = [];
  const toExpire   = [];
  for (const p of penalties) {
    if (!p) continue;
    if ((p.status === 'scheduled' || p.status === 'pending')
        && p.effectiveDate && new Date(p.effectiveDate) <= now) {
      toActivate.push(p._id);
      p.status = 'active';
    }
    if (p.status === 'active' && p.expiryDate && new Date(p.expiryDate) <= now) {
      toExpire.push(p._id);
      p.status = 'expired';
    }
  }
  if (toActivate.length) {
    await Penalty.updateMany({ _id: { $in: toActivate }, status: { $in: ['scheduled', 'pending'] } },
      { $set: { status: 'active' } });
  }
  if (toExpire.length) {
    await Penalty.updateMany({ _id: { $in: toExpire }, status: 'active' },
      { $set: { status: 'expired' } });
  }
};

/**
 * Split a list of penalties into buckets by effect on Final Marks.
 * @param {Array} penalties
 * @returns {{active: Array, probable: Array, resolved: Array}}
 */
const bucketPenalties = (penalties = []) => {
  const active = [];
  const probable = [];
  const resolved = [];
  for (const p of penalties) {
    if (!p) continue;
    if (p.probable) { probable.push(p); continue; }
    if (p.status === 'active')                 active.push(p);
    else if (p.status === 'resolved' ||
             p.status === 'cancelled' ||
             p.status === 'expired')            resolved.push(p);
    // pending / scheduled -> shown separately, not active, not resolved.
  }
  return { active, probable, resolved };
};

/**
 * Compute the deducted marks for a single submission from an array
 * of penalties that all target it.
 */
const sumMarksPenalty = (penalties = []) => {
  let total = 0;
  for (const p of penalties) {
    if (!p) continue;
    if (p.probable) continue;
    if (p.status !== 'active') continue;
    total += Number(p.penaltyMarks) || 0;
  }
  return total;
};

/**
 * Compute Final Marks for one submission.
 * Never mutates the submission -- returns a new number.
 */
const computeFinal = (earnedPoints, penalties = []) => {
  const earned = Number(earnedPoints) || 0;
  const deducted = sumMarksPenalty(penalties);
  return Math.max(0, earned - deducted);
};

/**
 * Attach `finalMarks` + `penaltyBreakdown` fields to an array of
 * submission-like plain objects.  Fetches every penalty in one
 * round-trip.  Safe to call with lean() output.
 *
 *   after(sub) = {
 *     ...sub,
 *     finalMarks: <number>,
 *     penaltyBreakdown: {
 *       template: [<Penalty>...],       // absent_submission, critical, repeated
 *       attendance: [<Penalty>...],     // attendance_manual
 *       dependency: [<Penalty>...],     // dependency_pending
 *       manual: [<Penalty>...],         // manual_marks
 *       totalDeducted: <number>,
 *     },
 *   }
 */
const attachFinalMarks = async (subs) => {
  const list = Array.isArray(subs) ? subs : [subs];
  const ids = list.map((s) => s && (s._id || s.id)).filter(Boolean);
  if (!ids.length) return subs;

  const penalties = await Penalty.find({ submission: { $in: ids } }).lean();
  // Verification-audit fix -- transition stale state (scheduled ->
  // active, active -> expired) before we compute Final Marks so a
  // completion penalty that already expired stops deducting and a
  // grace-period penalty that should have activated actually does.
  await _sweepStateTransitions(penalties);
  const bySub = {};
  for (const p of penalties) {
    const k = String(p.submission);
    (bySub[k] = bySub[k] || []).push(p);
  }
  for (const s of list) {
    const bucket = bySub[String(s._id || s.id)] || [];
    s.finalMarks = computeFinal(s.earnedPoints, bucket);
    s.penaltyBreakdown = {
      template:   bucket.filter((p) => p.category === 'absent_submission'
                                    || p.category === 'critical_threshold'
                                    || p.category === 'repeated_missing'),
      attendance: bucket.filter((p) => p.category === 'attendance_manual'),
      dependency: bucket.filter((p) => p.category === 'dependency_pending'),
      manual:     bucket.filter((p) => p.category === 'manual_marks'
                                    || p.category === 'manual_completion'),
      totalDeducted: sumMarksPenalty(bucket),
    };
  }
  return subs;
};

module.exports = {
  bucketPenalties,
  sumMarksPenalty,
  computeFinal,
  attachFinalMarks,
  // Exported so the Fines & Penalties dashboard route can run the
  // same state-transition sweep before bucketing rows.
  _sweepStateTransitions,
};
