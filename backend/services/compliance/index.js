/**
 * Compliance & Accountability -- barrel export.
 *
 * Loading this file is the sanctioned way to bring the compliance
 * engine into a controller / test / cron.  It also runs a one-shot
 * boot log so it's obvious in dev / staging that the new engine's
 * scaffold is present.
 *
 * The individual submodules stay small and cohesive; call sites
 * import from this barrel to keep import paths stable across future
 * refactors.
 */

const featureFlags = require('../../config/featureFlags');
const detectorRegistry = require('./registry/detectorRegistry');
const actionExecutorRegistry = require('./registry/actionExecutorRegistry');
const marksStrategyRegistry = require('./registry/marksStrategyRegistry');
const naturalKey = require('./naturalKey');
const dates = require('./dates');
// Phase 4 -- register built-in detectors on first import.  Safe on
// re-import; the registration helper is latched.
const detectorRegisterAll = require('./detectors/register');
detectorRegisterAll.registerAll();
const ruleEvaluationScheduler = require('./scheduler/ruleEvaluationScheduler');
const incidentService = require('./incidents/incidentService');
// Phase 5 -- register built-in marks strategies + action executors.
const marksStrategies = require('./marks/strategies');
marksStrategies.registerAll();
const executors = require('./actions/executors');
executors.registerAll();
const actionEngine = require('./actions/actionEngine');
const ledgerService = require('./ledger/ledgerService');
// Phase 6 lifecycle services.
const waiverService   = require('./waiver/waiverService');
const recoveryService = require('./recovery/recoveryService');
const escalationRunner = require('./escalation/escalationRunner');
const timelineService = require('./timeline/timelineService');
const ledgerReconciler = require('./reconciliation/ledgerReconciler');

// One-shot boot banner.  Prints once per process regardless of how
// many callers import the barrel.
let _bannerPrinted = false;
const logBoot = () => {
  if (_bannerPrinted) return;
  _bannerPrinted = true;
  if (!featureFlags.isEnabled('compliance.scaffold')) return;
  const snap = featureFlags.snapshot();
  const on = Object.entries(snap).filter(([, v]) => v).map(([k]) => k);
  console.log(
    `[compliance] scaffold loaded (v2). flags on: ${on.join(', ') || '(none)'}`,
  );
};

module.exports = {
  featureFlags,
  detectorRegistry,
  actionExecutorRegistry,
  marksStrategyRegistry,
  naturalKey,
  dates,
  ruleEvaluationScheduler,
  incidentService,
  actionEngine,
  ledgerService,
  marksStrategies,
  waiverService,
  recoveryService,
  escalationRunner,
  timelineService,
  ledgerReconciler,
  logBoot,
};
