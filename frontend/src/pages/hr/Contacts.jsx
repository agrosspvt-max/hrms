import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import StatCard from '../../components/StatCard.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, authUrl } from '../../utils/helpers';
import CompanyDocuments from './CompanyDocuments.jsx';

const BADGE_INTERNAL = 'badge bg-blue-50 text-blue-700';
const BADGE_EXTERNAL = 'badge bg-purple-50 text-purple-700';
const CAT_META = {
  emergency: { label: 'Emergency', cls: 'badge bg-red-50 text-red-700 font-semibold' },
  critical_support: { label: 'Critical Support', cls: 'badge bg-orange-50 text-orange-700 font-semibold' },
  management: { label: 'Management', cls: 'badge bg-indigo-50 text-indigo-700' },
  general: { label: 'General', cls: 'badge-gray' },
};
const SUGGESTED_SCOPES = [
  'Payroll & Salary Queries', 'Leave Management', 'Attendance Issues', 'Sales Coordination',
  'Marketing Activities', 'Technical Support', 'Procurement', 'HR Operations', 'Field Operations',
];
const SUGGESTED_EXTERNAL_TYPES = [
  'Vendor', 'Consultant', 'Chartered Accountant', 'Legal Advisor', 'Distributor',
  'Transport Coordinator', 'Agency Contact', 'Service Engineer', 'Temporary Staff',
  'Freelancer', 'Government Contact', 'Customer Support Contact',
];
const RECENT_KEY = 'hrms_recent_contacts';

const initialsOf = (n = '') => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

const loadRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
const pushRecent = (id) => {
  try {
    const cur = loadRecent().filter((x) => x !== id);
    cur.unshift(id);
    localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, 8)));
  } catch { /* ignore */ }
};

export default function Contacts() {
  const toast = useToast();
  const { user } = useAuth();
  const canManage = user?.role === 'hr' || user?.role === 'super_admin';

  const [items, setItems] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [favIds, setFavIds] = useState(new Set());
  const [analytics, setAnalytics] = useState(null);

  const [q, setQ] = useState('');
  const [fKind, setFKind] = useState('all'); // all | employee | external | favorites
  const [fDept, setFDept] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [modal, setModal] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [recentIds, setRecentIds] = useState(loadRecent());
  // Two-tab surface: Contacts (existing directory) and Company
  // Documents (lightweight HR document library).  Only one tab body
  // is visible at a time; the header (title + tab bar) is shared.
  const [tab, setTab] = useState('contacts');

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (fKind === 'employee' || fKind === 'external') params.kind = fKind;
      if (fStatus) params.status = fStatus;
      if (q) params.q = q;
      const [c, e, favs, an] = await Promise.all([
        api.get('/contacts', { params }),
        canManage ? api.get('/employees', { params: { status: 'active' } }).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
        api.get('/contacts/favorites').then((r) => r.data).catch(() => []),
        canManage ? api.get('/contacts/analytics').then((r) => r.data).catch(() => null) : Promise.resolve(null),
      ]);
      setItems(c.data); setEmployees(e.data || []);
      setFavIds(new Set((favs || []).map((x) => String(x._id))));
      setAnalytics(an);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q, fKind, fStatus]);

  // Department options (from contacts in the current list).
  const departments = useMemo(() => {
    const m = new Map();
    items.forEach((c) => { if (c.departmentText) m.set(c.departmentText, (m.get(c.departmentText) || 0) + 1); });
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [items]);

  const shown = items.filter((c) => {
    if (fKind === 'favorites' && !favIds.has(String(c._id))) return false;
    if (fDept && c.departmentText !== fDept) return false;
    if (fCategory && (c.category || 'general') !== fCategory) return false;
    return true;
  });

  const recentContacts = useMemo(() => recentIds.map((id) => items.find((c) => String(c._id) === id)).filter(Boolean).slice(0, 6), [recentIds, items]);

  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text || ''); toast.success(`${label} copied`); }
    catch { toast.error('Copy failed'); }
  };

  const save = async (form) => {
    try {
      if (modal.mode === 'create') await api.post('/contacts', form);
      else await api.put(`/contacts/${modal.data._id}`, form);
      toast.success('Saved'); setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const toggle = async (c) => {
    try { await api.patch(`/contacts/${c._id}/status`); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const del = async (c) => {
    if (!confirm(`Delete ${c.name}?`)) return;
    try { await api.delete(`/contacts/${c._id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  const toggleFavorite = async (c) => {
    const id = String(c._id);
    const wasFav = favIds.has(id);
    const next = new Set(favIds);
    if (wasFav) next.delete(id); else next.add(id);
    setFavIds(next);
    try { await (wasFav ? api.delete(`/contacts/${id}/favorite`) : api.post(`/contacts/${id}/favorite`)); }
    catch (err) { setFavIds(favIds); toast.error(errMsg(err)); }
  };

  const openDrawer = async (c) => {
    setDrawer(c);
    pushRecent(String(c._id));
    setRecentIds(loadRecent());
    api.post(`/contacts/${c._id}/view`).catch(() => {});
  };

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Contacts</h1>
          <p className="text-sm text-slate-500">Your work contact book — internal teammates &amp; trusted external partners.</p>
        </div>
        {tab === 'contacts' && canManage && (
          <div className="flex gap-2">
            <a className="btn-secondary" href={authUrl('/api/contacts/export.csv')}>Export CSV</a>
            <button className="btn-secondary" onClick={() => setModal({ mode: 'create', data: { kind: 'employee', linkedEmployee: '', scopeOfWork: '', category: 'general' } })}>+ Internal Contact</button>
            <button className="btn-primary" onClick={() => setModal({ mode: 'create', data: { kind: 'external', name: '', organization: '', contactType: '', phone: '', email: '', roleTitle: '', departmentText: '', scopeOfWork: '', category: 'general' } })}>+ External Contact</button>
          </div>
        )}
      </div>

      {/* Tab bar -- shared header, one section body visible at a time. */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        {[
          { key: 'contacts',  label: 'Contacts' },
          { key: 'documents', label: 'Company Documents' },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === t.key
              ? 'border-brand-500 text-brand-700 font-semibold'
              : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'contacts' && <>

      {/* HR analytics */}
      {canManage && analytics && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <StatCard label="Total Contacts" value={analytics.total} accent="brand" />
          <StatCard label="Internal" value={analytics.internal} accent="blue" />
          <StatCard label="External" value={analytics.external} accent="amber" />
          <StatCard label="Active" value={analytics.active} accent="green" />
          <StatCard label="Inactive" value={analytics.inactive} accent="red" />
          <div className="card card-body">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Most Viewed</div>
            {analytics.mostViewed.length === 0 ? <div className="text-sm text-slate-400 italic mt-1">No views yet</div> :
              <div className="space-y-1 mt-1">
                {analytics.mostViewed.slice(0, 3).map((m) => (
                  <div key={m._id} className="flex items-center justify-between text-sm">
                    <span className="text-slate-700 truncate">{m.name}</span>
                    <span className="badge-gray">{m.views}</span>
                  </div>
                ))}
              </div>}
          </div>
        </div>
      )}

      {/* Search + filters */}
      <div className="card card-body flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[220px]">
          <label className="label">Search</label>
          <input className="input" placeholder="Name, phone, email, scope of work…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div>
          <label className="label">Type</label>
          <select className="input max-w-[180px]" value={fKind} onChange={(e) => setFKind(e.target.value)}>
            <option value="all">All contacts</option>
            <option value="employee">Internal employees</option>
            <option value="external">External contacts</option>
            <option value="favorites">★ Favorites only</option>
          </select>
        </div>
        <div>
          <label className="label">Category</label>
          <select className="input max-w-[170px]" value={fCategory} onChange={(e) => setFCategory(e.target.value)}>
            <option value="">All categories</option>
            <option value="emergency">Emergency</option>
            <option value="critical_support">Critical Support</option>
            <option value="management">Management</option>
            <option value="general">General</option>
          </select>
        </div>
        {canManage && (
          <div>
            <label className="label">Status</label>
            <select className="input max-w-[160px]" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="">Active &amp; inactive</option>
              <option value="active">Active only</option>
              <option value="inactive">Inactive only</option>
            </select>
          </div>
        )}
        <div className="text-sm text-slate-500 whitespace-nowrap">{shown.length} contact(s)</div>
      </div>

      {/* Department chip strip */}
      {departments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setFDept('')}
            className={`px-3 py-1 rounded-full text-xs border ${!fDept ? 'bg-brand-600 text-white border-brand-600' : 'bg-white border-slate-200 text-slate-600 hover:border-brand-300'}`}>
            All departments
          </button>
          {departments.map((d) => (
            <button key={d.name} onClick={() => setFDept(d.name === fDept ? '' : d.name)}
              className={`px-3 py-1 rounded-full text-xs border ${fDept === d.name ? 'bg-brand-600 text-white border-brand-600' : 'bg-white border-slate-200 text-slate-600 hover:border-brand-300'}`}>
              {d.name} <span className="opacity-70">({d.count})</span>
            </button>
          ))}
        </div>
      )}

      {/* Recently Viewed */}
      {recentContacts.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-2">Recently Viewed</div>
          <div className="flex flex-wrap gap-2">
            {recentContacts.map((c) => (
              <button key={c._id} onClick={() => openDrawer(c)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:border-brand-300 text-left text-xs">
                <div className="font-medium text-slate-800">{c.name}</div>
                <div className="text-[10px] text-slate-500">{c.roleTitle || c.organization || 'Contact'}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Contact grid */}
      {loading ? <Loader /> : shown.length === 0 ? (
        <EmptyState title="No contacts" subtitle={canManage ? 'Add your first contact above.' : 'Ask HR to add contacts to the directory.'} />
      ) : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {shown.map((c) => (
            <ContactCard
              key={c._id}
              c={c}
              isFav={favIds.has(String(c._id))}
              canManage={canManage}
              onOpen={() => openDrawer(c)}
              onCall={(phone) => { if (phone) window.location.href = `tel:${phone}`; }}
              onCopy={copy}
              onFav={() => toggleFavorite(c)}
              onEdit={() => setModal({ mode: 'edit', data: c })}
              onToggle={() => toggle(c)}
              onDelete={() => del(c)}
            />
          ))}
        </div>
      )}

      {modal && (
        <ContactModal
          modal={modal}
          employees={employees}
          existingLinkedIds={items.filter((x) => x.kind === 'employee').map((x) => String(x.linkedEmployee))}
          onCancel={() => setModal(null)}
          onSave={save}
        />
      )}
      {drawer && (
        <ContactDrawer
          c={drawer}
          isFav={favIds.has(String(drawer._id))}
          onClose={() => setDrawer(null)}
          onCall={(phone) => { if (phone) window.location.href = `tel:${phone}`; }}
          onCopy={copy}
          onFav={() => toggleFavorite(drawer)}
        />
      )}

      </>}

      {/* Company Documents tab body -- lightweight document library.
          HR / Super Admin get the management UI; employees see only
          documents flagged visibleToEmployees:true.  Renders as its
          own tab so the two surfaces feel like one feature. */}
      {tab === 'documents' && <CompanyDocuments />}
    </div>
  );
}

function StarButton({ isFav, onClick, label = 'Favorite' }) {
  return (
    <button onClick={onClick} title={isFav ? 'Remove from favorites' : 'Mark as favorite'}
      className={`shrink-0 ${isFav ? 'text-amber-400' : 'text-slate-300 hover:text-amber-400'}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 15 9 22 9.27 17 14.14 18.18 21 12 17.77 5.82 21 7 14.14 2 9.27 9 9 12 2" />
      </svg>
      <span className="sr-only">{label}</span>
    </button>
  );
}

function ContactCard({ c, isFav, canManage, onOpen, onCall, onCopy, onFav, onEdit, onToggle, onDelete }) {
  const isInt = c.kind === 'employee';
  const phone = c.phone || '';
  const email = c.email || '';
  const cat = CAT_META[c.category || 'general'];
  return (
    <div className={`card card-body ${c.status === 'inactive' ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <button onClick={onOpen} className="w-12 h-12 rounded-2xl grid place-items-center text-sm font-bold text-white shrink-0 hover:opacity-90 transition"
          style={{ background: isInt ? 'linear-gradient(135deg, #1a365d 0%, #3182ce 100%)' : 'linear-gradient(135deg, #6d28d9 0%, #a855f7 100%)' }}>
          {initialsOf(c.name)}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={onOpen} className="font-semibold text-slate-900 hover:text-brand-700 truncate">{c.name}</button>
            <StarButton isFav={isFav} onClick={onFav} />
            <span className={isInt ? BADGE_INTERNAL : BADGE_EXTERNAL}>{isInt ? 'Internal' : 'External'}</span>
            <span className={cat.cls}>{cat.label}</span>
            {c.status === 'inactive' && <span className="badge-gray">Inactive</span>}
          </div>
          <div className="text-xs text-slate-500 truncate">
            {c.roleTitle || c.contactType || ''}
            {c.departmentText && <> · {c.departmentText}</>}
            {!isInt && c.organization && <> · {c.organization}</>}
          </div>
          {c.scopeOfWork && <div className="text-sm text-slate-700 mt-2"><span className="text-slate-400">Scope:</span> {c.scopeOfWork}</div>}
          <div className="mt-2 space-y-1 text-sm">
            {phone && (
              <div className="flex items-center justify-between gap-2">
                <a className="text-slate-700 hover:text-brand-700" href={`tel:${phone}`}>{phone}</a>
                <div className="flex gap-1">
                  <button className="btn-ghost !py-0.5 text-xs" onClick={() => onCall(phone)}>Call</button>
                  <button className="btn-ghost !py-0.5 text-xs" onClick={() => onCopy(phone, 'Phone')}>Copy</button>
                </div>
              </div>
            )}
            {email && (
              <div className="flex items-center justify-between gap-2">
                <a className="text-slate-700 hover:text-brand-700 truncate" href={`mailto:${email}`}>{email}</a>
                <button className="btn-ghost !py-0.5 text-xs" onClick={() => onCopy(email, 'Email')}>Copy</button>
              </div>
            )}
          </div>
        </div>
      </div>
      {canManage && (
        <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-end gap-1">
          <button className="btn-ghost !py-0.5 text-xs" onClick={onToggle}>{c.status === 'active' ? 'Deactivate' : 'Activate'}</button>
          <button className="btn-ghost !py-0.5 text-xs" onClick={onEdit}>Edit</button>
          <button className="btn-ghost !py-0.5 text-xs text-red-600" onClick={onDelete}>Delete</button>
        </div>
      )}
    </div>
  );
}

function ContactDrawer({ c, isFav, onClose, onCall, onCopy, onFav }) {
  const isInt = c.kind === 'employee';
  const cat = CAT_META[c.category || 'general'];
  return (
    <Modal open onClose={onClose} size="lg" title="Contact details"
      footer={<button className="btn-secondary" onClick={onClose}>Close</button>}>
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-14 h-14 rounded-2xl grid place-items-center text-base font-bold text-white shrink-0"
            style={{ background: isInt ? 'linear-gradient(135deg, #1a365d 0%, #3182ce 100%)' : 'linear-gradient(135deg, #6d28d9 0%, #a855f7 100%)' }}>
            {initialsOf(c.name)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-lg font-bold text-slate-900">{c.name}</div>
              <StarButton isFav={isFav} onClick={onFav} />
              <span className={isInt ? BADGE_INTERNAL : BADGE_EXTERNAL}>{isInt ? 'Internal' : 'External'}</span>
              <span className={cat.cls}>{cat.label}</span>
              {c.isHOD && <span className="badge-green">HOD</span>}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {c.roleTitle || c.contactType || ''}
              {c.departmentText && <> · {c.departmentText}</>}
              {!isInt && c.organization && <> · {c.organization}</>}
            </div>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          {isInt && (<>
            <Field label="Employee ID" value={c.employeeId} />
            <Field label="Department" value={c.departmentText} />
            <Field label="Designation" value={c.roleTitle} />
            <Field label="Reporting Manager" value={c.reportingManager} />
          </>)}
          {!isInt && (<>
            <Field label="Organization" value={c.organization} />
            <Field label="Type" value={c.contactType} />
            <Field label="Role" value={c.roleTitle} />
            <Field label="Department" value={c.departmentText} />
          </>)}
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">Contact Details</div>
          <div className="space-y-1 text-sm">
            {c.phone && (<div className="flex items-center justify-between gap-2">
              <a className="text-slate-700 hover:text-brand-700" href={`tel:${c.phone}`}>{c.phone}</a>
              <div className="flex gap-1">
                <button className="btn-ghost !py-0.5 text-xs" onClick={() => onCall(c.phone)}>Call</button>
                <button className="btn-ghost !py-0.5 text-xs" onClick={() => onCopy(c.phone, 'Phone')}>Copy</button>
              </div>
            </div>)}
            {c.altPhone && (<div className="flex items-center justify-between gap-2">
              <a className="text-slate-700 hover:text-brand-700" href={`tel:${c.altPhone}`}>{c.altPhone} <span className="text-[10px] text-slate-400">alt</span></a>
              <button className="btn-ghost !py-0.5 text-xs" onClick={() => onCopy(c.altPhone, 'Phone')}>Copy</button>
            </div>)}
            {c.email && (<div className="flex items-center justify-between gap-2">
              <a className="text-slate-700 hover:text-brand-700 truncate" href={`mailto:${c.email}`}>{c.email}</a>
              <button className="btn-ghost !py-0.5 text-xs" onClick={() => onCopy(c.email, 'Email')}>Copy</button>
            </div>)}
            {!c.phone && !c.email && <div className="text-xs text-slate-400 italic">No contact details on file.</div>}
          </div>
        </div>

        {c.scopeOfWork && <Field label="Scope of Work" value={c.scopeOfWork} block />}
        {!isInt && c.address && <Field label="Address" value={c.address} block />}
        {!isInt && c.notes && <Field label="Notes" value={c.notes} block />}
      </div>
    </Modal>
  );
}

const Field = ({ label, value, block }) => (
  block ? (
    <div>
      <div className="text-[11px] uppercase text-slate-500 tracking-wide">{label}</div>
      <div className="text-sm text-slate-700 mt-0.5 whitespace-pre-wrap">{value || <span className="text-slate-400 italic">—</span>}</div>
    </div>
  ) : (
    <div className="bg-slate-50 rounded-lg p-2">
      <div className="text-[10px] uppercase text-slate-500 tracking-wide">{label}</div>
      <div className="text-sm text-slate-800 mt-0.5">{value || <span className="text-slate-400 italic">—</span>}</div>
    </div>
  )
);

function ContactModal({ modal, employees, existingLinkedIds, onCancel, onSave }) {
  const [f, setF] = useState(modal.data);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const isEmployee = f.kind === 'employee';
  const [empSearch, setEmpSearch] = useState('');

  const employeeOptions = useMemo(() => {
    const q = empSearch.toLowerCase();
    return employees
      .filter((u) => u.role === 'employee' || u.role === 'hr')
      .filter((u) => !q
        || u.name?.toLowerCase().includes(q)
        || u.employeeId?.toLowerCase().includes(q)
        || u.department?.name?.toLowerCase().includes(q)
        || u.designation?.title?.toLowerCase().includes(q));
  }, [employees, empSearch]);

  const valid = isEmployee ? !!f.linkedEmployee : !!(f.name || '').trim();

  return (
    <Modal open onClose={onCancel} size="lg" title={modal.mode === 'create' ? `Add ${isEmployee ? 'Internal' : 'External'} Contact` : 'Edit Contact'}
      footer={<><button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" disabled={!valid} onClick={() => onSave(f)}>Save</button></>}>
      {modal.mode === 'create' && (
        <div className="mb-3 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
          {[['employee', 'Internal employee'], ['external', 'External contact']].map(([k, label]) => (
            <button key={k} onClick={() => setF((s) => ({ ...s, kind: k }))}
              className={`px-4 py-1.5 text-xs font-medium rounded-md transition ${f.kind === k ? 'bg-white shadow text-brand-700' : 'text-slate-500 hover:text-slate-700'}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="mb-3">
        <label className="label">Category</label>
        <select className="input max-w-[220px]" value={f.category || 'general'} onChange={(e) => set('category', e.target.value)}>
          <option value="general">General</option>
          <option value="management">Management</option>
          <option value="critical_support">Critical Support</option>
          <option value="emergency">Emergency</option>
        </select>
      </div>

      {isEmployee ? (
        <div className="space-y-3">
          <div>
            <label className="label">Search employee (name, ID, department, designation)</label>
            <input className="input" placeholder="Start typing…" value={empSearch} onChange={(e) => setEmpSearch(e.target.value)} />
            {/* Phase 56 -- results were previously hidden inside a native
                <select> that only reactively filters when clicked, so
                typing looked like "nothing happened".  Now results
                render as a live scrollable list right below the search
                input: matches update on every keystroke, clearing the
                search restores the full roster, and clicking a row
                populates linkedEmployee exactly like before. */}
            <div className="text-[11px] text-slate-500 mt-1">
              {empSearch
                ? `${employeeOptions.length} match${employeeOptions.length === 1 ? '' : 'es'}`
                : `${employeeOptions.length} employee${employeeOptions.length === 1 ? '' : 's'} available`}
            </div>
          </div>
          <div>
            <label className="label">Select employee</label>
            <div className="border border-slate-200 rounded-lg max-h-64 overflow-y-auto bg-white">
              {employeeOptions.length === 0 ? (
                <div className="p-3 text-xs italic text-slate-500">
                  {empSearch ? 'No employees match this search.' : 'No employees available.'}
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {employeeOptions.map((u) => {
                    const dup = existingLinkedIds.includes(String(u._id)) && String(u._id) !== String(modal.data?.linkedEmployee);
                    const isSel = String(f.linkedEmployee || '') === String(u._id);
                    return (
                      <li key={u._id}>
                        <button
                          type="button"
                          disabled={dup}
                          onClick={() => set('linkedEmployee', String(u._id))}
                          className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 transition ${
                            isSel ? 'bg-brand-50 text-brand-800 font-medium'
                              : dup ? 'text-slate-400 bg-slate-50 cursor-not-allowed'
                              : 'hover:bg-slate-50 text-slate-700'
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {u.name}
                              <span className="text-slate-400 font-normal"> · {u.employeeId}</span>
                            </span>
                            <span className="block text-[10px] text-slate-500 truncate">
                              {[u.department?.name, u.designation?.title].filter(Boolean).join(' · ') || '—'}
                            </span>
                          </span>
                          {isSel && <span className="text-brand-600 text-xs">✓ Selected</span>}
                          {dup && !isSel && <span className="text-[10px] italic">already in directory</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">Phone, email, department &amp; designation come from the employee record and stay in sync.</div>
          </div>
          <div>
            <label className="label">Scope of work / Contact purpose</label>
            <input className="input" placeholder="e.g. Payroll & Salary Queries" value={f.scopeOfWork || ''} onChange={(e) => set('scopeOfWork', e.target.value)} list="scope-suggestions" />
            <datalist id="scope-suggestions">
              {SUGGESTED_SCOPES.map((s) => <option key={s} value={s} />)}
            </datalist>
          </div>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          <div className="md:col-span-2"><label className="label">Contact name</label><input className="input" value={f.name || ''} onChange={(e) => set('name', e.target.value)} /></div>
          <div><label className="label">Organization / Company</label><input className="input" value={f.organization || ''} onChange={(e) => set('organization', e.target.value)} /></div>
          <div><label className="label">Contact type</label>
            <input className="input" placeholder="e.g. Vendor, Consultant…" value={f.contactType || ''} onChange={(e) => set('contactType', e.target.value)} list="ext-type-suggestions" />
            <datalist id="ext-type-suggestions">{SUGGESTED_EXTERNAL_TYPES.map((s) => <option key={s} value={s} />)}</datalist>
          </div>
          <div><label className="label">Designation / Role</label><input className="input" value={f.roleTitle || ''} onChange={(e) => set('roleTitle', e.target.value)} /></div>
          <div><label className="label">Department (optional)</label><input className="input" value={f.departmentText || ''} onChange={(e) => set('departmentText', e.target.value)} /></div>
          <div><label className="label">Phone</label><input className="input" value={f.phone || ''} onChange={(e) => set('phone', e.target.value)} /></div>
          <div><label className="label">Alternate phone</label><input className="input" value={f.altPhone || ''} onChange={(e) => set('altPhone', e.target.value)} /></div>
          <div className="md:col-span-2"><label className="label">Email</label><input className="input" type="email" value={f.email || ''} onChange={(e) => set('email', e.target.value)} /></div>
          <div className="md:col-span-2"><label className="label">Address</label><textarea className="input" rows={2} value={f.address || ''} onChange={(e) => set('address', e.target.value)} /></div>
          <div className="md:col-span-2"><label className="label">Scope of work / Contact purpose</label>
            <input className="input" value={f.scopeOfWork || ''} onChange={(e) => set('scopeOfWork', e.target.value)} list="scope-suggestions" />
            <datalist id="scope-suggestions">{SUGGESTED_SCOPES.map((s) => <option key={s} value={s} />)}</datalist>
          </div>
          <div className="md:col-span-2"><label className="label">Notes</label><textarea className="input" rows={2} value={f.notes || ''} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
      )}
    </Modal>
  );
}
