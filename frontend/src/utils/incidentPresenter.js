/**
 * incidentPresenter.js -- pure UI helpers for the IncidentDetailPanel.
 * Everything here is stateless mapping: no fetches, no side effects.
 */

// Rule code → human-facing title.  Mirrors the RuleManifest on the
// backend seeder; unknown codes fall back to a title-cased version of
// the code itself so future rules still render sensibly.
const RULE_TITLES = {
  missed_submission_v2:      'Missed Submission',
  dependency_pending_v2:     'Dependency Pending',
  performance_lock_v2:       'Performance Lock',
  attendance_manual_v2:      'Attendance Manual Correction',
  manual_marks_v2:           'Manual Marks Adjustment',
  completion_adjustment_v2:  'Completion Score Adjustment',
  financial_penalty_v2:      'Financial Penalty',
};
export const ruleTitle = (code) => RULE_TITLES[code]
  || String(code || '')
    .replace(/_v\d+$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
  || 'Compliance Rule';

// Detector code → display label.  Kept out of the enums file because
// it's presentation-only and doesn't need registry hydration.
const DETECTOR_LABELS = {
  'built_in.missed_submission':  'Missed Submission Detector',
  'built_in.dependency_pending': 'Dependency Pending Detector',
  'built_in.performance_lock':   'Performance Lock Detector',
  'manual':                      'HR-initiated',
};
export const detectorLabel = (code) =>
  DETECTOR_LABELS[code] || (code ? `Detector: ${code}` : '');

// Human sentence + ledger-family for each action.  Used both in the
// "Actions Applied" readable list and in the "Ledger Status" section.
//   ledger: null  -> action never writes a ledger row (notification, warning, perf-lock, …)
//   ledger: 'marks' | 'financial' | 'percentage' | 'attendance'
//           -> action writes to that ledger (or SKIPs when quantity=0)
const ACTION_META = {
  zero_daily_marks:      { verb: 'Daily marks set to zero',                ledger: 'marks',      unit: 'pts' },
  add_daily_total:       { verb: 'Daily total adjusted',                    ledger: 'marks',      unit: 'pts' },
  fixed_marks_reduction: { verb: 'Fixed marks reduction applied',           ledger: 'marks',      unit: 'pts' },
  percent_reduction:     { verb: 'Completion percentage reduced',           ledger: 'percentage', unit: '%'   },
  financial_fine:        { verb: 'Financial fine levied',                   ledger: 'financial',  unit: '₹'   },
  half_day_lwp:          { verb: 'Half-day Leave-Without-Pay applied',      ledger: 'attendance', unit: 'unit' },
  full_day_lwp:          { verb: 'Full-day Leave-Without-Pay applied',      ledger: 'attendance', unit: 'unit' },
  warning:               { verb: 'Warning recorded',                        ledger: null,         unit: ''    },
  notification:          { verb: 'Employee notification sent',              ledger: null,         unit: ''    },
  manager_notification:  { verb: 'Manager notification sent',               ledger: null,         unit: ''    },
  performance_lock:      { verb: 'Performance lock renewed',                ledger: null,         unit: ''    },
  suspend_incentive:     { verb: 'Incentive suspended',                     ledger: null,         unit: ''    },
  custom:                { verb: 'Custom action recorded',                  ledger: null,         unit: ''    },
};
export const actionMeta = (type) => ACTION_META[type]
  || { verb: type ? type.replace(/_/g, ' ') : 'Action', ledger: null, unit: '' };

// Effect → number the badge/list should display.  Null when no
// numeric value applies (notification, warning, etc.).
export const effectValue = (effect) => {
  if (!effect) return null;
  if (effect.amount)          return `-₹${effect.amount}`;
  if (effect.percent)         return `-${effect.percent}%`;
  if (effect.marks)           return `-${effect.marks} pts`;
  if (effect.attendanceUnit === 0.5) return '0.5 unit';
  if (effect.attendanceUnit === 1)   return '1 unit';
  return null;
};

// Ledger family → HR-facing short prefix.  We slice the last 6 hex
// chars of the ObjectId ref to build a stable-looking "reference"
// string in the UI without exposing full Mongo ids.
export const ledgerRefLabel = (family, refId) => {
  const P = { marks: 'ML', financial: 'FL', percentage: 'PL', attendance: 'AL' };
  const prefix = P[family] || 'REF';
  const tail = String(refId || '').slice(-6).toUpperCase();
  return `${prefix}-${tail}`;
};

// Timeline event kind → icon + label + accent tone.  These are the
// kinds emitted by services/compliance/*  (incidentService, waiver,
// recovery, actionEngine, escalationRunner, cancel).
export const eventPresentation = (kind) => {
  const map = {
    incident_created:    { label: 'Incident detected',    icon: '🟠', tone: 'text-amber-700' },
    incident_effective:  { label: 'Rule became effective',icon: '⚡', tone: 'text-orange-700' },
    action_applied:      { label: 'Action applied',       icon: '✓',  tone: 'text-red-700' },
    escalated:           { label: 'Escalation step fired',icon: '↑',  tone: 'text-red-700' },
    waiver_requested:    { label: 'Waiver requested',     icon: '📨', tone: 'text-blue-700' },
    waiver_decided:      { label: 'Waiver decided',       icon: '⚖️',  tone: 'text-blue-700' },
    recovery_applied:    { label: 'Recovery applied',     icon: '↩', tone: 'text-emerald-700' },
    incident_resolved:   { label: 'Incident resolved',    icon: '✅', tone: 'text-emerald-700' },
    incident_cancelled:  { label: 'Incident cancelled',   icon: '✖', tone: 'text-slate-700' },
  };
  return map[kind] || { label: kind || 'Event', icon: '•', tone: 'text-slate-700' };
};

// Severity chip tone.  Mirrors complianceEnums but avoids importing
// so this file stays leaf-free.
export const severityTone = (sev) => ({
  low:      'bg-slate-100 text-slate-700',
  medium:   'bg-amber-100 text-amber-800',
  high:     'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-800',
}[sev] || 'bg-slate-100 text-slate-700');

// Status chip tone.
export const statusTone = (status) => ({
  candidate: 'bg-slate-100 text-slate-700',
  active:    'bg-red-100 text-red-800',
  resolved:  'bg-emerald-100 text-emerald-800',
  waived:    'bg-amber-100 text-amber-800',
  cancelled: 'bg-slate-100 text-slate-600',
  expired:   'bg-slate-100 text-slate-500',
}[status] || 'bg-slate-100 text-slate-700');

// Compact date; caller passes a Date/ISO string.
export const fmtWhen = (d, withTime = true) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  const date = dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  if (!withTime) return date;
  const time = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
};

// Ordered list of statuses that make an incident "still open".
export const isOpenIncident = (status) => ['candidate', 'active'].includes(status);
