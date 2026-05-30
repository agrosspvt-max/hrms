const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, index: true },
    description: { type: String, trim: true },

    // Optional Head of Department - an employee appointed by HR to
    // supervise/review this department.  Departments MAY exist without
    // a HOD, in which case submissions route straight to HR.
    hodEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Department', departmentSchema);
