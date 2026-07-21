import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import useComplianceConfig, { isFeatureEnabled } from '../hooks/useComplianceConfig.js';
import api from '../api/axios';

const Icon = ({ d, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

// Icon paths
const I = {
  dash: 'M3 12l9-9 9 9M5 10v10h14V10',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  tasks: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  leave: 'M8 7V3M16 7V3M3 11h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  people: 'M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  chart: 'M3 3v18h18M7 14l4-4 4 4 6-6',
  attendance: 'M9 12l2 2 4-4M8 7V3M16 7V3M3 11h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  clock: 'M12 8v4l3 2M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z',
  grid: 'M3 7h18M3 12h18M3 17h18',
  star: 'M12 2l3 7h7l-5.5 4.5L18 21l-6-4.5L6 21l1.5-7.5L2 9h7z',
  doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
  review: 'M9 12l2 2 4-4M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z',
  tools: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.1-.6-.6-2.1z',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  reset: 'M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  money: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  admin: 'M12 4a4 4 0 100 8 4 4 0 000-8zM4 21v-2a6 6 0 0112 0v2M18 8v3m1.5-1.5h-3',
  audit: 'M12 8v4l3 2M12 2a10 10 0 100 20 10 10 0 000-20z',
  bell: 'M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0a3 3 0 11-6 0',
  chevron: 'M9 18l6-6-6-6',
};

/* =====================================================================
 * Phase 43 — Feature Permissions map for the sidebar
 *
 * Per-employee `featurePermissions[<moduleKey>].enabled === true` adds
 * the corresponding nav item to the employee's sidebar.  HR / Super
 * Admin / HOD sidebars are unchanged.  Employees without any
 * configured permissions keep their default sidebar.
 *
 * Module-key → nav-item lookup.  Keep the labels + icons aligned with
 * the HR / Super Admin defaults below so the UX feels native.
 * ===================================================================== */
const GRANTED_MODULES = [
  { key: 'attendance',        to: '/attendance',        label: 'Attendance',        icon: I.attendance },
  { key: 'leaveApprovals',    to: '/leaves',            label: 'Leave Approvals',   icon: I.leave },
  { key: 'submissionReviews', to: '/reviews',           label: 'Submission Reviews', icon: I.review },
  { key: 'globalPendency',    to: '/backlog',           label: 'Global Pendency',   icon: I.clock },
  { key: 'departments',       to: '/organization',     label: 'Departments',       icon: I.grid },
  { key: 'products',          to: '/products',          label: 'Products & Dealers', icon: I.tools },
  { key: 'assignments',       to: '/assignments',       label: 'Assignments',       icon: I.tasks },
  { key: 'submissionControl', to: '/submission-control', label: 'Submission Control', icon: I.review },
  { key: 'templateAnalytics', to: '/template-analytics', label: 'Template Analytics', icon: I.chart },
  { key: 'salary',            to: '/salary',            label: 'Salary',            icon: I.money },
  { key: 'contacts',          to: '/contacts',          label: 'Contacts',          icon: I.people },
  { key: 'eventsHolidays',    to: '/events',            label: 'Events & Holidays', icon: I.calendar },
  // Phase 74 -- Employee Interactions (HR case-management + searchable history).
  { key: 'employeeInteractions', to: '/interactions',    label: 'Employee Interactions', icon: I.review },
  { key: 'auditLog',          to: '/audit',             label: 'Audit Log',         icon: I.audit },
  { key: 'sendAlerts',        to: '/sent-alerts',       label: 'Send Alerts',       icon: I.send },
  { key: 'performance',       to: '/performance',       label: 'Performance',       icon: I.chart },
  // Phase 61 -- Fines & Penalties module.  HR can grant HODs access
  // via FeaturePermissions[penalties].enabled.
  { key: 'penalties',          to: '/penalties',          label: 'Fines & Penalties', icon: I.money },
];

/** Build the role-aware grouped navigation tree. */
function buildNav(user) {
  const role = user?.role;
  if (role === 'employee') {
    const team = user?.isHOD ? [{
      type: 'group', id: 'team', label: 'Team', icon: I.people, items: [
        { to: '/team', label: 'Manage Team', icon: I.people },
        { to: '/team-reviews', label: 'Team Reviews', icon: I.review, badgeKey: 'hodReviews' },
        // HOD Performance dashboard: department-scoped automatically on
        // the backend.  Visible only to HODs (regular employees never
        // see this).  HR / Super Admin keep the existing HR-section
        // Performance entry below.
        { to: '/performance', label: 'Performance', icon: I.chart },
      ],
    }] : [];

    // Phase 43: HR-granted modules.  When the employee has any module
    // toggled on via featurePermissions, surface those items in a new
    // "Granted Access" group above My Work.  Default employee
    // experience is preserved when no permissions are configured.
    const perms = (user?.featurePermissions && typeof user.featurePermissions === 'object')
      ? user.featurePermissions : {};
    const grantedItems = GRANTED_MODULES.filter((m) => perms[m.key]?.enabled);
    const grantedGroup = grantedItems.length > 0 ? [{
      type: 'group', id: 'granted', label: 'Granted Access', icon: I.admin,
      items: grantedItems.map((m) => ({ to: m.to, label: m.label, icon: m.icon })),
    }] : [];

    return [
      { type: 'link', to: '/', label: 'My Dashboard', icon: I.dash },
      ...team,
      ...grantedGroup,
      {
        type: 'group', id: 'mywork', label: 'My Work', icon: I.inbox, items: [
          { to: '/notifications', label: 'Notifications', icon: I.bell, badgeKey: 'notifications' },
          { to: '/my-attendance', label: 'My Attendance', icon: I.attendance },
          { to: '/my-leaves', label: 'My Leaves', icon: I.leave },
          { to: '/my-salary', label: 'My Salary Slips', icon: I.doc },
          // Phase 74 -- employees see meetings they're invited to +
          // interactions explicitly marked Employee Visible.
          { to: '/my-interactions', label: 'My Interactions', icon: I.review },
          // Compliance v2 -- surfaced only when the backend flag
          // `compliance.employeeCardV2` is on.  The link is filtered
          // out at render time via useComplianceConfig; when the flag
          // is off the item disappears from the sidebar entirely.
          { to: '/my-compliance', label: 'My Compliance', icon: I.doc, complianceGated: true },
          { to: '/contacts', label: 'Contacts', icon: I.people },
        ],
      },
    ];
  }

  // HR + Super Admin
  const isSA = role === 'super_admin';
  return [
    { type: 'link', to: '/', label: 'Dashboard', icon: I.dash },
    {
      type: 'group', id: 'mywork', label: 'My Work', icon: I.inbox, items: [
        { to: '/my-tasks', label: 'My Tasks', icon: I.tasks, badgeKey: 'myTasks' },
        ...(!isSA ? [{ to: '/my-leaves', label: 'My Leaves', icon: I.leave }] : []),
      ],
    },
    {
      type: 'group', id: 'employees', label: 'Employees', icon: I.people, items: [
        { to: '/employees', label: 'Employees', icon: I.people },
        { to: '/performance', label: 'Performance', icon: I.chart },
        { to: '/attendance', label: 'Attendance', icon: I.attendance },
        { to: '/backlog', label: 'Global Pendency', icon: I.clock },
        { to: '/organization', label: 'Departments', icon: I.grid },
        { to: '/products', label: 'Products & Dealers', icon: I.tools },
        { to: '/assignments', label: 'Assignments', icon: I.tasks },
        { to: '/submission-control', label: 'Submission Control', icon: I.review },
        { to: '/template-analytics', label: 'Template Analytics', icon: I.chart },
        { to: '/leaves', label: 'Leave Approvals', icon: I.leave },
      ],
    },
    { type: 'link', to: '/reviews', label: 'Submission Reviews', icon: I.review },
    {
      type: 'group', id: 'utilities', label: 'Utilities', icon: I.tools, items: [
        { to: '/sent-alerts', label: 'Send Alerts', icon: I.send },
        { to: '/reset-requests', label: 'Reset Requests', icon: I.reset, badgeKey: 'resetRequests' },
        { to: '/events', label: 'Events & Holidays', icon: I.calendar },
        // Employee Interactions redesign: single workspace entry.
        // Meetings, Notes, and Manage Tags now live inside as tabs.
        { to: '/interactions', label: 'Employee Interactions', icon: I.review },
        { to: '/contacts', label: 'Contacts', icon: I.people },
        { to: '/salary', label: 'Salary', icon: I.money },
        // Phase 61 -- Fines & Penalties module.
        { to: '/penalties', label: 'Fines & Penalties', icon: I.money },
        // Compliance & Accountability v2 workspace.  Rendered ONLY
        // when the backend flag `compliance.dashboardV2` is on so a
        // half-rolled-out deployment doesn't surface a dead link.
        // Legacy /penalties stays alongside during the dual-run
        // window; ops flip `compliance.legacyGone` later to retire
        // it (out of scope for this rollout).
        { to: '/hr/compliance', label: 'Compliance', icon: I.audit, complianceGated: 'dashboardV2' },
        ...(isSA ? [
          { to: '/manage-access', label: 'Manage Access', icon: I.admin },
          { to: '/audit', label: 'Audit Log', icon: I.audit },
        ] : []),
      ],
    },
  ];
}

const pathMatches = (to, pathname) => pathname === to || (to !== '/' && pathname.startsWith(to + '/'));

export default function Sidebar({ open, onClose }) {
  const { user } = useAuth();
  const location = useLocation();
  // Compliance v2 -- gate compliance-related nav items on the
  // backend feature snapshot.  Items opt in via `complianceGated`:
  //   complianceGated: true                -> gated on 'employeeCardV2' (legacy default)
  //   complianceGated: 'employeeCardV2'    -> explicit
  //   complianceGated: 'dashboardV2'       -> HR compliance workspace
  //   complianceGated: 'waiverRecovery'    -> incidents / timeline / ledgers
  //   complianceGated: 'rules'             -> rules editor
  // Uses the same cached snapshot the dashboard reads.
  const complianceCfg = useComplianceConfig();
  const rawNav = buildNav(user);
  const _flagFor = (gated) => (gated === true ? 'employeeCardV2' : String(gated));
  const _passesComplianceGate = (item) => {
    if (!item.complianceGated) return true;
    return isFeatureEnabled(complianceCfg, _flagFor(item.complianceGated));
  };
  const nav = rawNav.map((entry) => {
    if (entry.type !== 'group' || !Array.isArray(entry.items)) return entry;
    return {
      ...entry,
      items: entry.items.filter(_passesComplianceGate),
    };
  });

  // ---- badge counts ----
  const [counts, setCounts] = useState({ notifications: 0, resetRequests: 0, hodReviews: 0, myTasks: 0 });
  const setCount = (k, v) => setCounts((c) => ({ ...c, [k]: v }));

  useEffect(() => {
    let alive = true;
    const isHOD = user?.role === 'employee' && user?.isHOD;
    const isEmp = user?.role === 'employee';
    const isHRSA = user?.role === 'hr' || user?.role === 'super_admin';
    const run = async () => {
      try {
        if (isHOD) { const { data } = await api.get('/submissions/hod/reviews', { params: { status: 'under_hod' } }); if (alive) setCount('hodReviews', Array.isArray(data) ? data.length : 0); }
        if (isEmp) { const { data } = await api.get('/notifications/unread-count'); if (alive) setCount('notifications', data.count || 0); }
        if (isHRSA) {
          const { data } = await api.get('/password-reset/pending-count').catch(() => ({ data: {} }));
          if (alive) setCount('resetRequests', data.count || 0);
          const md = await api.get('/dependencies/mine/count').then((r) => r.data).catch(() => ({}));
          if (alive) setCount('myTasks', md.count || 0);
        }
      } catch { /* silent */ }
    };
    run();
    const handler = () => run();
    window.addEventListener('hrms:notifications-changed', handler);
    window.addEventListener('hrms:reset-requests-changed', handler);
    // Phase 47 -- realtime nudge so the sidebar badges (unread inbox,
    // HOD review queue, etc.) refresh the instant the backend pushes.
    window.addEventListener('hrms:rt:notification:new', handler);
    window.addEventListener('hrms:rt:notification:read', handler);
    window.addEventListener('hrms:rt:notification:resolved', handler);
    window.addEventListener('hrms:rt:submission:submitted', handler);
    return () => {
      alive = false;
      window.removeEventListener('hrms:notifications-changed', handler);
      window.removeEventListener('hrms:reset-requests-changed', handler);
      window.removeEventListener('hrms:rt:notification:new', handler);
      window.removeEventListener('hrms:rt:notification:read', handler);
      window.removeEventListener('hrms:rt:notification:resolved', handler);
      window.removeEventListener('hrms:rt:submission:submitted', handler);
    };
  }, [user, location.pathname]);

  // ---- collapsible group open state (persisted) ----
  const groupIds = nav.filter((n) => n.type === 'group').map((n) => n.id);
  const [openGroups, setOpenGroups] = useState(() => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('hrms_nav_groups') || '{}'); } catch { /* ignore */ }
    const init = {};
    groupIds.forEach((id) => { init[id] = id in saved ? saved[id] : true; });
    return init;
  });
  // Auto-expand the group that contains the active route.
  useEffect(() => {
    const activeGroup = nav.find((n) => n.type === 'group' && n.items.some((it) => pathMatches(it.to, location.pathname)));
    if (activeGroup && !openGroups[activeGroup.id]) {
      setOpenGroups((g) => ({ ...g, [activeGroup.id]: true }));
    }
    // eslint-disable-next-line
  }, [location.pathname]);
  const toggleGroup = (id) => setOpenGroups((g) => {
    const next = { ...g, [id]: !g[id] };
    try { localStorage.setItem('hrms_nav_groups', JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  const badgeFor = (key) => (key ? counts[key] || 0 : 0);

  const LinkItem = ({ item, nested }) => {
    const count = badgeFor(item.badgeKey);
    return (
      <NavLink
        to={item.to}
        end={item.to === '/'}
        onClick={onClose}
        className={({ isActive }) =>
          `flex items-center gap-3 ${nested ? 'pl-9 pr-3' : 'px-3'} py-2 rounded-lg text-sm transition ${
            isActive
              ? 'bg-brand-50 text-brand-700 font-medium dark:bg-brand-500/15 dark:text-brand-300'
              : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
          }`
        }
      >
        <Icon d={item.icon} size={nested ? 16 : 18} />
        <span className="flex-1">{item.label}</span>
        {count > 0 && (
          <span className="bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] grid place-items-center px-1">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </NavLink>
    );
  };

  return (
    <>
      <div className={`fixed inset-0 bg-black/30 z-40 md:hidden ${open ? '' : 'hidden'}`} onClick={onClose} />
      {/*
        Position policy:
          - Mobile: position:fixed + translate-x slide drawer (unchanged).
          - Desktop: stays position:fixed (NOT md:static) so it pins to
            the viewport and never scrolls with page content.  The right
            column reserves md:ml-64 so it doesn't slide under us.
          - md:h-screen guarantees a 100vh container; nav items still get
            overflow-y-auto for the rare case nav overflows the viewport.
      */}
      <aside
        className={`fixed top-0 left-0 h-full md:h-screen w-64 bg-white border-r border-slate-200 z-50 overflow-y-auto
          dark:bg-slate-900 dark:border-slate-800
          transform transition-transform md:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="h-16 flex items-center px-5 border-b border-slate-100 sticky top-0 bg-white z-10
                        dark:bg-slate-900 dark:border-slate-800">
          <div className="w-8 h-8 rounded-lg bg-brand-600 text-white grid place-items-center font-bold">H</div>
          <div className="ml-2">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">HRMS</div>
            <div className="text-[10px] text-slate-500 dark:text-slate-400 -mt-0.5">Workflow &amp; Salary</div>
          </div>
        </div>

        <nav className="px-3 py-4 space-y-1">
          {nav.map((entry) => {
            if (entry.type === 'link') return <LinkItem key={entry.to} item={entry} />;
            // group
            const isOpen = !!openGroups[entry.id];
            const groupActive = entry.items.some((it) => pathMatches(it.to, location.pathname));
            const groupBadge = entry.items.reduce((sum, it) => sum + badgeFor(it.badgeKey), 0);
            return (
              <div key={entry.id} className="pt-1">
                <button
                  onClick={() => toggleGroup(entry.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
                    groupActive
                      ? 'text-brand-700 font-semibold dark:text-brand-300'
                      : 'text-slate-500 hover:bg-slate-50 font-medium dark:text-slate-400 dark:hover:bg-slate-800'
                  }`}
                >
                  <Icon d={entry.icon} />
                  <span className="flex-1 text-left uppercase tracking-wide text-[11px]">{entry.label}</span>
                  {!isOpen && groupBadge > 0 && (
                    <span className="bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] grid place-items-center px-1">
                      {groupBadge > 99 ? '99+' : groupBadge}
                    </span>
                  )}
                  <span className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}><Icon d={I.chevron} size={14} /></span>
                </button>
                <div className={`overflow-hidden transition-all duration-200 ${isOpen ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0'}`}>
                  <div className="mt-1 space-y-0.5">
                    {entry.items.map((it) => <LinkItem key={it.to} item={it} nested />)}
                  </div>
                </div>
              </div>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
