const mongoose = require('mongoose');

/**
 * DependencyTask
 *
 * A linked follow-up unit of work created when an employee completes THEIR
 * part of a task/report row but the work now depends on someone else.  It
 * is the backbone of the collaborative workflow / escalation pipeline.
 *
 * It is intentionally a SEPARATE collection (not a Submission) so that the
 * existing daily-submission, scoring, attendance and salary pipelines stay
 * completely untouched.  Dependency tasks are surfaced through their own
 * dashboard section + analytics.
 *
 * A chain of dependencies (A -> B -> C ...) shares a single `chainId` so the
 * whole escalation path can be reconstructed and visualised as a tree.
 */
const dependencyTaskSchema = new mongoose.Schema(
  {
    // ---- Source of the dependency ----
    sourceSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', index: true },
    // For task templates this is the embedded task _id; for excel/sheet rows
    // it's the field-name / score-key (stored as a string for uniformity).
    sourceTaskId: { type: String, default: '' },
    sourceKind: { type: String, enum: ['task', 'excel', 'sheet'], default: 'task' },

    // Human-readable name of the originating task / report row.
    originalTaskName: { type: String, default: '' },

    // ---- Routing ----
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Denormalised names so the card still reads correctly if a user is
    // later renamed or removed.
    assignedToName: { type: String, default: '' },
    assignedByName: { type: String, default: '' },
    // The employee who previously owned the work (same as assignedBy for the
    // first hop; kept explicit for chain clarity).
    previousEmployee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    remark: { type: String, default: '' },

    // ---- Linkage / context ----
    chainId: { type: String, index: true },           // shared across a dependency chain
    parentDependencyTaskId: { type: mongoose.Schema.Types.ObjectId, ref: 'DependencyTask' },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    departmentName: { type: String, default: '' },
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'Template' },
    templateTitle: { type: String, default: '' },

    // ---- Lifecycle ----
    currentStatus: {
      type: String,
      enum: ['open', 'in_progress', 'resolved'],
      default: 'open',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'normal', 'high'],
      default: 'normal',
    },
    // waitingSince mirrors createdAt but is set explicitly so it survives
    // any future re-open logic without depending on timestamps.
    waitingSince: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolutionNote: { type: String, default: '' },
  },
  { timestamps: true }
);

dependencyTaskSchema.index({ assignedTo: 1, currentStatus: 1, createdAt: -1 });
dependencyTaskSchema.index({ chainId: 1, createdAt: 1 });

module.exports = mongoose.model('DependencyTask', dependencyTaskSchema);
