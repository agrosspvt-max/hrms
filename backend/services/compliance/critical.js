/**
 * critical.js -- SINGLE SOURCE OF TRUTH for task criticality across
 * the HRMS.  Every compliance detector, executor, dashboard metric or
 * analytics query that needs to know whether a task is "critical"
 * MUST route through this helper.  The helper reads ONLY the
 * `isCritical` flag stored on the template document -- never
 * template names, priorities, or heuristics.
 *
 * The flag lives in two places on `Template`:
 *   - Task Templates      : `tasks[i].isCritical`         (per-task)
 *   - Custom Templates    : `customFields[i].isCritical`  (per-field)
 *
 * Three lookup shapes are supported:
 *
 *   resolveCriticalByTaskId(templateId, taskId)
 *     Definitive per-task check.  True IFF that specific task row
 *     (or custom field, if the id matches one) has `isCritical:true`.
 *     Preferred for detectors that already know which task overdue-ed
 *     (Performance Lock, Dependency Pending).
 *
 *   resolveCriticalByTemplateId(templateId)
 *     Template-wide check -- true IFF ANY task OR customField on the
 *     template is marked critical.  Used when the miss is at the
 *     whole-submission level (Missed Submission) where no single
 *     task can be blamed.
 *
 *   resolveCriticalForDependency(dep)
 *     Convenience for Dependency Pending: resolves the specific
 *     `sourceTaskId` against its source submission's template.  If
 *     the dependency lacks a source submission (HR-created directly)
 *     or a sourceTaskId, returns false -- fail-closed by design.
 *
 * Cache lifetime: PER-TICK.  `beginTick()` clears the maps before
 * each detection cycle.  Successful lookups (true or false) are
 * cached; DB errors are NOT cached so a transient blip is retried.
 *
 * Zero writes.  Safe on any read path.
 */

const Template = require('../../models/Template');
const Submission = require('../../models/Submission');
const mongoose = require('mongoose');

// String(templateId) -> { any, tasks: Map<String(taskId), bool>, fields: Map<String(fieldId), bool> }
const _cache = new Map();
// String(submissionId) -> { templateId, tasks: Map<String(snapshotTaskId), bool> }
const _subCache = new Map();

const _isTrue = (v) => v === true;

/**
 * Load a compact projection of the template.  Returns null on
 * missing / error.  Callers MUST handle a null result.
 */
const _loadTemplate = async (templateId) => {
  const k = String(templateId);
  if (_cache.has(k)) return _cache.get(k);
  try {
    const t = await Template.findById(templateId)
      .select('tasks._id tasks.isCritical customFields._id customFields.isCritical')
      .lean();
    if (!t) { _cache.set(k, null); return null; }

    const tasksArr  = Array.isArray(t.tasks) ? t.tasks : [];
    const fieldsArr = Array.isArray(t.customFields) ? t.customFields : [];

    const tasks = new Map();
    tasksArr.forEach((row) => {
      if (row && row._id) tasks.set(String(row._id), _isTrue(row.isCritical));
    });
    const fields = new Map();
    fieldsArr.forEach((row) => {
      if (row && row._id) fields.set(String(row._id), _isTrue(row.isCritical));
    });

    // Template-wide "any critical" check must be independent of subdoc
    // _id existence -- we scan the full arrays so a legacy doc whose
    // subdocs somehow lack ids still resolves correctly.
    const any =
      tasksArr.some((row) => row && _isTrue(row.isCritical))
      || fieldsArr.some((row) => row && _isTrue(row.isCritical));

    const rec = { any, tasks, fields };
    _cache.set(k, rec);
    return rec;
  } catch (e) {
    console.error('[compliance/critical] template lookup failed for', k, e.message);
    // Do NOT cache transient errors.
    return null;
  }
};

/**
 * Template-wide check.  True iff ANY task or customField on the
 * template is marked critical.  Fails closed on missing template /
 * lookup errors.
 */
const resolveCriticalByTemplateId = async (templateId) => {
  if (!templateId) return false;
  const rec = await _loadTemplate(templateId);
  return !!(rec && rec.any);
};

/**
 * Per-task check.  If `taskId` matches a task row -> that row's flag.
 * If it matches a customField row -> that field's flag.  If it
 * matches neither, falls back to the template-wide check ONLY when
 * we've established the template exists (so we don't silently upgrade
 * an unrelated id to critical).
 */
const resolveCriticalByTaskId = async (templateId, taskId) => {
  if (!templateId || !taskId) return false;
  const rec = await _loadTemplate(templateId);
  if (!rec) return false;
  const k = String(taskId);
  if (rec.tasks.has(k)) return rec.tasks.get(k);
  if (rec.fields.has(k)) return rec.fields.get(k);
  return false;
};

/**
 * Dependency Pending helper.  Resolves criticality for a single
 * DependencyTask row using the snapshot on its source submission (if
 * present) and falling back to the live template.
 *
 * `dep` must be a plain object with at least `sourceSubmissionId`
 * and `sourceTaskId` (both may be missing -- returns false then).
 *
 * Preference order:
 *   1) Snapshot on Submission.tasks[i].isCritical for the row whose
 *      `taskId === dep.sourceTaskId` (stable, HR toggles later don't
 *      retroactively re-classify).
 *   2) Live Template.tasks[i].isCritical for the same taskId.
 *   3) false.
 */
const resolveCriticalForDependency = async (dep) => {
  if (!dep) return false;
  const subId  = dep.sourceSubmissionId;
  const taskId = dep.sourceTaskId;
  if (!subId || !taskId) return false;

  const sk = String(subId);
  let subRec = _subCache.get(sk);
  if (!subRec) {
    try {
      const sub = await Submission.findById(subId)
        .select('template tasks._id tasks.taskId tasks.isCritical')
        .lean();
      if (!sub) {
        subRec = { templateId: null, tasks: new Map() };
      } else {
        const tasks = new Map();
        (Array.isArray(sub.tasks) ? sub.tasks : []).forEach((row) => {
          // Snapshot rows carry the ORIGINAL template task id in `taskId`.
          const rid = row && (row.taskId || row._id);
          if (rid) tasks.set(String(rid), _isTrue(row.isCritical));
        });
        subRec = { templateId: sub.template || null, tasks };
      }
      _subCache.set(sk, subRec);
    } catch (e) {
      console.error('[compliance/critical] submission lookup failed for', sk, e.message);
      return false;
    }
  }

  const tk = String(taskId);
  if (subRec.tasks.has(tk)) return subRec.tasks.get(tk);

  // Snapshot didn't carry the flag (legacy submission).  Fall back
  // to the live template.
  if (subRec.templateId) {
    return resolveCriticalByTaskId(subRec.templateId, tk);
  }
  return false;
};

/**
 * Reset the cache.  Called from `ruleEvaluationScheduler.tick()`
 * before detection runs.  Also exported as `clearCache` for tests
 * and ops tooling.
 */
const beginTick = () => { _cache.clear(); _subCache.clear(); };
const clearCache = () => { _cache.clear(); _subCache.clear(); };

/** Test-only introspection.  Never used in production. */
const _size = () => _cache.size + _subCache.size;

module.exports = {
  resolveCriticalByTemplateId,
  resolveCriticalByTaskId,
  resolveCriticalForDependency,
  beginTick,
  clearCache,
  _size,
};
