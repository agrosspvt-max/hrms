/**
 * Preset tag categories + default colours.  Frontend-only constant --
 * HR can override the colour per tag, so this table is just the
 * starting palette.  Every category value here is also a valid enum
 * on backend/models/InteractionTag.js.
 */
export const TAG_CATEGORIES = [
  { value: 'performance',  label: 'Performance',  color: '#0ea5e9' },
  { value: 'warning',      label: 'Warning',      color: '#ef4444' },
  { value: 'discipline',   label: 'Discipline',   color: '#dc2626' },
  { value: 'appreciation', label: 'Appreciation', color: '#22c55e' },
  { value: 'attendance',   label: 'Attendance',   color: '#f97316' },
  { value: 'development',  label: 'Development',  color: '#8b5cf6' },
  { value: 'hr',           label: 'HR',           color: '#6366f1' },
  { value: 'information',  label: 'Information',  color: '#0891b2' },
  { value: 'reminder',     label: 'Reminder',     color: '#f59e0b' },
  { value: 'complaint',    label: 'Complaint',    color: '#f97316' },
  { value: 'customer',     label: 'Customer',     color: '#06b6d4' },
  { value: 'finance',      label: 'Finance',      color: '#eab308' },
  { value: 'management',   label: 'Management',   color: '#4f46e5' },
  { value: 'training',     label: 'Training',     color: '#a855f7' },
  { value: 'custom',       label: 'Custom',       color: '#64748b' },
];

export const CATEGORY_COLOR = Object.fromEntries(TAG_CATEGORIES.map((c) => [c.value, c.color]));

export const MEETING_TYPES = [
  'Weekly Meeting',
  'Monthly Review',
  'Performance Review',
  'Sales Review',
  'Training Session',
  'Warning Discussion',
  'One-on-One',
  'Department Meeting',
  'Management Meeting',
  'Client Meeting',
  'Other',
];
