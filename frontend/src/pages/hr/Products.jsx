import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtMoney, authUrl } from '../../utils/helpers';

/**
 * Products & Dealers module (HR / Super Admin only).
 *
 *   - Products tab    -> name, price/unit, NBV %, unit (L/KG), active.
 *   - Dealers tab     -> dealer name, place, active.  Drives the dealer
 *                        dropdown in the Farmer Records sub-table.
 *   - Quantities tab  -> legacy label/value/unit master kept for older
 *                        templates; new Product Sales rows accept a raw
 *                        canonical quantity directly.
 *
 * All three masters drive dropdowns in the Product & Farmer Report
 * custom assignment.  Soft-deactivate (active=false) instead of
 * hard-delete so historical submissions still resolve their snapshots.
 */
export default function Products() {
  const [tab, setTab] = useState('products');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Products &amp; Dealers</h1>
        <p className="text-sm text-slate-500">Master data for the Product &amp; Farmer Report and any future field-sales template.</p>
      </div>
      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        {[['products', 'Products'], ['dealers', 'Dealers'], ['quantities', 'Quantity Master (legacy)']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition ${tab === k ? 'bg-white shadow text-brand-700' : 'text-slate-500 hover:text-slate-700'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'products'   ? <ProductsTab />   :
       tab === 'dealers'    ? <DealersTab />    :
       <QuantitiesTab />}
    </div>
  );
}

/* ---------------------------- Dealers tab ---------------------------- */

const blankDealer = { firmName: '', place: '', dealerName: '', active: true };

function DealersTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState('');
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const params = search ? { search } : {};
      setItems((await api.get('/dealers', { params })).data);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [search]);

  const save = async (form) => {
    try {
      const payload = {
        firmName:   String(form.firmName || '').trim(),
        place:      String(form.place || '').trim(),
        dealerName: String(form.dealerName || '').trim(),
        active:     form.active !== false,
      };
      if (modal.mode === 'create') await api.post('/dealers', payload);
      else await api.put(`/dealers/${modal.data._id}`, payload);
      toast.success('Saved'); setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const deactivate = async (d) => {
    const label = `${d.firmName || d.name || 'dealer'} @ ${d.place || '—'}`;
    if (!confirm(`Deactivate "${label}"? Past farmer records keep their snapshot; the dealer just stops appearing in employee dropdowns.`)) return;
    try { await api.delete(`/dealers/${d._id}`); toast.success('Deactivated'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  // Inline form validation matches backend's required-field rule.
  const canSave = !!(modal?.data?.firmName?.trim() && modal?.data?.place?.trim() && modal?.data?.dealerName?.trim());

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center gap-2 flex-wrap">
        <input
          className="input max-w-xs"
          placeholder="Search by firm, place, or dealer name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex justify-end gap-2 flex-wrap">
          <a className="btn-secondary" href={authUrl('/api/dealers/import-sample')}>Download Sample Excel</a>
          <button className="btn-secondary" onClick={() => setImportOpen(true)}>Import Dealers</button>
          <a className="btn-secondary" href={authUrl('/api/dealers/export')}>Export Dealers</a>
          <button className="btn-primary" onClick={() => setModal({ mode: 'create', data: { ...blankDealer } })}>+ Add Dealer</button>
        </div>
      </div>
      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          items.length === 0 ? <EmptyState title="No dealers yet" subtitle="Add a dealer or import the sample to make them pickable on Farmer Records." /> :
          <table className="table">
            <thead><tr><th>Firm Name</th><th>Place</th><th>Dealer Name</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {items.map((d) => (
                <tr key={d._id} className={d.active ? '' : 'opacity-60'}>
                  <td className="font-medium text-slate-800">{d.firmName || d.name || '—'}</td>
                  <td>{d.place || <span className="text-slate-400">—</span>}</td>
                  <td>{d.dealerName || <span className="text-slate-400">—</span>}</td>
                  <td>{d.active ? <span className="badge-green">Active</span> : <span className="badge-gray">Inactive</span>}</td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost" onClick={() => setModal({ mode: 'edit', data: d })}>Edit</button>
                    {d.active && <button className="btn-ghost text-red-600" onClick={() => deactivate(d)}>Deactivate</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>
      {modal && (
        <Modal open onClose={() => setModal(null)} title={modal.mode === 'create' ? 'Add Dealer' : 'Edit Dealer'}
          footer={<>
            <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn-primary" disabled={!canSave} onClick={() => save(modal.data)}>Save</button>
          </>}>
          <div className="space-y-3">
            <div>
              <label className="label">Firm Name</label>
              <input className="input" value={modal.data.firmName || ''} onChange={(e) => setModal({ ...modal, data: { ...modal.data, firmName: e.target.value } })} placeholder="e.g. Agro Traders" />
            </div>
            <div>
              <label className="label">Place</label>
              <input className="input" value={modal.data.place || ''} onChange={(e) => setModal({ ...modal, data: { ...modal.data, place: e.target.value } })} placeholder="e.g. Bhopal" />
              <div className="text-[11px] text-slate-500 mt-1">
                The same Firm Name in two different places counts as two distinct dealers.
              </div>
            </div>
            <div>
              <label className="label">Dealer Name</label>
              <input className="input" value={modal.data.dealerName || ''} onChange={(e) => setModal({ ...modal, data: { ...modal.data, dealerName: e.target.value } })} placeholder="e.g. Rajesh Sharma" />
              <div className="text-[11px] text-slate-500 mt-1">
                Internal — employees never see the dealer name; HR + analytics do.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input id="d-active" type="checkbox" checked={modal.data.active !== false} onChange={(e) => setModal({ ...modal, data: { ...modal.data, active: e.target.checked } })} />
              <label htmlFor="d-active" className="text-sm">Active</label>
            </div>
          </div>
        </Modal>
      )}
      {importOpen && (
        <ImportDealersModal
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); load(); }}
        />
      )}
    </div>
  );
}

/* ----- Bulk dealer import modal (mirrors ImportProductsModal) ----- */
function ImportDealersModal({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const toast = useToast();

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/dealers/import', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(data);
      toast.success(`Created ${data.createdCount} · Updated ${data.updatedCount}${data.failedCount ? ` · Failed ${data.failedCount}` : ''}`);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const downloadFailedCsv = () => {
    if (!result?.failed?.length) return;
    const headers = ['Row Number', 'Firm Name', 'Reason'];
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    result.failed.forEach((r) => lines.push([r.row, r.firmName, r.reason].map(esc).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dealer_import_errors_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Import Dealers from Excel"
      footer={result ? (
        <button className="btn-primary" onClick={onImported}>Done</button>
      ) : (
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={upload} disabled={!file || busy}>
            {busy ? 'Importing…' : 'Upload & Import'}
          </button>
        </>
      )}
    >
      <div className="space-y-4">
        {!result && (
          <>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700 space-y-2">
              <div className="font-semibold text-slate-900">Step 1 — Download the template</div>
              <p className="text-[13px]">
                Download the sample, fill the <b>Dealers</b> sheet, and re-upload.  Existing rows with the same
                <b> Firm Name + Place</b> are <b>updated</b>; new combinations are created.
              </p>
              <a className="btn-secondary inline-block" href={authUrl('/api/dealers/import-sample')}>Download Sample Excel</a>
            </div>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700 space-y-2">
              <div className="font-semibold text-slate-900">Step 2 — Upload the filled file</div>
              <p className="text-[13px]">
                Accepted: <code>.xlsx</code>, <code>.xls</code>, <code>.csv</code>.  Required columns: Firm Name, Place, Dealer Name.
              </p>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:font-semibold hover:file:bg-brand-100"
              />
              {file && (
                <div className="text-[12px] text-slate-500">Selected: <b>{file.name}</b> ({Math.round(file.size / 1024)} KB)</div>
              )}
            </div>
          </>
        )}

        {result && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-green-50 border border-green-200 p-3">
                <div className="text-[11px] text-green-700 uppercase">Created</div>
                <div className="text-2xl font-bold text-green-700">{result.createdCount}</div>
              </div>
              <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
                <div className="text-[11px] text-blue-700 uppercase">Updated</div>
                <div className="text-2xl font-bold text-blue-700">{result.updatedCount}</div>
              </div>
              <div className={`rounded-lg p-3 ${result.failedCount > 0 ? 'bg-amber-50 border border-amber-200' : 'bg-slate-50 border border-slate-200'}`}>
                <div className={`text-[11px] uppercase ${result.failedCount > 0 ? 'text-amber-700' : 'text-slate-500'}`}>Failed</div>
                <div className={`text-2xl font-bold ${result.failedCount > 0 ? 'text-amber-700' : 'text-slate-500'}`}>{result.failedCount}</div>
              </div>
            </div>
            <div className="text-xs text-slate-500">
              File: <span className="font-mono">{result.file}</span> · {result.totalRows} row(s) read.
            </div>
            {result.failed?.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold text-slate-800">Failed rows ({result.failed.length})</div>
                  <button className="btn-secondary !py-1 !text-xs" onClick={downloadFailedCsv}>Download Errors CSV</button>
                </div>
                <div className="max-h-72 overflow-y-auto border border-amber-100 rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-amber-50 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold text-amber-800 w-16">Row</th>
                        <th className="text-left px-3 py-2 font-semibold text-amber-800">Firm Name</th>
                        <th className="text-left px-3 py-2 font-semibold text-amber-800">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.failed.map((r, i) => (
                        <tr key={i} className="border-t border-amber-100">
                          <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{r.row}</td>
                          <td className="px-3 py-1.5 text-slate-700">{r.firmName}</td>
                          <td className="px-3 py-1.5 text-amber-800">{r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------------------------- Products tab ---------------------------- */

const blankProduct = { name: '', pricePerUnit: 0, nbvPercentage: 0, unit: 'L', description: '', active: true };

function ProductsTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
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
      <div className="flex justify-end gap-2 flex-wrap">
        <a className="btn-secondary" href={authUrl('/api/products/import-sample')}>Download Sample Excel</a>
        <button className="btn-secondary" onClick={() => setImportOpen(true)}>Import Products</button>
        <a className="btn-secondary" href={authUrl('/api/products/export')}>Export Products</a>
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
      {importOpen && (
        <ImportProductsModal
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); load(); }}
        />
      )}
    </div>
  );
}

/* ----- Bulk import modal ----- */
function ImportProductsModal({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const toast = useToast();

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/products/import', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(data);
      toast.success(`Created ${data.createdCount} · Updated ${data.updatedCount}${data.failedCount ? ` · Failed ${data.failedCount}` : ''}`);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const downloadFailedCsv = () => {
    if (!result?.failed?.length) return;
    const headers = ['Row Number', 'Product Name', 'Reason'];
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    result.failed.forEach((r) => lines.push([r.row, r.name, r.reason].map(esc).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `product_import_errors_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Import Products from Excel"
      footer={result ? (
        <button className="btn-primary" onClick={onImported}>Done</button>
      ) : (
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={upload} disabled={!file || busy}>
            {busy ? 'Importing…' : 'Upload & Import'}
          </button>
        </>
      )}
    >
      <div className="space-y-4">
        {!result && (
          <>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700 space-y-2">
              <div className="font-semibold text-slate-900">Step 1 — Download the template</div>
              <p className="text-[13px]">
                Download the sample, fill the <b>Products</b> sheet, and re-upload.  Existing products with the same name
                are <b>updated</b> (matched case-insensitively); new names are created.
              </p>
              <a className="btn-secondary inline-block" href={authUrl('/api/products/import-sample')}>Download Sample Excel</a>
            </div>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700 space-y-2">
              <div className="font-semibold text-slate-900">Step 2 — Upload the filled file</div>
              <p className="text-[13px]">
                Accepted: <code>.xlsx</code>, <code>.xls</code>, <code>.csv</code>.  Required columns: Product Name, Unit (L / KG), Price Per Unit (&gt; 0), NBV % (0–100).
              </p>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:font-semibold hover:file:bg-brand-100"
              />
              {file && (
                <div className="text-[12px] text-slate-500">Selected: <b>{file.name}</b> ({Math.round(file.size / 1024)} KB)</div>
              )}
            </div>
          </>
        )}

        {result && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-green-50 border border-green-200 p-3">
                <div className="text-[11px] text-green-700 uppercase">Created</div>
                <div className="text-2xl font-bold text-green-700">{result.createdCount}</div>
              </div>
              <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
                <div className="text-[11px] text-blue-700 uppercase">Updated</div>
                <div className="text-2xl font-bold text-blue-700">{result.updatedCount}</div>
              </div>
              <div className={`rounded-lg p-3 ${result.failedCount > 0 ? 'bg-amber-50 border border-amber-200' : 'bg-slate-50 border border-slate-200'}`}>
                <div className={`text-[11px] uppercase ${result.failedCount > 0 ? 'text-amber-700' : 'text-slate-500'}`}>Failed</div>
                <div className={`text-2xl font-bold ${result.failedCount > 0 ? 'text-amber-700' : 'text-slate-500'}`}>{result.failedCount}</div>
              </div>
            </div>
            <div className="text-xs text-slate-500">
              File: <span className="font-mono">{result.file}</span> · {result.totalRows} row(s) read.
            </div>
            {result.failed?.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold text-slate-800">Failed rows ({result.failed.length})</div>
                  <button className="btn-secondary !py-1 !text-xs" onClick={downloadFailedCsv}>Download Errors CSV</button>
                </div>
                <div className="max-h-72 overflow-y-auto border border-amber-100 rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-amber-50 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold text-amber-800 w-16">Row</th>
                        <th className="text-left px-3 py-2 font-semibold text-amber-800">Product Name</th>
                        <th className="text-left px-3 py-2 font-semibold text-amber-800">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.failed.map((r, i) => (
                        <tr key={i} className="border-t border-amber-100">
                          <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{r.row}</td>
                          <td className="px-3 py-1.5 text-slate-700">{r.name}</td>
                          <td className="px-3 py-1.5 text-amber-800">{r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
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
