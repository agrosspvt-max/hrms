const router = require('express').Router();
const { protect, authorize, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/interactionController');
const t = require('../controllers/interactionTagController');

router.use(protect);

// Employee-side reads (own timeline / own meetings + autocomplete).
router.get('/mine',              c.mine);
router.get('/mentions',          c.mentions);
router.get('/timeline/:employee', c.timeline);
router.post('/:id/respond',      c.respond);

// Reviewer gate: HR / SA / HOD / employees granted the feature.
const gate = requireRoleOrFeature('hr', 'employeeInteractions');

router.get('/analytics',         gate, c.analytics);
router.get('/',                  gate, c.list);
router.post('/',                 gate, c.create);
router.get('/:id',               c.getOne);            // gate performed inside (participant view allowed)
router.put('/:id',               gate, c.update);
router.delete('/:id',            gate, c.remove);

router.post('/:id/notes',         gate, c.addNote);
router.put('/:id/notes/:noteId',  gate, c.updateNote);
router.delete('/:id/notes/:noteId', gate, c.removeNote);

router.put('/:id/participants',   gate, c.setParticipants);
router.put('/:id/attendance',     gate, c.setAttendance);
router.post('/:id/follow-up/resolve', gate, c.resolveFollowUp);

module.exports = router;

// Tag catalogue routes are exposed under /api/interaction-tags via a
// sibling router file so they can be gated separately (HR/SA only for
// writes, any authenticated user for reads).
