import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';

const CATEGORIES = [
  { value: 'performance', label: 'Performance' },
  { value: 'behaviour',   label: 'Behaviour' },
  { value: 'compliance',  label: 'Compliance' },
  { value: 'hr',          label: 'HR' },
  { value: 'custom',      label: 'Custom' },
];
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

export default function ManageInteractionTags() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [modal, setModal] = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/interaction-tags', { params: { category: category || undefined, archived: showArchived ? 'true' : 'false' } })
      .then(({ data }) => setRows(data || []))
      .catch((err) => toast.error(errMsg(err)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [category, showArchived]);

  const remove = async (id) => {
    if (!confirm('Delete this tag? Interactions and notes will keep their reference until removed manually.')) return;
    try { await api.delete(`/interaction-tags/${id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Manage Tags</h1>
          <p className="text-sm text-slate-500">Global tag catalogue used across Employee Interactions.</p>
        </div>
        <button className="btn-primary" onClick={() => setModal({ mode: 'create', data: { category: 'custom', color: '#64748b', severity: 'info', countsInAnalytics: true } })}>+ New Tag</button>
      </div>

      <div className="card card-body flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Category</label>
          <select className="input max-w-[180px]" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {loading ? <Loader /> : rows.length === 0 ? (
        <EmptyState title="No tags found" />
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {rows.map((t) => (
            <div key={t._id} className="card card-body">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: t.color }} />
                    <div className="text-sm font-semibold">@{t.name}</div>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5 capitalize">{t.category} · {t.severity}</div>
                  {t.description && <div className="text-xs text-slate-600 mt-1">{t.description}</div>}
                </div>
                <div className="flex flex-col items-end gap-1">
                  {t.archived && <span className="badge text-[10px] border bg-slate-100 text-slate-600 border-slate-200">archived</span>}
                  {t.countsAsWarning && <span className="badge text-[10px] border bg-red-50 text-red-700 border-red-200">counts as warning</span>}
                  {!t.countsInAnalytics && <span className="badge text-[10px] border bg-slate-50 text-slate-500 border-slate-200">not in analytics</span>}
                  {t.visibleToEmployee && <span className="badge text-[10px] border bg-blue-50 text-blue-700 border-blue-200">employee visible</span>}
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-2">
                <button className="btn-ghost !py-1 !text-xs" onClick={() => setModal({ mode: 'edit', data: { ...t } })}>Edit</button>
                <button className="btn-ghost !py-1 !text-xs text-red-600" onClick={() => remove(t._id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <TagModal modal={modal} onCancel={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}

function TagModal({ modal, onCancel, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(() => ({
    name: modal.data.name || '',
    category: modal.data.category || 'custom',
    color: modal.data.color || '#64748b',
    icon: modal.data.icon || '',
    description: modal.data.description || '',
    severity: modal.data.severity || 'info',
    countsAsWarning: !!modal.data.countsAsWarning,
    countsInAnalytics: modal.data.countsInAnalytics !== false,
    visibleToEmployee: !!modal.data.visibleToEmployee,
    archived: !!modal.data.archived,
  }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    if (!f.name.trim()) { toast.error('Name is required'); return; }
    setBusy(true);
    try {
      if (modal.mode === 'create') await api.post('/interaction-tags', f);
      else await api.put(`/interaction-tags/${modal.data._id}`, f);
      toast.success('Saved');
      onSaved?.();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onCancel} size="md" title={modal.mode === 'create' ? 'New Tag' : `Edit Tag — @${modal.data.name}`}
      footer={<><button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={busy}>Save</button></>}>
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Dealer Complaint" />
          </div>
          <div>
            <label className="label">Category</label>
            <select className="input" value={f.category} onChange={(e) => set('category', e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Color</label>
            <input className="input h-10" type="color" value={f.color} onChange={(e) => set('color', e.target.value)} />
          </div>
          <div>
            <label className="label">Icon (emoji, optional)</label>
            <input className="input" value={f.icon} onChange={(e) => set('icon', e.target.value)} />
          </div>
          <div>
            <label className="label">Severity</label>
            <select className="input" value={f.severity} onChange={(e) => set('severity', e.target.value)}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.countsAsWarning} onChange={(e) => set('countsAsWarning', e.target.checked)} /> Counts as Warning</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.countsInAnalytics} onChange={(e) => set('countsInAnalytics', e.target.checked)} /> Counts in Analytics</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.visibleToEmployee} onChange={(e) => set('visibleToEmployee', e.target.checked)} /> Visible to Employee</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.archived} onChange={(e) => set('archived', e.target.checked)} /> Archived</label>
        </div>
      </div>
    </Modal>
  );
}
