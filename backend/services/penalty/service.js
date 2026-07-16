/**
 * services/penalty/service.js
 *
 * Domain-facing façade over penaltyEngine + performanceRecovery.
 * Controllers should import from HERE rather than reach into engine
 * internals -- keeps controller code thin and business logic
 * discoverable.
 */
const penaltyEngine     = require('../penaltyEngine');
const performanceRecovery = require('../performanceRecovery');

module.exports = {
  // Engine orchestration.
  runDaily:                penaltyEngine.runDaily,
  runProbablesForToday:    penaltyEngine.runProbablesForToday,
  resolveAbsentOnSubmit:   penaltyEngine.resolveAbsentSubmissionOnSubmit,
  onDependencyResolved:    penaltyEngine.onDependencyResolved,
  onPendingTaskResolved:   penaltyEngine.onPendingTaskResolved,
  enforcePerformanceLock:  penaltyEngine.enforcePerformanceLock,

  // Recovery (HR action: restore / information / neutral).
  applyRecovery:           performanceRecovery.applyRecovery,
};
