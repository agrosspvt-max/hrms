/**
 * departmentMigration
 *
 * One-time + boot-time migration for the Department.analyticsType field.
 *
 *   - Adds `analyticsType: 'calling'` to any department named "Marketing"
 *     (case-insensitive) that is currently 'standard' or missing the
 *     field entirely.  All other rows keep / default to 'standard'.
 *
 *   - Idempotent: a tenant whose Marketing row is already 'calling' is
 *     a no-op.  Safe to re-run on every restart.
 *
 *   - Logs an explicit summary line so deploys can verify the migration
 *     ran without diving into the database.
 */

const Department = require('../models/Department');

const migrateDepartmentAnalyticsType = async () => {
  // Case-insensitive name match.  Anchored so "Marketing Operations"
  // doesn't match -- only departments literally named "Marketing".
  const result = await Department.updateMany(
    {
      name: { $regex: /^marketing$/i },
      $or: [{ analyticsType: { $exists: false } }, { analyticsType: 'standard' }],
    },
    { $set: { analyticsType: 'calling' } },
  );
  const upgraded = result?.modifiedCount || 0;
  if (upgraded > 0) {
    console.log(`[migrate] departments: analyticsType=calling set on ${upgraded} existing Marketing-named department(s)`);
  } else {
    console.log('[migrate] departments: no Marketing-named department(s) needed analyticsType upgrade');
  }
  return { upgraded };
};

module.exports = { migrateDepartmentAnalyticsType };
