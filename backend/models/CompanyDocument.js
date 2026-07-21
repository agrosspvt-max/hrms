/**
 * CompanyDocument -- lightweight document library for the Contacts
 * page.  Currently used to host the HR Policy PDF and a small set of
 * companion documents (handbook, leave policy, etc.).
 *
 * Deliberately simple: one collection, one file per row, no
 * versioning, no folders, no categories.  Bytes live inline in the
 * `data` Buffer (select:false so list endpoints ship metadata only);
 * the stream endpoint fetches with `.select('+data')`.  Migration to
 * cloud storage later is additive -- add `storageProvider` /
 * `storageKey` fields; the stream endpoint branches accordingly.
 * Not modelled today because we don't need it.
 */
const mongoose = require('mongoose');

const companyDocumentSchema = new mongoose.Schema(
  {
    title:       { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    // File metadata (always populated on upload).
    fileName:    { type: String, required: true },
    mimeType:    { type: String, required: true },
    size:        { type: Number, required: true, min: 0 },
    // File bytes.  select:false so list / read endpoints don't ship
    // multi-MB payloads by mistake.  The inline stream endpoint pulls
    // this explicitly.
    data:        { type: Buffer, select: false },

    // Optional -- HR may stamp when the policy takes effect.
    effectiveDate:       { type: Date, default: null },
    // Employees can read this document when true.  When false, only
    // HR + Super Admin see it.
    visibleToEmployees:  { type: Boolean, default: true, index: true },
    // Soft-off switch (hide without deleting).
    isActive:            { type: Boolean, default: true, index: true },

    uploadedBy:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

companyDocumentSchema.index({ isActive: 1, visibleToEmployees: 1, createdAt: -1 });

module.exports = mongoose.model('CompanyDocument', companyDocumentSchema);
