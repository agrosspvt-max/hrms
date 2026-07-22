import { useState } from 'react';

/**
 * DateRangeFilter -- shared preset + custom-range picker.
 *
 * Emits an { from, to, preset } object where from/to are ISO strings
 * (UTC-midnight boundaries for full days) OR nulls when preset is
 * 'all'.  Presets are computed in the browser's LOCAL timezone so
 * "This Month" matches the user's calendar, then converted to ISO
 * for the backend which normalises to startOfDay(UTC) internally.
 *
 * Consumers pass the value + onChange:
 *   <DateRangeFilter value={range} onChange={setRange} />
 */

const _toISO = (d) => (d ? new Date(d).toISOString() : null);
const _startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const _endOfDay   = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

export const DATE_PRESETS = [
  { key: 'all',        label: 'All time' },
  { key: 'today',      label: 'Today' },
  { key: 'last7',      label: 'Last 7 days' },
  { key: 'last30',     label: 'Last 30 days' },
  { key: 'thisMonth',  label: 'This month' },
  { key: 'prevMonth',  label: 'Previous month' },
  { key: 'custom',     label: 'Custom range…' },
];

export function rangeFromPreset(preset, custom = {}) {
  const now = new Date();
  if (preset === 'all') return { preset, from: null, to: null };
  if (preset === 'today') {
    return { preset, from: _toISO(_startOfDay(now)), to: _toISO(_endOfDay(now)) };
  }
  if (preset === 'last7') {
    const f = _startOfDay(now); f.setDate(f.getDate() - 6);
    return { preset, from: _toISO(f), to: _toISO(_endOfDay(now)) };
  }
  if (preset === 'last30') {
    const f = _startOfDay(now); f.setDate(f.getDate() - 29);
    return { preset, from: _toISO(f), to: _toISO(_endOfDay(now)) };
  }
  if (preset === 'thisMonth') {
    const f = new Date(now.getFullYear(), now.getMonth(), 1);
    const t = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { preset, from: _toISO(f), to: _toISO(t) };
  }
  if (preset === 'prevMonth') {
    const f = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const t = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { preset, from: _toISO(f), to: _toISO(t) };
  }
  if (preset === 'custom') {
    const from = custom.from ? _toISO(_startOfDay(new Date(custom.from))) : null;
    const to   = custom.to   ? _toISO(_endOfDay(new Date(custom.to)))    : null;
    return { preset, from, to };
  }
  return { preset: 'all', from: null, to: null };
}

export default function DateRangeFilter({ value, onChange }) {
  const preset = (value && value.preset) || 'all';
  const [customFrom, setCustomFrom] = useState(
    value && value.preset === 'custom' && value.from ? value.from.slice(0, 10) : ''
  );
  const [customTo, setCustomTo] = useState(
    value && value.preset === 'custom' && value.to ? value.to.slice(0, 10) : ''
  );

  const pick = (nextPreset) => {
    if (nextPreset === 'custom') {
      onChange(rangeFromPreset('custom', { from: customFrom, to: customTo }));
    } else {
      onChange(rangeFromPreset(nextPreset));
    }
  };
  const applyCustom = () => {
    onChange(rangeFromPreset('custom', { from: customFrom, to: customTo }));
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={preset}
        onChange={(e) => pick(e.target.value)}
        className="border rounded-md text-sm px-2 py-1.5"
        title="Date range"
      >
        {DATE_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>{p.label}</option>
        ))}
      </select>
      {preset === 'custom' && (
        <>
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="border rounded-md text-sm px-2 py-1.5"
          />
          <span className="text-slate-400 text-xs">to</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="border rounded-md text-sm px-2 py-1.5"
          />
          <button className="btn-secondary !py-1 !text-xs" onClick={applyCustom}>Apply</button>
        </>
      )}
    </div>
  );
}
