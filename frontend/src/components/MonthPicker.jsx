import { useEffect, useRef, useState } from 'react';

/**
 * MonthPicker — cross-browser drop-in replacement for <input type="month">.
 *
 * Why this exists:
 *   <input type="month"> is fully supported in Chromium browsers but
 *   per spec degrades to a plain text input in Firefox and Safari.
 *   The user-facing symptom was an admin (on Firefox) seeing an
 *   editable "2026-06" string while everyone else (on Chrome) saw the
 *   native month picker.  This component renders the SAME UI in every
 *   browser: a calendar-icon button that opens a popover with a year
 *   stepper and a 3×4 grid of months.
 *
 * Props:
 *   value      — 'YYYY-MM' string (same shape the native input emits)
 *   onChange   — (newValue) => void   (same shape)
 *   className  — extra classes for the trigger button wrapper
 *   minYear/maxYear — optional clamps on the stepper.  Default ±10y.
 *
 * Output is byte-identical to the native input so pages can swap in
 * <MonthPicker> without changing their existing state / load() logic.
 */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const _parse = (str) => {
  // Returns [year, monthIdx0-11] from 'YYYY-MM'.  Falls back to today
  // when the value is malformed so we never crash on bad input.
  if (typeof str === 'string') {
    const m = str.match(/^(\d{4})-(\d{1,2})$/);
    if (m) {
      const y = Number(m[1]);
      const mo = Math.max(1, Math.min(12, Number(m[2])));
      return [y, mo - 1];
    }
  }
  const d = new Date();
  return [d.getFullYear(), d.getMonth()];
};

const _format = (y, mIdx) => `${y}-${String(mIdx + 1).padStart(2, '0')}`;

export default function MonthPicker({
  value, onChange, className = '',
  minYear, maxYear,
}) {
  const [selY, selM] = _parse(value);
  const [open, setOpen] = useState(false);
  // The year currently shown in the popover (lets the user navigate
  // without committing).  Reset to the selected year every time the
  // popover opens so re-opening doesn't preserve a stale year.
  const [viewYear, setViewYear] = useState(selY);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (open) setViewYear(selY);
  }, [open, selY]);

  // Close when clicking outside.  Also close on Escape for keyboard parity.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const now = new Date();
  const yMin = typeof minYear === 'number' ? minYear : now.getFullYear() - 10;
  const yMax = typeof maxYear === 'number' ? maxYear : now.getFullYear() + 10;

  const select = (mIdx) => {
    onChange(_format(viewYear, mIdx));
    setOpen(false);
  };

  return (
    <div className={`relative inline-block ${className}`} ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="input flex items-center gap-2 max-w-[180px]"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
             className="text-slate-500 shrink-0">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8"  y1="2" x2="8"  y2="6" />
          <line x1="3"  y1="10" x2="21" y2="10" />
        </svg>
        <span className="text-sm">{MONTHS_SHORT[selM]} {selY}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Select month"
          className="absolute z-20 mt-2 p-3 bg-white border border-slate-200 rounded-lg shadow-lg w-[260px] dark:bg-slate-800 dark:border-slate-700"
        >
          {/* Year stepper */}
          <div className="flex items-center justify-between mb-3">
            <button
              type="button"
              className="px-2 py-1 rounded hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-700"
              onClick={() => setViewYear((y) => Math.max(yMin, y - 1))}
              disabled={viewYear <= yMin}
              aria-label="Previous year"
            >‹</button>
            <div className="font-semibold text-slate-800 dark:text-slate-100">{viewYear}</div>
            <button
              type="button"
              className="px-2 py-1 rounded hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-700"
              onClick={() => setViewYear((y) => Math.min(yMax, y + 1))}
              disabled={viewYear >= yMax}
              aria-label="Next year"
            >›</button>
          </div>

          {/* Month grid */}
          <div className="grid grid-cols-3 gap-1">
            {MONTHS_SHORT.map((label, i) => {
              const isSel = viewYear === selY && i === selM;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => select(i)}
                  className={
                    isSel
                      ? 'px-2 py-2 text-sm rounded-md bg-brand-600 text-white font-semibold'
                      : 'px-2 py-2 text-sm rounded-md text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700'
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
