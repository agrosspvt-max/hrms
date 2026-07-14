const router = require('express').Router();
const { protect, authorize, requireReviewer, requireRoleOrFeature } = require('../middleware/auth');
const c = require('../controllers/submissionController');

// Phase 44.3 -- HR + Super Admin OR employee with `submissionReviews`.
const reviewGate = requireRoleOrFeature('hr', 'submissionReviews');

router.use(protect);

router.get('/today', c.getToday);
router.get('/history', c.history);

// HOD review panel (department-scoped). Open to HR / Super Admin and to a
// HOD with review permission. Declared before '/:id/...' (distinct paths).
router.get('/hod/reviews', requireReviewer, c.listForHodReview);
router.post('/:id/hod-review', requireReviewer, c.hodReviewSubmission);

router.post('/:id/submit', c.submitOne);
// Phase 19: persist a draft of an unsubmitted submission.  Same body
// shape as /submit so the frontend builds one payload for both
// contexts -- this endpoint just stores it without validating,
// without running auto-formulas, and without flipping `submitted`.
router.put('/:id/draft', c.saveDraft);
router.post('/backlog/complete', c.completeBacklogTask);

// HR review panel
router.get('/reviews', reviewGate, c.listForReview);
router.post('/:id/review', reviewGate, c.reviewSubmission);
// Bulk innovation marks (HR / SA only).  Always declared
// BEFORE any param-suffixed POST so '/review/bulk' is matched verbatim.
router.post('/review/bulk', reviewGate, c.bulkReview);

module.exports = router;
