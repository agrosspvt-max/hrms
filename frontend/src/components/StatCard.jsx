import { Link } from 'react-router-dom';

/**
 * StatCard
 *
 * Tile shown on dashboards.  Pass `to="/route"` to make the whole card
 * a clickable Link with a subtle hover state and a chevron in the
 * bottom corner so it's discoverable.
 */
export default function StatCard({ label, value, sub, accent = 'brand', to }) {
  const accents = {
    brand: 'bg-brand-50 text-brand-700',
    green: 'bg-green-50 text-green-700',
    red: 'bg-red-50 text-red-700',
    amber: 'bg-amber-50 text-amber-700',
    blue: 'bg-blue-50 text-blue-700',
  };

  const inner = (
    <div className="card-body">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
          <div className="text-2xl font-bold text-slate-900 mt-1">{value}</div>
          {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
        </div>
        <div className={`w-9 h-9 rounded-lg grid place-items-center ${accents[accent]}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3v18h18M7 14l4-4 4 4 6-6" />
          </svg>
        </div>
      </div>
      {to && (
        <div className="mt-3 flex items-center text-[11px] text-slate-400 group-hover:text-brand-600 transition">
          View
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-1 transition-transform group-hover:translate-x-0.5">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      )}
    </div>
  );

  if (to) {
    return (
      <Link
        to={to}
        className="card group block transition hover:border-brand-200 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1"
      >
        {inner}
      </Link>
    );
  }

  return <div className="card">{inner}</div>;
}
