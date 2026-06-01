import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';

/**
 * Sun / moon icon button.  Available to every role because it lives in
 * the Topbar (which Layout renders for employees, HR, HOD and SA alike).
 */
function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="p-2 rounded-lg hover:bg-slate-100 text-slate-600
                 dark:hover:bg-slate-800 dark:text-slate-300 transition"
    >
      {isDark ? (
        // sun
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        // moon
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

export default function Topbar({ onMenu }) {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const nav = useNavigate();

  return (
    <header className="h-16 bg-white border-b border-slate-200 px-4 md:px-6 flex items-center justify-between sticky top-0 z-30
                       dark:bg-slate-900 dark:border-slate-800">
      <div className="flex items-center gap-3">
        <button onClick={onMenu} className="md:hidden p-2 rounded hover:bg-slate-100 dark:hover:bg-slate-800 dark:text-slate-300">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
        </button>
        <div>
          <div className="text-xs text-slate-500 dark:text-slate-400">Welcome back,</div>
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{user?.name}</div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <ThemeToggle />
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 grid place-items-center text-sm font-bold
                            dark:bg-brand-500/20 dark:text-brand-300">
              {user?.name?.[0]?.toUpperCase()}
            </div>
            <div className="hidden md:block text-left">
              <div className="text-sm text-slate-700 dark:text-slate-200">{user?.name}</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">{user?.email}</div>
            </div>
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-lg py-1
                            dark:bg-slate-900 dark:border-slate-800">
              <button
                onClick={() => { setMenuOpen(false); nav('/change-password'); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 text-slate-700
                           dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Change password
              </button>
              <button
                onClick={() => { logout(); nav('/login'); }}
                className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50
                           dark:hover:bg-red-500/15"
              >
                Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
