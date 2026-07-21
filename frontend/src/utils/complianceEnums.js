/**
 * complianceEnums.js -- source-of-truth for the Rule Builder UI.
 *
 * Values MUST stay in sync with the backend enums declared in:
 *   - backend/models/ComplianceRule.js  (ACTION_TYPES, MARKS_STRATEGIES)
 *   - backend/services/compliance/rules/ruleService.js
 *   - backend/services/compliance/detectors/register.js
 *
 * If a new action / detector / strategy ever ships, only this file
 * (and the executor / detector wiring on the backend) needs updating.
 */

export const CATEGORIES = [
  { value: 'submission',  label: 'Submission' },
  { value: 'dependency',  label: 'Dependency' },
  { value: 'attendance',  label: 'Attendance' },
  { value: 'conduct',     label: 'Conduct' },
  { value: 'custom',      label: 'Custom' },
];

export const SEVERITIES = [
  { value: 'low',      label: 'Low',      tone: 'bg-slate-100 text-slate-700' },
  { value: 'medium',   label: 'Medium',   tone: 'bg-amber-100 text-amber-800' },
  { value: 'high',     label: 'High',     tone: 'bg-orange-100 text-orange-800' },
  { value: 'critical', label: 'Critical', tone: 'bg-red-100 text-red-800' },
];

export const DETECTORS = [
  { value: 'built_in.missed_submission',  label: 'Built-in — Missed Submission',  automatic: true },
  { value: 'built_in.dependency_pending', label: 'Built-in — Dependency Pending', automatic: true },
  { value: 'built_in.performance_lock',   label: 'Built-in — Performance Lock',   automatic: true },
  { value: 'manual',                      label: 'Manual (HR-initiated)',         automatic: false },
];

// One entry per action.type in backend/models/ComplianceRule.js.
// `configSchema` drives the dynamic per-action form in
// components/compliance/RuleActionsEditor.jsx.
export const ACTION_TYPES = [
  {
    value: 'zero_daily_marks',
    label: 'Zero Daily Marks',
    hint: 'Deducts full expected marks for the day using the selected strategy.',
    configSchema: ['marksStrategy', 'strategyN', 'marks', 'recurring'],
  },
  {
    value: 'add_daily_total',
    label: 'Add To Daily Total',
    hint: 'Adds a fixed number of marks to the daily total (used with strategies).',
    configSchema: ['marksStrategy', 'strategyN', 'marks', 'recurring'],
  },
  {
    value: 'fixed_marks_reduction',
    label: 'Fixed Marks Reduction',
    hint: 'Reduce marks by a fixed number.',
    configSchema: ['marks', 'recurring'],
  },
  {
    value: 'percent_reduction',
    label: 'Percent Reduction',
    hint: 'Reduce completion percentage (with an optional cap).',
    configSchema: ['percent', 'percentPerDay', 'maxCap', 'recurring'],
  },
  {
    value: 'financial_fine',
    label: 'Financial Fine',
    hint: 'Levy a monetary fine; optional higher rate for critical tasks.',
    configSchema: ['amount', 'criticalAmount', 'recurring'],
  },
  {
    value: 'half_day_lwp',
    label: 'Half-day LWP',
    hint: 'Mark half day as Leave Without Pay.',
    configSchema: ['recurring'],
  },
  {
    value: 'full_day_lwp',
    label: 'Full-day LWP',
    hint: 'Mark full day as Leave Without Pay.',
    configSchema: ['recurring'],
  },
  {
    value: 'warning',
    label: 'Warning',
    hint: 'Record a warning (no ledger impact).',
    configSchema: [],
  },
  {
    value: 'notification',
    label: 'Notification (Employee)',
    hint: 'Send an in-app notification to the employee.',
    configSchema: ['template'],
  },
  {
    value: 'manager_notification',
    label: 'Notification (Manager)',
    hint: "Notify the employee's HOD / reporting manager.",
    configSchema: ['template'],
  },
  {
    value: 'performance_lock',
    label: 'Performance Lock',
    hint: 'Lock daily performance display; mirrors the legacy F&P card.',
    configSchema: ['recurring'],
  },
  {
    value: 'suspend_incentive',
    label: 'Suspend Incentive',
    hint: 'Suspend incentive payout for the incident window.',
    configSchema: [],
  },
  {
    value: 'custom',
    label: 'Custom',
    hint: 'Placeholder for a rule that carries only a status flag.',
    configSchema: [],
  },
];

export const MARKS_STRATEGIES = [
  { value: 'last_n_avg',       label: 'Average of last N days' },
  { value: 'template_default', label: "Template's expected marks" },
  { value: 'department_avg',   label: 'Department average' },
  { value: 'admin_defined',    label: 'Fixed number (admin-defined)' },
];

export const RECOVERY_MODES = [
  { value: 'restore',     label: 'Restore (reverse ledger + resolve)' },
  { value: 'information', label: 'Information (count for analytics, ledger reversed)' },
  { value: 'neutral',     label: 'Neutral (informational; analytics ignores)' },
];

export const APPROVER_ROLES = [
  { value: 'hr',          label: 'HR' },
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'hod',         label: 'HOD' },
];

export const NOTIFICATION_EVENTS = [
  { value: 'onIncident',   label: 'On Incident (candidate created)' },
  { value: 'onEffective',  label: 'On Effective (promoted to active)' },
  { value: 'onEscalation', label: 'On Escalation' },
  { value: 'onRecovery',   label: 'On Recovery' },
  { value: 'onWaiver',     label: 'On Waiver' },
];

export const NOTIFICATION_AUDIENCES = [
  { value: 'employee', label: 'Employee' },
  { value: 'manager',  label: 'Manager' },
  { value: 'hr',       label: 'HR' },
];

export const findActionSpec = (type) =>
  ACTION_TYPES.find((a) => a.value === type) || null;
