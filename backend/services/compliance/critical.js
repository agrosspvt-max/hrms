/**
 * critical.js -- SINGLE SOURCE OF TRUTH for task criticality across
 * the HRMS.  Every compliance detector, executor, dashboard metric or
 * analytics query that needs to know whether a task is "critical"
 * MUST route through this helper.  It reads ONLY `isCritical` flags --
 * never template names, priorities, or heuristics.
 *
 * Source of truth per stage:
 *   - A task that already exists on a Submission: the SNAPSHOT
 *     (`Submission.tasks[i].isCritical`, written when the row was created).
 *     An explicit true OR false wins; later template edits do not
 *     re-classify history.
 *   - Only rows that predate the snapshot (field absent) fall back to the
 *     live `Template` flag.
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
 *   1) The snapshot row on the source submission.  `sourceTaskId` is the
 *      Submission.tasks[] row `_id` (what stampDependency writes); the
 *      template task id (`row.taskId`) is accepted for older rows.  An
 *      explicit true/false on that row wins -- HR toggles later don't
 *      retroactively re-classify.
 *   2) Live Template.tasks[i].isCritical, only when the row has no
 *      snapshot (pre-snapshot data) or the id matches no row.
 *   3) false (excel / sheet sources, no source submission).
 */
const resolveCriticalForDependency = async (dep) => {
  if (!dep) return false;
  const subId  = dep.sourceSubmissionId;
  const taskId = dep.sourceTaskId;
  if (!subId || !taskId) return false;
  // Excel columns / sheet scores carry no criticality concept.
  if (dep.sourceKind === 'excel' || dep.sourceKind === 'sheet') return false;

  const sk = String(subId);
  let subRec = _subCache.get(sk);
  if (!subRec) {
    try {
      const sub = await Submission.findById(subId)
        .select('template tasks._id tasks.taskId tasks.isCritical')
        .lean();
      const byRowId = new Map();
      const byTemplateTaskId = new Map();
      if (sub) {
        (Array.isArray(sub.tasks) ? sub.tasks : []).forEach((row) => {
          if (!row) return;
          // `undefined` (not false) marks a legacy row without a snapshot.
          const entry = {
            flag: typeof row.isCritical === 'boolean' ? row.isCritical : null,
            templateTaskId: row.taskId || null,
          };
          if (row._id) byRowId.set(String(row._id), entry);
          if (row.taskId) byTemplateTaskId.set(String(row.taskId), entry);
        });
      }
      subRec = { templateId: (sub && sub.template) || null, byRowId, byTemplateTaskId };
      _subCache.set(sk, subRec);
    } catch (e) {
      console.error('[compliance/critical] submission lookup failed for', sk, e.message);
      return false;
    }
  }

  const tk = String(taskId);
  // DependencyTask.sourceTaskId is the Submission.tasks[] row `_id`
  // (submissionController.stampDependency / dependencyEngine);
  // the template task id is accepted too for older / HR-created rows.
  const row = subRec.byRowId.get(tk) || subRec.byTemplateTaskId.get(tk);
  if (row) {
    if (row.flag !== null) return row.flag;                       // snapshot wins
    return subRec.templateId
      ? resolveCriticalByTaskId(subRec.templateId, row.templateTaskId || tk)   // legacy row
      : false;
  }
  // Unknown row id: last resort, treat it as a template task id.
  return subRec.templateId ? resolveCriticalByTaskId(subRec.templateId, tk) : false;
};

/**
 * Pending-task row (from PendingStateService) -> critical?  The row's
 * `criticalSnapshot` (true/false) is authoritative; null means a legacy
 * row, so the live template is consulted by template task id.
 */
const resolveCriticalForPendingRow = async (row) => {
  if (!row) return false;
  if (row.criticalSnapshot === true) return true;
  if (row.criticalSnapshot === false) return false;
  if (row.isCritical === true && row.criticalSnapshot === undefined) return true;   // caller without the tri-state
  if (row.templateId && row.templateTaskId) {
    return resolveCriticalByTaskId(row.templateId, row.templateTaskId);
  }
  return false;
};

/**
 * Whole-submission miss (Missed Submission): critical iff the stub's own
 * task snapshot contains a critical task.  A stub with no snapshot at all
 * (custom templates, pre-snapshot rows) falls back to the template-wide flag.
 */
const resolveCriticalForSubmission = async (stub) => {
  if (!stub) return false;
  const flags = (Array.isArray(stub.tasks) ? stub.tasks : [])
    .filter((t) => t && typeof t.isCritical === 'boolean');
  if (flags.length) return flags.some((t) => t.isCritical === true);
  return resolveCriticalByTemplateId(stub.template);
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
  resolveCriticalForPendingRow,
  resolveCriticalForSubmission,
  beginTick,
  clearCache,
  _size,
};
