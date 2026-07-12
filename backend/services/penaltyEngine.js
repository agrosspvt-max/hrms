/**
 * penaltyEngine.js  --  Phase 61 Automatic Penalty Generation.
 *
 * Every automatic rule lives here as a small pure(-ish) function
 * that takes ({ employee, day }) and yields Penalty documents.
 *
 * Rules implemented (v1):
 *   R1.  ABSENT_SUBMISSION      Employee was PRESENT on day D and had
 *                               a task-template assignment, but never
 *                               submitted it.  Beginning D+1 the
 *                               system creates a probable penalty on
 *                               D+1; on D+2 that promotes to active.
 *   R2.  DEPENDENCY_PENDING     Any dependency task stuck Pending for
 *                               3 consecutive days.  From day 4 a
 *                               penalty is created and RENEWED daily
 *                               until every open dependency clears.
 *
 * Rules that live elsewhere:
 *   - attendance_manual         Written by the attendance controller
 *                               when HR flips Absent -> Present with
 *                               Performance Penalty (Option A).  See
 *                               attendanceController.setForDay.
 *   - manual_marks              HR-created via /penalties (Phase 61.8).
 *   - manual_completion         Same route.
 *
 * Design notes
 * ------------
 * - Never overwrite Submission.earnedPoints.  We only insert Penalty
 *   documents that penaltyMath.attachFinalMarks() joins on read.
 * - The Penalty schema carries a partial unique index on
 *   (employee, category, targetDate, submission) for automatic +
 *   non-probable records, so double-inserts are impossible.
 * - Probable (warning) penalties use `probable: true` and slip
 *   past the unique index; we look for them by hand before inserting.
 */
const Penalty       = require('../models/Penalty');
const Submission    = require('../models/Submission');
const Assignment    = require('../models/Assignment');
const Attendance    = require('../models/Attendance');
const DependencyTask = require('../models/DependencyTask');
const notify        = require('./notifyEvents');
const { startOfDay } = require('../utils/dateHelpers');
// Verification-audit fix (spec item 11) -- every AUTOMATIC penalty
// creation must land in the audit trail.  Because the engine runs
// outside any HTTP request, we use a synthetic sentinel ObjectId
// (all zeros) to satisfy AuditLog.actor's `required: true` while
// leaving a clear marker that no human triggered the row.
const AuditLog = require('../models/AuditLog');
const mongoose = require('mongoose');
const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000000');

const _logSystemAudit = async ({ action, targetId, targetLabel, meta }) => {
  try {
    await AuditLog.create({
      actor: SYSTEM_ACTOR_ID,
      actorRole: 'system',
      action,
      targetType: 'Penalty',
      targetId,
      targetLabel: targetLabel || '',
      meta: meta || {},
    });
  } catch (e) {
    console.error('[penaltyEngine] audit:', e.message);
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
const _add = (d, n) => new Date(startOfDay(d).getTime() + n * DAY_MS);

/**
 * Look up (or insert) a Penalty deterministically.  Skips insert
 * when a matching AUTOMATIC + non-probable record exists (the
 * unique index catches remaining races).
 */
const _upsertAutoPenalty = async (doc) => {
  const filter = {
    employee: doc.employee,
    category: doc.category,
    targetDate: doc.targetDate,
    submission: doc.submission || null,
    source: 'automatic',
    probable: false,
  };
  const existing = await Penalty.findOne(filter).lean();
  if (existing) return existing;
  try {
    const created = await Penalty.create(doc);
    // Verification-audit fix -- spec item 11 requires the audit
    // trail to record automatic penalty creation.  Fires ONCE at
    // first-insert; subsequent findOne hits skip this branch so
    // refreshing 100 times still produces exactly one audit row.
    _logSystemAudit({
      action: 'penalty.auto.create',
      targetId: created._id,
      targetLabel: `${doc.category} · auto`,
      meta: {
        employee: String(doc.employee),
        category: doc.category,
        rule: doc.rule || '',
        penaltyMarks: doc.penaltyMarks || 0,
        targetDate: doc.targetDate,
        submission: doc.submission || null,
        dependencyIds: doc.dependencyIds || [],
      },
    });
    return created.toObject();
  } catch (e) {
    // Duplicate key -- someone else inserted concurrently.  No
    // audit written because the winning insert already logged one.
    if (e && e.code === 11000) {
      return Penalty.findOne(filter).lean();
    }
    throw e;
  }
};

/**
 * Verification-audit fix -- probable records are now covered by a
 * partial unique index (models/Penalty.js).  Mirror the automatic
 * upsert's dup-key catch so a race between two probable-sweep calls
 * produces exactly one document instead of throwing.
 */
const _upsertProbable = async (doc) => {
  const filter = {
    employee: doc.employee,
    category: doc.category,
    targetDate: doc.targetDate,
    submission: doc.submission || null,
    source: 'automatic',
    probable: true,
  };
  const existing = await Penalty.findOne(filter).lean();
  if (existing) return existing;
  try {
    const created = await Penalty.create(doc);
    // Verification-audit fix (spec item 11) -- probable creations
    // are audited too, ONCE per (employee, category, target).
    _logSystemAudit({
      action: 'penalty.auto.probable.create',
      targetId: created._id,
      targetLabel: `${doc.category} · probable`,
      meta: {
        employee: String(doc.employee),
        category: doc.category,
        rule: doc.rule || '',
        targetDate: doc.targetDate,
        submission: doc.submission || null,
      },
    });
    return created.toObject();
  } catch (e) {
    if (e && e.code === 11000) {
      return Penalty.findOne(filter).lean();
    }
    throw e;
  }
};

/* ================================================================
 *  R1 -- ABSENT_SUBMISSION
 * ================================================================ */

/**
 * R1a -- Probable (warning) penalty for TODAY.
 *
 * Fires when the employee is present today, has a task-template
 * assignment, and has not submitted it yet AND the day isn't over.
 * Employee sees a dashboard warning that a penalty will apply
 * tomorrow.  The record uses `probable: true` and is auto-flipped
 * to `resolved` (or deleted) the moment the employee submits.
 */
const _isPresentAttendance = async (employeeId, day) => {
  const att = await Attendance.findOne({ employee: employeeId, date: startOfDay(day) }).lean();
  // No explicit record -> derived; assume present unless leave/weekly-off.
  if (!att) return true;
  return att.status === 'present' || att.status === 'half_paid' || att.status === 'half_unpaid';
};

/**
 * Sweep across every unsubmitted submission for `day` and emit
 * probable penalties.  Called from the employee's getToday so we
 * don't need a separate cron for warnings.
 */
const sweepProbableAbsentSubmission = async ({ employeeId, day }) => {
  const target = startOfDay(day);
  const present = await _isPresentAttendance(employeeId, target);
  if (!present) return [];

  // Every submission the daily engine seeded for this employee/day.
  const subs = await Submission.find({
    employee: employeeId,
    date: target,
    submitted: false,
    deleted: { $ne: true },
  }).select('_id template templateType').lean();

  if (!subs.length) return [];

  const results = [];
  for (const s of subs) {
    // We only warn for TASK templates -- excel/sheet/custom follow
    // their own gating rules.  The spec is explicit that only work
    // submission for the assigned task template counts.
    if (s.templateType && s.templateType !== 'task' && s.templateType !== 'custom') continue;
    const p = await _upsertProbable({
      employee: employeeId,
      category: 'absent_submission',
      source: 'automatic',
      probable: true,
      status: 'active',
      penaltyMarks: 0,           // warnings never deduct.
      targetDate: target,
      submission: s._id,
      rule: 'submission_missing_v1_warn',
      reason: 'Present but today\'s submission is missing.',
      employeeMessage: 'You have not submitted today\'s work yet. If unresolved by end-of-day, a performance penalty will apply tomorrow.',
      effectiveDate: target,
    });
    if (p) results.push(p);
  }
  return results;
};

/**
 * R1b -- Enforced penalty for YESTERDAY.
 *
 * Runs the day after.  For every unsubmitted task-template
 * submission from `previousDay` where the employee was present,
 * create an active penalty equal to that submission's earned marks
 * (which will be 0 for a never-submitted stub, but if HR later
 * decides to grade a partially-completed submission the penalty
 * still zeros the Final Marks by construction).
 *
 * We also resolve the previous probable warnings and let the
 * dashboard show them under "Resolved" (converted to enforced).
 */
const enforceAbsentSubmission = async ({ employeeId, previousDay }) => {
  const target = startOfDay(previousDay);
  const present = await _isPresentAttendance(employeeId, target);
  if (!present) return [];

  const subs = await Submission.find({
    employee: employeeId,
    date: target,
    submitted: false,
    deleted: { $ne: true },
  }).lean();

  if (!subs.length) return [];

  const created = [];
  for (const s of subs) {
    if (s.templateType && s.templateType !== 'task' && s.templateType !== 'custom') continue;

    const p = await _upsertAutoPenalty({
      employee: employeeId,
      category: 'absent_submission',
      source: 'automatic',
      probable: false,
      status: 'active',
      // Wipe the day's earned marks by penalising exactly Earned.
      // Because Final = max(0, Earned − Penalties), this produces
      // the "Final = 0" result the spec requires while leaving the
      // original earnedPoints untouched for transparency.
      penaltyMarks: Number(s.earnedPoints) || 0,
      targetDate: target,
      submission: s._id,
      rule: 'submission_missing_v1',
      reason: 'Present but work not submitted.',
      employeeMessage: 'A performance penalty was applied: you were marked present but did not submit yesterday\'s work.',
      effectiveDate: startOfDay(new Date()),
    });
    if (p) {
      created.push(p);
      // Best-effort notification -- never blocks the engine.
      notify.notifyPenalty({
        employeeId,
        penalty: p,
        mode: 'active',
      });
    }

    // Any probable record for this same tuple is now resolved.
    await Penalty.updateMany(
      { employee: employeeId, category: 'absent_submission', probable: true, submission: s._id },
      { $set: { status: 'resolved', resolvedAt: new Date() } }
    );
  }
  return created;
};

/**
 * Resolve outstanding absent_submission penalties the moment the
 * employee submits work for the target day.  Called from
 * submitOne / saveDraft on transition.
 */
const resolveAbsentSubmissionOnSubmit = async ({ submissionId }) => {
  await Penalty.updateMany(
    { submission: submissionId, category: 'absent_submission', status: { $in: ['active', 'pending', 'scheduled'] } },
    { $set: { status: 'resolved', resolvedAt: new Date() } }
  );
};

/* ================================================================
 *  R2 -- DEPENDENCY_PENDING (3 consecutive days -> daily penalty)
 * ================================================================ */

/**
 * List dependency tasks that have been pending for 3+ consecutive
 * days.  Uses DependencyTask.assignedAt as the clock.
 */
const _overdueDependencies = async (employeeId, asOf) => {
  const threshold = new Date(startOfDay(asOf).getTime() - 3 * DAY_MS);
  return DependencyTask.find({
    assignedTo: employeeId,
    status: { $in: ['pending', 'assigned'] },  // any open state
    assignedAt: { $lte: threshold },
  }).lean();
};

/**
 * R2 -- Daily enforcement.  Creates ONE penalty per employee per
 * day that lists every overdue dependency.  The penalty carries
 * `penaltyMarks = 0` because the spec pins the deduction to the
 * day's earned marks -- we compute that lazily during read via
 * a special short-circuit in penaltyMath (Phase 61.4b: TODO in the
 * consumer).  For now we tag with `dependencyIds` so the UI can
 * show which ones triggered.
 */
const enforceDependencyPending = async ({ employeeId, day }) => {
  const target = startOfDay(day);
  const overdue = await _overdueDependencies(employeeId, target);
  if (!overdue.length) return null;

  const primary = await Submission.findOne({
    employee: employeeId,
    date: target,
    deleted: { $ne: true },
  }).select('_id earnedPoints').lean();

  const doc = {
    employee: employeeId,
    category: 'dependency_pending',
    source: 'automatic',
    probable: false,
    status: 'active',
    // Penalize the entire day's earned marks so Final -> 0.
    penaltyMarks: primary ? Number(primary.earnedPoints) || 0 : 0,
    targetDate: target,
    submission: primary ? primary._id : null,
    dependencyIds: overdue.map((d) => d._id),
    rule: 'dependency_3day_v1',
    reason: `${overdue.length} dependency task${overdue.length === 1 ? '' : 's'} pending for 3+ days.`,
    employeeMessage: `${overdue.length} dependency task${overdue.length === 1 ? ' is' : 's are'} overdue by more than 3 days. Resolve to lift the daily penalty.`,
    effectiveDate: target,
  };
  const p = await _upsertAutoPenalty(doc);
  if (p) {
    notify.notifyPenalty({ employeeId, penalty: p, mode: 'active' });
  }
  return p;
};

/**
 * Called from dependencyController.resolve so any active
 * dependency_pending penalty that referenced this task can be
 * resolved when the last overdue task closes.
 */
const onDependencyResolved = async ({ employeeId, dependencyId }) => {
  const stillOpen = await DependencyTask.countDocuments({
    assignedTo: employeeId,
    status: { $in: ['pending', 'assigned'] },
  });
  if (stillOpen > 0) return;
  await Penalty.updateMany(
    { employee: employeeId, category: 'dependency_pending', status: 'active' },
    { $set: { status: 'resolved', resolvedAt: new Date() } }
  );
};

/**
 * Probable warning: dependency pending for exactly 2 days -> warn
 * that day 3 will trigger a penalty.  Same idempotent upsert.
 */
const sweepProbableDependencyPending = async ({ employeeId, day }) => {
  const target = startOfDay(day);
  // Pending for 2 days but not yet 3.
  const upper = new Date(target.getTime() - 2 * DAY_MS);
  const lower = new Date(target.getTime() - 3 * DAY_MS + 1);
  const nearOverdue = await DependencyTask.find({
    assignedTo: employeeId,
    status: { $in: ['pending', 'assigned'] },
    assignedAt: { $gte: lower, $lte: upper },
  }).lean();
  if (!nearOverdue.length) return null;
  const p = await _upsertProbable({
    employee: employeeId,
    category: 'dependency_pending',
    source: 'automatic',
    probable: true,
    status: 'active',
    penaltyMarks: 0,
    targetDate: target,
    dependencyIds: nearOverdue.map((d) => d._id),
    rule: 'dependency_3day_v1_warn',
    reason: 'Pending dependency task -- 2 days remaining.',
    employeeMessage: 'You have a dependency pending for 2 days. If unresolved by tomorrow, performance penalties will apply.',
    effectiveDate: target,
  });
  return p;
};

/* ================================================================
 *  Orchestration
 * ================================================================ */

/**
 * runProbablesForToday(employeeId) -- called from getToday so the
 * warnings surface immediately without waiting for a cron.
 */
const runProbablesForToday = async ({ employeeId, day = new Date() }) => {
  const results = { probable: [] };
  try {
    results.probable.push(...await sweepProbableAbsentSubmission({ employeeId, day }));
  } catch (e) { console.error('[penaltyEngine] probable absent:', e.message); }
  try {
    const dp = await sweepProbableDependencyPending({ employeeId, day });
    if (dp) results.probable.push(dp);
  } catch (e) { console.error('[penaltyEngine] probable dependency:', e.message); }
  return results;
};

/**
 * runDaily({ day }) -- meant to run once per calendar day per
 * employee.  Safe to call multiple times: every writer is idempotent.
 * The caller decides the "run for who" scope (per-employee login
 * hook, or a bulk cron).
 */
const runDaily = async ({ employeeId, day = new Date() }) => {
  const target = startOfDay(day);
  const results = { enforced: [] };
  // Absent submission is enforced the day AFTER the miss.
  try {
    const previousDay = _add(target, -1);
    results.enforced.push(...await enforceAbsentSubmission({ employeeId, previousDay }));
  } catch (e) { console.error('[penaltyEngine] enforce absent:', e.message); }
  // Dependency penalty renews daily until resolved.
  try {
    const dp = await enforceDependencyPending({ employeeId, day: target });
    if (dp) results.enforced.push(dp);
  } catch (e) { console.error('[penaltyEngine] enforce dependency:', e.message); }
  return results;
};

module.exports = {
  runProbablesForToday,
  runDaily,
  resolveAbsentSubmissionOnSubmit,
  onDependencyResolved,
  // Exposed for direct testing / bulk backfill.
  enforceAbsentSubmission,
  enforceDependencyPending,
  sweepProbableAbsentSubmission,
  sweepProbableDependencyPending,
};
