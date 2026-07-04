// Simulate what MongoDB driver 6.20.0 returns for Buffer fields when lean().
// The driver uses BSON directly; we check how it deserializes a Binary subtype 0.
const bson = require('bson');
const http = require('http');
const mongoose = require('mongoose');

const buf = Buffer.from('%PDF-1.4 hello world', 'utf8');

// Serialize + deserialize with BSON — the exact codec the driver uses.
const raw = bson.serialize({ data: buf });
// Two representative deserialize modes.  The driver 6.x defaults are what
// Mongoose 8 with .lean() actually returns.
const dLean       = bson.deserialize(raw, { promoteBuffers: false });
const dLeanPromoted = bson.deserialize(raw, { promoteBuffers: true });

console.log('bson version:', '(exports blocked)');
console.log('promoteBuffers:false ->', dLean.data?.constructor?.name, 'isBuffer=', Buffer.isBuffer(dLean.data),
  'len=', dLean.data?.length, 'keys=', Object.keys(dLean.data || {}).slice(0, 6));
console.log('promoteBuffers:true  ->', dLeanPromoted.data?.constructor?.name, 'isBuffer=', Buffer.isBuffer(dLeanPromoted.data),
  'len=', dLeanPromoted.data?.length);

// What .toString() gives us on the Binary object -- this is what would be
// coerced to a body if we hand it to res.end() as-is.
const b = dLean.data;
console.log('Binary.toString() preview:', String(b).slice(0, 40));
console.log('Binary.length property:', b.length);
console.log('Binary.buffer isBuffer:', Buffer.isBuffer(b.buffer || b.value?.() ), 'value() type:', typeof b.value === 'function' ? b.value()?.constructor?.name : 'n/a');

// Now send via res.end() to see what actually goes on the wire.
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.end(b);
});
server.listen(0, () => {
  const port = server.address().port;
  http.get({ port, path: '/' }, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => {
      const body = Buffer.concat(chunks);
      console.log('res.end(Binary) -> bodyLen=', body.length, 'preview=', body.slice(0, 40).toString());
      console.log('Original Buffer len:', buf.length);
      server.close();
    });
    r.on('error', (e) => { console.log('req err', e.message); server.close(); });
  }).on('error', (e) => { console.log('http.get err', e.message); server.close(); });
});
