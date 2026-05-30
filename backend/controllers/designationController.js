const asyncHandler = require('express-async-handler');
const Designation = require('../models/Designation');
const User = require('../models/User');

// Coerce an empty-string department to null (standalone designation).
const cleanDept = (body) => {
  const out = { ...body };
  if ('department' in out && (out.department === '' || out.department === undefined)) out.department = null;
  return out;
};

const list = asyncHandler(async (_req, res) => {
  res.json(await Designation.find({}).populate('department', 'name').sort({ title: 1 }));
});

const create = asyncHandler(async (req, res) => {
  const d = await Designation.create(cleanDept(req.body));
  res.status(201).json(await d.populate('department', 'name'));
});

const update = asyncHandler(async (req, res) => {
  const d = await Designation.findByIdAndUpdate(req.params.id, cleanDept(req.body), { new: true })
    .populate('department', 'name');
  if (!d) { res.status(404); throw new Error('Designation not found'); }
  res.json(d);
});

/**
 * DELETE /api/designations/:id?reassignTo=<designationId>
 * Employees holding this designation are NEVER broken: they are either
 * reassigned to `reassignTo` (when provided) or have their designation
 * cleared (set to null).  The count of affected employees is returned.
 */
const remove = asyncHandler(async (req, res) => {
  const d = await Designation.findById(req.params.id);
  if (!d) { res.status(404); throw new Error('Designation not found'); }

  const reassignTo = req.query.reassignTo || req.body?.reassignTo || null;
  if (reassignTo) {
    const target = await Designation.findById(reassignTo);
    if (!target) { res.status(400); throw new Error('Reassignment designation not found'); }
  }
  const result = await User.updateMany(
    { designation: d._id },
    { $set: { designation: reassignTo || null } }
  );

  await Designation.findByIdAndDelete(d._id);
  res.json({ message: 'Designation deleted', reassigned: result.modifiedCount || 0, reassignedTo: reassignTo || null });
});

module.exports = { list, create, update, remove };
