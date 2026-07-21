/**
 * ActionBadge -- small pill that describes one applied compliance
 * action ("₹200 fine", "5% reduction", "Half Day LWP", ...).  Used
 * inside the Compliance Card and the Incident Detail view.
 */
const LABELS = {
  zero_daily_marks:      { label: 'Marks Zeroed',      cls: 'bg-red-50 text-red-700 border-red-200' },
  add_daily_total:       { label: 'Total Adjusted',    cls: 'bg-red-50 text-red-700 border-red-200' },
  fixed_marks_reduction: { label: 'Marks Reduced',     cls: 'bg-red-50 text-red-700 border-red-200' },
  percent_reduction:     { label: '% Reduction',       cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  financial_fine:        { label: 'Fine',              cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  half_day_lwp:          { label: 'Half Day LWP',      cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  full_day_lwp:          { label: 'Full Day LWP',      cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  warning:               { label: 'Warning',           cls: 'bg-slate-50 text-slate-700 border-slate-200' },
  notification:          { label: 'Notification',      cls: 'bg-slate-50 text-slate-700 border-slate-200' },
  manager_notification:  { label: 'Manager Notified',  cls: 'bg-slate-50 text-slate-700 border-slate-200' },
  performance_lock:      { label: 'Performance Lock',  cls: 'bg-red-100 text-red-800 border-red-300' },
  suspend_incentive:     { label: 'Incentive Held',    cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  custom:                { label: 'Custom',            cls: 'bg-slate-50 text-slate-700 border-slate-200' },
};

export default function ActionBadge({ effect }) {
  if (!effect) return null;
  const meta = LABELS[effect.actionType] || { label: effect.actionType, cls: 'bg-slate-50 text-slate-700 border-slate-200' };
  let value = '';
  if (effect.amount)         value = `₹${effect.amount}`;
  else if (effect.percent)   value = `-${effect.percent}%`;
  else if (effect.marks)     value = `-${effect.marks} pts`;
  else if (effect.attendanceUnit === 0.5) value = '0.5 unit';
  else if (effect.attendanceUnit === 1)   value = '1 unit';
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>
      <span>{meta.label}</span>
      {value && <span className="opacity-80">{value}</span>}
      {effect.status === 'waived' && <span className="opacity-70 italic">· waived</span>}
      {effect.status === 'resolved' && <span className="opacity-70 italic">· resolved</span>}
    </span>
  );
}
