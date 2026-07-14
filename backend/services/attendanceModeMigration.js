/**
 * attendanceModeMigration.js
 *
 * One-time boot migration.  Ensures every existing employee whose
 * `attendanceMode` is NOT `auto_attendance` is normalised to
 * `attendance_review`.  Employees already on Auto Attendance are
 * left untouched.
 *
 * Rule:
 *   auto_attendance                 -> leave unchanged
 *   attendance_review               -> leave unchanged (matches filter -> no write)
 *   submission_based                -> flip to attendance_review
 *   null / undefined / empty / any  -> flip to attendance_review
 *
 * Idempotent: the update filter excludes both `auto_attendance` AND
 * `attendance_review`, so a re-run on a system where every employee
 * has already been migrated performs ZERO writes.
 *
 * Never touches attendance history, submissions, leaves, performance,
 * penalties, notifications, salary, or any other employee field --
 * ONLY `attendanceMode`.
 */
const User = require('../models/User');

const runOnce = async () => {
  try {
    const r = await User.updateMany(
      {
        // Every row NOT already on Auto Attendance and NOT already on
        // Attendance Review.  Covers submission_based / null /
        // undefined / missing / anything unexpected.
        attendanceMode: { $nin: ['auto_attendance', 'attendance_review'] },
      },
      { $set: { attendanceMode: 'attendance_review' } },
    );
    if (r?.modifiedCount > 0) {
      console.log(`[attendance-mode-migration] normalised ${r.modifiedCount} employee(s) to attendance_review`);
    }
    return { modifiedCount: r?.modifiedCount || 0 };
  } catch (e) {
    console.error('[attendance-mode-migration] failed:', e.message);
    return { error: e.message };
  }
};

/** Fire-and-forget wrapper used at server boot.  Non-blocking. */
const start = () => { setImmediate(() => runOnce().catch(() => {})); };

module.exports = { runOnce, start };
