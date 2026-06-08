import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * SearchableSelect
 *
 * Drop-in replacement for <select> + <option> with:
 *   - Case-insensitive substring search across one or many fields.
 *   - Keyboard nav: ArrowUp / ArrowDown / Enter / Escape / Tab.
 *   - Same controlled-component API as a native select: value + onChange(value).
 *   - Optional API-backed search via onSearch (parent owns options + fetch).
 *   - Optional clear button.
 *
 * Usage (simple {label, value} shape):
 *   <SearchableSelect
 *     value={dept}
 *     onChange={setDept}
 *     options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]}
 *     placeholder="All departments"
 *   />
 *
 * Usage (arbitrary objects + custom accessors -- e.g. dealers):
 *   <SearchableSelect
 *     value={dealerId}
 *     onChange={setDealerId}
 *     options={dealers}
 *     getValue={(d) => d._id}
 *     getLabel={(d) => `${d.firmName} (${d.place})`}
 *     getSearchText={(d) => `${d.firmName} ${d.place} ${d.dealerName}`}
 *     placeholder="Select dealer…"
 *   />
 *
 * API-backed mode (for very large datasets):
 *   <SearchableSelect
 *     value={empId}
 *     onChange={setEmpId}
 *     onSearch={(q) => api.get('/employees', { params: { q } }).then((r) => r.data)}
 *     getLabel={(e) => `${e.name} (${e.employeeId})`}
 *     getSearchText={() => ''}  // server already filtered
 *     maxVisible={50}
 *   />
 */
const norm = (s) => String(s ?? '').toLowerCase();

const _defaultGetValue = (o) => (o && typeof o === 'object' ? (o.value ?? o._id ?? o.id) : o);
const _defaultGetLabel = (o) => {
  if (o == null) return '';
  if (typeof o === 'object') return o.label ?? o.name ?? o.title ?? String(o.value ?? o._id ?? '');
  return String(o);
};
const _defaultGetSearchText = (o) => _defaultGetLabel(o);

export default function SearchableSelect({
  value,
  onChange,
  options = [],
  getValue = _defaultGetValue,
  getLabel = _defaultGetLabel,
  getSearchText = _defaultGetSearchText,
  // Pretty-print for option rows -- defaults to getLabel.  Useful when
  // the "displayed when selected" label differs from the "option row"
  // label (e.g. a small secondary line in dropdown).
  renderOption,
  placeholder = 'Select…',
  emptyText = 'No matches',
  disabled = false,
  allowClear = true,
  className = 'input',
  // Cap the option list to keep the DOM cheap on very large datasets.
  // The dropdown shows "Refine search to see more" when truncated.
  maxVisible = 200,
  // Optional API-backed search.  When defined, the component debounces
  // input and calls onSearch(query); parent owns the options array.
  onSearch,
  searchDebounceMs = 250,
  // Optional id/name passthrough for form labels.
  id,
  name,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Resolve the option currently representing `value` (so the input
  // shows the right label when collapsed).
  const selected = useMemo(() => {
    if (value === '' || value == null) return null;
    return options.find((o) => String(getValue(o)) === String(value)) || null;
  }, [value, options, getValue]);
  const selectedLabel = selected ? getLabel(selected) : '';

  // Client-side filter when no onSearch hook -- case-insensitive
  // substring across getSearchText().
  const filtered = useMemo(() => {
    if (onSearch) return options; // parent already filtered
    const q = norm(query.trim());
    if (!q) return options;
    return options.filter((o) => norm(getSearchText(o)).includes(q));
  }, [options, query, onSearch, getSearchText]);
  const visible = filtered.slice(0, maxVisible);
  const truncated = filtered.length > visible.length;

  // Debounced API search when in API-backed mode.
  useEffect(() => {
    if (!onSearch) return undefined;
    const id = setTimeout(() => { onSearch(query); }, searchDebounceMs);
    return () => clearTimeout(id);
  }, [query, onSearch, searchDebounceMs]);

  // Click-outside closes.
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Reset active row when filter shifts.
  useEffect(() => { setActiveIdx(0); }, [query, options.length]);

  // Keep the active row in view as the user arrow-keys through.
  useEffect(() => {
    const el = listRef.current?.children?.[activeIdx];
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIdx]);

  const openPanel = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    setQuery(''); // start fresh each time the panel opens
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [disabled]);

  const closePanel = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const pick = useCallback((o) => {
    onChange?.(o == null ? '' : getValue(o));
    closePanel();
  }, [onChange, getValue, closePanel]);

  const onKeyDown = useCallback((e) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, visible.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = visible[activeIdx];
      if (opt) pick(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
    } else if (e.key === 'Tab') {
      // Don't trap focus -- just close.
      closePanel();
    } else if (e.key === 'Backspace' && query === '' && allowClear && value) {
      // Empty input + backspace clears the selection (common autocomplete UX).
      onChange?.('');
    }
  }, [open, openPanel, visible, activeIdx, pick, closePanel, query, allowClear, value, onChange]);

  return (
    <div
      ref={rootRef}
      className={`ss-root relative ${disabled ? 'opacity-60 pointer-events-none' : ''}`}
    >
      {/* Collapsed display = a button styled like the existing .input
          control so callers don't have to restyle.  Click opens the
          panel; the visible "input" inside the panel handles search. */}
      <button
        type="button"
        id={id}
        name={name}
        className={`${className} text-left flex items-center justify-between gap-2 cursor-pointer w-full`}
        onClick={() => (open ? closePanel() : openPanel())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`truncate ${selectedLabel ? 'text-slate-800' : 'text-slate-400'}`}>
          {selectedLabel || placeholder}
        </span>
        <span className="flex items-center gap-1 text-slate-400 text-xs">
          {allowClear && value !== '' && value != null && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              className="px-1 hover:text-red-600"
              title="Clear"
              onClick={(e) => { e.stopPropagation(); onChange?.(''); }}
            >×</span>
          )}
          <span aria-hidden>▾</span>
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 left-0 right-0 rounded-lg border border-slate-200 bg-white shadow-lg overflow-hidden">
          <div className="p-2 border-b border-slate-100">
            <input
              ref={inputRef}
              className="w-full px-2 py-1.5 rounded border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-200"
              placeholder="Type to search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              aria-autocomplete="list"
            />
          </div>
          <ul
            ref={listRef}
            className="max-h-64 overflow-y-auto py-1 text-sm"
            role="listbox"
          >
            {visible.length === 0 ? (
              <li className="px-3 py-2 text-slate-400 italic">{emptyText}</li>
            ) : (
              visible.map((o, i) => {
                const v = getValue(o);
                const isSelected = String(v) === String(value);
                const isActive = i === activeIdx;
                return (
                  <li
                    key={String(v) + ':' + i}
                    role="option"
                    aria-selected={isSelected}
                    className={[
                      'px-3 py-1.5 cursor-pointer',
                      isActive ? 'bg-brand-50' : '',
                      isSelected ? 'font-semibold text-brand-700' : 'text-slate-800',
                    ].filter(Boolean).join(' ')}
                    onMouseEnter={() => setActiveIdx(i)}
                    onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                  >
                    {renderOption ? renderOption(o) : getLabel(o)}
                  </li>
                );
              })
            )}
            {truncated && (
              <li className="px-3 py-1 text-[11px] text-slate-400 italic border-t border-slate-100">
                Showing first {visible.length} of {filtered.length} — refine search to see more.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
