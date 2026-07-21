/**
 * backfillJob.js -- write synthetic ComplianceIncident +
 * ComplianceActionEffect rows for every legacy `Penalty` row.
 *
 * DEFAULT MODE: dry-run.  The job prints what it WOULD write and
 * exits without touching the DB.  Committed mode requires:
 *
 *   1. `--commit` on the CLI (or `commit: true` in code).
 *   2. `compliance.legacyBackfill` feature flag ON.
 *   3. The `.penalty` collection currently has legacy rows without
 *      `incidentId` set (safety check -- refuses to run twice).
 *
 * Both dry-run and commit modes are idempotent -- the natural key
 * (`legacy_projection|<penaltyId>`) is partial-unique, so re-runs
 * skip rows that already have their synthetic incident.
 *
 * Rollback: `deleteSynthetic()` removes every incident whose
 * naturalKey begins with `legacy_projection|`, plus their child
 * effects.  Never touches original Penalty rows.
 */

const Penalty = require('../../../models/Penalty');
const ComplianceRule = require('../../../models/ComplianceRule');
const ComplianceIncident = require('../../../models/ComplianceIncident');
const ComplianceActionEffect = require('../../../models/ComplianceActionEffect');
const { isEnabled } = require('../../../config/featureFlags');
const projection = require('./penaltyProjectionService');

const _now = () => new Date().toISOString();

const _log = (line) => console.log(`[compliance/backfill ${_now()}] ${line}`);
const _err = (line) => console.error(`[compliance/backfill ${_now()}] ERR ${line}`);

/**
 * Safety check that refuses to run committed backfill when the
 * database looks like it's already been migrated.  Specifically:
 * if `>= 50%` of legacy Penalty rows already carry `incidentId`,
 * we bail (the batch has almost certainly been run before and the
 * caller passed `--commit` by mistake).
 */
const _refuseIfAlreadyBackfilled = async () => {
  const total = await Penalty.countDocuments({ source: 'automatic' });
  if (total === 0) return;
  const migrated = await Penalty.countDocuments({
    source: 'automatic',
    incidentId: { $ne: null },
  });
  const pct = migrated / total;
  if (pct >= 0.5) {
    throw new Error(
      `Safety check refused: ${Math.round(pct * 100)}% of automatic Penalty rows ` +
      `already carry incidentId; re-running commit would double-write.  Use ` +
      `deleteSynthetic() first if you truly want to rebuild.`);
  }
};

/**
 * Run the backfill.  Options:
 *
 *   commit      -- when false (default), no writes happen.
 *   batchSize   -- how many Penalty rows to process per batch.
 *   categories  -- optional array of Penalty.category values to
 *                  restrict the sweep.
 *   dryRunLimit -- print at most this many "would-write" lines.
 */
const run = async ({
  commit = false,
  batchSize = 500,
  categories = null,
  dryRunLimit = 20,
} = {}) => {
  const summary = {
    scanned: 0,
    skipped: 0,       // no rule mapping, or already has incidentId
    projected: 0,     // would write (dry-run) or wrote (commit)
    committed: 0,
    errors: 0,
    sampleProjections: [],
    startedAt: new Date(),
    endedAt: null,
    mode: commit ? 'commit' : 'dry-run',
  };

  if (commit) {
    if (!isEnabled('compliance.legacyBackfill')) {
      throw new Error('commit mode refused: compliance.legacyBackfill flag is off.');
    }
    await _refuseIfAlreadyBackfilled();
  }

  // Cache rules by code for fast lookup.
  const ruleRows = await ComplianceRule.find({}).select('_id code version').lean();
  const ruleByCode = new Map(ruleRows.map((r) => [r.code, r]));

  const where = { source: 'automatic', incidentId: null };
  if (Array.isArray(categories) && categories.length) {
    where.category = { $in: categories };
  }

  let lastId = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const q = { ...where };
    if (lastId) q._id = { $gt: lastId };
    const batch = await Penalty.find(q).sort({ _id: 1 }).limit(batchSize).lean();
    if (!batch.length) break;
    lastId = batch[batch.length - 1]._id;

    for (const p of batch) {
      summary.scanned += 1;
      const map = projection.mappingFor(p);
      if (!map) { summary.skipped += 1; continue; }
      const rule = ruleByCode.get(map.ruleCode);
      if (!rule) { summary.skipped += 1; continue; }

      summary.projected += 1;
      if (summary.sampleProjections.length < dryRunLimit) {
        summary.sampleProjections.push({
          penaltyId: p._id, ruleCode: map.ruleCode,
          actionType: map.actionType, naturalKey: map.naturalKey,
          status: map.status,
        });
      }

      if (!commit) continue;

      // Committed path.  Idempotent: skip if a synthetic incident
      // already exists for this Penalty.
      try {
        let incident = await ComplianceIncident.findOne({
          naturalKey: map.naturalKey, source: 'automatic',
        });
        if (!incident) {
          try {
            incident = await ComplianceIncident.create({
              ruleId: rule._id, ruleVersion: rule.version, ruleCode: rule.code,
              employee: p.employee, severity: 'medium',
              incidentDate: map.incidentDate, effectiveDate: map.effectiveDate,
              naturalKey: map.naturalKey,
              context: map.context, detectorMeta: map.detectorMeta,
              status: map.status,
              source: 'automatic',
              createdBy: null,
              resolvedAt: p.resolvedAt || (map.status === 'resolved' ? new Date() : null),
              cancelledAt: p.cancelledAt || (map.status === 'cancelled' ? new Date() : null),
              cancelledBy: p.cancelledBy || null,
              cancelReason: p.cancelReason || '',
            });
          } catch (e) {
            if (e && e.code === 11000) {
              incident = await ComplianceIncident.findOne({
                naturalKey: map.naturalKey, source: 'automatic',
              });
            } else { throw e; }
          }
        }

        // Effect row.
        const ruleAction = (rule.actions || []).find((a) => a.type === map.actionType);
        const ruleActionId = ruleAction ? ruleAction._id : incident._id;   // stable fallback
        let effect = await ComplianceActionEffect.findOne({
          incidentId: incident._id,
          ruleActionId,
          effectiveDate: map.effectiveDate,
        });
        if (!effect) {
          try {
            effect = await ComplianceActionEffect.create({
              incidentId: incident._id,
              ruleId: rule._id,
              ruleActionId,
              actionType: map.actionType,
              employee: p.employee,
              status: map.status,
              effectiveDate: map.effectiveDate,
              amount: map.amount, marks: map.marks, percent: map.percent,
              penaltyId: p._id,
            });
          } catch (e) {
            if (!e || e.code !== 11000) throw e;
          }
        }

        // Back-reference on the legacy Penalty.
        if (!p.incidentId) {
          await Penalty.updateOne(
            { _id: p._id, incidentId: null },
            { $set: { incidentId: incident._id } },
          );
        }

        summary.committed += 1;
      } catch (e) {
        summary.errors += 1;
        _err(`penalty ${p._id}: ${e.message}`);
      }
    }
  }

  summary.endedAt = new Date();
  _log(`${summary.mode} complete: scanned=${summary.scanned} ` +
       `projected=${summary.projected} committed=${summary.committed} ` +
       `skipped=${summary.skipped} errors=${summary.errors}`);
  return summary;
};

/**
 * Delete every synthetic incident + effect the backfill wrote.
 * Does NOT touch the original Penalty rows.  Safe rollback.
 */
const deleteSynthetic = async ({ commit = false } = {}) => {
  const incidentQ = { naturalKey: { $regex: '^legacy_projection\\|' }, source: 'automatic' };
  const scanned = await ComplianceIncident.countDocuments(incidentQ);
  if (!commit) {
    _log(`dry-run rollback: would delete ${scanned} synthetic incident(s) + child effects.`);
    return { mode: 'dry-run', scanned, deletedIncidents: 0, deletedEffects: 0 };
  }
  const incidents = await ComplianceIncident.find(incidentQ).select('_id').lean();
  const ids = incidents.map((i) => i._id);
  const effR = await ComplianceActionEffect.deleteMany({ incidentId: { $in: ids } });
  const incR = await ComplianceIncident.deleteMany({ _id: { $in: ids } });
  // Clear the back-reference on Penalty rows we set.
  await Penalty.updateMany(
    { incidentId: { $in: ids } },
    { $set: { incidentId: null } },
  );
  _log(`rollback commit: incidents=${incR.deletedCount} effects=${effR.deletedCount}`);
  return {
    mode: 'commit',
    scanned,
    deletedIncidents: incR.deletedCount,
    deletedEffects:   effR.deletedCount,
  };
};

module.exports = { run, deleteSynthetic };
