const mongoose = require('mongoose');

/**
 * NoteType -- a reusable notebook / collection HR groups Note entries
 * under.  Purely a categorisation entity: no domain logic, no reminders,
 * no notifications.  Personal notes have noteType === null.
 *
 * Reuse: shares the same visibility semantics used by Interaction /
 * InteractionNote so a future consolidation is trivial.
 */
const noteTypeSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true, unique: true },
    slug:        { type: String, required: true, trim: true, lowercase: true, unique: true },
    description: { type: String, default: '' },
    icon:        { type: String, default: '' },     // emoji or lucide name
    color:       { type: String, default: '#64748b' },
    visibility:  {
      type: String,
      enum: ['hr_only', 'managers_hr'],
      default: 'hr_only',
    },
    archived:    { type: Boolean, default: false, index: true },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('NoteType', noteTypeSchema);
