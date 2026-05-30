const asyncHandler = require('express-async-handler');
const Department = require('../models/Department');
const Designation = require('../models/Designation');
const User = require('../models/User');

const list = asyncHandler(async (_req, res) => {
  res.json(await Department.find({}).populate('hodEmployeeId', 'name employeeId').sort({ name: 1 }));
});

const create = asyncHandler(async (req, res) => {
  const dep = await Department.create(req.body);
  res.status(201).json(dep);
});

const update = asyncHandler(async (req, res) => {
  const dep = await Department.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!dep) { res.status(404); throw new Error('Department not found'); }
  res.json(dep);
});

/**
 * DELETE /api/departments/:id?reassignTo=<deptId>
 * Employees / designations are never broken: employees are moved to
 * `reassignTo` (or cleared), designations in the department become
 * standalone (or move), and any HOD pointing here is detached.
 */
const remove = asyncHandler(async (req, res) => {
  const dep = await Department.findById(req.params.id);
  if (!dep) { res.status(404); throw new Error('Department not found'); }

  const reassignTo = req.query.reassignTo || req.body?.reassignTo || null;
  if (reassignTo) {
    const target = await Department.findById(reassignTo);
    if (!target) { res.status(400); throw new Error('Reassignment department not found'); }
  }

  const moved = await User.updateMany({ department: dep._id }, { $set: { department: reassignTo || null } });
  await Designation.updateMany({ department: dep._id }, { $set: { department: reassignTo || null } });
  // Detach any HODs who headed this department so they don't dangle.
  await User.updateMany(
    { hodDepartment: dep._id },
    { $set: { hodDepartment: reassignTo || null, ...(reassignTo ? {} : { isHOD: false }) } }
  );

  await Department.findByIdAndDelete(dep._id);
  res.json({ message: 'Department deleted', employeesMoved: moved.modifiedCount || 0, reassignedTo: reassignTo || null });
});

/**
 * GET /api/departments/org-structure
 * Full organizational tree for the control-center module: departments with
 * their designations + employees + HOD, standalone designations, employees
 * without a department, and headline stats.  Read-only aggregation.
 */
const orgStructure = asyncHandler(async (_req, res) => {
  const [departments, designations, employees] = await Promise.all([
    Department.find({}).populate('hodEmployeeId', 'name employeeId').sort({ name: 1 }).lean(),
    Designation.find({}).sort({ title: 1 }).lean(),
    User.find({ role: 'employee' })
      .select('name employeeId department designation reportingManager isHOD status')
      .lean(),
  ]);

  const empOf = (filterFn) => employees.filter(filterFn).map((e) => ({
    _id: e._id, name: e.name, employeeId: e.employeeId,
    designation: e.designation ? String(e.designation) : null,
    reportingManager: e.reportingManager || '', isHOD: !!e.isHOD, status: e.status,
  }));

  const deptTree = departments.map((dep) => {
    const deptEmployees = empOf((e) => String(e.department) === String(dep._id));
    const deptDesigs = designations.filter((dg) => String(dg.department) === String(dep._id));
    const designationNodes = deptDesigs.map((dg) => {
      const members = deptEmployees.filter((e) => e.designation === String(dg._id));
      return { _id: dg._id, title: dg.title, description: dg.description || '', employeeCount: members.length, employees: members };
    });
    const unassigned = deptEmployees.filter((e) => !e.designation);
    return {
      _id: dep._id, name: dep.name, description: dep.description || '',
      hod: dep.hodEmployeeId ? { _id: dep.hodEmployeeId._id, name: dep.hodEmployeeId.name, employeeId: dep.hodEmployeeId.employeeId } : null,
      employeeCount: deptEmployees.length,
      designations: designationNodes,
      unassignedEmployees: unassigned,
    };
  });

  const standalone = designations.filter((dg) => !dg.department).map((dg) => {
    const members = empOf((e) => e.designation === String(dg._id));
    return { _id: dg._id, title: dg.title, description: dg.description || '', employeeCount: members.length, employees: members };
  });

  const noDepartmentEmployees = empOf((e) => !e.department);

  res.json({
    departments: deptTree,
    standaloneDesignations: standalone,
    noDepartmentEmployees,
    stats: {
      totalDepartments: departments.length,
      totalDesignations: designations.length,
      standaloneDesignations: standalone.length,
      employeesWithoutDepartment: noDepartmentEmployees.length,
      totalEmployees: employees.length,
    },
  });
});

module.exports = { list, create, update, remove, orgStructure };
