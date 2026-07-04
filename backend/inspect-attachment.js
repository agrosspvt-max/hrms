/**
 * inspect-attachment.js
 *
 * Standalone diagnostic.  Reads ONE LeaveAttachment (the latest, or a
 * specific _id you pass on the CLI) and reports:
 *   - Whether `data` exists.
 *   - Byte length + comparison to the stored `size` field.
 *   - The first 12 bytes in hex + printable form + inferred file kind.
 *   - The wire shape of `data` under both .lean() and hydrated reads,
 *     so you can see the Binary-vs-Buffer bug directly.
 *
 * Run:
 *   cd backend
 *   node inspect-attachment.js               # latest active attachment
 *   node inspect-attachment.js <attachmentId>
 *
 * No writes.  Read-only.  Safe on production.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LeaveAttachment = require('./models/LeaveAttachment');

// Magic-byte fingerprints for the five allowed formats.
const MAGIC = [
  { kind: 'PDF',  match: (b) => b.slice(0, 5).toString('ascii') === '%PDF-' },
  { kind: 'PNG',  match: (b) => b[0] === 0x89 && b.slice(1, 4).toString('ascii') === 'PNG' },
  { kind: 'JPEG', match: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { kind: 'WEBP', match: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { kind: 'GIF',  match: (b) => b.slice(0, 3).toString('ascii') === 'GIF' },
];
const identify = (b) => (MAGIC.find((m) => m.match(b)) || { kind: 'UNKNOWN' }).kind;

const hex = (b, n = 12) => Array.from(b.slice(0, n)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
const printable = (b, n = 12) => Array.from(b.slice(0, n)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');

// Compute the canonical byte length regardless of whether the field
// came back as a Buffer or a mongodb.Binary object.
const byteLen = (d) => {
  if (!d) return 0;
  if (Buffer.isBuffer(d)) return d.length;
  if (typeof d.length === 'function') return d.length();      // mongodb.Binary
  if (typeof d.length === 'number')   return d.length;         // Some drivers
  if (d.buffer && Buffer.isBuffer(d.buffer)) return d.buffer.length;
  return 0;
};
// Coerce to a raw Buffer for magic-byte inspection.
const asBuffer = (d) => {
  if (!d) return Buffer.alloc(0);
  if (Buffer.isBuffer(d)) return d;
  if (d.buffer && Buffer.isBuffer(d.buffer)) return d.buffer;  // mongodb.Binary
  if (typeof d.value === 'function' && Buffer.isBuffer(d.value())) return d.value();
  return Buffer.from(d);
};

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI not set. Copy your production .env into backend/.env first.'); process.exit(1); }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  const targetId = process.argv[2];
  const query = targetId ? { _id: targetId } : { deletedAt: { $in: [null, undefined] } };
  const sort  = targetId ? {} : { createdAt: -1 };

  // ---- Read 1: .lean() -- exactly what the stream handler currently does.
  const leanDoc = await LeaveAttachment.findOne(query, null, { sort }).select('+data').lean();
  if (!leanDoc) { console.error('No LeaveAttachment matched.'); await mongoose.disconnect(); process.exit(2); }

  // ---- Read 2: hydrated -- what the fix will use.
  const hydDoc = await LeaveAttachment.findById(leanDoc._id).select('+data');

  const leanBytes = asBuffer(leanDoc.data);
  const hydBytes  = asBuffer(hydDoc.data);

  console.log('==== LeaveAttachment inspection ====');
  console.log('  _id             :', String(leanDoc._id));
  console.log('  filename        :', leanDoc.filename);
  console.log('  mimeType        :', leanDoc.mimeType);
  console.log('  size (stored)   :', leanDoc.size, 'bytes');
  console.log('  leave           :', leanDoc.leave);
  console.log('  employee        :', leanDoc.employee);
  console.log('  storageProvider :', leanDoc.storageProvider);
  console.log('  storageKey      :', JSON.stringify(leanDoc.storageKey));
  console.log('  createdAt       :', leanDoc.createdAt);
  console.log('');
  console.log('---- .lean() read (current stream handler) ----');
  console.log('  data present?          :', leanDoc.data != null);
  console.log('  data constructor       :', leanDoc.data?.constructor?.name);
  console.log('  Buffer.isBuffer(data)  :', Buffer.isBuffer(leanDoc.data));
  console.log('  byteLen(data)          :', byteLen(leanDoc.data));
  console.log('  data === stored size?  :', byteLen(leanDoc.data) === leanDoc.size);
  console.log('  first 12 bytes (hex)   :', hex(leanBytes));
  console.log('  first 12 bytes (ascii) :', JSON.stringify(printable(leanBytes)));
  console.log('  inferred file kind     :', identify(leanBytes));
  console.log('');
  console.log('---- hydrated read (proposed fix) ----');
  console.log('  data present?          :', hydDoc.data != null);
  console.log('  data constructor       :', hydDoc.data?.constructor?.name);
  console.log('  Buffer.isBuffer(data)  :', Buffer.isBuffer(hydDoc.data));
  console.log('  byteLen(data)          :', byteLen(hydDoc.data));
  console.log('  first 12 bytes (hex)   :', hex(hydBytes));
  console.log('  inferred file kind     :', identify(hydBytes));
  console.log('');
  console.log('---- Consistency checks ----');
  console.log('  bytes identical?       :', leanBytes.equals(hydBytes));
  console.log('  hydrated matches size? :', hydBytes.length === leanDoc.size);
  console.log('  mimeType agrees w/kind :', (leanDoc.mimeType || '').split('/').pop().toUpperCase().replace('JPG', 'JPEG')
                                            === identify(leanBytes).replace('JPG', 'JPEG'));

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
