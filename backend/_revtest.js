const { requireReviewer } = require('./middleware/auth');
const run = (user) => {
  let status = 200, err = null;
  const req = { user, originalUrl: '/api/submissions/hod/reviews' };
  const res = { status(c){ status = c; return this; } };
  try { requireReviewer(req, res, () => {}); } catch (e) { err = e.message; }
  return { status, err };
};
const cases = [
  ['HR', { role:'hr' }],
  ['Super Admin', { role:'super_admin' }],
  ['HOD + canReview', { role:'employee', isHOD:true, hodPermissions:{canReview:true} }],
  ['HOD without canReview', { role:'employee', isHOD:true, hodPermissions:{canReview:false} }],
  ['Plain employee', { role:'employee', isHOD:false }],
];
for (const [label, u] of cases) {
  const r = run(u);
  console.log(label.padEnd(24), r.err ? `DENY (${r.status})` : 'ALLOW');
}
