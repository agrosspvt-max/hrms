/**
 * dependencyEngine
 *
 * Creates and resolves the linked follow-up work ("DependencyTask") that
 * powers the collaborative / escalation workflow.  Kept isolated from the
 * daily-submission + scoring pipelines so nothing about marks, attendance
 * or salary is affected.
 */

const crypto = require('crypto');
const DependencyTask = require('../models/DependencyTask');
const Submission = require('../models/Submission');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Department = require('../models/Department');

/** Short, sortable, collision-resistant chain id. */
const newChainId = () =>
  `DCH-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * Create a DependencyTask handing a completed-but-blocked unit of work to
 * another active account, plus an in-app notification.
 *
 * @returns the created DependencyTask document.
 */
const createDependencyTask = async ({
  submission,
  sourceKind = 'task',
  sourceTaskId = '',
  originalTaskName = '',
  assignedToId,
  assignedBy,               // the User doc handing off (req.user)
  remark = '',
  priority = 'normal',
  chainId,                  // reuse when re-forwarding an existing chain
  templateTitle = '',
}) => {
  const assignee = await User.findById(assignedToId).select('name status department');
  if (!assignee) throw new Error('Selected assignee not found');
  if (assignee.status !== 'active') throw new Error('Selected assignee is not active');

  // The blocker originates from the department of the person handing it off.
  let department = assignedBy.department || null;
  let departmentName = '';
  if (department) {
    const d = await Department.findById(department).select('name');
    departmentName = d?.name || '';
  }

  const depTask = await DependencyTask.create({
    sourceSubmissionId: submission?._id,
    sourceTaskId: String(sourceTaskId || ''),
    sourceKind,
    originalTaskName,
    assignedTo: assignee._id,
    assignedBy: assignedBy._id,
    assignedToName: assignee.name || '',
    assignedByName: assignedBy.name || '',
    previousEmployee: assignedBy._id,
    remark,
    chainId: chainId || newChainId(),
    department,
    departmentName,
    template: submission?.template,
    templateTitle,
    currentStatus: 'open',
    priority: ['low', 'normal', 'high'].includes(priority) ? priority : 'normal',
    waitingSince: new Date(),
  });

  // In-app notification (non-fatal).
  await Notification.create({
    recipient: assignee._id,
    sender: assignedBy._id,
    type: 'dependency_assigned',
    title: 'Dependency work assigned to you',
    message: `${assignedBy.name || 'A colleague'} assigned dependency work to you${originalTaskName ? `: "${originalTaskName}"` : ''}.`,
    relatedTitles: originalTaskName ? [originalTaskName] : [],
  }).catch(() => {});

  return depTask;
};

/**
 * Resolve a DependencyTask: mark it resolved, notify the person who handed
 * it off, and (best-effort) flip the originating submission row's
 * dependencyStatus to 'resolved' so the source report reflects closure.
 */
const resolveDependencyTask = async (depTask, byUser, note = '') => {
  depTask.currentStatus = 'resolved';
  depTask.resolvedAt = new Date();
  depTask.resolvedBy = byUser._id;
  depTask.resolutionNote = note || '';
  await depTask.save();

  // Reflect closure on the source submission row (best-effort).
  try {
    if (depTask.sourceSubmissionId) {
      const sub = await Submission.findById(depTask.sourceSubmissionId);
      if (sub) {
        if (depTask.sourceKind === 'task') {
          const t = sub.tasks.id(depTask.sourceTaskId);
          if (t) t.dependencyStatus = 'resolved';
        } else if (depTask.sourceKind === 'excel') {
          const r = sub.excelResponses.find((x) => x.fieldName === depTask.sourceTaskId);
          if (r) r.dependencyStatus = 'resolved';
        } else if (depTask.sourceKind === 'sheet' && sub.sheet) {
          const sc = (sub.sheet.scores || []).find((x) => x.key === depTask.sourceTaskId);
          if (sc) { sc.dependencyStatus = 'resolved'; sub.markModified('sheet'); }
        }
        await sub.save();
      }
    }
  } catch (e) {
    console.error('[dependency] source reflect failed:', e.message);
  }

  // Notify the original assigner that their blocker is cleared.
  await Notification.create({
    recipient: depTask.assignedBy,
    sender: byUser._id,
    type: 'dependency_resolved',
    title: 'Dependency work resolved',
    message: `${byUser.name || 'A colleague'} resolved the dependency work${depTask.originalTaskName ? `: "${depTask.originalTaskName}"` : ''}.`,
    relatedTitles: depTask.originalTaskName ? [depTask.originalTaskName] : [],
  }).catch(() => {});

  return depTask;
};

module.exports = { newChainId, createDependencyTask, resolveDependencyTask };
