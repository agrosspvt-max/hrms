const mongoose = require('mongoose');

const designationSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, unique: true, trim: true, index: true },
    description: { type: String, trim: true },

    // A designation may belong to a department, or be standalone/global
    // (department = null).  Optional + nullable so existing designations
    // keep working unchanged.
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Designation', designationSchema);
