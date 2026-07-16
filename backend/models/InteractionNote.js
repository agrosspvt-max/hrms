const mongoose = require('mongoose');

/**
 * InteractionNote -- append-only chronological notes attached to one
 * Interaction.  Split from the parent document so a meeting or case
 * file with hundreds of notes doesn't force the parent to blow past
 * the 16MB Mongo document limit and so per-note visibility, tags and
 * mentions stay first-class.
 */
const interactionNoteSchema = new mongoose.Schema(
  {
    interaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Interaction', required: true, index: true },
    author:      { type: mongoose.Schema.Types.ObjectId, ref: 'User',        required: true, index: true },
    body:        { type: String, required: true, trim: true },
    tags:        { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'InteractionTag' }], default: [] },
    mentions:    { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    visibility: {
      type: String,
      enum: ['hr_only', 'managers_hr', 'employee_visible'],
      default: 'hr_only',
    },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastEditedAt: { type: Date },
    // Denormalised search text: body + tag names.  Powered by the
    // module's global search endpoint.
    searchText:   { type: String, default: '', index: 'text' },
  },
  { timestamps: true },
);

interactionNoteSchema.index({ interaction: 1, createdAt: -1 });

module.exports = mongoose.model('InteractionNote', interactionNoteSchema);
