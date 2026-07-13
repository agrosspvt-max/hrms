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
 * Phase 64 -- effective Available / Earned overrides per evaluation
 * mode on the shared performance-recovery workflow.  Returns the
 * "display" trio a UI should show for the submission's own row when
 * the strongest applicable penalty on it uses one of the modes.
 *
 *   restore     -- no override, marks unchanged
 *   information -- Available = original, Earned = 0
 *   neutral     -- Available = 0, Earned = 0
 *
 * When multiple penalties target the same submission, the STRONGEST
 * wins: neutral > information > restore.  Any manual/auto penalty
 * without an evaluationMode falls through to the standard math.
 */
const applyEvaluationOverride = (sub, penalties) => {
  const modes = (penalties || [])
    .filter((p) => p && p.evaluationMode && p.status === 'active' && !p.probable)
    .map((p) => p.evaluationMode);
  const has = (m) => modes.includes(m);
  const originalTotal  = Number(sub.totalPoints)  || 0;
  const originalEarned = Number(sub.earnedPoints) || 0;
  if (has('neutral')) {
    return {
      mode: 'neutral',
      availableMarks: 0,
      earnedMarks: 0,
      finalMarks: 0,
      originalTotal, originalEarned,
    };
  }
  if (has('information')) {
    return {
      mode: 'information',
      availableMarks: originalTotal,
      earnedMarks: 0,
      finalMarks: 0,
      originalTotal, originalEarned,
    };
  }
  return null;
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

    // Phase 64.1 Item 2 -- historical marks are IMMUTABLE.  We only
    // ever derive.  Every submission response now exposes the full
    // canonical audit trio so every UI surface reads the same fields:
    //   originalAvailableMarks / originalEarnedMarks
    //   penaltyDeduction        (capped at Earned so audit is readable)
    //   penaltyDeductionRaw     (uncapped Σ for engine-side inspection)
    //   manualRestoration       (from 'restore' evaluation mode)
    //   finalAvailableMarks / finalEarnedMarks / finalScore
    const originalAvailable = Number(s.totalPoints)  || 0;
    const originalEarned    = Number(s.earnedPoints) || 0;
    const penaltyDeductionRaw = sumMarksPenalty(bucket);
    // Phase 64.2 Item 1 -- cap the DISPLAY value at Earned so a day
    // that stacks (say) missed_submission + performance_lock never
    // shows "-174 penalty on 82 Earned".  Final Marks was already
    // clamped to 0 via Math.max in computeFinal; capping here keeps
    // the audit line arithmetically consistent (Earned - deduction
    // = Final, with everyone at 0 when penalties >= Earned).  The
    // uncapped total remains available on penaltyDeductionRaw for
    // engine + admin diagnostics.
    const penaltyDeduction  = Math.min(originalEarned, penaltyDeductionRaw);
    // Phase 64.2 Item 2 -- manualRestoration reads the audit field
    // now persistently stored by performanceRecovery.applyEvaluationMode
    // (`restoredMarks`).  Old rows without the field contribute 0.
    const manualRestoration = bucket
      .filter((p) => p && p.evaluationMode === 'restore' && p.status === 'resolved')
      .reduce((sum, p) => sum + (Number(p.restoredMarks) || 0), 0);

    // Phase 64 -- evaluation-mode override wins over raw marks math.
    const override = applyEvaluationOverride(s, bucket);
    if (override) {
      s.finalMarks = override.finalMarks;
      s.availableMarksDisplay = override.availableMarks;
      s.earnedMarksDisplay    = override.earnedMarks;
      s.evaluationMode        = override.mode;
    } else {
      s.finalMarks = computeFinal(originalEarned, bucket);
      s.availableMarksDisplay = originalAvailable;
      s.earnedMarksDisplay    = originalEarned;
      s.evaluationMode        = '';
    }

    // Phase 64.1 Item 2 -- canonical trio + restoration.  These are
    // the ONLY marks fields consumers should read going forward;
    // legacy fields (finalMarks, earnedMarksDisplay, etc.) are kept
    // for backward compat (Part 11) but new callers should use these.
    s.originalAvailableMarks = originalAvailable;
    s.originalEarnedMarks    = originalEarned;
    s.penaltyDeduction       = penaltyDeduction;
    s.manualRestoration      = manualRestoration;
    s.finalAvailableMarks    = s.availableMarksDisplay;
    s.finalEarnedMarks       = s.earnedMarksDisplay;
    s.finalScore             = s.finalMarks;

    s.penaltyBreakdown = {
      template:   bucket.filter((p) => p.category === 'absent_submission'
                                    || p.category === 'missed_submission'
                                    || p.category === 'critical_threshold'
                                    || p.category === 'repeated_missing'),
      attendance: bucket.filter((p) => p.category === 'attendance_manual'),
      dependency: bucket.filter((p) => p.category === 'dependency_pending'
                                    || p.category === 'performance_lock'),
      manual:     bucket.filter((p) => p.category === 'manual_marks'
                                    || p.category === 'manual_completion'
                                    || p.category === 'marks_adjustment'),
      // Phase 64.2 Item 1 -- consistent with the capped
      // `penaltyDeduction` so UI totals never exceed Earned.
      totalDeducted:    penaltyDeduction,
      totalDeductedRaw: penaltyDeductionRaw,
      // Phase 64.1 Item 3 -- surface every performance_lock row's
      // human-readable metadata so the UI can explain WHY (spec Item 5).
      performanceLocks: bucket
        .filter((p) => p.category === 'performance_lock' && !p.probable)
        .map((p) => ({
          _id: p._id,
          // Phase 64.1 Item 3 -- every locked day must be able to
          // explain WHY.  Expose the full metadata set the spec
          // enumerates so the UI never has to say only "0 Marks".
          lockReason:          p.reason || '',
          lockCategory:        p.category,
          pendingTask:         p.overdueRef?.taskTitle || '',
          pendingSince:        p.overdueRef?.pendingSince || null,
          allowedResolveDays:  null, // populated by caller from the source task if desired
          resolveBy:           p.overdueRef?.resolveBy || null,
          lockedSince:         p.effectiveDate || p.createdAt,
          unlockedAt:          p.resolvedAt || null,
          resolvedBy:          p.resolvedBy || null,
          restoredBy:          p.restoredBy || p.reopenRequest?.decidedBy || null,
          restorationReason:   p.restorationReason || p.reopenRequest?.decisionNote || '',
          status:              p.status,
          evaluationMode:      p.evaluationMode || '',
        })),
    };
  }
  return subs;
};

/**
 * Phase 64.1 Item 1 -- Completion Score Adjustment overlap math.
 *
 * Given a set of adjustment penalty rows and a query window
 * [queryFrom, queryTo], return the total percentage-points delta
 * that applies to the completion score for that window.  Rules:
 *
 *   - Only rows with category in { 'completion_adjustment',
 *     'manual_completion' } and status 'active' are considered.
 *   - For each row, compute the overlap between the row's
 *     evaluationPeriod and the query window.
 *   - Weight = overlap_days / query_days.  This is exactly the
 *     spec's "Whole Year -> Adjustment contributes only for Jul"
 *     behaviour: a -5% adjustment that covers 31 days of a 365-day
 *     query contributes -5 * (31/365) percentage points.
 *   - Multiple adjustments STACK additively (spec: -5% + -3% = -8%).
 *   - Rows with no evaluationPeriod are treated as legacy manual_
 *     completion penalties and applied at full weight (no overlap
 *     math) so old data doesn't drop off silently.
 *
 * Returns a Number (percentage points, e.g. -5 or -0.42).  Never
 * mutates the inputs (spec Part 11: no historical mutation).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const _toStart = (d) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

const computeCompletionAdjustment = (adjustments, queryFrom, queryTo) => {
  if (!Array.isArray(adjustments) || !queryFrom || !queryTo) return 0;
  const qStart = _toStart(queryFrom);
  const qEnd   = _toStart(queryTo);
  if (qEnd < qStart) return 0;
  const queryDays = Math.max(1, Math.round((qEnd - qStart) / DAY_MS) + 1);

  let total = 0;
  for (const a of adjustments) {
    if (!a) continue;
    // Cancelled / expired / resolved -> not active -> ignored.
    if (a.status !== 'active') continue;
    if (a.category !== 'completion_adjustment' && a.category !== 'manual_completion') continue;
    const pct = Number(a.completionPercent) || 0;
    if (pct === 0) continue;

    const period = a.evaluationPeriod || {};
    if (!period.startDate || !period.endDate) {
      // Legacy manual_completion penalties (pre-Phase-64) never
      // carried an evaluation window; apply them at full weight so
      // historical data continues to project.
      total += pct;
      continue;
    }
    const aStart = _toStart(period.startDate);
    const aEnd   = _toStart(period.endDate);
    // Overlap = [max(starts), min(ends)] inclusive.
    const overlapStart = new Date(Math.max(qStart.getTime(), aStart.getTime()));
    const overlapEnd   = new Date(Math.min(qEnd.getTime(),   aEnd.getTime()));
    if (overlapStart > overlapEnd) continue;
    const overlapDays = Math.max(1, Math.round((overlapEnd - overlapStart) / DAY_MS) + 1);
    const weight = Math.min(1, overlapDays / queryDays);
    total += pct * weight;
    // Note: subtraction of adjustment happens at the display layer
    // (Original - Adjustment = Final).  The stored pct field is the
    // magnitude of the deduction; callers use it verbatim.
  }
  return total;
};

/**
 * Phase 64.1 Item 6 helper -- convenience wrapper that returns a
 * { original, adjustment, final } trio suitable for display.
 *
 *   original    -- the completion percentage BEFORE any adjustment
 *   adjustment  -- negative if HR reduced it (spec's "-5%" case)
 *   final       -- clamped to [0, 100]
 */
const applyCompletionAdjustment = (originalPercent, adjustments, queryFrom, queryTo) => {
  const original = Number(originalPercent) || 0;
  const delta = computeCompletionAdjustment(adjustments, queryFrom, queryTo);
  // `pct` on a penalty is stored as a positive magnitude (spec's
  // "-5" is stored as 5, marked as a deduction).  Subtract here.
  const final = Math.max(0, Math.min(100, original - delta));
  return {
    original,
    adjustment: -delta, // signed for display ("-5%" is -5)
    final,
  };
};

module.exports = {
  bucketPenalties,
  sumMarksPenalty,
  computeFinal,
  attachFinalMarks,
  // Phase 64.1 -- shared helpers (spec Part 10: single source of truth).
  computeCompletionAdjustment,
  applyCompletionAdjustment,
  applyEvaluationOverride,
  // Exported so the Fines & Penalties dashboard route can run the
  // same state-transition sweep before bucketing rows.
  _sweepStateTransitions,
};
