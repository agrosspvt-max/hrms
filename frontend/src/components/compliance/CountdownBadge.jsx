/**
 * CountdownBadge -- shows "X hours until enforced" for a candidate
 * incident whose effectiveDate is in the future.
 */
import { useEffect, useState } from 'react';

const _fmt = (ms) => {
  if (ms <= 0) return 'now';
  const hours = Math.floor(ms / 3600000);
  if (hours >= 48) return `${Math.round(hours / 24)}d`;
  const minutes = Math.floor((ms % 3600000) / 60000);
  return hours >= 1 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

export default function CountdownBadge({ effectiveDate }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const target = new Date(effectiveDate).getTime();
  const delta = target - now;
  const past = delta <= 0;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${past ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
      {past ? 'due now' : `in ${_fmt(delta)}`}
    </span>
  );
}
