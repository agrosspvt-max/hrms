/**
 * scope.js -- resolve a ComplianceRule's `scope` filter to a set of
 * User ids.  Every detector runs against the resolved set.
 *
 * Scope semantics (all optional; empty = no filter):
 *
 *   scope.employeeIds  -- explicit id list (union'd with other filters)
 *   scope.departments  -- department id list
 *   scope.designations -- designation id list
 *
 * `templates` is scope for template-scoped rules (missed submission
 * on a specific template) but does NOT gate which employees are
 * considered here -- it's applied INSIDE the detector.
 *
 * When no filter is set the rule applies to every ACTIVE non-super-admin
 * employee (auto_attendance excluded, matching the existing Submission
 * Review scope so the new engine mirrors legacy semantics).
 */

const User = require('../../models/User');

const _idList = (arr) => (Array.isArray(arr) ? arr.filter(Boolean) : []);

const resolveEmployeeIds = async (rule) => {
  const s = (rule && rule.scope) || {};
  const or = [];
  const emp = _idList(s.employeeIds);
  const dept = _idList(s.departments);
  const desig = _idList(s.designations);

  if (emp.length)   or.push({ _id: { $in: emp } });
  if (dept.length)  or.push({ department: { $in: dept } });
  if (desig.length) or.push({ designation: { $in: desig } });

  const where = {
    status: 'active',
    role: { $ne: 'super_admin' },
    attendanceMode: { $ne: 'auto_attendance' },
  };
  if (or.length) where.$or = or;

  const rows = await User.find(where).select('_id').lean();
  return rows.map((r) => r._id);
};

module.exports = { resolveEmployeeIds };
