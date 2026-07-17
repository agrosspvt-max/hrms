const mongoose = require('mongoose');

/**
 * Note -- HR knowledge-base entry.
 *
 *   personal = true  AND noteType = null  -> Personal (HR diary) note.
 *   personal = false AND noteType = <id>  -> Entry inside a Note Type notebook.
 *
 * Deliberately a new collection (not Interaction) because notes here
 * are notebook entries, not meeting artefacts.  Fields mirror what the
 * Interaction module already understands so mention / tag / search /
 * timeline plumbing can be reused.
 */
const noteSchema = new mongoose.Schema(
  {
    noteType:   { type: mongoose.Schema.Types.ObjectId, ref: 'NoteType', index: true },
    personal:   { type: Boolean, default: false, index: true },

    title:      { type: String, required: true, trim: true },
    body:       { type: String, default: '' },

    mentions:   { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    tags:       { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'InteractionTag' }], default: [] },

    // Placeholder for future attachments.  Kept in the schema so file
    // uploads become an additive change later.
    attachments: [{
      name: String, url: String, mimeType: String, size: Number,
      uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      uploadedAt: Date,
    }],

    visibility: {
      type: String,
      enum: ['hr_only', 'managers_hr', 'employee_visible'],
      default: 'hr_only',
    },

    createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Denormalised searchable text so global search stays a single
    // regex against one field (same pattern as Interaction.searchText).
    searchText: { type: String, default: '', index: 'text' },
  },
  { timestamps: true },
);

noteSchema.index({ noteType: 1, createdAt: -1 });
noteSchema.index({ personal: 1, createdBy: 1, createdAt: -1 });
noteSchema.index({ mentions: 1, createdAt: -1 });

module.exports = mongoose.model('Note', noteSchema);
