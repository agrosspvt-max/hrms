const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, index: true },
    description: { type: String, trim: true },

    // Optional Head of Department - an employee appointed by HR to
    // supervise/review this department.  Departments MAY exist without
    // a HOD, in which case submissions route straight to HR.
    hodEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /* ----- Analytics-type marker -----
     * Drives which Performance tabs a HOD of this department sees:
     *   - 'standard'  -> Pendency Review + Completion Review only
     *   - 'calling'   -> adds Calling Analytics + Product & Farmer
     *                    Analytics as the default tab.
     * The marker lives on the Department, not on a hard-coded name,
     * so HR can rename departments freely without losing the tab set.
     * Boot migration upgrades existing "Marketing" departments to
     * 'calling'; all other existing rows stay 'standard' via the
     * Mongoose default. */
    analyticsType: {
      type: String,
      enum: ['standard', 'calling'],
      default: 'standard',
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Department', departmentSchema);
