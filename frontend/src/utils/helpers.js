export const fmtDate = (d) => {
  if (!d) return '-';
  const dt = new Date(d);
  return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
};

export const fmtMoney = (n) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n || 0);

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
 * anchor links (PDF salary slips, CSV exports) authenticate correctly.
 */
export const authUrl = (path) => {
  const token = localStorage.getItem('hrms_token') || '';
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(token)}`;
};
