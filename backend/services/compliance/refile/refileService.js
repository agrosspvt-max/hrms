/**
 * refileService.js -- request / decide / send back / revoke / consume a
 * re-file grant (ComplianceRefile).  See models/ComplianceRefile.js for the
 * concept and state machine; services/compliance/refile/refileEligibility.js
 * for the read side.
 *
 * Roles (same as the legacy reopen flow):
 *   request   the employee, for their OWN missed day only (HR cannot request on
 *             someone's behalf; HR uses sendBack)
 *   decide / sendBack / revoke   HR and Super Admin only (HODs do not take part)
 *
 * Every transition is an atomic compare-and-set on `status`, so concurrent or
 * repeated calls produce exactly one effect, and writes exactly one event.
 * Repeating the SAME decision is a no-op; the OPPOSITE decision after a
 * terminal state is a 409.
 */
const mongoose = require('mongoose');
const Submission = require('../../../models/Submission');
const ComplianceRefile = require('../../../models/ComplianceRefile');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const Penalty = require('../../../models/Penalty');
const lifecycle = require('../lifecycle');
const eligibility = require('./refileEligibility');
const { liveSubmissionFilter } = require('../../../utils/submissionFilter');
const { startOfDay } = require('../../../utils/dateHelpers');
const { logAudit } = require('../../../utils/audit');

const MODES = ['restore', 'information', 'neutral'];
const isAdmin = (u) => !!u && (u.role === 'hr' || u.role === 'super_admin');
const err = (msg, httpStatus, code) => new lifecycle.LifecycleError(msg, { httpStatus, code });
const OPEN_INCIDENT = lifecycle.OPEN_INCIDENT;

const _emit = async (args) => {
  try {
    const ComplianceEvent = require('../../../models/ComplianceEvent');
    await ComplianceEvent.create({ ts: new Date(), payload: {}, ...args });
  } catch (e) { console.error('[compliance/refile] event emit failed:', e.message); }
};
const _audit = (req, action, row, meta = {}) => {
  if (!req) return;
  try {
    logAudit(req, { action, targetType: 'ComplianceRefile', targetId: row._id, targetLabel: 'refile',
      meta: { employee: String(row.employee), submissionId: String(row.submissionId), ...meta } });
  } catch (_) { /* audit is best effort */ }
};
const _plain = (d) => (d && d.toObject ? d.toObject() : (d ? { ...d } : d));

const _missedIncidentFor = async (submissionId) => ComplianceIncident.findOne({
  'context.submissionId': submissionId, ruleCode: { $in: eligibility.MISSED_RULES }, status: { $in: OPEN_INCIDENT },
}).select('_id').lean();

const _openFor = (submissionId) => ComplianceRefile.findOne({ submissionId, open: true }).lean();

/* ------------------------------------------------------------------ */
/* Employee: request                                                   */
/* ------------------------------------------------------------------ */
const request = async ({ user, submissionId, reason = '', req = null, today = startOfDay(new Date()) }) => {
  if (!user || !user._id) throw err('Authentication required.', 401, 'unauthenticated');
  if (!submissionId || !mongoose.Types.ObjectId.isValid(submissionId)) throw err('A valid submissionId is required.', 400, 'bad_request');
  const why = String(reason || '').trim();
  if (!why) throw err('Reason is required.', 400, 'reason_required');

  const sub = await Submission.findById(submissionId).lean();
  if (!sub) throw err('Submission not found.', 404, 'not_found');
  if (String(sub.employee) !== String(user._id)) throw err('Not your submission.', 403, 'forbidden');
  if (!eligibility.isLive(sub)) throw err('This submission cannot be re-filed.', 400, 'not_live');
  if (sub.submitted) throw err('This submission is already submitted.', 409, 'already_submitted');

  const gate = await eligibility.check({ submission: sub, today });
  if (gate.state === 'current_day') throw err('A same-day submission does not need a re-file request.', 400, 'current_day');
  if (gate.state === 'not_gated') throw err('There is no missed-submission record for this day; nothing to reopen.', 400, 'not_gated');

  const existing = await _openFor(sub._id);
  if (existing) return { ...existing, alreadyRequested: true };
  if (gate.state === 'granted') return { employee: sub.employee, submissionId: sub._id, status: 'approved', alreadyRequested: true };

  const inc = await _missedIncidentFor(sub._id);
  let row;
  try {
    row = await ComplianceRefile.create({
      employee: sub.employee, submissionId: sub._id, targetDate: sub.date, incidentId: inc ? inc._id : null,
      status: 'pending', open: true, source: 'employee', requestedBy: user._id, requestedAt: new Date(), reason: why,
    });
  } catch (e) {
    if (e && e.code === 11000) {                       // lost a race to an identical request
      const winner = await _openFor(sub._id);
      if (winner) return { ...winner, alreadyRequested: true };
    }
    throw e;
  }
  await _emit({ employee: sub.employee, incidentId: inc ? inc._id : null, kind: 'refile_requested',
    payload: { refileId: row._id, submissionId: sub._id, targetDate: sub.date, reason: why }, actor: user._id });
  _audit(req, 'compliance.refile.request', row, { reason: why });
  return _plain(row);
};

/* ------------------------------------------------------------------ */
/* Bridge side effects of an approval that carries an evaluation mode  */
/* ------------------------------------------------------------------ */
const _applyMode = async ({ sub, mode, note, actor, req }) => {
  const out = { mode, compliance: { applied: false }, legacy: { applied: false } };
  if (!mode) return out;
  // Compliance: recover the missed-day incident (same three modes).
  try {
    const inc = await _missedIncidentFor(sub._id);
    if (inc) {
      await require('../recovery/recoveryService').apply({ incidentId: inc._id, mode, reason: note || 'Re-file approved', actor: actor._id, req, skipLegacyMirror: true });
      out.compliance = { applied: true, incidentId: inc._id };
    }
  } catch (e) { out.compliance = { applied: false, reason: e.message }; }
  // BRIDGE: while the legacy Penalty still drives Final Marks, apply the same
  // mode to the matching legacy row (and mark its reopen approved) so the two
  // stores stay equivalent.  Remove with the Penalty system.
  try {
    const pen = await Penalty.findOne({ submission: sub._id, category: { $in: eligibility.MISSED_CATS }, status: { $in: ['active', 'pending', 'scheduled'] } });
    if (pen && !(pen.reopenRequest && pen.reopenRequest.decision === 'approved' && pen.evaluationMode === mode)) {
      pen.reopenRequest = {
        requested: true, reason: (pen.reopenRequest && pen.reopenRequest.reason) || note || 'Reopened via Compliance',
        requestedAt: (pen.reopenRequest && pen.reopenRequest.requestedAt) || new Date(), decision: 'approved',
        decidedBy: actor._id, decidedAt: new Date(), decisionNote: note || '', completedAt: null,
      };
      await pen.save();
      await require('../../performanceRecovery').applyEvaluationMode({ penalty: pen, mode, actor, note, req });
      out.legacy = { applied: true, penaltyId: pen._id };
    }
  } catch (e) { out.legacy = { applied: false, reason: e.message }; }
  return out;
};

/* ------------------------------------------------------------------ */
/* HR: decide on a pending request                                     */
/* ------------------------------------------------------------------ */
const decide = async ({ refileId, decision, note = '', evaluationMode = '', actor, req = null }) => {
  if (!isAdmin(actor)) throw err('HR / Super Admin only.', 403, 'forbidden');
  if (!['approved', 'rejected'].includes(decision)) throw err("decision must be 'approved' or 'rejected'.", 400, 'bad_request');
  if (evaluationMode && (!MODES.includes(evaluationMode) || decision !== 'approved')) {
    throw err('evaluationMode must be restore | information | neutral and is only valid when approving.', 400, 'bad_request');
  }
  const row = refileId && mongoose.Types.ObjectId.isValid(refileId) ? await ComplianceRefile.findById(refileId).lean() : null;
  if (!row) throw err('Re-file request not found.', 404, 'not_found');
  const target = decision === 'approved' ? 'approved' : 'rejected';

  if (row.status !== 'pending') {
    if (row.status === target) return { ...row, alreadyDecided: true };
    throw err(`This request is already ${row.status}; it cannot be ${target}.`, 409, `refile_${row.status}`);
  }
  const sub = await Submission.findById(row.submissionId).lean();
  if (decision === 'approved') {
    if (!sub || !eligibility.isLive(sub)) throw err('The submission is no longer eligible for a re-file.', 400, 'not_live');
    if (sub.submitted) throw err('The submission has already been submitted.', 409, 'already_submitted');
  }
  const note_ = String(note || '').trim();
  const won = await ComplianceRefile.findOneAndUpdate(
    { _id: row._id, status: 'pending' },
    { $set: {
      status: target, open: target === 'approved', decidedBy: actor._id, decidedAt: new Date(),
      decisionNote: note_, evaluationMode: evaluationMode || '',
    } },
    { new: true },
  );
  if (!won) {
    const cur = await ComplianceRefile.findById(row._id).lean();
    if (cur && cur.status === target) return { ...cur, alreadyDecided: true };
    throw err(`This request is already ${cur ? cur.status : 'gone'}; it cannot be ${target}.`, 409, 'refile_state_changed');
  }
  const side = decision === 'approved' ? await _applyMode({ sub, mode: evaluationMode, note: note_, actor, req }) : null;
  await _emit({ employee: row.employee, incidentId: row.incidentId, kind: 'refile_decided',
    payload: { refileId: row._id, decision: target, note: note_, evaluationMode: evaluationMode || '', submissionId: row.submissionId }, actor: actor._id });
  _audit(req, `compliance.refile.${target}`, row, { note: note_, evaluationMode: evaluationMode || '' });
  return { ..._plain(won), sideEffects: side };
};

/* ------------------------------------------------------------------ */
/* HR: send a missed day back (with or without an employee request)    */
/* ------------------------------------------------------------------ */
const sendBack = async ({ submissionId = null, employeeId = null, date = null, note = '', evaluationMode = '', actor, req = null, today = startOfDay(new Date()) }) => {
  if (!isAdmin(actor)) throw err('HR / Super Admin only.', 403, 'forbidden');
  if (evaluationMode && !MODES.includes(evaluationMode)) throw err('evaluationMode must be restore | information | neutral.', 400, 'bad_request');
  let stubs;
  if (submissionId) {
    if (!mongoose.Types.ObjectId.isValid(submissionId)) throw err('A valid submissionId is required.', 400, 'bad_request');
    const s = await Submission.findById(submissionId).lean();
    stubs = s ? [s] : [];
  } else {
    if (!employeeId || !mongoose.Types.ObjectId.isValid(employeeId) || !date) throw err('Provide submissionId, or employeeId and date.', 400, 'bad_request');
    // Every unsubmitted live stub of that employee-day (the legacy button reopened one
    // ARBITRARY stub of a multi-template day; a day is sent back as a whole here).
    stubs = await Submission.find({ employee: employeeId, date: startOfDay(new Date(date)), submitted: false, ...liveSubmissionFilter({}) }).lean();
  }
  const note_ = String(note || '').trim();
  const out = [];
  for (const sub of stubs) {
    const item = { submissionId: sub._id };
    if (!eligibility.isLive(sub)) { out.push({ ...item, outcome: 'skipped', reason: 'not_live' }); continue; }
    if (sub.submitted) { out.push({ ...item, outcome: 'skipped', reason: 'already_submitted' }); continue; }
    const gate = await eligibility.check({ submission: sub, today });
    if (gate.state === 'current_day' || gate.state === 'not_gated') { out.push({ ...item, outcome: 'skipped', reason: gate.state }); continue; }

    // Converge on one approved row even if an employee request lands concurrently:
    // approve an open pending request in place, else create the approved row; if the
    // create loses to a request that just appeared, loop and approve THAT request.
    let row = null; let already = null;
    for (let attempt = 0; attempt < 4 && !row && !already; attempt++) {
      const open = await _openFor(sub._id);
      if (open && open.status === 'approved') { already = open; break; }
      if (open && open.status === 'pending') {
        row = await ComplianceRefile.findOneAndUpdate(
          { _id: open._id, status: 'pending' },
          { $set: { status: 'approved', open: true, decidedBy: actor._id, decidedAt: new Date(), decisionNote: note_, evaluationMode: evaluationMode || '' } },
          { new: true },
        );
        continue;
      }
      const inc = await _missedIncidentFor(sub._id);
      try {
        row = await ComplianceRefile.create({
          employee: sub.employee, submissionId: sub._id, targetDate: sub.date, incidentId: inc ? inc._id : null,
          status: 'approved', open: true, source: 'hr', requestedBy: actor._id, requestedAt: new Date(),
          reason: note_ || 'Reopened by HR from Submission Review', decidedBy: actor._id, decidedAt: new Date(),
          decisionNote: note_, evaluationMode: evaluationMode || '',
        });
      } catch (e) {
        if (!(e && e.code === 11000)) throw e;          // a request appeared first: loop and approve it
      }
    }
    if (already) { out.push({ ...item, outcome: 'already_approved', refileId: already._id }); continue; }
    if (!row) { out.push({ ...item, outcome: 'skipped', reason: 'race' }); continue; }
    const side = await _applyMode({ sub, mode: evaluationMode, note: note_, actor, req });
    await _emit({ employee: row.employee, incidentId: row.incidentId, kind: 'refile_decided',
      payload: { refileId: row._id, decision: 'approved', hrInitiated: row.source === 'hr', note: note_, evaluationMode: evaluationMode || '', submissionId: sub._id }, actor: actor._id });
    _audit(req, 'compliance.refile.approved', row, { note: note_, evaluationMode: evaluationMode || '', hrInitiated: true });
    out.push({ ...item, outcome: 'approved', refileId: row._id, sideEffects: side });
  }
  if (!out.some((o) => o.outcome === 'approved' || o.outcome === 'already_approved')) {
    throw err('Nothing to send back: no unsubmitted missed submission with a missed-day record was found.', 409, 'nothing_to_send_back');
  }
  return { results: out, approved: out.filter((o) => o.outcome === 'approved').length };
};

/* ------------------------------------------------------------------ */
/* HR: revoke a pending / approved request                              */
/* ------------------------------------------------------------------ */
const revoke = async ({ refileId, reason = '', actor, req = null }) => {
  if (!isAdmin(actor)) throw err('HR / Super Admin only.', 403, 'forbidden');
  const row = refileId && mongoose.Types.ObjectId.isValid(refileId) ? await ComplianceRefile.findById(refileId).lean() : null;
  if (!row) throw err('Re-file request not found.', 404, 'not_found');
  if (row.status === 'revoked') return { ...row, alreadyRevoked: true };
  if (!['pending', 'approved'].includes(row.status)) throw err(`This request is ${row.status}; it cannot be revoked.`, 409, `refile_${row.status}`);
  const won = await ComplianceRefile.findOneAndUpdate(
    { _id: row._id, status: { $in: ['pending', 'approved'] } },
    { $set: { status: 'revoked', open: false, revokedAt: new Date(), revokedBy: actor._id, revokeReason: String(reason || '').trim() } },
    { new: true },
  );
  if (!won) {
    const cur = await ComplianceRefile.findById(row._id).lean();
    if (cur && cur.status === 'revoked') return { ...cur, alreadyRevoked: true };
    throw err(`This request is ${cur ? cur.status : 'gone'}; it cannot be revoked.`, 409, 'refile_state_changed');
  }
  await _emit({ employee: row.employee, incidentId: row.incidentId, kind: 'refile_revoked',
    payload: { refileId: row._id, previous: row.status, reason: String(reason || '').trim() }, actor: actor._id });
  _audit(req, 'compliance.refile.revoke', row, { previous: row.status });
  return _plain(won);
};

/* ------------------------------------------------------------------ */
/* Submission side: consume the grant when the stub is submitted        */
/* ------------------------------------------------------------------ */
const consumeForSubmission = async ({ submissionId, actor = null }) => {
  if (!submissionId) return { consumed: false };
  const won = await ComplianceRefile.findOneAndUpdate(
    { submissionId, status: 'approved' },
    { $set: { status: 'consumed', open: false, consumedAt: new Date(), consumedBy: actor } },
    { new: true },
  );
  if (!won) return { consumed: false };
  await _emit({ employee: won.employee, incidentId: won.incidentId, kind: 'refile_consumed',
    payload: { refileId: won._id, submissionId }, actor: actor || 'system' });
  return { consumed: true, refileId: won._id };
};

/* ------------------------------------------------------------------ */
/* Lists                                                                */
/* ------------------------------------------------------------------ */
const list = async ({ user, status = null, limit = 200 }) => {
  const where = {};
  if (status) where.status = status;
  if (!isAdmin(user)) where.employee = user._id;                // employees only ever see their own
  return ComplianceRefile.find(where).sort({ requestedAt: -1 }).limit(Math.min(500, Math.max(1, Number(limit) || 200))).lean();
};

module.exports = { request, decide, sendBack, revoke, consumeForSubmission, list, MODES };
