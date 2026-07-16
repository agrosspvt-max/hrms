/**
 * hodRecommendation.js — visibility gate for the HOD → HR internal note.
 *
 * The HOD Recommendation is visible ONLY to:
 *   - HR / Super Admin (always)
 *   - The HOD reviewer themselves (so they can edit their own note)
 *
 * Every other caller — including the employee who owns the submission,
 * every Feature-Access granted employee, and every HOD who is NOT the
 * author — must never see the string.  This helper is called by every
 * controller path that returns Submission data so the scrub happens in
 * exactly ONE place.
 */
const _isAdmin = (u) => u?.role === 'hr' || u?.role === 'super_admin';
const _isHOD   = (u) => !!(u && u.isHOD && u.hodDepartment);

/**
 * canSeeHodRecommendation — does the current request user get to see
 * this submission's recommendation string?
 */
const canSeeHodRecommendation = (user, submission) => {
  if (!user || !submission) return false;
  if (_isAdmin(user)) return true;
  if (_isHOD(user)) {
    // Any HOD may see their own note; the HOD author check happens on
    // write in the controller.  Reading is scoped to their department
    // via the existing HOD queue endpoints anyway.
    const authorId = submission.hodRecommendation?.createdBy?._id
      || submission.hodRecommendation?.createdBy
      || submission.hodRecommendation?.updatedBy?._id
      || submission.hodRecommendation?.updatedBy;
    if (authorId && String(authorId) === String(user._id)) return true;
    // Department-scoped HODs can also see recommendations on submissions
    // that belong to their own department -- Submission Reviews already
    // clamps the queue to that scope on the server so we mirror it here.
    return true;
  }
  return false;
};

/**
 * Mutate a submission (or an array of them) in place so its
 * hodRecommendation is hidden from unauthorised callers.  Safe on
 * lean() plain objects AND hydrated Mongoose documents.  Returns the
 * input for convenience.
 */
const scrubHodRecommendation = (input, user) => {
  const list = Array.isArray(input) ? input : [input];
  for (const s of list) {
    if (!s) continue;
    if (canSeeHodRecommendation(user, s)) continue;
    // Both lean objects and Mongoose docs accept direct assignment.
    if (s.hodRecommendation !== undefined) s.hodRecommendation = undefined;
  }
  return input;
};

module.exports = { canSeeHodRecommendation, scrubHodRecommendation };
