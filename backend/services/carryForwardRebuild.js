/**
 * carryForwardRebuild
 *
 * Recomputes auto-generated carry-forward values on every UNSUBMITTED
 * custom-template submission whose template declares a systemGenerated
 * `yesterdayPending` field (the Calling Report mechanism today; any
 * future custom template that opts in via the same key + flag).
 *
 *   1. Find every eligible Template (sysGen yesterdayPending).
 *   2. For each unsubmitted submission tied to those templates within
 *      the requested employee / template scope:
 *        a. Look up the most-recent LIVE prior submitted submission
 *           (same employee, same template) using liveSubmissionFilter
 *           so test-marked + soft-deleted rows don't poison the carry.
 *        b. Pull totalPending from that prior row (0 if none).
 *        c. Write the carry into yesterdayPending.
 *        d. Re-run computeAutoFields so every formula field
 *           (oldPendingRemaining, totalPending, pendingRate,
 *           connectionRate, unattendedCalls, totalConversions,
 *           conversionRate, totalCallsCompleted, callCompletionRate)
 *           re-derives from the updated values.
 *        e. Save only when something actually changed (idempotent).
 *
 * Never touches submitted submissions, attendance, salary, leave, or
 * any historical analytics surface.
 *
 * Returns { walked, rebuilt, skipped }.
 */

const mongoose       = require('mongoose');
const Submission     = require('../models/Submission');
const Template       = require('../models/Template');
const { computeAutoFields } = require('./customTemplate');
const { liveSubmissionFilter } = require('../utils/submissionFilter');

const _toObjectIds = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    if (!x) continue;
    if (mongoose.Types.ObjectId.isValid(x)) out.push(new mongoose.Types.ObjectId(String(x)));
  }
  return out;
};

const rebuildCarryForward = async ({ employeeIds = null, templateIds = null } = {}) => {
  // Eligibility = template has a systemGenerated `yesterdayPending`
  // field.  Cached up front so we don't query Template once per sub.
  const tplFilter = { templateType: 'custom' };
  const scopedTpl = _toObjectIds(templateIds);
  if (scopedTpl.length > 0) tplFilter._id = { $in: scopedTpl };
  const templates = await Template.find(tplFilter).select('customFields customKind').lean();
  const eligible = templates.filter((t) =>
    Array.isArray(t.customFields)
    && t.customFields.some((f) => f.key === 'yesterdayPending' && f.systemGenerated),
  );
  if (eligible.length === 0) return { walked: 0, rebuilt: 0, skipped: 0 };
  const tplById = new Map(eligible.map((t) => [String(t._id), t]));

  // Find unsubmitted submissions in scope.
  const subWhere = {
    template: { $in: eligible.map((t) => t._id) },
    submitted: false,
  };
  const scopedEmp = _toObjectIds(employeeIds);
  if (scopedEmp.length > 0) subWhere.employee = { $in: scopedEmp };
  const subs = await Submission.find(subWhere);

  let rebuilt = 0;
  let skipped = 0;
  for (const sub of subs) {
    const tpl = tplById.get(String(sub.template));
    if (!tpl) { skipped += 1; continue; }

    // Most-recent live prior submitted row.  Same filter analytics use.
    const prior = await Submission.findOne({
      employee: sub.employee,
      template: sub.template,
      date: { $lt: sub.date },
      submitted: true,
      ...liveSubmissionFilter({}),
    }).sort({ date: -1 }).select('customResponses');
    const priorTotal = (prior?.customResponses || []).find((r) => r.key === 'totalPending');
    const carry = Number(priorTotal?.value) || 0;

    // Idempotence check -- read current yesterdayPending; if the new
    // carry already matches AND every auto field is already up to
    // date, skip the save.  We still re-run computeAutoFields so the
    // formula side-effects (e.g. coercing number fields) are
    // captured, then compare arrays.
    const before = (sub.customResponses || []).map((r) => ({ key: r.key, value: r.value }));
    const values = {};
    before.forEach((r) => { values[r.key] = r.value; });
    values.yesterdayPending = carry;
    const after = computeAutoFields(tpl, values);

    const same = before.length === after.length
      && before.every((b) => {
        const a = after.find((x) => x.key === b.key);
        return a && String(a.value) === String(b.value);
      });
    if (same) { skipped += 1; continue; }

    sub.customResponses = after;
    sub.markModified('customResponses');
    await sub.save();
    rebuilt += 1;
  }

  return { walked: subs.length, rebuilt, skipped };
};

module.exports = { rebuildCarryForward };
