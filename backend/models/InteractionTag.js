const mongoose = require('mongoose');

/**
 * InteractionTag -- global tag catalogue for the Employee Interactions
 * module.  HR / Super Admin manage the catalogue; every interaction
 * and every note references tags by ObjectId so renaming a tag
 * updates the whole history without a data migration.
 *
 * Categories mirror the spec: Performance / Behaviour / Compliance / HR / Custom.
 */
const interactionTagSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true, unique: true },
    slug:        { type: String, required: true, trim: true, lowercase: true, unique: true },
    category: {
      type: String,
      enum: ['performance', 'behaviour', 'compliance', 'hr', 'custom'],
      default: 'custom',
      index: true,
    },
    color:        { type: String, default: '#64748b' },   // slate-500
    icon:         { type: String, default: '' },
    description:  { type: String, default: '' },
    severity: {
      type: String,
      enum: ['info', 'low', 'medium', 'high', 'critical'],
      default: 'info',
    },
    countsAsWarning:   { type: Boolean, default: false },
    countsInAnalytics: { type: Boolean, default: true },
    visibleToEmployee: { type: Boolean, default: false },
    archived:          { type: Boolean, default: false, index: true },
    createdBy:         { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

interactionTagSchema.index({ name: 'text', description: 'text' });

module.exports = mongoose.model('InteractionTag', interactionTagSchema);
