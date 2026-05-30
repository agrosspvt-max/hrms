/**
 * ScheduleTag
 *
 * Small colour-coded pill that shows an assignment / submission / task's
 * recurrence type.  Colour coding (per spec):
 *   Daily    -> Blue
 *   Weekly   -> Purple
 *   Monthly  -> Orange
 *   One Time -> Gray
 *
 * Pass `frequency` (required) and optionally `label` to append the
 * human-readable schedule (e.g. "Every Monday") after the type chip.
 */
const META = {
  daily: { text: 'DAILY', cls: 'bg-blue-50 text-blue-700' },
  weekly: { text: 'WEEKLY', cls: 'bg-purple-50 text-purple-700' },
  monthly: { text: 'MONTHLY', cls: 'bg-orange-50 text-orange-700' },
  'one-time': { text: 'ONE TIME', cls: 'bg-slate-100 text-slate-600' },
};

export const scheduleMeta = (frequency) => META[frequency] || META.daily;

export default function ScheduleTag({ frequency = 'daily', label, showLabel = true, className = '' }) {
  const m = scheduleMeta(frequency);
  // If a label exists and isn't just the bare type, show its detail part
  // (e.g. "Weekly • Every Monday" -> "Every Monday").
  const detail = showLabel && label && label.includes('•')
    ? label.split('•').slice(1).join('•').trim()
    : '';
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide ${m.cls}`}>
        {m.text}
      </span>
      {detail && <span className="text-[11px] text-slate-500">{detail}</span>}
    </span>
  );
}
