const router = require('express').Router();
const { protect } = require('../../middleware/auth');
const c = require('../../controllers/compliance/incidentController');
const t = require('../../controllers/compliance/timelineController');
const cfg = require('../../controllers/compliance/configController');

router.use(protect);

// Public (any logged-in user) -- returns the subset of feature flags
// + rollout cutoff the frontend uses to gate its UI.  Zero DB reads.
router.get('/config', cfg.get);

// Incidents
router.get('/incidents',                c.list);
router.get('/incidents/:id',            c.get);
router.post('/incidents',               c.create);
router.post('/incidents/:id/cancel',    c.cancel);
router.post('/incidents/:id/acknowledge', c.acknowledge);
router.get('/me/accountability',        c.myAccountability);
router.post('/incidents/:id/recover',   c.recover);
router.post('/incidents/:id/activate',  c.activate);
router.post('/incidents/:id/resolve',   c.resolve);
router.post('/incidents/:id/waive',     c.waiveDirect);
router.post('/incidents/:id/waive/request', c.waiveRequest);
router.post('/incidents/:id/waive/decide',  c.waiveDecide);

// Payroll: owed financial effects (HR only; handlers enforce the role)
const pay = require('../../controllers/compliance/payrollController');
router.get('/payroll/pending',          pay.pending);
router.get('/payroll/refund-due',       pay.refundDue);
router.post('/payroll/mark-deducted',   pay.markDeducted);

// Re-file grants (employee request / HR decision) -- see services/compliance/refile
const rf = require('../../controllers/compliance/refileController');
router.post('/refile/requests',              rf.create);
router.get('/refile/requests',               rf.list);
router.post('/refile/requests/:id/decide',   rf.decide);
router.post('/refile/requests/:id/revoke',   rf.revoke);
router.post('/refile/send-back',             rf.sendBack);

// Timeline (read-only)
router.get('/timeline/me',              t.me);
router.get('/timeline/incident/:id',    t.forIncident);
router.get('/timeline/:employeeId',     t.forEmployee);

// Ledgers (read-only) -- Phase 6 backend, consumed by Phase 7 UI.
const ledgerC = require('../../controllers/compliance/ledgerController');
router.get('/ledgers/:name', ledgerC.get);

module.exports = router;
