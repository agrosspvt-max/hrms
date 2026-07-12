/**
 * privateRemark.js — Phase 60 visibility gate.
 *
 * Employee Private Remarks are visible ONLY to:
 *   - HR / Super Admin (always)
 *   - The employee who submitted them (self view only)
 *
 * Every other caller — including HOD reviewers and any Feature-Access
 * granted employee — must never see the string.  This helper is
 * called by every controller path that returns Submission data so
 * the scrub happens in exactly ONE place.  If a future endpoint
 * forgets to call it, the field still leaks — hence the defensive
 * comment on every populate + explicit rule below.
 */
const _isAdmin = (u) => u?.role === 'hr' || u?.role === 'super_admin';

/**
 * canSeePrivateRemark — the current request user may see this
 * submission's remark.  Everything else -> false.
 */
const canSeePrivateRemark = (user, submission) => {
  if (!user || !submission) return false;
  if (_isAdmin(user)) return true;
  // Employee viewing their own submission is fine.
  const ownerId = submission.employee?._id || submission.employee;
  if (ownerId && String(ownerId) === String(user._id)) return true;
  // Everyone else -- including HOD reviewers -- is denied.
  return false;
};

/**
 * Mutate a submission (or an array of them) in place so its
 * privateRemark + privateRemarkSubmittedAt are hidden from the caller.
 * Safe on lean() plain objects AND hydrated Mongoose documents.
 * Returns the input for convenience.
 */
const scrubPrivateRemark = (input, user) => {
  const list = Array.isArray(input) ? input : [input];
  for (const s of list) {
    if (!s) continue;
    if (canSeePrivateRemark(user, s)) continue;
    // Both lean objects and Mongoose docs accept direct assignment.
    if (s.privateRemark !== undefined) s.privateRemark = '';
    if (s.privateRemarkSubmittedAt !== undefined) s.privateRemarkSubmittedAt = undefined;
  }
  return input;
};

module.exports = { canSeePrivateRemark, scrubPrivateRemark };
