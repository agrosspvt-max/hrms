/**
 * incidentController.js -- HTTP surface for ComplianceIncident.
 *
 * Employee-facing:
 *   GET  /api/compliance/incidents            (their own; auto-scoped)
 *   GET  /api/compliance/incidents/:id
 *   POST /api/compliance/incidents/:id/waive/request  (own only)
 *
 * HR / Super Admin:
 *   GET  /api/compliance/incidents            (filters: employee, from, to, status)
 *   POST /api/compliance/incidents             (manual creation)
 *   POST /api/compliance/incidents/:id/cancel
 *   POST /api/compliance/incidents/:id/recover
 *   POST /api/compliance/incidents/:id/waive
 *   POST /api/compliance/incidents/:id/waive/decide  (approve/reject)
 */

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const ComplianceIncident = require('../../models/ComplianceIncident');
const ComplianceRule     = require('../../models/ComplianceRule');
const ComplianceActionEffect = require('../../models/ComplianceActionEffect');
const ComplianceWaiver   = require('../../models/ComplianceWaiver');
const { isEnabled } = require('../../config/featureFlags');

const compliance = require('../../services/compliance');
const waiverService = require('../../services/compliance/waiver/waiverService');
const recoveryService = require('../../services/compliance/recovery/recoveryService');
const incidentService = compliance.incidentService;
const { naturalKey } = compliance;

const _isAdmin = (u) => u && (u.role === 'hr' || u.role === 'super_admin');
const _isHOD   = (u) => u && (u.role === 'hod' || u.isHOD === true);

const _flagGate = (res) => {
  if (!isEnabled('compliance.waiverRecovery')) {
    res.status(404);
    throw new Error('Compliance lifecycle endpoints are not enabled on this deployment.');
  }
};

// -----------------------------------------------------------
// GET /api/compliance/incidents
//
// Query parameters:
//   employee=<id>          (HR only)
//   status=<enum>
//   rule=<code>
//   from=<iso>  to=<iso>
//   limit=<n>              (default 200, hard cap 500)
//   includeEffects=true    (Batch-3 fix #18) -- attach `.effects` to each row
//   includeWaivers=true    (same, for waivers)
//
// Response shape is unchanged when `includeEffects` / `includeWaivers`
// are absent -- the endpoint returns a plain array of incident docs.
// When either flag is present, each incident row gains an inline
// `effects` and/or `waivers` array populated via one bulk `$in`
// query -- eliminating the N+1 pattern (one extra fetch per row) a
// client that currently calls `GET /incidents/:id` in a loop would
// exhibit.
// -----------------------------------------------------------
const _truthy = (v) => v === true || v === 'true' || v === '1' || v === 1;

const list = asyncHandler(async (req, res) => {
  _flagGate(res);
  const where = {};
  if (_isAdmin(req.user)) {
    if (req.query.employee && mongoose.Types.ObjectId.isValid(req.query.employee)) {
      where.employee = req.query.employee;
    }
  } else {
    // Employees see their own only.
    where.employee = req.user._id;
  }
  if (req.query.status)  where.status  = req.query.status;
  if (req.query.rule)    where.ruleCode = req.query.rule;
  if (req.query.from || req.query.to) {
    where.incidentDate = {};
    if (req.query.from) where.incidentDate.$gte = new Date(req.query.from);
    if (req.query.to)   where.incidentDate.$lte = new Date(req.query.to);
  }
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const rows = await ComplianceIncident.find(where)
    .sort({ incidentDate: -1 })
    .limit(limit)
    .lean();

  const wantEffects = _truthy(req.query.includeEffects);
  const wantWaivers = _truthy(req.query.includeWaivers);
  if (!wantEffects && !wantWaivers) {
    // Preserve legacy array-of-incidents shape.
    return res.json(rows);
  }
  if (rows.length === 0) return res.json(rows);

  const ids = rows.map((r) => r._id);
  // Batch-3 fix #18 -- ONE bulk query per requested attachment,
  // regardless of how many incidents came back.  Groups on the
  // server, indexes on client.  Preserves per-row order + pagination.
  const [effectsByInc, waiversByInc] = await Promise.all([
    wantEffects
      ? (async () => {
          const effs = await ComplianceActionEffect.find({ incidentId: { $in: ids } }).lean();
          const map = new Map();
          for (const e of effs) {
            const k = String(e.incidentId);
            const arr = map.get(k) || [];
            arr.push(e);
            map.set(k, arr);
          }
          return map;
        })()
      : null,
    wantWaivers
      ? (async () => {
          const wvs = await ComplianceWaiver.find({ incidentId: { $in: ids } })
            .sort({ requestedAt: -1 }).lean();
          const map = new Map();
          for (const w of wvs) {
            const k = String(w.incidentId);
            const arr = map.get(k) || [];
            arr.push(w);
            map.set(k, arr);
          }
          return map;
        })()
      : null,
  ]);

  for (const row of rows) {
    if (effectsByInc) row.effects = effectsByInc.get(String(row._id)) || [];
    if (waiversByInc) row.waivers = waiversByInc.get(String(row._id)) || [];
  }
  res.json(rows);
});

const get = asyncHandler(async (req, res) => {
  _flagGate(res);
  // Populate createdBy so the frontend can display "Created by …" for
  // manual incidents; falls back to no-op when the field is null
  // (automatic incidents leave createdBy unset).
  const row = await ComplianceIncident.findById(req.params.id)
    .populate('createdBy', 'name email')
    .lean();
  if (!row) { res.status(404); throw new Error('Incident not found.'); }
  if (!_isAdmin(req.user) && String(row.employee) !== String(req.user._id)) {
    res.status(403); throw new Error('You may not view this incident.');
  }
  const [effects, waivers] = await Promise.all([
    ComplianceActionEffect.find({ incidentId: row._id }).lean(),
    ComplianceWaiver.find({ incidentId: row._id }).sort({ requestedAt: -1 }).lean(),
  ]);
  res.json({ incident: row, effects, waivers });
});

// -----------------------------------------------------------
// POST /api/compliance/incidents  (HR manual creation)
// -----------------------------------------------------------
const create = asyncHandler(async (req, res) => {
  _flagGate(res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  const {
    ruleCode, employee, incidentDate,
    context = {}, detectorMeta = {}, severity, token,
  } = req.body || {};
  if (!ruleCode)  { res.status(400); throw new Error('ruleCode is required.'); }
  if (!employee || !mongoose.Types.ObjectId.isValid(employee)) {
    res.status(400); throw new Error('Valid employee id is required.');
  }
  const rule = await ComplianceRule.findOne({ code: ruleCode }).lean();
  if (!rule)   { res.status(404); throw new Error('Rule not found.'); }
  if (!rule.enabled) {
    res.status(400); throw new Error('Rule is disabled; enable it before creating incidents.');
  }
  const day = incidentDate ? new Date(incidentDate) : new Date();
  const effectiveDate = compliance.dates.computeEffectiveDate(rule, day);
  const nk = naturalKey.manualIncidentKey({
    ruleCode: rule.code, employeeId: employee, day,
    token: token || String(new mongoose.Types.ObjectId()),
  });
  const { incident, created } = await incidentService.recordIncident({
    rule, employeeId: employee, naturalKey: nk,
    incidentDate: day, effectiveDate,
    context, detectorMeta,
    source: 'manual',
    severity, actor: req.user._id, req,
  });
  res.status(created ? 201 : 200).json(incident);
});

// -----------------------------------------------------------
// POST /api/compliance/incidents/:id/cancel  (HR only)
// -----------------------------------------------------------
const cancel = asyncHandler(async (req, res) => {
  _flagGate(res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  const row = await incidentService.cancelIncident(req.params.id, {
    reason: req.body && req.body.reason,
    actor:  req.user._id,
    req,
  });
  if (!row) { res.status(404); throw new Error('Incident not found.'); }
  res.json(row);
});

// -----------------------------------------------------------
// POST /api/compliance/incidents/:id/recover  (HR only)
// -----------------------------------------------------------
const recover = asyncHandler(async (req, res) => {
  _flagGate(res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  try {
    const doc = await recoveryService.apply({
      incidentId: req.params.id,
      effectIds: req.body && req.body.effectIds,
      mode:      req.body && req.body.mode,
      reason:    req.body && req.body.reason,
      actor:     req.user._id, req,
    });
    res.json(doc);
  } catch (e) {
    res.status(400); throw e;
  }
});

// -----------------------------------------------------------
// POST /api/compliance/incidents/:id/waive        (HR direct waive)
// POST /api/compliance/incidents/:id/waive/request (employee request)
// POST /api/compliance/incidents/:id/waive/decide  (HR decide)
// -----------------------------------------------------------
const waiveDirect = asyncHandler(async (req, res) => {
  _flagGate(res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  const { scope = 'full', effectIds = [], reason = '' } = req.body || {};
  const waiver = await waiverService.request({
    incidentId: req.params.id, scope, effectIds, reason,
    requestedBy: req.user._id, req,
  });
  const decided = await waiverService.decide({
    waiverId: waiver._id, decision: 'auto_approved',
    note: reason,
    decidedBy: req.user._id, req,
  });
  res.json(decided);
});

const waiveRequest = asyncHandler(async (req, res) => {
  _flagGate(res);
  const inc = await ComplianceIncident.findById(req.params.id).lean();
  if (!inc) { res.status(404); throw new Error('Incident not found.'); }
  if (!_isAdmin(req.user) && String(inc.employee) !== String(req.user._id)) {
    res.status(403); throw new Error('You may only raise waiver requests on your own incidents.');
  }
  try {
    const waiver = await waiverService.request({
      incidentId: req.params.id,
      scope:  (req.body && req.body.scope) || 'full',
      effectIds: (req.body && req.body.effectIds) || [],
      reason: req.body && req.body.reason,
      evidenceUrl: req.body && req.body.evidenceUrl,
      requestedBy: req.user._id, req,
    });
    res.status(201).json(waiver);
  } catch (e) { res.status(400); throw e; }
});

const waiveDecide = asyncHandler(async (req, res) => {
  _flagGate(res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  try {
    const waiver = await waiverService.decide({
      waiverId: req.body && req.body.waiverId,
      decision: req.body && req.body.decision,
      note:     req.body && req.body.note,
      decidedBy: req.user._id, req,
    });
    res.json(waiver);
  } catch (e) { res.status(400); throw e; }
});

module.exports = {
  list, get, create, cancel, recover,
  waiveDirect, waiveRequest, waiveDecide,
};
