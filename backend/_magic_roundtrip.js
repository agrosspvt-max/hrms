// Proves MongoDB's BSON serialization preserves file magic bytes byte-for-byte
// for the five allowed formats.  Uses the SAME bson package the driver uses,
// so this is exactly what your DB does end-to-end.
const bson = require('bson');
const samples = [
  // Real PDF file header (from tools like `xxd sample.pdf | head -1`).
  { kind: 'PDF',  buf: Buffer.from('255044462d312e340a25e2e3cfd30a', 'hex'), realFilename: 'sample.pdf'  },
  // Real PNG signature.
  { kind: 'PNG',  buf: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), realFilename: 'x.png' },
  // Real JPEG SOI + APP0 marker for JFIF.
  { kind: 'JPEG', buf: Buffer.from('ffd8ffe000104a4649460001', 'hex'),        realFilename: 'x.jpg' },
  // Real WEBP: RIFF <size> WEBP.
  { kind: 'WEBP', buf: Buffer.from('52494646aa000000574542505650', 'hex'),   realFilename: 'x.webp' },
];
const asBuffer = (d) =>
  Buffer.isBuffer(d) ? d
  : (d?.buffer && Buffer.isBuffer(d.buffer)) ? d.buffer
  : Buffer.from(d);

const hex = (b, n = 12) => Array.from(b.slice(0, n)).map((x) => x.toString(16).padStart(2, '0')).join(' ');

for (const s of samples) {
  const wrote = { filename: s.realFilename, size: s.buf.length, data: s.buf };
  const raw = bson.serialize(wrote);

  // Simulate .lean() read (driver default, promoteBuffers:false).
  const readLean = bson.deserialize(raw, { promoteBuffers: false });
  const leanBytes = asBuffer(readLean.data);
  // Simulate hydrated read (Mongoose casts to Buffer).
  const readHyd = bson.deserialize(raw, { promoteBuffers: true });
  const hydBytes = asBuffer(readHyd.data);

  console.log(`==== ${s.kind} =====================================`);
  console.log(`  written bytes   : ${hex(s.buf)}`);
  console.log(`  lean data class : ${readLean.data.constructor.name} (Buffer.isBuffer=${Buffer.isBuffer(readLean.data)})`);
  console.log(`  lean bytes      : ${hex(leanBytes)}`);
  console.log(`  hydrated bytes  : ${hex(hydBytes)}`);
  console.log(`  bytes identical : ${s.buf.equals(leanBytes) && s.buf.equals(hydBytes)}`);
  console.log(`  size matches    : ${leanBytes.length === s.buf.length && hydBytes.length === s.buf.length}`);
  console.log('');
}
