import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export default function Layout() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar open={open} onClose={() => setOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onMenu={() => setOpen(true)} />
        <main className="flex-1 p-4 md:p-6 max-w-[1600px] w-full mx-auto">
          <Outlet />
        </main>
        <footer className="border-t border-slate-200 bg-white/60 px-4 md:px-6 py-2 text-[11px] text-slate-400 flex items-center justify-between">
          <span>HRMS v1.0</span>
          {user?.role && <span className="uppercase tracking-wide">{user.role}</span>}
        </footer>
      </div>
    </div>
  );
}
