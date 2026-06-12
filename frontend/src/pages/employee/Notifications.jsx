import { useEffect, useRef, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';

/**
 * Employee inbox - lists all notifications received from HR (or the system).
 * Unread items get a brand-accent stripe and a "New" badge; clicking the
 * "Mark read" button (or "Mark all read" at the top) clears them.
 */
export default function Notifications() {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('all'); // all | unread
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/notifications/mine', {
        params: filter === 'unread' ? { status: 'unread' } : {},
      });
      setItems(data);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  /**
   * Optimistic mark-as-read: flip the local state FIRST so the card
   * updates instantly + the unread count drops to N-1 without any
   * page refresh, fire the API in the background, and roll back if
   * it fails.  No `load()` -- no spinner, no scroll-jump, no flicker.
   * Dispatches `hrms:notifications-changed` so the sidebar badge
   * re-fetches its count, matching every other state-changing path.
   */
  const markRead = async (id) => {
    let prevItem;
    const stamp = new Date().toISOString();
    setItems((cur) => cur.map((n) => {
      if (n._id !== id) return n;
      prevItem = n;
      return { ...n, read: true, readAt: n.readAt || stamp };
    }));
    window.dispatchEvent(new Event('hrms:notifications-changed'));
    try {
      await api.patch(`/notifications/${id}/read`);
    } catch (err) {
      // Roll the local state back so the user sees an honest UI.
      setItems((cur) => cur.map((n) => (n._id === id && prevItem ? prevItem : n)));
      window.dispatchEvent(new Event('hrms:notifications-changed'));
      toast.error(errMsg(err));
    }
  };

  const markAllRead = async () => {
    const prevItems = items;
    const stamp = new Date().toISOString();
    setItems((cur) => cur.map((n) => (n.read ? n : { ...n, read: true, readAt: stamp })));
    window.dispatchEvent(new Event('hrms:notifications-changed'));
    try {
      const { data } = await api.patch('/notifications/read-all');
      toast.success(`${data.updated} marked as read`);
    } catch (err) {
      setItems(prevItems);
      window.dispatchEvent(new Event('hrms:notifications-changed'));
      toast.error(errMsg(err));
    }
  };

  const remove = async (id) => {
    if (!confirm('Delete this notification?')) return;
    const prevItems = items;
    setItems((cur) => cur.filter((n) => n._id !== id));
    window.dispatchEvent(new Event('hrms:notifications-changed'));
    try {
      await api.delete(`/notifications/${id}`);
    } catch (err) {
      setItems(prevItems);
      window.dispatchEvent(new Event('hrms:notifications-changed'));
      toast.error(errMsg(err));
    }
  };

  const unread = items.filter((i) => !i.read).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Notifications</h1>
          <p className="text-sm text-slate-500">
            Messages and alerts from HR. {filter === 'all' && `${unread} unread.`}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select className="input max-w-[160px]" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="unread">Unread only</option>
          </select>
          <button className="btn-secondary" onClick={markAllRead} disabled={unread === 0}>
            Mark all read
          </button>
        </div>
      </div>

      {loading ? <Loader /> :
        items.length === 0 ? <EmptyState title="No notifications" subtitle={filter === 'unread' ? 'Nothing unread.' : 'Your inbox is empty.'} /> :
        <div className="space-y-2">
          {items.map((n) => (
            <NotificationCard key={n._id} n={n} onRead={() => markRead(n._id)} onDelete={() => remove(n._id)} />
          ))}
        </div>}
    </div>
  );
}

/**
 * Collapsible notification row.
 *
 * Closed by default: shows only the title, badges, sender and timestamp
 * so the inbox is easy to scan.  Clicking the row expands the message
 * body, and on the FIRST expand of an unread notification it
 * automatically fires the mark-as-read API call -- the explicit "Mark
 * read" button is no longer needed.
 */
function NotificationCard({ n, onRead, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const autoReadFiredRef = useRef(false);
  const isBacklog = n.type === 'backlog_alert';

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    // First time the user opens an unread message -> auto-mark read.
    // The ref guards against firing the API twice on a fast re-expand
    // before the parent's reload finishes.
    if (next && !n.read && !autoReadFiredRef.current) {
      autoReadFiredRef.current = true;
      onRead();
    }
  };

  return (
    <div className={`card overflow-hidden transition ${n.read ? '' : 'ring-1 ring-brand-200'}`}>
      <div className={`h-1 ${n.read ? 'bg-transparent' : 'bg-brand-500'}`} />

      {/* Always-visible header. Click anywhere here to toggle. */}
      <button
        type="button"
        onClick={toggle}
        className="w-full text-left px-5 py-4 hover:bg-slate-50/60 transition"
        aria-expanded={expanded}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className={`text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
              <div className={`text-sm ${n.read ? 'font-medium text-slate-700' : 'font-semibold text-slate-900'}`}>
                {n.title}
              </div>
              {!n.read && <span className="badge-blue">New</span>}
              {isBacklog && <span className="badge-amber">Pendency</span>}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 pl-6">
              From {n.sender?.name || 'System'}
              {n.sender?.role && <span> ({n.sender.role.toUpperCase()})</span>}
              {' • '}
              {new Date(n.createdAt).toLocaleString()}
            </div>
          </div>
          <div className="text-[11px] text-slate-400 hidden sm:block whitespace-nowrap">
            {expanded ? 'Click to collapse' : 'Click to read'}
          </div>
        </div>
      </button>

      {/* Body - only visible when expanded */}
      {expanded && (
        <div className="border-t border-slate-100 px-5 py-4 bg-slate-50/30">
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{n.message}</p>

          {n.relatedTitles?.length > 0 && (
            <div className="mt-3 bg-amber-50 border border-amber-100 rounded-lg p-3">
              <div className="text-[11px] font-semibold text-amber-800 uppercase mb-1">
                Referenced task{n.relatedTitles.length !== 1 ? 's' : ''}
              </div>
              <ul className="text-sm text-amber-900 list-disc pl-5">
                {n.relatedTitles.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between flex-wrap gap-2">
            <div className="text-[11px] text-slate-400">
              {n.read && n.readAt
                ? <>Read at {new Date(n.readAt).toLocaleString()}</>
                : <>Marking as read…</>}
            </div>
            <button className="btn-ghost text-xs text-red-600" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
