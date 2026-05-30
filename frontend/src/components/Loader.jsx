export const Loader = ({ label = 'Loading...' }) => (
  <div className="flex items-center justify-center py-10 text-slate-500 text-sm gap-2">
    <span className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
    {label}
  </div>
);

export const EmptyState = ({ title = 'Nothing here yet', subtitle, action }) => (
  <div className="text-center py-12 text-slate-500">
    <div className="text-4xl mb-2">∅</div>
    <div className="text-sm font-medium text-slate-700">{title}</div>
    {subtitle && <div className="text-xs mt-1">{subtitle}</div>}
    {action && <div className="mt-3">{action}</div>}
  </div>
);

export default Loader;
