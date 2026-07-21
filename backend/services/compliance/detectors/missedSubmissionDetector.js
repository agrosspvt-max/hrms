/**
 * missedSubmissionDetector.js -- Compliance v2 replacement for
 * penaltyEngine.enforceAbsentSubmission.
 *
 * Reuses the SAME source of truth (`expectedSubmissions.getMissedSubmissions`
 * + `Attendance` present-check) so the new engine and the legacy
 * engine never disagree.  Emits one candidate per unsubmitted
 * template stub on the target day.
 *
 * Detector contract: pure, DB-read-only, never writes.  Idempotency
 * is enforced downstream via naturalKey + partial-unique index.
 */

const Attendance = require('../../../models/Attendance');
const Template = require('../../../models/Template');
const expectedSubmissions = require('../../expectedSubmissions');
const { startOfDay, addDays } = require('../../../utils/dateHelpers');
const { missedSubmissionKey } = require('../naturalKey');
const critical = require('../critical');

const _isPresent = async (employeeId, day) => {
  const att = await Attendance.findOne({ employee: employeeId, date: startOfDay(day) }).lean();
  if (!att) return true;                            // no record -> present by default
  return ['present', 'half_paid', 'half_unpaid'].includes(att.status);
};

/**
 * Detector entry point.  Fires for a single (employee, day) pair
 * against the day BEFORE the scheduler's tick day -- matching
 * `enforceAbsentSubmission({previousDay})` semantics.
 *
 *   day  = the sweep's calendar day (today)
 *   T-1  = the target day the detector inspects
 */
const detect = async ({ rule, employee, day }) => {
  if (!rule || !employee) return [];
  const target = startOfDay(addDays(day, -1));

  // Rollout gate -- reuse the shared cutoff.  Pre-rollout days
  // produce zero candidates so the entire flow short-circuits.
  if (expectedSubmissions.isBeforeComplianceRollout(target)) return [];

  const present = await _isPresent(employee._id, target);
  if (!present) return [];

  const stubs = await expectedSubmissions.getMissedSubmissions({
    employeeId: employee._id,
    day: target,
  });
  if (!stubs.length) return [];

  // Batch-3 fix #15 -- resolve real template titles in one bulk
  // query per (employee, tick).  Previous implementation aliased
  // `templateTitle` to the templateType ("task" / "custom"), which
  // surfaced as bogus titles on the HR Compliance Dashboard and in
  // notification bodies.  We fetch the actual Template.title for
  // every distinct template referenced by this employee's missed
  // stubs; empty string when the template row is missing.
  const uniqTplIds = [...new Set(
    stubs.map((s) => s.template && String(s.template)).filter(Boolean),
  )];
  const titleById = new Map();
  if (uniqTplIds.length) {
    try {
      const tpls = await Template.find({ _id: { $in: uniqTplIds } })
        .select('title').lean();
      for (const t of tpls) titleById.set(String(t._id), t.title || '');
    } catch (e) {
      console.error('[compliance/missedSubmission] title lookup failed:', e.message);
    }
  }

  const out = [];
  for (const s of stubs) {
    // Legacy filter: only task / custom templates are compliance-gated.
    if (s.templateType && s.templateType !== 'task' && s.templateType !== 'custom') continue;
    const templateTitle = s.template ? (titleById.get(String(s.template)) || '') : '';
    out.push({
      naturalKey: missedSubmissionKey({
        ruleCode: rule.code,
        employeeId: employee._id,
        day: target,
        submissionId: s._id,
      }),
      incidentDate: target,
      context: {
        submissionId: s._id,
        templateId:   s.template || null,
        // Fixed: real template title, not the templateType enum.
        templateTitle,
        assignmentId: s.assignment || null,
        scheduleLabel: s.scheduleLabel || '',
        workDate: target,
        // Stabilization patch (C5): populate departmentId so the
        // department_avg marks strategy can hit its fast path.
        departmentId: employee.department || null,
        designationId: employee.designation || null,
      },
      detectorMeta: {
        detector: 'built_in.missed_submission',
        templateType: s.templateType,
        // Batch-1 fix #2 (Option A) -- criticality lookup via Template.
        criticalTask: await critical.resolveCriticalByTemplateId(s.template),
      },
    });
  }
  return out;
};

module.exports = { detect, code: 'built_in.missed_submission' };
