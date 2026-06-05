import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtMoney } from '../../utils/helpers';

/**
 * Products module (HR / Super Admin only).
 *
 *   - Products tab    -> name, price/unit, NBV %, unit (L/KG), active.
 *   - Quantities tab  -> label, canonical value, unit, active.
 *
 * Both masters drive the dropdowns in the Product & Farmer Report
 * custom assignment.  Soft-deactivate (active=false) instead of
 * hard-delete so historical submissions still resolve their snapshots.
 */
export default function Products() {
  const [tab, setTab] = useState('products');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Products</h1>
        <p className="text-sm text-slate-500">Master data for the Product &amp; Farmer Report and any future field-sales template.</p>
      </div>
      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        {[['products', 'Products'], ['quantities', 'Quantity Master']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition ${tab === k ? 'bg-white shadow text-brand-700' : 'text-slate-500 hover:text-slate-700'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'products' ? <ProductsTab /> : <QuantitiesTab />}
    </div>
  );
}

/* ---------------------------- Products tab ---------------------------- */

const blankProduct = { name: '', pricePerUnit: 0, nbvPercentage: 0, unit: 'L', description: '', active: true };

function ProductsTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try { setItems((await api.get('/products')).data); }
    catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const save = async (form) => {
    try {
      if (modal.mode === 'create') await api.post('/products', form);
      else await api.put(`/products/${modal.data._id}`, form);
      toast.success('Saved'); setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const deactivate = async (p) => {
    if (!confirm(`Deactivate "${p.name}"? Past submissions stay intact; the product just stops appearing in employee dropdowns.`)) return;
    try { await api.delete(`/products/${p._id}`); toast.success('Deactivated'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button className="btn-primary" onClick={() => setModal({ mode: 'create', data: { ...blankProduct } })}>+ Add Product</button>
      </div>
      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          items.length === 0 ? <EmptyState title="No products yet" subtitle="Add a product to make it available in field-sales reports." /> :
          <table className="table">
            <thead><tr><th>Name</th><th>Unit</th><th>Price / Unit</th><th>NBV %</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {items.map((p) => (
                <tr key={p._id} className={p.active ? '' : 'opacity-60'}>
                  <td className="font-medium text-slate-800">{p.name}{p.description && <div className="text-[11px] text-slate-500">{p.description}</div>}</td>
                  <td>{p.unit}</td>
                  <td className="font-mono">{fmtMoney(p.pricePerUnit)}</td>
                  <td>{p.nbvPercentage}%</td>
                  <td>{p.active ? <span className="badge-green">Active</span> : <span className="badge-gray">Inactive</span>}</td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost" onClick={() => setModal({ mode: 'edit', data: p })}>Edit</button>
                    {p.active && <button className="btn-ghost text-red-600" onClick={() => deactivate(p)}>Deactivate</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>
      {modal && (
        <ProductForm
          mode={modal.mode}
          initial={modal.data}
          onCancel={() => setModal(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function ProductForm({ mode, initial, onCancel, onSave }) {
  const [form, setForm] = useState(initial);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal open onClose={onCancel} title={mode === 'create' ? 'Add Product' : `Edit ${form.name}`}
      footer={<>
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={() => onSave(form)} disabled={!form.name}>Save</button>
      </>}
    >
      <div className="grid md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <label className="label">Product Name</label>
          <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. JANTAGOLD" />
        </div>
        <div>
          <label className="label">Unit</label>
          <select className="input" value={form.unit} onChange={(e) => set('unit', e.target.value)}>
            <option value="L">Liter (L)</option>
            <option value="KG">Kilogram (KG)</option>
          </select>
        </div>
        <div>
          <label className="label">Price per Unit (₹)</label>
          <input className="input" type="number" min="0" value={form.pricePerUnit} onChange={(e) => set('pricePerUnit', Number(e.target.value) || 0)} />
        </div>
        <div>
          <label className="label">NBV %</label>
          <input className="input" type="number" min="0" max="100" value={form.nbvPercentage} onChange={(e) => set('nbvPercentage', Number(e.target.value) || 0)} />
          <div className="text-[11px] text-slate-500 mt-1">e.g. 25 → 25% of every sale counts as NBV.</div>
        </div>
        <div className="md:col-span-2">
          <label className="label">Description (optional)</label>
          <textarea className="input" rows={2} value={form.description || ''} onChange={(e) => set('description', e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input type="checkbox" checked={form.active !== false} onChange={(e) => set('active', e.target.checked)} />
          Active (appears in employee dropdowns)
        </label>
      </div>
    </Modal>
  );
}

/* --------------------------- Quantities tab --------------------------- */

const blankQuantity = { label: '', value: 0, unit: 'L', active: true };

function QuantitiesTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try { setItems((await api.get('/quantities')).data); }
    catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const save = async (form) => {
    try {
      if (modal.mode === 'create') await api.post('/quantities', form);
      else await api.put(`/quantities/${modal.data._id}`, form);
      toast.success('Saved'); setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const deactivate = async (q) => {
    if (!confirm(`Deactivate "${q.label}"?`)) return;
    try { await api.delete(`/quantities/${q._id}`); toast.success('Deactivated'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-xs text-slate-500">Each quantity's <b>canonical value</b> is in the unit's base measure (Liters or Kilograms). e.g. "500 ml" stores 0.5 (L); "25 KG" stores 25 (KG).</div>
        <button className="btn-primary" onClick={() => setModal({ mode: 'create', data: { ...blankQuantity } })}>+ Add Quantity</button>
      </div>
      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          items.length === 0 ? <EmptyState title="No quantities yet" /> :
          <table className="table">
            <thead><tr><th>Label</th><th>Unit</th><th>Canonical Value</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {items.map((q) => (
                <tr key={q._id} className={q.active ? '' : 'opacity-60'}>
                  <td className="font-medium text-slate-800">{q.label}</td>
                  <td>{q.unit}</td>
                  <td className="font-mono">{q.value}</td>
                  <td>{q.active ? <span className="badge-green">Active</span> : <span className="badge-gray">Inactive</span>}</td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost" onClick={() => setModal({ mode: 'edit', data: q })}>Edit</button>
                    {q.active && <button className="btn-ghost text-red-600" onClick={() => deactivate(q)}>Deactivate</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>
      {modal && (
        <QuantityForm
          mode={modal.mode}
          initial={modal.data}
          onCancel={() => setModal(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function QuantityForm({ mode, initial, onCancel, onSave }) {
  const [form, setForm] = useState(initial);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal open onClose={onCancel} title={mode === 'create' ? 'Add Quantity' : `Edit ${form.label}`}
      footer={<>
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={() => onSave(form)} disabled={!form.label}>Save</button>
      </>}
    >
      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <label className="label">Label</label>
          <input className="input" value={form.label} onChange={(e) => set('label', e.target.value)} placeholder='e.g. "500 ml" or "25 KG"' />
        </div>
        <div>
          <label className="label">Unit</label>
          <select className="input" value={form.unit} onChange={(e) => set('unit', e.target.value)}>
            <option value="L">Liter (L)</option>
            <option value="KG">Kilogram (KG)</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="label">Canonical Value (in {form.unit})</label>
          <input className="input" type="number" min="0" step="0.001" value={form.value} onChange={(e) => set('value', Number(e.target.value) || 0)} />
          <div className="text-[11px] text-slate-500 mt-1">
            500 ml → 0.5 (L). 25 KG → 25 (KG). This is the multiplier used in the Sales Value formula.
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input type="checkbox" checked={form.active !== false} onChange={(e) => set('active', e.target.checked)} />
          Active
        </label>
      </div>
    </Modal>
  );
}
