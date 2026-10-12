/**
 * refileEligibility.js -- the ONE place that answers
 *
 *     "Is this employee authorized to submit this past (missed) day?"
 *
 * It reproduces, condition for condition, the legacy late-submit gate
 * (submissionController.submitOne) and the reopen look-ups used by
 * getToday, expectedSubmissions and the daily review, but takes the GRANT
 * from Compliance (ComplianceRefile).
 *
 * Legacy-behaviour contract (kept exactly):
 *   - a submission dated today or later is never gated
 *   - a past day is gated ONLY when a "missed" marker exists for it; no marker
 *     => allowed (that is how pre-rollout / cancelled / resolved days behave)
 *   - gated + approved grant => allowed; otherwise blocked with the legacy
 *     message chosen by the request state (pending / rejected / none)
 *
 * What is new / transitional (all marked BRIDGE):
 *   - the missed marker is "legacy active missed Penalty" OR "open Compliance
 *     missed_submission incident" (the legacy writers are still on, and the v2
 *     rule may be off, so neither alone is complete yet)
 *   - an approved LEGACY reopen is still honoured (HR may still decide on the
 *     legacy Fines & Penalties page)
 * When the legacy Penalty system is retired, delete the lines tagged BRIDGE.
 *
 * A grant never authorizes: another employee, another date, another stub, or a
 * deleted / test / hidden submission -- identity is the stub id and the grant's
 * own employee and date must match the stub.
 */
const Penalty = require('../../../models/Penalty');
const ComplianceRefile = require('../../../models/ComplianceRefile');
const ComplianceIncident = require('../../../models/ComplianceIncident');

const MISSED_CATS = Object.freeze(['missed_submission', 'absent_submission']);
const MISSED_RULES = Object.freeze(['missed_submission_v2', 'absent_submission_v2']);
const BLOCKING_PENALTY_STATUS = Object.freeze(['active', 'pending', 'scheduled']);
const BLOCKING_INCIDENT_STATUS = Object.freeze(['candidate', 'active']);

const MESSAGES = Object.freeze({
  pending: 'A reopen request is still pending HR review.  You cannot re-submit until it is approved.',
  rejected: 'HR rejected your reopen request.  Contact HR to raise a new request.',
  none: 'This day\'s submission window has closed.  Open Fines & Penalties to request reopening from HR.',
});

// ComplianceRefile.status -> the legacy reopenRequest.decision vocabulary the
// existing UI / classifiers understand.
const DECISION_OF = Object.freeze({ pending: 'pending', approved: 'approved', rejected: 'rejected', consumed: 'completed', revoked: 'cancelled' });

const isLive = (s) => !!s && !s.deleted && !s.isTestData && !s.hidden;
const sameDay = (a, b) => a && b && new Date(a).getTime() === new Date(b).getTime();
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** A refile row counts for a stub only if its own employee + date agree with the stub. */
const matches = (r, sub) => sameId(r.submissionId, sub._id) && sameId(r.employee, sub.employee) && sameDay(r.targetDate, sub.date);

const _latest = (rows) => [...rows].sort((a, b) => new Date(b.requestedAt || b.createdAt || 0) - new Date(a.requestedAt || a.createdAt || 0))[0] || null;

/**
 * Effective decision for a stub from its refile rows + the legacy Penalty
 * (BRIDGE).  approved beats everything; then pending; then the most recent
 * Compliance row; then the legacy decision.
 */
const effectiveDecision = (refiles, legacyPenalty) => {
  const lg = (legacyPenalty && legacyPenalty.reopenRequest && legacyPenalty.reopenRequest.decision) || '';
  if (refiles.some((r) => r.status === 'approved') || lg === 'approved') return 'approved';
  if (refiles.some((r) => r.status === 'pending') || lg === 'pending') return 'pending';
  const last = _latest(refiles);
  return last ? DECISION_OF[last.status] : lg;
};

/**
 * @param {{submission:Object, today:Date}} args  submission = the stub being submitted
 * @returns {{allowed:boolean, state:string, decision:string, message?:string, source?:string}}
 */
const check = async ({ submission, today }) => {
  const day = new Date(today);
  if (!submission || !submission.date || new Date(submission.date).getTime() >= day.getTime()) {
    return { allowed: true, state: 'current_day', decision: '' };
  }
  const [legacyPen, incident, refiles] = await Promise.all([
    // BRIDGE: the legacy missed-day marker (exactly the legacy gate query).
    Penalty.findOne({ submission: submission._id, category: { $in: MISSED_CATS }, status: { $in: BLOCKING_PENALTY_STATUS } })
      .select('reopenRequest').lean(),
    ComplianceIncident.findOne({
      'context.submissionId': submission._id, ruleCode: { $in: MISSED_RULES }, status: { $in: BLOCKING_INCIDENT_STATUS },
    }).select('_id').lean(),
    ComplianceRefile.find({ submissionId: submission._id }).lean(),
  ]);
  const mine = refiles.filter((r) => matches(r, submission));

  if (!legacyPen && !incident) return { allowed: true, state: 'not_gated', decision: effectiveDecision(mine, null) };

  const live = isLive(submission);
  const grantC = live && mine.some((r) => r.status === 'approved');
  const grantL = live && legacyPen && legacyPen.reopenRequest && legacyPen.reopenRequest.decision === 'approved';   // BRIDGE
  if (grantC || grantL) {
    return { allowed: true, state: 'granted', decision: 'approved', source: grantC ? 'compliance' : 'legacy' };
  }
  const decision = effectiveDecision(mine, legacyPen);
  return {
    allowed: false, state: 'blocked', decision,
    message: decision === 'pending' ? MESSAGES.pending : decision === 'rejected' ? MESSAGES.rejected : MESSAGES.none,
  };
};

/**
 * Stub ids with an APPROVED grant for an employee (getToday's "reopened" list).
 */
const approvedStubIds = async (employeeId) => {
  const rows = await ComplianceRefile.find({ employee: employeeId, status: 'approved' }).select('submissionId').lean();
  const ids = new Set(rows.map((r) => String(r.submissionId)));
  // BRIDGE: grants approved on the legacy Fines & Penalties page.
  const legacy = await Penalty.find({
    employee: employeeId, category: { $in: MISSED_CATS }, 'reopenRequest.decision': 'approved',
  }).select('submission').lean();
  for (const p of legacy) if (p.submission) ids.add(String(p.submission));
  return [...ids];
};

/**
 * Map(stubId -> {reopenRequest:{decision}, source}) for the given stub ids; the
 * shape expectedSubmissions / dailyReview already consume.  `preloadedPenalties`
 * (BRIDGE) is the legacy rows when the caller already has them.
 */
const decisionIndex = async (stubIds, { preloadedPenalties } = {}) => {
  const out = new Map();
  if (!stubIds || !stubIds.length) return out;
  const [refiles, legacy] = await Promise.all([
    ComplianceRefile.find({ submissionId: { $in: stubIds } }).lean(),
    preloadedPenalties
      ? Promise.resolve(preloadedPenalties.filter((p) => stubIds.some((id) => String(id) === String(p.submission))))
      : Penalty.find({ submission: { $in: stubIds }, category: { $in: MISSED_CATS }, source: 'automatic', probable: false })
        .select('submission reopenRequest').lean(),
  ]);
  const rBy = new Map(); for (const r of refiles) { const k = String(r.submissionId); (rBy.get(k) || rBy.set(k, []).get(k)).push(r); }
  const lBy = new Map(); for (const p of legacy) if (p.submission) lBy.set(String(p.submission), p);
  for (const id of new Set([...rBy.keys(), ...lBy.keys()])) {
    const decision = effectiveDecision(rBy.get(id) || [], lBy.get(id) || null);
    out.set(id, { submission: id, reopenRequest: { decision }, source: (rBy.get(id) || []).length ? 'compliance' : 'legacy' });
  }
  return out;
};

/**
 * Per (employee, day) view for the HR daily review ("Send Back" button + badge).
 * Returns Map("empId|YYYY-MM-DD" -> {penaltyId, canSendBack, reopenDecision}).
 * `penaltyId` stays for the legacy buttons; `canSendBack` is true when any
 * missed marker exists (legacy Penalty or Compliance incident).
 */
const dayIndex = async ({ employeeIds, dates, since }) => {
  const key = (e, d) => `${String(e)}|${new Date(d).toISOString().slice(0, 10)}`;
  const out = new Map();
  if (!employeeIds.length || !dates.length) return out;
  const [pens, incs, refiles] = await Promise.all([
    Penalty.find({
      employee: { $in: employeeIds }, category: { $in: MISSED_CATS },
      targetDate: { $in: dates, ...(since ? { $gte: since } : {}) },
      source: 'automatic', probable: false, archivedPreRollout: { $ne: true },
    }).select('employee targetDate reopenRequest').lean(),                                       // BRIDGE
    ComplianceIncident.find({
      employee: { $in: employeeIds }, ruleCode: { $in: MISSED_RULES }, status: { $in: BLOCKING_INCIDENT_STATUS },
      incidentDate: { $in: dates, ...(since ? { $gte: since } : {}) },
    }).select('employee incidentDate').lean(),
    ComplianceRefile.find({ employee: { $in: employeeIds }, targetDate: { $in: dates } }).lean(),
  ]);
  const get = (k) => out.get(k) || out.set(k, { penaltyId: null, canSendBack: false, reopenDecision: '', _refiles: [], _legacy: null }).get(k);
  for (const p of pens) { const e = get(key(p.employee, p.targetDate)); e.penaltyId = p._id; e.canSendBack = true; e._legacy = p; }
  for (const i of incs) { get(key(i.employee, i.incidentDate)).canSendBack = true; }
  for (const r of refiles) { const e = get(key(r.employee, r.targetDate)); e._refiles.push(r); e.canSendBack = true; }
  for (const e of out.values()) { e.reopenDecision = effectiveDecision(e._refiles, e._legacy); delete e._refiles; delete e._legacy; }
  return out;
};

/**
 * Adds `reopenRequest` ({requested, decision}) to the missed rows of an
 * attached penaltyBreakdown so the Submission Review "Reopened" badge works
 * whichever store holds the grant (legacy rows already carry their own and are
 * only overridden when a Compliance row exists).
 */
const decorateBreakdown = async (subs) => {
  const list = (Array.isArray(subs) ? subs : [subs]).filter((s) => s && s.penaltyBreakdown && Array.isArray(s.penaltyBreakdown.template));
  const ids = list.map((s) => s._id || s.id).filter(Boolean);
  if (!ids.length) return subs;
  const refiles = await ComplianceRefile.find({ submissionId: { $in: ids } }).lean();
  if (!refiles.length) return subs;
  const by = new Map(); for (const r of refiles) { const k = String(r.submissionId); (by.get(k) || by.set(k, []).get(k)).push(r); }
  for (const s of list) {
    const rows = by.get(String(s._id || s.id));
    if (!rows) continue;
    // Copy, never mutate: breakdown rows may be shared with the caller's own objects.
    s.penaltyBreakdown.template = s.penaltyBreakdown.template.map((p) => (
      (p.category !== 'missed_submission' && p.category !== 'absent_submission') ? p
        : { ...p, reopenRequest: { ...(p.reopenRequest || {}), requested: true, decision: effectiveDecision(rows, p) } }));
  }
  return subs;
};

module.exports = {
  check, approvedStubIds, decisionIndex, dayIndex, decorateBreakdown,
  effectiveDecision, isLive, matches, DECISION_OF, MESSAGES, MISSED_CATS, MISSED_RULES,
};
