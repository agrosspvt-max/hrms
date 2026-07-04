// Reproduces the .lean() vs hydrated shape difference AND proves the
// new _asBuffer helper coerces both to a real Buffer that res.end()
// accepts.  Uses the app's installed bson (same codec the driver uses).
const bson = require('bson');
const http = require('http');

// Copy of the _asBuffer helper from leaveAttachmentController.js (verbatim).
const _asBuffer = (d) => {
  if (d == null) return null;
  if (Buffer.isBuffer(d)) return d;
  if (d.buffer && Buffer.isBuffer(d.buffer)) return d.buffer;
  if (typeof d.value === 'function') {
    const v = d.value();
    if (Buffer.isBuffer(v)) return v;
    if (v && (v.byteLength != null || Array.isArray(v))) return Buffer.from(v);
  }
  if (d.byteLength != null || Array.isArray(d)) return Buffer.from(d);
  return null;
};

const samples = [
  { kind: 'PDF',  buf: Buffer.from('255044462d312e340a25e2e3cfd30a', 'hex') },
  { kind: 'PNG',  buf: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') },
  { kind: 'JPEG', buf: Buffer.from('ffd8ffe000104a4649460001', 'hex') },
  { kind: 'WEBP', buf: Buffer.from('52494646aa000000574542505650', 'hex') },
];

(async () => {
  for (const s of samples) {
    const raw = bson.serialize({ filename: `x.${s.kind.toLowerCase()}`, size: s.buf.length, data: s.buf });
    // Simulate current bug: driver default (Binary object).
    const leanShape = bson.deserialize(raw, { promoteBuffers: false });
    // Simulate hydrated read (real Buffer).
    const hydShape  = bson.deserialize(raw, { promoteBuffers: true });

    const outFromLean = _asBuffer(leanShape.data);
    const outFromHyd  = _asBuffer(hydShape.data);

    // Prove both flow into res.end() without throwing.
    const wrote = await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', outFromLean.length);
        res.end(outFromLean);
      });
      srv.listen(0, () => {
        http.get({ port: srv.address().port, path: '/' }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => { srv.close(); resolve({ len: +r.headers['content-length'], body: Buffer.concat(chunks) }); });
        }).on('error', (e) => { srv.close(); reject(e); });
      });
    }).catch((e) => ({ error: e.message }));

    console.log(`==== ${s.kind} =====================================`);
    console.log(`  input (.lean shape) : ${leanShape.data.constructor.name}  isBuffer=${Buffer.isBuffer(leanShape.data)}`);
    console.log(`  _asBuffer(lean)     : ${outFromLean?.constructor?.name} len=${outFromLean?.length}  isBuffer=${Buffer.isBuffer(outFromLean)}`);
    console.log(`  _asBuffer(hydrated) : ${outFromHyd?.constructor?.name} len=${outFromHyd?.length}   isBuffer=${Buffer.isBuffer(outFromHyd)}`);
    console.log(`  bytes preserved     : ${outFromLean.equals(s.buf) && outFromHyd.equals(s.buf)}`);
    console.log(`  res.end() over wire : Content-Length=${wrote.len}  bodyLen=${wrote.body?.length}  bodyEqualsSrc=${wrote.body?.equals(s.buf)}`);
    console.log(`  first 8 bytes hex   : ${Array.from(wrote.body.slice(0,8)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
    console.log('');
  }
})();
