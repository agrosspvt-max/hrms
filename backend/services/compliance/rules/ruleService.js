/**
 * ruleService.js -- validation, versioning, audit for ComplianceRule.
 *
 * Controllers stay thin: parse HTTP -> call this service -> shape
 * the response.  Every mutation bumps `version` and emits an audit
 * row.  No detector / executor code lives here; this file is a
 * config-only service.
 */

const mongoose = require('mongoose');
const ComplianceRule = require('../../../models/ComplianceRule');
const { logAudit } = require('../../../utils/audit');

// Re-export the enum surface so controllers can validate against a
// single source of truth without importing the model directly.
const { ACTION_TYPES, MARKS_STRATEGIES } = ComplianceRule;

const CATEGORIES  = ['submission', 'dependency', 'attendance', 'conduct', 'custom'];
const SEVERITIES  = ['low', 'medium', 'high', 'critical'];
const APPROVER_ROLES  = ['hr', 'super_admin', 'hod'];
const RECOVERY_MODES  = ['restore', 'information', 'neutral'];

/**
 * Deterministic rule shape validation.  Throws an Error with a short
 * message the controller can surface as a 400.
 *
 * We only validate structure the model can't enforce on its own
 * (cross-field checks + action-type consistency).  Mongoose still
 * catches type / enum / required at save time.
 */
const validateRulePayload = (payload, { isUpdate = false } = {}) => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Rule payload must be an object.');
  }
  const required = isUpdate ? [] : ['code', 'name', 'category', 'detector'];
  for (const k of required) {
    if (!payload[k]) throw new Error(`Missing required field: ${k}`);
  }
  if (payload.category && !CATEGORIES.includes(payload.category)) {
    throw new Error(`Invalid category: ${payload.category}`);
  }
  if (payload.severity && !SEVERITIES.includes(payload.severity)) {
    throw new Error(`Invalid severity: ${payload.severity}`);
  }
  if (Array.isArray(payload.actions)) {
    const seen = new Set();
    for (const a of payload.actions) {
      if (!a || typeof a !== 'object') throw new Error('Action rows must be objects.');
      if (!ACTION_TYPES.includes(a.type)) {
        throw new Error(`Invalid action type: ${a.type}`);
      }
      // marksStrategy is optional; when present it must be one of ours.
      const strat = a.config && a.config.marksStrategy;
      if (strat && !MARKS_STRATEGIES.includes(strat)) {
        throw new Error(`Invalid marksStrategy: ${strat}`);
      }
      // Optional stable id -- used by clients to preserve targeting
      // across saves.  If provided, it must be unique within the rule.
      if (a._id && seen.has(String(a._id))) {
        throw new Error(`Duplicate action _id in payload: ${a._id}`);
      }
      if (a._id) seen.add(String(a._id));
    }
  }
  if (payload.trigger) {
    if (typeof payload.trigger !== 'object') throw new Error('trigger must be an object');
    if (payload.trigger.evaluationDelayDays !== undefined
        && (!Number.isFinite(payload.trigger.evaluationDelayDays)
            || payload.trigger.evaluationDelayDays < 0)) {
      throw new Error('trigger.evaluationDelayDays must be a non-negative number');
    }
    if (payload.trigger.thresholdDays !== undefined
        && (!Number.isFinite(payload.trigger.thresholdDays)
            || payload.trigger.thresholdDays < 0)) {
      throw new Error('trigger.thresholdDays must be a non-negative number');
    }
    if (payload.trigger.cutoffTime && !/^\d{2}:\d{2}$/.test(payload.trigger.cutoffTime)) {
      throw new Error('trigger.cutoffTime must be HH:MM');
    }
  }
  if (payload.waiver && Array.isArray(payload.waiver.approverRoles)) {
    for (const r of payload.waiver.approverRoles) {
      if (!APPROVER_ROLES.includes(r)) {
        throw new Error(`Invalid waiver.approverRoles entry: ${r}`);
      }
    }
  }
  if (payload.recovery && Array.isArray(payload.recovery.modes)) {
    for (const m of payload.recovery.modes) {
      if (!RECOVERY_MODES.includes(m)) {
        throw new Error(`Invalid recovery mode: ${m}`);
      }
    }
  }
  if (Array.isArray(payload.escalation)) {
    for (const step of payload.escalation) {
      if (!step || typeof step !== 'object') {
        throw new Error('escalation entries must be objects');
      }
      if (!Number.isFinite(step.afterDays) || step.afterDays < 1) {
        throw new Error('escalation.afterDays must be >= 1');
      }
      if (Array.isArray(step.actionsAdd)) {
        for (const a of step.actionsAdd) {
          if (!ACTION_TYPES.includes(a && a.type)) {
            throw new Error(`Invalid escalation action type: ${a && a.type}`);
          }
        }
      }
    }
  }
};

/** Fields that a client is allowed to update.  We intentionally
 *  reject `version`, `_id`, `createdAt`, `createdBy`; those are
 *  managed by the service. */
const _pickUpdatable = (src) => {
  const out = {};
  const keys = [
    'name', 'description', 'category', 'detector', 'enabled', 'severity',
    'trigger', 'scope', 'actions', 'notifications',
    'recovery', 'waiver', 'escalation',
  ];
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
};

const list = async () => ComplianceRule.find({}).sort({ category: 1, code: 1 }).lean();

const get = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return ComplianceRule.findById(id).lean();
};

const getByCode = async (code) => ComplianceRule.findOne({ code }).lean();

const create = async (payload, req) => {
  validateRulePayload(payload, { isUpdate: false });
  const doc = new ComplianceRule({
    ..._pickUpdatable(payload),
    code: String(payload.code).trim(),
    version: 1,
    createdBy: req && req.user ? req.user._id : null,
    updatedBy: req && req.user ? req.user._id : null,
  });
  try {
    await doc.save();
  } catch (e) {
    if (e && e.code === 11000) {
      throw new Error(`Rule code already exists: ${payload.code}`);
    }
    throw e;
  }
  logAudit(req, {
    action: 'compliance.rule.create',
    targetType: 'ComplianceRule',
    targetId: doc._id,
    targetLabel: doc.code,
    meta: {
      category: doc.category,
      detector: doc.detector,
      enabled:  doc.enabled,
    },
  });
  return doc.toObject();
};

const update = async (id, payload, req) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new Error('Invalid rule id.');
  const existing = await ComplianceRule.findById(id);
  if (!existing) throw new Error('Rule not found.');
  validateRulePayload(payload, { isUpdate: true });
  const patch = _pickUpdatable(payload);
  Object.assign(existing, patch);
  existing.version += 1;
  existing.updatedBy = req && req.user ? req.user._id : null;
  await existing.save();
  logAudit(req, {
    action: 'compliance.rule.update',
    targetType: 'ComplianceRule',
    targetId: existing._id,
    targetLabel: existing.code,
    meta: {
      version: existing.version,
      changed: Object.keys(patch),
    },
  });
  return existing.toObject();
};

const setEnabled = async (id, enabled, req) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new Error('Invalid rule id.');
  const existing = await ComplianceRule.findById(id);
  if (!existing) throw new Error('Rule not found.');
  if (existing.enabled === !!enabled) return existing.toObject();
  existing.enabled = !!enabled;
  existing.version += 1;
  existing.updatedBy = req && req.user ? req.user._id : null;
  await existing.save();
  logAudit(req, {
    action: enabled ? 'compliance.rule.enable' : 'compliance.rule.disable',
    targetType: 'ComplianceRule',
    targetId: existing._id,
    targetLabel: existing.code,
    meta: { version: existing.version, enabled: existing.enabled },
  });
  return existing.toObject();
};

module.exports = {
  list,
  get,
  getByCode,
  create,
  update,
  setEnabled,
  validateRulePayload,
  CATEGORIES,
  SEVERITIES,
  ACTION_TYPES,
  MARKS_STRATEGIES,
  APPROVER_ROLES,
  RECOVERY_MODES,
};
