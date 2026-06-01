import { createContext, useContext, useEffect, useState } from 'react';

/**
 * Global theme provider.  Persists the choice to localStorage so the
 * theme survives reloads, falls back to the user's OS preference on the
 * very first visit, and toggles the `dark` class on <html> so every
 * Tailwind `dark:` variant in the codebase reacts.
 *
 * Available everywhere (employees, HR, HOD, super admin) via <Topbar/>.
 */

const STORAGE_KEY = 'hrms_theme';
const ThemeContext = createContext({ theme: 'light', toggleTheme: () => {} });

const readInitialTheme = () => {
  if (typeof window === 'undefined') return 'light';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch (_) { /* ignore */ }
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
};

const applyThemeClass = (theme) => {
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
};

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(readInitialTheme);

  useEffect(() => { applyThemeClass(theme); }, [theme]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (_) { /* ignore */ }
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  const setLight = () => setTheme('light');
  const setDark = () => setTheme('dark');

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setLight, setDark }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
