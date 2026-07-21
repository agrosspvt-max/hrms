/**
 * critical.js -- shared helper that resolves "was this incident's
 * source associated with a critical task?" by inspecting the
 * originating Template's `customFields[i].isCritical` (Option A of
 * the approved product decision for Batch-1 fix #2).
 *
 * Detectors call `resolveCriticalByTemplateId(templateId)`; the
 * helper returns `true` when the template has ANY customField with
 * `isCritical:true`.
 *
 * Cache lifetime (Batch-2 pre-batch hardening): PER-TICK.  The
 * scheduler calls `beginTick()` at the start of every evaluation
 * cycle, which clears the cache.  Within one tick, repeated lookups
 * for the same templateId hit the in-memory map; across ticks, a
 * Template.customFields.isCritical edit is picked up on the next tick.
 * No external cache infrastructure required.
 *
 * Zero writes.  Safe on any read path.
 */

const Template = require('../../models/Template');

const _cache = new Map();   // String(templateId) -> boolean, reset per tick

/**
 * Resolve criticality for a template id.  Returns false on missing
 * template / lookup error (fail-closed so a lookup blip never
 * escalates a fine).
 *
 * On DB error we do NOT cache the false result -- next lookup in
 * the same tick re-attempts the query so a transient blip doesn't
 * stick.  Successful lookups (true or false) are cached.
 */
const resolveCriticalByTemplateId = async (templateId) => {
  if (!templateId) return false;
  const k = String(templateId);
  if (_cache.has(k)) return _cache.get(k);
  try {
    const t = await Template.findById(templateId).select('customFields').lean();
    const anyCritical = !!(t && Array.isArray(t.customFields)
      && t.customFields.some((f) => f && f.isCritical === true));
    _cache.set(k, anyCritical);
    return anyCritical;
  } catch (e) {
    console.error('[compliance/critical] lookup failed for', k, e.message);
    // NOT cached: transient errors get retried on the next call.
    return false;
  }
};

/**
 * Reset the cache.  Called from `ruleEvaluationScheduler.tick()`
 * before detection runs.  Also exported as `clearCache` for tests
 * and ops tooling.
 */
const beginTick = () => _cache.clear();
const clearCache = () => _cache.clear();

/** Test-only introspection.  Never used in production. */
const _size = () => _cache.size;

module.exports = { resolveCriticalByTemplateId, beginTick, clearCache, _size };
