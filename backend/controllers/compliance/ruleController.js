/**
 * ruleController.js -- HTTP surface for ComplianceRule CRUD.
 *
 * Auth model:
 *   - Read (list / get / history): HR / Super Admin.
 *   - Mutations (create / update / enable / disable): Super Admin.
 *     HR can be granted mutation power via a future
 *     featurePermissions.complianceRules flag (checked when present).
 *
 * Every mutation goes through ruleService, which is the sole place
 * that touches ComplianceRule + writes the audit trail.
 */

const asyncHandler = require('express-async-handler');
const ruleService  = require('../../services/compliance/rules/ruleService');
const { isEnabled } = require('../../config/featureFlags');
const AuditLog = require('../../models/AuditLog');

const _isAdmin      = (u) => u && (u.role === 'hr' || u.role === 'super_admin');
const _isSuperAdmin = (u) => u && u.role === 'super_admin';

const _hasRulePermission = (u) => {
  if (_isSuperAdmin(u)) return true;
  const perms = u && u.featurePermissions;
  const complianceRules = perms && (perms.toObject ? perms.toObject() : perms).complianceRules;
  return !!(complianceRules && complianceRules.enabled);
};

// Every route is gated by the phase feature flag so the phase is a
// no-op when disabled.  Return 404 rather than 403 so a probe can't
// discover the endpoints exist.
const _flagGate = (req, res) => {
  if (!isEnabled('compliance.rules')) {
    res.status(404);
    throw new Error('Compliance rules are not enabled on this deployment.');
  }
};

const list = asyncHandler(async (req, res) => {
  _flagGate(req, res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  const rows = await ruleService.list();
  res.json(rows);
});

const get = asyncHandler(async (req, res) => {
  _flagGate(req, res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  const row = await ruleService.get(req.params.id);
  if (!row) { res.status(404); throw new Error('Rule not found.'); }
  res.json(row);
});

const create = asyncHandler(async (req, res) => {
  _flagGate(req, res);
  if (!_hasRulePermission(req.user)) {
    res.status(403); throw new Error('Super Admin (or complianceRules feature) required.');
  }
  try {
    const doc = await ruleService.create(req.body || {}, req);
    res.status(201).json(doc);
  } catch (e) {
    res.status(400); throw e;
  }
});

const update = asyncHandler(async (req, res) => {
  _flagGate(req, res);
  if (!_hasRulePermission(req.user)) {
    res.status(403); throw new Error('Super Admin (or complianceRules feature) required.');
  }
  try {
    const doc = await ruleService.update(req.params.id, req.body || {}, req);
    res.json(doc);
  } catch (e) {
    if (/not found/i.test(e.message)) res.status(404);
    else res.status(400);
    throw e;
  }
});

const enable = asyncHandler(async (req, res) => {
  _flagGate(req, res);
  if (!_hasRulePermission(req.user)) {
    res.status(403); throw new Error('Super Admin (or complianceRules feature) required.');
  }
  try {
    const doc = await ruleService.setEnabled(req.params.id, true, req);
    res.json(doc);
  } catch (e) {
    if (/not found/i.test(e.message)) res.status(404);
    else res.status(400);
    throw e;
  }
});

const disable = asyncHandler(async (req, res) => {
  _flagGate(req, res);
  if (!_hasRulePermission(req.user)) {
    res.status(403); throw new Error('Super Admin (or complianceRules feature) required.');
  }
  try {
    const doc = await ruleService.setEnabled(req.params.id, false, req);
    res.json(doc);
  } catch (e) {
    if (/not found/i.test(e.message)) res.status(404);
    else res.status(400);
    throw e;
  }
});

/**
 * GET /api/compliance/rules/:id/history
 *
 * Returns every rule.create / rule.update / rule.enable / rule.disable
 * audit row for the rule, newest first.  Small, targeted query -- no
 * separate collection, no version snapshot to maintain.
 */
const history = asyncHandler(async (req, res) => {
  _flagGate(req, res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  // QA-fix H1 -- populate actor so the drawer can display the real
  // user's name/email instead of falling back to an ObjectId suffix.
  const rows = await AuditLog.find({
    targetType: 'ComplianceRule',
    targetId: req.params.id,
    action: { $in: ['compliance.rule.create', 'compliance.rule.update',
                    'compliance.rule.enable', 'compliance.rule.disable'] },
  })
    .sort({ createdAt: -1 })
    .populate('actor', 'name email')
    .lean();
  res.json(rows);
});

module.exports = { list, get, create, update, enable, disable, history };
