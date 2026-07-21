/**
 * companyDocumentController.js -- lightweight HR document library.
 *
 * Employee reads are scoped to `isActive:true && visibleToEmployees:true`.
 * HR / Super Admin see every row and manage uploads / edits / deletes.
 *
 * Upload path: multer memoryStorage (buffered in RAM).  We reject
 * everything that is not application/pdf.  10 MB cap matches the
 * existing employee-import limit; PDFs above that are rare for policy
 * docs and should be split.
 */

const asyncHandler = require('express-async-handler');
const { logAudit } = require('../utils/audit');
const CompanyDocument = require('../models/CompanyDocument');

const _isAdmin = (u) => u && (u.role === 'hr' || u.role === 'super_admin');

// Filter applied for non-HR viewers so employees never see hidden /
// deactivated documents.
const _employeeFilter = { isActive: true, visibleToEmployees: true };

/**
 * Map a Mongoose doc (with or without buffer bytes) to the wire
 * shape.  Never leaks `data` bytes.
 */
const _shape = (d) => ({
  _id: d._id,
  title: d.title,
  description: d.description || '',
  fileName: d.fileName,
  mimeType: d.mimeType,
  size: d.size,
  effectiveDate: d.effectiveDate || null,
  visibleToEmployees: !!d.visibleToEmployees,
  isActive: !!d.isActive,
  uploadedBy: d.uploadedBy && d.uploadedBy._id
    ? { _id: d.uploadedBy._id, name: d.uploadedBy.name, email: d.uploadedBy.email }
    : d.uploadedBy,
  uploadedAt: d.createdAt,
  updatedAt: d.updatedAt,
});

// GET /api/company-documents
// Everyone authenticated.  Employees get the filtered set; HR sees
// the full list so they can see hidden / inactive docs too.
const list = asyncHandler(async (req, res) => {
  const where = _isAdmin(req.user) ? {} : _employeeFilter;
  const docs = await CompanyDocument.find(where)
    .populate('uploadedBy', 'name email')
    .sort({ createdAt: -1 })
    .lean({ getters: true });
  res.json(docs.map(_shape));
});

// GET /api/company-documents/:id/inline
// Streams the PDF inline (browser preview).  Respects the same
// visibility rules as the list endpoint.
const inline = asyncHandler(async (req, res) => {
  const filter = _isAdmin(req.user)
    ? { _id: req.params.id }
    : { _id: req.params.id, ...(_employeeFilter) };
  const doc = await CompanyDocument.findOne(filter).select('+data title fileName mimeType size');
  if (!doc) { res.status(404); throw new Error('Document not found'); }
  if (!doc.data || !doc.data.length) { res.status(404); throw new Error('Document has no file'); }
  res.setHeader('Content-Type', doc.mimeType || 'application/pdf');
  res.setHeader('Content-Length', doc.data.length);
  // Inline (browser preview) rather than attachment so the modal's
  // iframe renders the PDF instead of triggering a download prompt.
  const safe = encodeURIComponent(doc.fileName || 'document.pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${safe}`);
  // Prevent aggressive caching so a replaced file surfaces immediately.
  res.setHeader('Cache-Control', 'no-store');
  res.send(doc.data);
});

const _acceptPdfOr400 = (req, res) => {
  const f = req.file;
  if (!f) { res.status(400); throw new Error('A PDF file is required.'); }
  const mt = (f.mimetype || '').toLowerCase();
  if (mt !== 'application/pdf') {
    res.status(400); throw new Error('Only PDF files are allowed.');
  }
};

// POST /api/company-documents  (HR / Super Admin, multer 'file')
const upload = asyncHandler(async (req, res) => {
  _acceptPdfOr400(req, res);
  const title = String(req.body.title || '').trim();
  if (!title) { res.status(400); throw new Error('Title is required.'); }
  const description = String(req.body.description || '').trim();
  const effectiveDate = req.body.effectiveDate ? new Date(req.body.effectiveDate) : null;
  // Multipart body values arrive as strings; normalise the toggle.
  const visibleToEmployees = String(req.body.visibleToEmployees ?? 'true') !== 'false';
  const doc = await CompanyDocument.create({
    title,
    description,
    fileName: req.file.originalname || 'document.pdf',
    mimeType: 'application/pdf',
    size: req.file.size,
    data: req.file.buffer,
    effectiveDate: effectiveDate && !isNaN(effectiveDate) ? effectiveDate : null,
    visibleToEmployees,
    isActive: true,
    uploadedBy: req.user._id,
  });
  logAudit(req, {
    action: 'company-documents.create',
    targetType: 'CompanyDocument',
    targetId: doc._id,
    targetLabel: title,
    meta: { fileName: doc.fileName, size: doc.size, visibleToEmployees },
  });
  const full = await CompanyDocument.findById(doc._id)
    .populate('uploadedBy', 'name email').lean({ getters: true });
  res.status(201).json(_shape(full));
});

// PATCH /api/company-documents/:id  (HR / Super Admin; JSON body)
const update = asyncHandler(async (req, res) => {
  const doc = await CompanyDocument.findById(req.params.id);
  if (!doc) { res.status(404); throw new Error('Document not found'); }
  const patch = req.body || {};
  const changed = [];
  if (patch.title !== undefined) {
    const t = String(patch.title).trim();
    if (!t) { res.status(400); throw new Error('Title cannot be blank.'); }
    if (t !== doc.title) { doc.title = t; changed.push('title'); }
  }
  if (patch.description !== undefined) {
    const d = String(patch.description).trim();
    if (d !== doc.description) { doc.description = d; changed.push('description'); }
  }
  if (patch.effectiveDate !== undefined) {
    const d = patch.effectiveDate ? new Date(patch.effectiveDate) : null;
    const norm = d && !isNaN(d) ? d : null;
    if (String(norm) !== String(doc.effectiveDate)) { doc.effectiveDate = norm; changed.push('effectiveDate'); }
  }
  if (patch.visibleToEmployees !== undefined) {
    const b = !!patch.visibleToEmployees;
    if (b !== doc.visibleToEmployees) { doc.visibleToEmployees = b; changed.push('visibleToEmployees'); }
  }
  if (patch.isActive !== undefined) {
    const b = !!patch.isActive;
    if (b !== doc.isActive) { doc.isActive = b; changed.push('isActive'); }
  }
  await doc.save();
  if (changed.length) {
    logAudit(req, {
      action: 'company-documents.update',
      targetType: 'CompanyDocument',
      targetId: doc._id,
      targetLabel: doc.title,
      meta: { changed },
    });
  }
  const full = await CompanyDocument.findById(doc._id)
    .populate('uploadedBy', 'name email').lean({ getters: true });
  res.json(_shape(full));
});

// PUT /api/company-documents/:id/file  (HR / Super Admin, multer 'file')
const replaceFile = asyncHandler(async (req, res) => {
  _acceptPdfOr400(req, res);
  const doc = await CompanyDocument.findById(req.params.id).select('+data title');
  if (!doc) { res.status(404); throw new Error('Document not found'); }
  doc.fileName = req.file.originalname || 'document.pdf';
  doc.mimeType = 'application/pdf';
  doc.size = req.file.size;
  doc.data = req.file.buffer;
  await doc.save();
  logAudit(req, {
    action: 'company-documents.replace',
    targetType: 'CompanyDocument',
    targetId: doc._id,
    targetLabel: doc.title,
    meta: { fileName: doc.fileName, size: doc.size },
  });
  const full = await CompanyDocument.findById(doc._id)
    .populate('uploadedBy', 'name email').lean({ getters: true });
  res.json(_shape(full));
});

// DELETE /api/company-documents/:id  (HR / Super Admin)
const remove = asyncHandler(async (req, res) => {
  const doc = await CompanyDocument.findByIdAndDelete(req.params.id);
  if (!doc) { res.status(404); throw new Error('Document not found'); }
  logAudit(req, {
    action: 'company-documents.delete',
    targetType: 'CompanyDocument',
    targetId: doc._id,
    targetLabel: doc.title,
    meta: {},
  });
  res.json({ message: 'Document deleted' });
});

module.exports = { list, inline, upload, update, replaceFile, remove };
