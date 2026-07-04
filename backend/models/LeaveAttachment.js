/**
 * LeaveAttachment — Phase 54.
 *
 * Supporting documents attached to a leave request (medical
 * certificates, wedding invitations, discharge summaries, etc.).
 *
 * Independent collection (spec: "Store attachments independently from
 * the leave record so the system can later support: multiple
 * attachments, versioning, cloud storage, audit history").  The Leave
 * document never grows a nested files[] array — instead every file is
 * its own LeaveAttachment referencing the leave.
 *
 * Two-phase upload (frontend contract):
 *   1. Employee picks files -> POST /api/leaves/attachments (multipart)
 *      creates LeaveAttachment rows with `leave: null` (orphaned).
 *   2. Employee submits leave -> POST /api/leaves with attachmentIds[]
 *      links each orphan to the new leave document.
 * Orphans older than 24h are pruned by the TTL index below.
 *
 * Storage abstraction:
 *   storageProvider = 'db'  -> file bytes in `data` (default; zero infra).
 *   storageProvider = 's3'/'gcs' -> only metadata + `storageKey` here.
 * The download endpoint reads `storageProvider` to decide where to
 * source the bytes, so migrating to cloud storage later needs no
 * schema change.
 */
const mongoose = require('mongoose');

const leaveAttachmentSchema = new mongoose.Schema(
  {
    // Nullable: an attachment can be uploaded BEFORE its leave record
    // exists (two-phase upload).  Also lets HR-requested docs post-
    // submission live under the same shape without a schema change.
    leave:      { type: mongoose.Schema.Types.ObjectId, ref: 'Leave', default: null, index: true },
    employee:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    filename:  { type: String, required: true },
    mimeType:  { type: String, required: true },
    size:      { type: Number, required: true },

    /* ---- Storage abstraction (spec: future cloud storage) ---- */
    storageProvider: {
      type: String,
      enum: ['db', 's3', 'gcs', 'local'],
      default: 'db',
    },
    // Cloud object key OR local disk path.  Empty for storageProvider='db'.
    storageKey: { type: String, default: '' },
    // Only populated when storageProvider === 'db'.  `select: false` so
    // list endpoints ship metadata only; the download route fetches
    // bytes with .select('+data').
    data: { type: Buffer, select: false },

    /* ---- Future compatibility (spec) ---- */
    // 'active'      — normal supporting document
    // 'requested'   — HR asked for it, employee hasn't uploaded yet
    // 'pending'     — employee uploaded requested doc, HR to verify
    // 'approved'    — HR verified
    // 'rejected'    — HR rejected the doc
    status: {
      type: String,
      enum: ['active', 'requested', 'pending', 'approved', 'rejected'],
      default: 'active',
      index: true,
    },
    // Versioning: parent points at the previous version; version
    // integer increments monotonically per parent chain.
    parentAttachment: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveAttachment', default: null },
    version: { type: Number, default: 1 },

    // Free-form future extension points.  Never populated by the
    // Phase-54 controller; declared here so upgrades are additive.
    comments:  { type: [mongoose.Schema.Types.Mixed], default: [] },
    metadata:  { type: mongoose.Schema.Types.Mixed, default: {} },

    // Soft delete (audit history stays intact).
    deletedAt: { type: Date },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// Composite index for the hot list query.
leaveAttachmentSchema.index({ leave: 1, deletedAt: 1, createdAt: 1 });
// TTL: orphaned uploads (never linked to a leave) expire after 24h so
// abandoned "apply" flows don't fill the DB.  Only orphans expire;
// once `leave` is set the TTL no longer applies because the filter
// key isn't the createdAt field alone.  We enforce the orphan
// specificity via a partial index.
leaveAttachmentSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 86400,
    partialFilterExpression: { leave: null },
  },
);

module.exports = mongoose.model('LeaveAttachment', leaveAttachmentSchema);
