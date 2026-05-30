const express = require('express');
const { authorize, requireHOD } = require('./middleware/auth');

const fakeProtect = (req, _res, next) => {
  req.user = {
    _id: 'u1',
    role: req.headers['x-role'] || 'employee',
    isHOD: req.headers['x-ishod'] === 'true',
    hodPermissions: { canReview: req.headers['x-canreview'] === 'true' },
  };
  next();
};

const app = express();
app.use(express.json());
const router = express.Router();
router.use(fakeProtect);
router.get('/team', requireHOD, (_req, res) => res.json({ ok: 'team' }));
router.use(authorize('hr'));
router.put('/:id', (_req, res) => res.json({ ok: 'updated' }));
app.use('/api/employees', router);
app.use((err, _req, res, _next) => res.status(res.statusCode >= 400 ? res.statusCode : 500).json({ message: err.message }));

const server = app.listen(0, async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/employees`;
  const tryReq = async (label, method, path, headers) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'PUT' ? '{}' : undefined });
    console.log(label, '->', r.status, JSON.stringify(await r.json()));
  };
  await tryReq('HR PUT /:id         ', 'PUT', '/abc', { 'x-role': 'hr' });
  await tryReq('superadmin PUT /:id ', 'PUT', '/abc', { 'x-role': 'super_admin' });
  await tryReq('employee PUT /:id   ', 'PUT', '/abc', { 'x-role': 'employee' });
  await tryReq('HOD-emp PUT /:id    ', 'PUT', '/abc', { 'x-role': 'employee', 'x-ishod': 'true' });
  await tryReq('HR GET /team        ', 'GET', '/team', { 'x-role': 'hr' });
  await tryReq('HOD-emp GET /team   ', 'GET', '/team', { 'x-role': 'employee', 'x-ishod': 'true' });
  server.close();
});
