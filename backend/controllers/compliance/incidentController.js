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
const { logAudit } = require('../../utils/audit');

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
  // Populate `employee` so employee-centric list rendering doesn't
  // need N+1 lookups.  Nested populate resolves department name +
  // designation title (same shape the incident-detail endpoint uses).
  // Mongoose dedupes the underlying User query, so populating
  // hundreds of incidents from a small employee cohort costs one
  // extra query, not one-per-row.
  const rows = await ComplianceIncident.find(where)
    .sort({ incidentDate: -1 })
    .limit(limit)
    .populate({
      path: 'employee',
      select: 'name employeeId department designation',
      populate: [
        { path: 'department',  select: 'name' },
        { path: 'designation', select: 'title' },
      ],
    })
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
  // Populate:
  //   - createdBy so the frontend can display "Created by …" for
  //     manual incidents; auto incidents leave createdBy null.
  //   - employee so the panel can display Name / Employee ID /
  //     Department / Designation without a second round-trip.  Nested
  //     populate resolves the department name + designation title
  //     (same shape the employee-directory endpoint returns).
  const row = await ComplianceIncident.findById(req.params.id)
    .populate('createdBy', 'name email')
    .populate({
      path: 'employee',
      select: 'name employeeId department designation',
      populate: [
        { path: 'department',  select: 'name' },
        { path: 'designation', select: 'title' },
      ],
    })
    .lean();
  if (!row) { res.status(404); throw new Error('Incident not found.'); }
  // `row.employee` is a populated object post-populate; fall through to
  // its _id.  When populate misses (deleted user) it's still a plain
  // ObjectId string, which String() also handles cleanly.
  const employeeId = (row.employee && row.employee._id) || row.employee;
  if (!_isAdmin(req.user) && String(employeeId) !== String(req.user._id)) {
    res.status(403); throw new Error('You may not view this incident.');
  }
  const [effects, waivers] = await Promise.all([
    ComplianceActionEffect.find({ incidentId: row._id }).lean(),
    ComplianceWaiver.find({ incidentId: row._id }).sort({ requestedAt: -1 }).lean(),
  ]);
  res.json({ incident: row, effects, waivers });
});


// -----------------------------------------------------------
// Manual issue validation (marks / completion / fine / warning).  Mirrors the
// checks of the legacy POST /api/penalties/manual and adds the submission link
// check, so a manual consequence is as safe as an automatic one.
// -----------------------------------------------------------
const _validateManualIssue = async ({ req, res, rule, employee, context, detectorMeta }) => {
  const bad = (msg) => { res.status(400); throw new Error(msg); };
  const User = require('../../models/User');
  if (!(await User.findById(employee).select('_id').lean())) { res.status(404); throw new Error('Employee not found.'); }

  const meta = { ...(detectorMeta || {}) };
  const ov = meta.hrOverride && typeof meta.hrOverride === 'object' ? meta.hrOverride : {};
  const clean = {};
  for (const k of ['marks', 'percent', 'amount']) {
    if (ov[k] === undefined || ov[k] === null || ov[k] === '') continue;
    const n = Number(ov[k]);
    if (!Number.isFinite(n) || n < 0) bad(`${k} must be a number >= 0.`);
    clean[k] = n;
  }
  const types = new Set((rule.actions || []).filter((a) => a.enabled !== false).map((a) => a.type));
  const cfg = (t) => ((rule.actions || []).find((a) => a.type === t) || {}).config || {};

  if (types.has('financial_fine')) {
    const amt = clean.amount !== undefined ? clean.amount : Number(cfg('financial_fine').amount) || 0;
    if (!(amt > 0)) bad('amount must be > 0 for a financial fine.');
  }
  if (types.has('percent_reduction') && rule.detector === 'manual') {
    const per = ov.evaluationPeriod;
    if (!per || !per.startDate || !per.endDate) bad('Completion adjustment requires evaluationPeriod {startDate, endDate} (past dates).');
    const { startOfDay } = require('../../utils/dateHelpers');
    const s = startOfDay(new Date(per.startDate)), e = startOfDay(new Date(per.endDate)), today = startOfDay(new Date());
    if (!(s <= e)) bad('evaluationPeriod.startDate must be on or before endDate.');
    if (s > today || e > today) bad('Completion adjustment period must be strictly in the past.');
    clean.evaluationPeriod = { startDate: s, endDate: e };
  }

  const ctx = { ...(context || {}) };
  if (ctx.submissionId) {
    // A marks effect is bound to this submission: it must be the employee's own live row.
    if (!mongoose.Types.ObjectId.isValid(ctx.submissionId)) bad('submissionId is not valid.');
    const link = require('../../services/compliance/submissionLink');
    const sub = await link.explicitIfLive(employee, ctx.submissionId);
    if (!sub) bad('submissionId must be a live (not deleted / test / hidden) submission of this employee.');
  }
  meta.hrOverride = clean;
  if (req.body && req.body.reason) meta.reason = String(req.body.reason).trim().slice(0, 500);
  if (req.body && req.body.employeeMessage) meta.employeeMessage = String(req.body.employeeMessage).trim().slice(0, 500);
  return { context: ctx, detectorMeta: meta };
};

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
  const sanitized = await _validateManualIssue({ req, res, rule, employee, context, detectorMeta });
  let effectiveDate = compliance.dates.computeEffectiveDate(rule, day);
  // Optional grace period (legacy manual marks): the incident stays `candidate`
  // and the effects are applied by the scheduler once the grace has passed.
  const grace = Number(req.body && req.body.graceHours) || 0;
  if (grace > 0) effectiveDate = new Date(Date.now() + grace * 3600e3);
  const nk = naturalKey.manualIncidentKey({
    ruleCode: rule.code, employeeId: employee, day,
    token: token || String(new mongoose.Types.ObjectId()),
  });
  const { incident, created } = await incidentService.recordIncident({
    rule, employeeId: employee, naturalKey: nk,
    incidentDate: day, effectiveDate,
    context: sanitized.context, detectorMeta: sanitized.detectorMeta,
    source: 'manual',
    severity, actor: req.user._id, req,
  });
  // A manual consequence is immediate (legacy POST /penalties/manual was): unless a
  // grace period was asked for, put the new incident in force and apply its
  // effects now instead of waiting for the next daily tick.  Idempotent -- the
  // promotion is an atomic compare-and-set and effects have unique keys.
  let out = incident;
  if (created && !(grace > 0) && new Date(incident.effectiveDate) <= new Date()) {
    try {
      const promoted = await incidentService.promoteToActive(incident._id);
      if (promoted) {
        await compliance.actionEngine.apply({ incident: promoted, day: new Date() });
        out = promoted;
      }
    } catch (e) { console.error('[compliance/create] immediate apply failed:', e.message); }
  }
  res.status(created ? 201 : 200).json(out);
});

// -----------------------------------------------------------
// POST /api/compliance/incidents/:id/cancel  (HR only)
// -----------------------------------------------------------
const cancel = asyncHandler(async (req, res) => {
  _flagGate(res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  let row;
  try {
    row = await incidentService.cancelIncident(req.params.id, {
      reason: req.body && req.body.reason,
      actor:  req.user._id,
      req,
    });
  } catch (e) { res.status(e.httpStatus || 400); throw e; }
  if (!row) { res.status(404); throw new Error('Incident not found.'); }
  res.json(row);
});

// -----------------------------------------------------------
// POST /api/compliance/incidents/:id/activate  (HR only)
//
// Manually promote a `candidate` incident to `active` immediately
// and fire the action engine.  Bypasses the scheduler's
// evaluationDelayDays gate so HR can apply consequences before the
// natural effective date.  Idempotent: repeat calls on an already-
// active incident return 409.
// -----------------------------------------------------------
const activate = asyncHandler(async (req, res) => {
  _flagGate(res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  const inc = await ComplianceIncident.findOneAndUpdate(
    { _id: req.params.id, status: 'candidate' },
    { $set: { status: 'active' } },
    { new: true },
  );
  if (!inc) { res.status(409); throw new Error('Incident is not in candidate state.'); }
  // Fire the action engine so effect + ledger rows land.  The engine
  // is idempotent on the (incident, ruleAction, effectiveDate) natural
  // key, so any re-runs are safe.
  const day = new Date();
  try {
    await compliance.actionEngine.apply({ incident: inc, day });
  } catch (e) {
    console.error('[compliance/incident/activate] apply failed:', e.message);
  }
  // Reuse the same event + audit that promoteToActive would have written.
  await incidentService._emitEvent({
    employee: inc.employee, incidentId: inc._id,
    kind: 'incident_effective',
    payload: {
      ruleCode: inc.ruleCode,
      effectiveDate: inc.effectiveDate,
      manual: true,
      reason: (req.body && req.body.reason) || undefined,
    },
    actor: req.user._id,
  });
  logAudit(req, {
    action: 'compliance.incident.activate',
    targetType: 'ComplianceIncident',
    targetId: inc._id,
    targetLabel: inc.ruleCode,
    meta: { reason: (req.body && req.body.reason) || '', employee: String(inc.employee) },
  });
  res.json(inc.toObject ? inc.toObject() : inc);
});

// -----------------------------------------------------------
// POST /api/compliance/incidents/:id/resolve  (HR only)
//
// Marks an incident resolved without reversing effects.  Suitable
// when the underlying condition cleared but the recorded penalty
// should stand.  For a resolution that ALSO refunds the ledger use
// POST /:id/recover.
// -----------------------------------------------------------
const resolve = asyncHandler(async (req, res) => {
  _flagGate(res);
  if (!_isAdmin(req.user)) { res.status(403); throw new Error('HR / Super Admin only.'); }
  let row;
  try {
    row = await incidentService.resolveIncident(req.params.id, {
      reason: req.body && req.body.reason,
      actor:  req.user._id,
      req,
      strict: true,   // a cancelled / waived incident is an error, not a silent success
    });
  } catch (e) { res.status(e.httpStatus || 400); throw e; }
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
    res.status(e.httpStatus || 400); throw e;
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
  try {
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
  } catch (e) { res.status(e.httpStatus || 400); throw e; }
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
  } catch (e) { res.status(e.httpStatus || 400); throw e; }
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
  } catch (e) { res.status(e.httpStatus || 400); throw e; }
});

// -----------------------------------------------------------
// POST /api/compliance/incidents/:id/acknowledge  (the employee concerned)
// -----------------------------------------------------------
const acknowledge = asyncHandler(async (req, res) => {
  _flagGate(res);
  try {
    const row = await require('../../services/compliance/acknowledgement/acknowledgementService')
      .acknowledge({ incidentId: req.params.id, user: req.user, req });
    res.json(row);
  } catch (e) { res.status(e.httpStatus || 400); throw e; }
});

// -----------------------------------------------------------
// GET /api/compliance/me/accountability  (the employee's own warnings + penalties,
// same {active, probable, resolved} shape as the legacy /penalties/mine)
// -----------------------------------------------------------
const myAccountability = asyncHandler(async (req, res) => {
  _flagGate(res);
  res.json(await require('../../services/compliance/projections/accountability')
    .forEmployee({ employeeId: req.user._id }));
});

module.exports = {
  list, get, create, cancel, recover, activate, resolve, acknowledge, myAccountability,
  waiveDirect, waiveRequest, waiveDecide,
};
