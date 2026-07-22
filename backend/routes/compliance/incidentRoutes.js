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
router.post('/incidents/:id/recover',   c.recover);
router.post('/incidents/:id/activate',  c.activate);
router.post('/incidents/:id/resolve',   c.resolve);
router.post('/incidents/:id/waive',     c.waiveDirect);
router.post('/incidents/:id/waive/request', c.waiveRequest);
router.post('/incidents/:id/waive/decide',  c.waiveDecide);

// Timeline (read-only)
router.get('/timeline/me',              t.me);
router.get('/timeline/incident/:id',    t.forIncident);
router.get('/timeline/:employeeId',     t.forEmployee);

// Ledgers (read-only) -- Phase 6 backend, consumed by Phase 7 UI.
const ledgerC = require('../../controllers/compliance/ledgerController');
router.get('/ledgers/:name', ledgerC.get);

module.exports = router;
