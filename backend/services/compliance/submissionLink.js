/**
 * submissionLink.js -- deterministic, identity-first link from a compliance
 * marks effect to the ONE Submission it affects.
 *
 * Legacy Penalty rows carry `submission` and Final Marks are derived per
 * submission; an effect needs the same relationship.  Rules:
 *
 *   1. An EXPLICIT submission id (incident.context.submissionId) is the
 *      identity.  It is used only if that submission exists, belongs to the
 *      incident's employee and is a LIVE row (not deleted / test / hidden).
 *      If it fails any check the result is null -- there is NO fallback to
 *      "some other submission of that day".
 *   2. With no explicit id (dependency pending, performance lock), the
 *      target is the employee's PRIMARY live submission on the effect's day,
 *      chosen exactly like the daily review / Phase 1 dependency anchor:
 *        submitted first, then earliest `submittedAt`, then `_id`.
 *   3. Recurring effects on days after the incident's first application are
 *      day-scoped: they always use rule 2 for their own day.
 *
 * Returns the lean submission ({_id, earnedPoints, totalPoints, date}) or
 * null.  Read-only.
 */
const mongoose = require('mongoose');
const Submission = require('../../models/Submission');
const { liveSubmissionFilter } = require('../../utils/submissionFilter');
const { startOfDay } = require('../../utils/dateHelpers');

const MARKS_ACTION_TYPES = Object.freeze(['zero_daily_marks', 'add_daily_total', 'fixed_marks_reduction']);
// Effects bound to a submission: marks effects (they deduct) and the lock (it
// explains WHY the day is zero; carries no marks itself).
const LINKED_ACTION_TYPES = Object.freeze([...MARKS_ACTION_TYPES, 'performance_lock']);
const SELECT = '_id employee date earnedPoints totalPoints';

// Without a live connection (or a test stub) a lookup would just buffer.
const _available = () => Boolean(Submission._stubbedByStubMongo || mongoose.connection.readyState === 1);

const primaryForDay = async (employeeId, day) => {
  if (!_available() || !employeeId || !day) return null;
  const q = Submission.findOne({ employee: employeeId, date: startOfDay(day), ...liveSubmissionFilter({}) })
    .sort({ submitted: -1, submittedAt: 1, _id: 1 }).select(SELECT);
  return (await q.lean()) || null;
};

const explicitIfLive = async (employeeId, submissionId) => {
  if (!_available() || !submissionId) return null;
  const s = await Submission.findOne({ _id: submissionId, employee: employeeId, ...liveSubmissionFilter({}) })
    .select(SELECT).lean();
  return s || null;
};

/**
 * @param {{incident:Object, effectiveDate:Date, recurring:boolean}} args
 */
const resolveTargetSubmission = async ({ incident, effectiveDate, recurring = false }) => {
  if (!incident || !incident.employee) return null;
  const explicit = incident.context && incident.context.submissionId;
  const day = startOfDay(effectiveDate);
  const firstDay = incident.effectiveDate ? startOfDay(incident.effectiveDate) : day;

  if (explicit && (incident.source === 'manual' || !recurring || day.getTime() === firstDay.getTime())) {
    return explicitIfLive(incident.employee, explicit);
  }
  if (explicit && recurring) return primaryForDay(incident.employee, day);   // later recurring day
  return primaryForDay(incident.employee, incident.incidentDate && !recurring ? incident.incidentDate : day);
};

module.exports = { resolveTargetSubmission, primaryForDay, explicitIfLive, MARKS_ACTION_TYPES, LINKED_ACTION_TYPES };
