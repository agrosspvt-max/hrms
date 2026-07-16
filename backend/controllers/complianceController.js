/**
 * complianceController.js
 *
 * Phase-1 architecture: read handlers never mutate.  The Penalty
 * Engine used to be invoked lazily inside GET /api/submissions/today
 * -- that broke the read/write rule, produced duplicate notifications,
 * and re-triggered on every dashboard refresh.
 *
 * The engine still needs an on-demand path (employee wants an
 * immediate re-scan after fixing a submission, HR wants to force a
 * sweep after data cleanup).  This controller is that path -- an
 * explicit POST that the client calls with intent.
 *
 * Endpoints:
 *   POST /api/compliance/refresh          -- re-run the engine for the
 *                                            caller (or the specified
 *                                            employee when caller is HR).
 *   POST /api/compliance/refresh/all      -- HR / Super Admin only,
 *                                            forces the org-wide sweep.
 */
const asyncHandler = require('express-async-handler');
const penaltyEngine = require('../services/penaltyEngine');
const { startOfDay } = require('../utils/dateHelpers');

const _isAdmin = (u) => u && (u.role === 'hr' || u.role === 'super_admin');

const refresh = asyncHandler(async (req, res) => {
  const day = startOfDay(new Date());
  const target = req.body?.employeeId && _isAdmin(req.user)
    ? req.body.employeeId
    : req.user._id;
  try {
    const enforced = await penaltyEngine.runDaily({ employeeId: target, day });
    // Probables intentionally left off -- Phase 64 Part 2 disabled
    // same-day warnings.  Kept out here so a client refresh doesn't
    // re-trigger the disabled path.
    res.json({ ok: true, refreshedAt: new Date(), enforced: enforced?.enforced?.length || 0 });
  } catch (err) {
    console.error('[compliance-refresh] runDaily failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const refreshAll = asyncHandler(async (req, res) => {
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  const { runOnceForAll } = require('../services/dailyComplianceScheduler');
  const summary = await runOnceForAll();
  res.json({ ok: true, summary });
});

module.exports = { refresh, refreshAll };
