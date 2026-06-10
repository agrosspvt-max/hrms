/**
 * assignmentSubTemplateMigration
 *
 * Phase 13 boot backfill.  Any Assignment carrying the Phase-12 single
 * `subTemplateId` field is upgraded so the same scope appears in the
 * new `subTemplateIds` array; the legacy field stays on the document
 * so older reads keep resolving.
 *
 * Idempotent: the filter only matches rows where subTemplateId is
 * populated AND subTemplateIds is empty.
 *
 * Semantics preserved:
 *   - Old assignment, no scope at all      -> subTemplateIds: []   (means "all")
 *   - Old assignment, subTemplateId: 'sub_a' -> subTemplateIds: ['sub_a']
 *   - New assignment, subTemplateIds: ['sub_a', 'sub_b'] -> untouched
 */

const Assignment = require('../models/Assignment');

const migrateAssignmentSubTemplateIds = async () => {
  const candidates = await Assignment.find({
    subTemplateId: { $exists: true, $ne: '' },
    $or: [
      { subTemplateIds: { $exists: false } },
      { subTemplateIds: { $size: 0 } },
    ],
  }).select('_id subTemplateId subTemplateIds').lean();

  if (candidates.length === 0) {
    console.log('[migrate] assignment sub-template ids: nothing to backfill');
    return { touched: 0 };
  }

  const ops = candidates.map((a) => ({
    updateOne: {
      filter: { _id: a._id },
      update: { $set: { subTemplateIds: [String(a.subTemplateId)] } },
    },
  }));
  const r = await Assignment.bulkWrite(ops, { ordered: false });
  const touched = r?.modifiedCount || ops.length;
  console.log(`[migrate] assignment sub-template ids: backfilled subTemplateIds on ${touched} assignment(s)`);
  return { touched };
};

module.exports = { migrateAssignmentSubTemplateIds };
