/**
 * leaveAttachmentController — Phase 54.
 *
 * Upload / list / stream / download endpoints for supporting
 * documents on leave requests.  Attachments are stored in their own
 * collection (see models/LeaveAttachment.js) so the leave workflow
 * itself is untouched — this is a pure extension.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const LeaveAttachment = require('../models/LeaveAttachment');
const Leave = require('../models/Leave');

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
const ALLOWED_LABELS = 'PDF, JPG, JPEG, PNG, WEBP';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per spec

const _isAdmin = (u) => u?.role === 'hr' || u?.role === 'super_admin';

/**
 * canRead — the current user may view / download this attachment.
 *   - HR/Super Admin see everything.
 *   - Employee sees attachments they OWN (uploaded) OR whose parent
 *     leave belongs to them.
 * Any other role combination returns false.
 */
const _canRead = (att, user) => {
  if (!user || !att) return false;
  if (_isAdmin(user)) return true;
  if (String(att.employee) === String(user._id)) return true;
  return false;
};

/* -------------------------------------------------------------------- */
/* Upload                                                               */
/*                                                                      */
/* Multer parses multipart/form-data upstream in the route.  This       */
/* handler validates every file (mime + size), rejects the whole batch  */
/* on any failure so the client can retry cleanly, and creates rows     */
/* with `leave: null`.  A subsequent POST /api/leaves with              */
/* `attachmentIds[]` promotes the orphans onto the new leave.           */
/* -------------------------------------------------------------------- */
const upload = asyncHandler(async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    res.status(400);
    throw new Error('At least one file is required.');
  }
  // Per-file validation.  Multer's fileFilter already rejected disallowed
  // mimes at the boundary; the size + defensive-mime check here guards
  // against buggy clients that hand-craft the multipart body.
  for (const f of files) {
    if (!ALLOWED_MIME.has(f.mimetype)) {
      res.status(400);
      throw new Error(`Unsupported file type: ${f.originalname}. Allowed: ${ALLOWED_LABELS}.`);
    }
    if (f.size > MAX_BYTES) {
      res.status(400);
      throw new Error(`File exceeds 10 MB: ${f.originalname}.`);
    }
  }
  const rows = files.map((f) => ({
    leave: null,                 // orphan until the leave is created
    employee:   req.user._id,
    uploadedBy: req.user._id,
    filename:  f.originalname || 'attachment',
    mimeType:  f.mimetype,
    size:      f.size,
    storageProvider: 'db',
    data: f.buffer,
    status: 'active',
  }));
  const created = await LeaveAttachment.insertMany(rows);
  // Do NOT return the data buffer — clients only need metadata + id
  // to reference the file on the subsequent leave POST.
  res.status(201).json(created.map((r) => ({
    _id: r._id,
    filename: r.filename,
    mimeType: r.mimeType,
    size: r.size,
    uploadedBy: r.uploadedBy,
    createdAt: r.createdAt,
  })));
});

/* -------------------------------------------------------------------- */
/* List — attachments for a specific leave                              */
/* -------------------------------------------------------------------- */
const listForLeave = asyncHandler(async (req, res) => {
  const { leaveId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(leaveId)) {
    res.status(400); throw new Error('Invalid leave id.');
  }
  const leave = await Leave.findById(leaveId).select('_id employee').lean();
  if (!leave) { res.status(404); throw new Error('Leave not found.'); }
  // Access: employee sees own leave, HR/SA sees all.
  if (!_isAdmin(req.user) && String(leave.employee) !== String(req.user._id)) {
    res.status(403); throw new Error('Forbidden.');
  }
  const items = await LeaveAttachment.find({
    leave: leaveId,
    deletedAt: { $in: [null, undefined] },
  })
    .populate('uploadedBy', 'name role employeeId')
    .sort({ createdAt: 1 })
    .lean();
  res.json(items.map((a) => ({
    _id: a._id,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    status: a.status,
    version: a.version,
    uploadedBy: a.uploadedBy,
    createdAt: a.createdAt,
  })));
});

/* -------------------------------------------------------------------- */
/* Stream — inline (browser preview) or attachment (download)           */
/* -------------------------------------------------------------------- */
const _stream = (disposition) => asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400); throw new Error('Invalid attachment id.');
  }
  const att = await LeaveAttachment.findById(id).select('+data').lean();
  if (!att || att.deletedAt) { res.status(404); throw new Error('Attachment not found.'); }
  if (!_canRead(att, req.user)) { res.status(403); throw new Error('Forbidden.'); }

  if (att.storageProvider !== 'db') {
    // Placeholder for future cloud storage: today only 'db' is used.
    res.status(501); throw new Error(`Storage provider "${att.storageProvider}" not supported.`);
  }
  if (!att.data) { res.status(410); throw new Error('Attachment data missing.'); }

  res.setHeader('Content-Type', att.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', att.size || att.data.length);
  // RFC 5987-style encoded filename so unicode names survive downloads.
  const safeName = String(att.filename || 'attachment')
    .replace(/[^\w. -]+/g, '_');
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(att.filename || 'attachment')}`,
  );
  // No-cache so a redownload after a soft-delete doesn't leak stale bytes.
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(att.data);
});
const download = _stream('attachment');
const inline   = _stream('inline');

/* -------------------------------------------------------------------- */
/* Metadata (JSON) for a single attachment                              */
/* -------------------------------------------------------------------- */
const getMeta = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400); throw new Error('Invalid attachment id.');
  }
  const att = await LeaveAttachment.findById(id)
    .populate('uploadedBy', 'name role employeeId')
    .lean();
  if (!att || att.deletedAt) { res.status(404); throw new Error('Attachment not found.'); }
  if (!_canRead(att, req.user)) { res.status(403); throw new Error('Forbidden.'); }
  const { data, ...safe } = att;
  res.json(safe);
});

module.exports = {
  upload, listForLeave, download, inline, getMeta,
  // Exposed constants so the leave controller can validate
  // `attachmentIds[]` ownership when linking orphans to a leave.
  ALLOWED_MIME, ALLOWED_LABELS, MAX_BYTES,
};
