/**
 * attendanceNoteRoutes — Phase 50.
 *
 * All endpoints sit under /api/attendance-notes and require an active
 * session.  Per-note permissions (edit / delete / lock) are enforced in
 * the controller; the middleware only gates authentication.
 *
 *   GET    /api/attendance-notes              list + filter
 *   GET    /api/attendance-notes/day-summary  cheap per-day counts
 *   POST   /api/attendance-notes              create
 *   PATCH  /api/attendance-notes/:id          patch (content OR status)
 *   DELETE /api/attendance-notes/:id          delete
 */
const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/attendanceNoteController');

router.use(protect);

router.get('/day-summary', c.daySummary);
router.get('/',            c.list);
router.post('/',           c.create);
router.patch('/:id',       c.patch);
router.delete('/:id',      c.remove);

module.exports = router;
