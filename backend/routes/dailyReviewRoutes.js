const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/dailyReviewController');

router.use(protect);

// Employee can save / update their own day's reflection.  Anyone
// authenticated can hit this (it always upserts onto req.user._id).
router.post('/reflection', c.saveReflection);

// HR / SA / HOD: grouped review feed + per-day drill + finalise.
// Controller enforces role-aware visibility + HOD department clamp.
router.get('/grouped',  c.listGrouped);
router.get('/day',      c.getDay);
router.post('/finalize', c.finalizeDay);
// Per-task status edit during review (Phase 10).
router.post('/task-status', c.editTaskStatus);

module.exports = router;
