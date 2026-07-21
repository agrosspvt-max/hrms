/**
 * executors/index.js -- built-in action executors.
 *
 * Contract:
 *
 *   executorFn({ rule, actionConfig, incident, employee })
 *     -> Promise< { effectDoc, ledgerAppends: [ {ledger, ...args} ] } >
 *
 * Executors are PURE with respect to state -- they return the shape
 * the ActionEngine should persist.  The engine handles persistence
 * and idempotency; separating the two keeps executors trivially
 * unit-testable without a DB.
 *
 * `effectDoc` is the ComplianceActionEffect payload minus the fields
 * the engine fills in (incidentId, ruleId, ruleActionId, employee,
 * effectiveDate, ledgerRefs).  `ledgerAppends` is a list the engine
 * writes in order; ledger refs get stapled back onto the effect after
 * write.
 */

const registry = require('../../registry/actionExecutorRegistry');
const marksStrategies = require('../../marks/strategies');

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
/**
 * HR override lookup.
 *
 * Manual-source incidents created via POST /api/compliance/incidents
 * carry per-incident values on `detectorMeta.hrOverride`.  This lets
 * HR levy a ₹300 fine on one incident and ₹500 on another without
 * editing the rule config.  Automatic detectors do NOT populate this
 * object; those incidents fall through to the rule config as before.
 *
 * Precedence, per field:
 *   1. incident.detectorMeta.hrOverride[key]  (per-incident override)
 *   2. rule.actions[i].config[key]            (rule default)
 *   3. built-in fallback (0 / strategy chain)
 */
const _override = (incident, key) => {
  const raw = incident && incident.detectorMeta && incident.detectorMeta.hrOverride
    ? incident.detectorMeta.hrOverride[key]
    : undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const _resolveMarks = async ({ rule, actionConfig, incident, employee }) => {
  // HR override wins.  When an HR-created incident supplies a marks
  // override, use it as-is and skip the strategy chain.
  const hr = _override(incident, 'marks');
  if (hr !== undefined) return hr;

  const strat = (actionConfig.config && actionConfig.config.marksStrategy)
    || 'admin_defined';
  const strategyConfig = actionConfig.config && actionConfig.config.strategyConfig || {};
  return await marksStrategies.compute({
    strategy: strat,
    config: { ...(actionConfig.config || {}), ...strategyConfig },
    employee,
    template: incident && incident.context && incident.context.templateId
      ? { _id: incident.context.templateId } : null,
    day: incident.incidentDate || incident.effectiveDate,
  });
};

// ---------------------------------------------------------------
// Marks-flavour executors
// ---------------------------------------------------------------
const zeroDailyMarks = async (ctx) => {
  const marks = await _resolveMarks(ctx);
  return {
    effectDoc: {
      actionType: 'zero_daily_marks',
      status: 'active',
      marks,
    },
    ledgerAppends: [{
      ledger: 'marks', direction: -1, quantity: marks,
      date: ctx.incident.effectiveDate,
      type: 'action',
      reason: 'zero_daily_marks',
    }],
  };
};

const addDailyTotal = async (ctx) => {
  const marks = await _resolveMarks(ctx);
  return {
    effectDoc: { actionType: 'add_daily_total', status: 'active', marks },
    ledgerAppends: [{
      ledger: 'marks', direction: -1, quantity: marks,
      date: ctx.incident.effectiveDate, type: 'action',
      reason: 'add_daily_total',
    }],
  };
};

const fixedMarksReduction = async (ctx) => {
  // HR override precedence -> rule default.
  const hr = _override(ctx.incident, 'marks');
  const cfgMarks = Number(ctx.actionConfig.config && ctx.actionConfig.config.marks) || 0;
  const marks = Math.max(0, hr !== undefined ? hr : cfgMarks);
  return {
    effectDoc: { actionType: 'fixed_marks_reduction', status: 'active', marks },
    ledgerAppends: marks > 0 ? [{
      ledger: 'marks', direction: -1, quantity: marks,
      date: ctx.incident.effectiveDate, type: 'action',
      reason: 'fixed_marks_reduction',
    }] : [],
  };
};

// ---------------------------------------------------------------
// Percentage executor
// ---------------------------------------------------------------
const percentReduction = async (ctx) => {
  const cfg = ctx.actionConfig.config || {};
  // HR override precedence -> rule default.
  const hr = _override(ctx.incident, 'percent');
  const base = hr !== undefined
    ? hr
    : (Number(cfg.percent) || Number(cfg.percentPerDay) || 0);
  const percent = Math.max(0, base);
  const maxCap = Number(cfg.maxCap) || Infinity;
  const clamped = Math.min(percent, maxCap);
  return {
    effectDoc: { actionType: 'percent_reduction', status: 'active', percent: clamped },
    ledgerAppends: clamped > 0 ? [{
      ledger: 'percentage', direction: -1, quantity: clamped,
      date: ctx.incident.effectiveDate, type: 'action',
      reason: 'percent_reduction',
    }] : [],
  };
};

// ---------------------------------------------------------------
// Financial fine executor -- reads criticalAmount when the incident's
// detectorMeta flags a critical task.
// ---------------------------------------------------------------
const financialFine = async (ctx) => {
  const cfg = ctx.actionConfig.config || {};
  const critical = ctx.incident && ctx.incident.detectorMeta
    && ctx.incident.detectorMeta.criticalTask === true;
  // HR override precedence -> critical rate -> normal rate.  The
  // override does NOT auto-swap for criticalAmount -- HR entered a
  // specific number; respect it.
  const hr = _override(ctx.incident, 'amount');
  const base = hr !== undefined
    ? hr
    : Number(critical ? (cfg.criticalAmount || cfg.amount) : cfg.amount) || 0;
  const amount = Math.max(0, base);
  return {
    effectDoc: { actionType: 'financial_fine', status: 'active', amount },
    ledgerAppends: amount > 0 ? [{
      ledger: 'financial', direction: -1, quantity: amount,
      date: ctx.incident.effectiveDate, type: 'action',
      reason: 'financial_fine',
    }] : [],
  };
};

// ---------------------------------------------------------------
// Attendance executors
// ---------------------------------------------------------------
const _lwp = (unit) => async (ctx) => ({
  effectDoc: {
    actionType: unit === 0.5 ? 'half_day_lwp' : 'full_day_lwp',
    status: 'active',
    attendanceUnit: unit,
  },
  ledgerAppends: [{
    ledger: 'attendance', direction: -1, quantity: unit,
    date: ctx.incident.effectiveDate, type: 'action',
    reason: unit === 0.5 ? 'half_day_lwp' : 'full_day_lwp',
  }],
});

const halfDayLwp = _lwp(0.5);
const fullDayLwp = _lwp(1.0);

// ---------------------------------------------------------------
// Warning / notification -- no ledger write.
// ---------------------------------------------------------------
const warning = async () => ({
  effectDoc: { actionType: 'warning', status: 'active' },
  ledgerAppends: [],
});

// Batch-1 fix #5: the notification / manager_notification executors
// now emit a `notifications` intent that the ActionEngine dispatches
// via `services/compliance/notifications/notifyCompliance.send` after
// the effect row is committed.  Executors stay pure -- they return
// the intent, the engine performs the side effect.
const notification = async ({ rule, actionConfig, incident }) => ({
  effectDoc: { actionType: 'notification', status: 'active' },
  ledgerAppends: [],
  notifications: [{
    audience: 'employee',
    event: 'incident_notification',
    message: (actionConfig.config && actionConfig.config.template)
      || `${(rule && rule.name) || (incident && incident.ruleCode) || 'Compliance'}: action applied.`,
    mode: 'active',
  }],
});

const managerNotification = async ({ rule, actionConfig, incident }) => ({
  effectDoc: { actionType: 'manager_notification', status: 'active' },
  ledgerAppends: [],
  notifications: [{
    audience: 'manager',
    event: 'incident_notification',
    message: (actionConfig.config && actionConfig.config.template)
      || `${(rule && rule.name) || (incident && incident.ruleCode) || 'Compliance'}: escalation to manager.`,
    mode: 'active',
  }],
});

// ---------------------------------------------------------------
// Performance Lock executor -- carries the overdue task snapshot into
// the effect + BC-writes a legacy Penalty row so the current
// EmployeeDashboard's "Performance Lock Active" card keeps rendering.
// The legacy write is gated by !compliance.dualWrite so Phase 9 can
// flip it off once every consumer has moved.
// ---------------------------------------------------------------
const performanceLock = async (ctx) => {
  const overdue = (ctx.incident && ctx.incident.detectorMeta && ctx.incident.detectorMeta.oldest) || {};
  return {
    effectDoc: {
      actionType: 'performance_lock',
      status: 'active',
      taskRef: overdue,
    },
    ledgerAppends: [],
    // The engine consults this to decide whether to write the mirror
    // Penalty row.  Only performance_lock currently opts into the BC
    // shim -- other action types keep the legacy Penalty writes with
    // penaltyEngine.enforceAbsentSubmission etc.
    legacyPenalty: {
      category: 'performance_lock',
      penaltyMarks: 0,
      overdueRef: overdue,
    },
  };
};

// ---------------------------------------------------------------
// Suspend incentive -- placeholder that materialises an effect row
// but doesn't touch a ledger.  IncentiveLedger is a Phase 6/future
// extension; this row lets HR see the intent immediately.
// ---------------------------------------------------------------
const suspendIncentive = async () => ({
  effectDoc: { actionType: 'suspend_incentive', status: 'active' },
  ledgerAppends: [],
});

const custom = async () => ({
  effectDoc: { actionType: 'custom', status: 'active' },
  ledgerAppends: [],
});

// ---------------------------------------------------------------
// Registration
// ---------------------------------------------------------------
const _ALL = {
  zero_daily_marks:      zeroDailyMarks,
  add_daily_total:       addDailyTotal,
  fixed_marks_reduction: fixedMarksReduction,
  percent_reduction:     percentReduction,
  financial_fine:        financialFine,
  half_day_lwp:          halfDayLwp,
  full_day_lwp:          fullDayLwp,
  warning:               warning,
  notification:          notification,
  manager_notification:  managerNotification,
  performance_lock:      performanceLock,
  suspend_incentive:     suspendIncentive,
  custom:                custom,
};

let _done = false;
const registerAll = () => {
  if (_done) return;
  for (const [type, fn] of Object.entries(_ALL)) {
    if (!registry.get(type)) registry.register(type, fn);
  }
  _done = true;
};

module.exports = { registerAll, _ALL };
