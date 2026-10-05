// Disclosure form logic (pure functions, no React) -- mirrors the rules
// enforced server-side in backend/services/disclosure.js.  The server is
// the source of truth; this only gives early feedback and builds a
// payload that never carries fields from a previously selected type.

export const DISCLOSURE_TYPES = [
  { value: 'mistake', label: 'Mistake' },
  { value: 'exception', label: 'Exception' },
  { value: 'other', label: 'Other' },
];

export const typeLabel = (t) => DISCLOSURE_TYPES.find((x) => x.value === t)?.label || t || '—';

export const emptyDisclosure = () => ({
  type: '', details: '', correctable: null, corrected: null, authorizedBy: '',
});

/** Switching type clears every field that belonged to the old type. */
export const changeType = (state, type) => ({ ...emptyDisclosure(), type, details: state.details });

/** Switching Correctable clears Corrected (it only applies when Yes). */
export const changeCorrectable = (state, correctable) => ({ ...state, correctable, corrected: null });

export const validateDisclosure = (s) => {
  if (!s.type) return 'Select a disclosure type.';
  if (!String(s.details || '').trim()) return 'Details are required.';
  if (s.type === 'mistake') {
    if (typeof s.correctable !== 'boolean') return 'Please state whether the mistake is correctable.';
    if (s.correctable && typeof s.corrected !== 'boolean') return 'Please state whether you corrected the mistake.';
  }
  if (s.type === 'exception' && !String(s.authorizedBy || '').trim()) {
    return 'Please enter who authorized the exception.';
  }
  return '';
};

/** Only the fields that apply to the selected type. */
export const buildDisclosurePayload = (s, date) => {
  const base = { date, type: s.type, details: String(s.details || '').trim() };
  if (s.type === 'mistake') {
    return s.correctable ? { ...base, correctable: true, corrected: s.corrected } : { ...base, correctable: false };
  }
  if (s.type === 'exception') return { ...base, authorizedBy: String(s.authorizedBy || '').trim() };
  return base;
};
