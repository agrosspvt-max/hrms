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
// Phase 23.6 -- bulk finalise the same innovation scores
// against a list of (employee, date) pairs in one round-trip.
router.post('/bulk-finalize', c.bulkFinalize);
// Per-task status edit during review (Phase 10).
router.post('/task-status', c.editTaskStatus);
// Phase 23.7 -- per-task marks edit for employee-added extra work.
router.post('/task-marks', c.editTaskMarks);
// Phase 59 -- full-edit for Custom submission values (Number, Status,
// Dropdown).  Also handles Extra Tasks.  Recalculates marks + writes
// audit log.  HR/SA always; HOD only when canEditSubmissions is set
// AND the owner is in their own department.
router.post('/edit-value', c.editSubmissionValue);

module.exports = router;
