export const fmtDate = (d) => {
  if (!d) return '-';
  const dt = new Date(d);
  return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
};

export const fmtMoney = (n) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n || 0);

/* ------------------------------------------------------------------
 * Phase 21 number formatters for analytics surfaces.
 *
 * The backend rounds via Math.round(x * 100) / 100, but JS floating-
 * point arithmetic still leaves ugly tails like 6944.039999999999.
 * These helpers force exactly 2 decimal places + Indian-locale
 * thousand separators for currency / percentages / ratios / averages
 * / KPIs.  Use fmtInt for fields that are conceptually whole numbers
 * (counts, submissions, products sold, farmers added).
 *
 * Purely presentational -- never re-route to a calculation, never
 * mutate state, safe to wrap any displayed value.
 * ---------------------------------------------------------------- */

/** ₹1,234.56 -- always 2 decimal places, Indian thousand separators. */
export const fmtCurrency = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return '₹0.00';
  return `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x)}`;
};

/** 53.45% -- always 2 decimal places. */
export const fmtPct = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0.00%';
  return `${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x)}%`;
};

/** 61.32 -- always 2 decimal places, with thousand separators.  For
 *  ratios / averages / KPIs / per-call metrics that aren't currency.  */
export const fmtAvg = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0.00';
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
};

/** 1,234 -- whole numbers only, with thousand separators.  For counts
 *  (calls completed, products sold, farmers added, submissions, etc.). */
export const fmtInt = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(x));
};

export const delayBadgeClass = (days) => {
  if (days === 0) return 'badge-gray';
  if (days === 1) return 'badge-amber';
  return 'badge-red';
};

export const delayLabel = (days) => {
  if (days === 0) return 'Today pending';
  if (days === 1) return '1 day pending';
  return `${days} days pending`;
};

export const errMsg = (err) =>
  err?.response?.data?.message || err?.message || 'Something went wrong';

export const monthKey = (date) => {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * Build a URL with the JWT appended as a query param, so file-download
 * anchor links (PDF salary slips, CSV exports, Excel templates) authenticate
 * correctly and -- critically -- point at the API host in production.
 *
 * In dev (VITE_API_URL unset) the link stays as `/api/...`, which the Vite
 * proxy forwards to the local backend.
 *
 * In production VITE_API_URL is the deployed backend URL ending in `/api`
 * (e.g. `https://hrms-jvxy.onrender.com/api`).  Without this prefix the
 * browser would navigate to the frontend host (Vercel), hit its SPA
 * fallback, and bounce back to the dashboard.  This helper strips the
 * leading `/api` from the path so the resulting URL is exactly the API
 * endpoint we want, no `/api/api/` duplication.
 */
export const authUrl = (path) => {
  const token = localStorage.getItem('hrms_token') || '';
  const base = import.meta.env.VITE_API_URL || '';
  // Strip a leading `/api` from the path ONLY when we have a configured
  // base (which already ends in `/api`).  In dev the relative `/api/...`
  // path is preserved as-is.
  const trimmedPath = base && path.startsWith('/api/') ? path.slice(4) : path;
  const sep = trimmedPath.includes('?') ? '&' : '?';
  return `${base}${trimmedPath}${sep}token=${encodeURIComponent(token)}`;
};
