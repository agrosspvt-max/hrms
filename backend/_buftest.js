const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const http = require('http');

(async () => {
  console.log('mongoose:', mongoose.version, ' driver:', require('mongodb/package.json').version);
  const srv = await MongoMemoryServer.create();
  await mongoose.connect(srv.getUri());

  const s = new mongoose.Schema({ data: { type: Buffer, select: false } });
  const M = mongoose.model('BufTest', s);

  const buf = Buffer.from('%PDF-1.4 hello world', 'utf8');
  const doc = await M.create({ data: buf });

  const hydrated = await M.findById(doc._id).select('+data');
  console.log('HYDRATED:', hydrated.data?.constructor?.name, 'len=', hydrated.data?.length,
    'isBuffer=', Buffer.isBuffer(hydrated.data));

  const lean = await M.findById(doc._id).select('+data').lean();
  console.log('LEAN:', lean.data?.constructor?.name, 'len=', lean.data?.length,
    'isBuffer=', Buffer.isBuffer(lean.data));
  console.log('LEAN.data protoKeys:', lean.data && Object.getOwnPropertyNames(Object.getPrototypeOf(lean.data)).slice(0, 10));

  // Send through res.end to see what actually goes on the wire.
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/plain'); res.end(lean.data); });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const got = await new Promise((resolve) => {
    http.get({ port, path: '/' }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks) }));
    });
  });
  console.log('LEAN via res.end -> bodyLen=', got.body.length, ' first20=', got.body.slice(0, 20).toString());

  await mongoose.disconnect(); await srv.stop();
})();
