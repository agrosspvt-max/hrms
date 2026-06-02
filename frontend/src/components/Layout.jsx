import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export default function Layout() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950">
      <Sidebar open={open} onClose={() => setOpen(false)} />
      {/*
        The desktop sidebar is position:fixed (see Sidebar.jsx) so it
        no longer participates in the flex flow.  Reserve its 16rem
        (w-64) of horizontal space here with md:ml-64 so page content
        sits to its right and the Topbar / footer don't slide underneath.
      */}
      <div className="flex-1 flex flex-col min-w-0 md:ml-64">
        <Topbar onMenu={() => setOpen(true)} />
        <main className="flex-1 p-4 md:p-6 max-w-[1600px] w-full mx-auto">
          <Outlet />
        </main>
        <footer className="border-t border-slate-200 bg-white/60 px-4 md:px-6 py-2 text-[11px] text-slate-400 flex items-center justify-between
                          dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-500">
          <span>HRMS v1.0</span>
          {user?.role && <span className="uppercase tracking-wide">{user.role}</span>}
        </footer>
      </div>
    </div>
  );
}
