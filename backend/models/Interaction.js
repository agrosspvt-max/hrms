const mongoose = require('mongoose');

/**
 * Interaction -- single unified document for every HR-employee touch
 * point.  Meetings, personal notes, warnings, appreciations, etc.
 * are all Interactions with a `type` discriminator.  A meeting is
 * simply an Interaction whose `meeting` sub-doc is populated.
 *
 * Sub-collections:
 *   participants[] -- employees involved (invitation + attendance).
 *   tags[]         -- ObjectId refs to InteractionTag (global catalogue).
 *   mentions[]     -- ObjectId refs to Users mentioned via `!` syntax
 *                     in the title / description (notes carry their own).
 *
 * `searchText` is a denormalised concatenation of title + description
 * + tag names + participant names used to power the module's global
 * text search without paying the join cost on every query.
 */
const participantSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Invitation response (employee-driven).
    invitationStatus: {
      type: String,
      enum: ['invited', 'accepted', 'declined', 'maybe'],
      default: 'invited',
    },
    invitationRespondedAt: { type: Date },
    // Attendance (HR-driven; final authority per spec).
    attendanceStatus: {
      type: String,
      enum: ['present', 'absent', 'late', 'left_early', 'excused', null],
      default: null,
    },
    attendanceSetBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    attendanceSetAt: { type: Date },
    note: { type: String, default: '' },
  },
  { _id: false },
);

const interactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        'meeting', 'personal_note', 'warning', 'appreciation', 'follow_up',
        'coaching', 'performance_discussion', 'salary_discussion',
        'training', 'probation_review', 'exit_discussion', 'other',
      ],
      required: true,
      index: true,
    },
    title:       { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    // Meeting-specific fields.  Populated only when type === 'meeting'
    // (or another synchronous-touch type such as coaching, training).
    meeting: {
      date:        { type: Date, index: true },
      time:        { type: String, default: '' },   // 'HH:mm' in 24h
      durationMinutes: { type: Number, default: 30 },
      mode:        { type: String, enum: ['online', 'offline'], default: 'offline' },
      location:    { type: String, default: '' },
      meetingType: { type: String, default: '' },   // 1-on-1, group, review, etc.
    },

    participants: { type: [participantSchema], default: [] },

    // Global tag references (InteractionTag) + free-text mentions.
    tags:     { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'InteractionTag' }], default: [], index: true },
    mentions: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },

    visibility: {
      type: String,
      enum: ['hr_only', 'managers_hr', 'employee_visible'],
      default: 'hr_only',
      index: true,
    },

    // Cross-module linkage (future-ready per spec).  Callers can pin
    // an interaction to a specific submission / salary slip / penalty
    // / leave / attendance day for zero-duplication traceability.
    linkedRefs: [{
      module: { type: String, enum: ['submission', 'salary', 'penalty', 'leave', 'attendance', 'self_review'] },
      id:     { type: mongoose.Schema.Types.ObjectId },
      label:  { type: String, default: '' },
    }],

    followUp: {
      required:   { type: Boolean, default: false, index: true },
      dueDate:    { type: Date },
      resolvedAt: { type: Date },
      resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      note:       { type: String, default: '' },
    },

    status: {
      type: String,
      enum: ['scheduled', 'completed', 'cancelled'],
      default: 'scheduled',
      index: true,
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Denormalised for search / analytics filtering.
    department:  { type: mongoose.Schema.Types.ObjectId, ref: 'Department', index: true },
    designation: { type: mongoose.Schema.Types.ObjectId, ref: 'Designation', index: true },

    // Denormalised searchable text (title + description + tags + names).
    searchText: { type: String, default: '', index: 'text' },
  },
  { timestamps: true },
);

// Composite indexes for the most common query patterns.
interactionSchema.index({ 'participants.employee': 1, createdAt: -1 });
interactionSchema.index({ type: 1, createdAt: -1 });
interactionSchema.index({ 'meeting.date': -1 });
interactionSchema.index({ 'followUp.required': 1, 'followUp.resolvedAt': 1, 'followUp.dueDate': 1 });

module.exports = mongoose.model('Interaction', interactionSchema);
