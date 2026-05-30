import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Topbar({ onMenu }) {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const nav = useNavigate();

  return (
    <header className="h-16 bg-white border-b border-slate-200 px-4 md:px-6 flex items-center justify-between sticky top-0 z-30">
      <div className="flex items-center gap-3">
        <button onClick={onMenu} className="md:hidden p-2 rounded hover:bg-slate-100">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
        </button>
        <div>
          <div className="text-xs text-slate-500">Welcome back,</div>
          <div className="text-sm font-semibold text-slate-900">{user?.name}</div>
        </div>
      </div>
      <div className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100"
        >
          <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 grid place-items-center text-sm font-bold">
            {user?.name?.[0]?.toUpperCase()}
          </div>
          <div className="hidden md:block text-left">
            <div className="text-sm text-slate-700">{user?.name}</div>
            <div className="text-[11px] text-slate-500">{user?.email}</div>
          </div>
        </button>
        {menuOpen && (
          <div className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-lg py-1">
            <button
              onClick={() => { setMenuOpen(false); nav('/change-password'); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
            >
              Change password
            </button>
            <button
              onClick={() => { logout(); nav('/login'); }}
              className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
