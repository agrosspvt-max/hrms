/**
 * strategies.js -- four built-in marks strategies + dispatcher.
 *
 * Each strategy returns a non-negative number representing "how many
 * marks this action should deduct" for the given (employee, day,
 * submission).  Strategies are pure functions with a small config
 * object; they NEVER touch ledgers or write anywhere.
 *
 * Dispatcher chain: caller-configured code -> declared fallback ->
 * `admin_defined` -> 0.
 */

const Submission = require('../../../models/Submission');
const Template   = require('../../../models/Template');
const User       = require('../../../models/User');
const { startOfDay, addDays } = require('../../../utils/dateHelpers');
const registry = require('../registry/marksStrategyRegistry');

const _isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * `last_n_avg` -- average earned marks over the last N days that
 * carry a submission for the same template.  Falls back to 0 when
 * the employee has no history (caller should then fall through to
 * the next strategy).
 */
const lastNAvg = async ({ employee, template, day, config = {} }) => {
  const N = Math.max(1, Number(config && config.N) || 7);
  const cutoff = startOfDay(addDays(startOfDay(day), -N));
  const q = { employee: employee._id, submitted: true, deleted: { $ne: true }, isTestData: { $ne: true } };
  if (template && template._id) q.template = template._id;
  q.date = { $gte: cutoff, $lte: startOfDay(day) };
  const rows = await Submission.find(q).select('earnedPoints').lean();
  if (!rows.length) return 0;
  const total = rows.reduce((s, r) => s + (Number(r.earnedPoints) || 0), 0);
  return Math.max(0, total / rows.length);
};

/**
 * Batch-3 fix #14 -- template-derived `expectedMarks`.
 *
 * The original implementation read a nullable `expectedMarks` field
 * on the Template that the schema never declared -- Mongoose's strict
 * mode dropped it on save, so the strategy always returned 0 and the
 * chain skipped straight to `admin_defined`.  We now derive an
 * expected-marks value from the template's own scoring configuration:
 *
 *   - task     -> sum of tasks[i].points
 *   - custom   -> sum of customFields[i].maxMarks where enableMarks
 *   - excel    -> sum of excelColumns[i].maxMarks where markEligible
 *   - sheet    -> sum of sheet.scores[i].maxMarks
 *
 * If the (Mongo-persisted) template happens to carry a non-schema
 * `expectedMarks` field (e.g. an out-of-band write), that explicit
 * value wins so operators retain a manual override path without a
 * schema migration.
 *
 * Returns 0 if the template has no scoring shape -- caller then falls
 * through to `admin_defined`, preserving Batch-1 fresh-hire behaviour.
 */
const _sumTemplateExpectedMarks = (tpl) => {
  if (!tpl) return 0;
  // Manual override path (non-schema field; only present when the doc
  // was written outside Mongoose or with strict:false).
  const override = Number(tpl.expectedMarks);
  if (Number.isFinite(override) && override > 0) return override;
  let sum = 0;
  if (Array.isArray(tpl.tasks)) {
    for (const t of tpl.tasks) sum += Math.max(0, Number(t && t.points) || 0);
  }
  if (Array.isArray(tpl.customFields)) {
    for (const f of tpl.customFields) {
      if (f && f.enableMarks) sum += Math.max(0, Number(f.maxMarks) || 0);
    }
  }
  if (Array.isArray(tpl.excelColumns)) {
    for (const c of tpl.excelColumns) {
      if (c && c.markEligible) sum += Math.max(0, Number(c.maxMarks) || 0);
    }
  }
  if (tpl.sheet && Array.isArray(tpl.sheet.scores)) {
    for (const s of tpl.sheet.scores) sum += Math.max(0, Number(s && s.maxMarks) || 0);
  }
  return sum;
};

const templateDefault = async ({ template }) => {
  if (!template) return 0;
  // Support both direct object + id.  If the caller already handed us
  // the full doc, skip the round-trip.
  let tpl = null;
  if (template && (template.tasks || template.customFields || template.excelColumns || template.sheet || template.expectedMarks !== undefined)) {
    tpl = template;
  } else {
    const tid = template && (template._id || template.id);
    if (tid) {
      tpl = await Template.findById(tid)
        .select('templateType tasks customFields excelColumns sheet.scores expectedMarks')
        .lean();
    }
  }
  const val = _sumTemplateExpectedMarks(tpl);
  return Number.isFinite(val) && val > 0 ? val : 0;
};

/**
 * `department_avg` -- 30-day rolling average of the department's
 * per-day earned marks.  Falls back to 0 on empty departments.
 *
 * Stabilization patch (C5): the previous implementation returned 0
 * whenever `employee.department` was missing.  Detectors did not
 * populate `context.departmentId`, so the strategy was effectively
 * dead.  We now fall back to `User.findById(employee._id).select
 * ('department')` on the slow path.  Detectors have been updated
 * to populate `context.departmentId` so the fast path stays cheap.
 */
const departmentAvg = async ({ employee, day, config = {} }) => {
  const window = Math.max(1, Number(config && config.windowDays) || 30);
  const cutoff = startOfDay(addDays(startOfDay(day), -window));
  if (!employee || !employee._id) return 0;
  let departmentId = employee.department;
  if (!departmentId) {
    const u = await User.findById(employee._id).select('department').lean();
    departmentId = u && u.department;
  }
  if (!departmentId) return 0;
  const peers = await User.find({
    department: departmentId,
    status: 'active',
  }).select('_id').lean();
  if (!peers.length) return 0;
  const rows = await Submission.find({
    employee: { $in: peers.map((p) => p._id) },
    submitted: true,
    deleted: { $ne: true }, isTestData: { $ne: true },
    date: { $gte: cutoff, $lte: startOfDay(day) },
  }).select('earnedPoints').lean();
  if (!rows.length) return 0;
  const total = rows.reduce((s, r) => s + (Number(r.earnedPoints) || 0), 0);
  return Math.max(0, total / rows.length);
};

/** `admin_defined` -- the rule's action config carries the number. */
const adminDefined = async ({ config = {} }) => {
  const val = Number(config && config.marks);
  return Number.isFinite(val) && val > 0 ? val : 0;
};

const registerAll = () => {
  if (!registry.get('last_n_avg'))       registry.register('last_n_avg', lastNAvg);
  if (!registry.get('template_default')) registry.register('template_default', templateDefault);
  if (!registry.get('department_avg'))   registry.register('department_avg', departmentAvg);
  if (!registry.get('admin_defined'))    registry.register('admin_defined', adminDefined);
};

/**
 * Dispatcher: run the requested strategy; when it returns 0 (i.e.
 * "no data") try the fallback chain.  The final fallback is
 * `admin_defined` (which reads a fixed `config.marks`).  Zero at the
 * end of the chain is a valid outcome (nothing to deduct).
 */
const compute = async (ctx) => {
  const chain = [];
  const asked = ctx && ctx.strategy;
  if (asked && registry.get(asked)) chain.push(asked);
  for (const fallback of ['template_default', 'admin_defined']) {
    if (!chain.includes(fallback)) chain.push(fallback);
  }
  for (const code of chain) {
    const fn = registry.get(code);
    if (!fn) continue;
    const v = await fn(ctx);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
};

module.exports = { registerAll, compute, lastNAvg, templateDefault, departmentAvg, adminDefined };
