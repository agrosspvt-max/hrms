import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { fmtDate, errMsg } from '../../utils/helpers';

/**
 * CompanyDocuments
 * ------------------------------------------------------------------
 * Section rendered inside the Contacts page.  HR / Super Admin see
 * the management UI (upload / edit / replace / delete + hidden
 * documents); employees see a compact read-only list with a View
 * button.
 *
 * Consumes:
 *   GET    /api/company-documents          -- list (scoped by role)
 *   POST   /api/company-documents          -- upload (multipart)
 *   PATCH  /api/company-documents/:id      -- edit metadata
 *   PUT    /api/company-documents/:id/file -- replace PDF
 *   DELETE /api/company-documents/:id      -- remove
 *   GET    /api/company-documents/:id/inline -- PDF stream (viewer)
 *
 * Reuses:
 *   - components/Modal.jsx (upload + edit + fullscreen viewer)
 *   - context/AuthContext (role gating)
 *   - context/ToastContext
 *   - api/axios (JWT is attached automatically for the blob fetch)
 */
export default function CompanyDocuments() {
  const { user } = useAuth();
  const toast = useToast();
  const canManage = user?.role === 'hr' || user?.role === 'super_admin';

  const [docs, setDocs]         = useState(null);
  const [err, setErr]           = useState(null);
  const [modal, setModal]       = useState(null);   // { mode:'create'|'edit', doc? }
  const [replaceFor, setReplaceFor] = useState(null);
  const [viewing, setViewing]   = useState(null);   // { doc, blobUrl }
  const [busyId, setBusyId]     = useState(null);

  const load = () => {
    setDocs(null); setErr(null);
    api.get('/company-documents')
      .then(({ data }) => setDocs(data))
      .catch((e) => setErr(errMsg(e)));
  };
  useEffect(load, []);

  const openView = async (doc) => {
    try {
      const { data } = await api.get(`/company-documents/${doc._id}/inline`, { responseType: 'blob' });
      const blobUrl = URL.createObjectURL(data);
      setViewing({ doc, blobUrl });
    } catch (e) { toast.error(errMsg(e)); }
  };

  const closeView = () => {
    if (viewing?.blobUrl) URL.revokeObjectURL(viewing.blobUrl);
    setViewing(null);
  };
  // Revoke on unmount.
  useEffect(() => () => { if (viewing?.blobUrl) URL.revokeObjectURL(viewing.blobUrl); }, [viewing]);

  const remove = async (doc) => {
    if (!window.confirm(`Delete "${doc.title}"? This cannot be undone.`)) return;
    setBusyId(doc._id);
    try {
      await api.delete(`/company-documents/${doc._id}`);
      toast.success('Document deleted.');
      load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusyId(null); }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-2 flex-wrap">
        <div>
          <p className="text-sm text-slate-500">
            {canManage
              ? 'HR-managed document library. Employees see documents marked "Visible to employees".'
              : 'Documents shared by your organisation. Click View to read.'}
          </p>
        </div>
        {canManage && (
          <button className="btn-primary" onClick={() => setModal({ mode: 'create' })}>
            + Upload Document
          </button>
        )}
      </div>

      {err && <div className="text-sm text-red-600 border rounded-md p-2 bg-red-50">{err}</div>}
      {!err && !docs && <Loader />}
      {docs && docs.length === 0 && (
        <EmptyState title="No company documents available." subtitle={canManage ? 'Upload your first document above.' : 'Ask HR to add documents to the library.'} />
      )}

      {docs && docs.length > 0 && (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {docs.map((d) => (
            <div key={d._id} className="card card-body flex flex-col gap-2">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-red-50 text-red-600 grid place-items-center text-lg shrink-0">
                  📄
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-800 truncate">{d.title}</span>
                    {canManage && !d.visibleToEmployees && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">HR only</span>
                    )}
                    {canManage && !d.isActive && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Inactive</span>
                    )}
                  </div>
                  {d.description && (
                    <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">{d.description}</div>
                  )}
                  {d.effectiveDate && (
                    <div className="text-[11px] text-slate-500 mt-1">Effective: {fmtDate(d.effectiveDate)}</div>
                  )}
                  {canManage && (
                    <div className="text-[11px] text-slate-400 mt-1">
                      Uploaded by {d.uploadedBy?.name || 'HR'}
                      {d.uploadedAt ? ` · ${new Date(d.uploadedAt).toLocaleDateString()}` : ''}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-wrap pt-1 border-t border-slate-100">
                <button className="btn-primary !py-1 !text-xs" onClick={() => openView(d)}>View</button>
                {canManage && (
                  <>
                    <button className="btn-secondary !py-1 !text-xs" onClick={() => setModal({ mode: 'edit', doc: d })}>Edit</button>
                    <button className="btn-secondary !py-1 !text-xs" onClick={() => setReplaceFor(d)}>Replace</button>
                    <button className="btn-secondary !py-1 !text-xs text-red-600 ml-auto" disabled={busyId === d._id} onClick={() => remove(d)}>Delete</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <DocumentFormModal
          mode={modal.mode}
          doc={modal.doc}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
      {replaceFor && (
        <ReplaceFileModal
          doc={replaceFor}
          onClose={() => setReplaceFor(null)}
          onSaved={() => { setReplaceFor(null); load(); }}
        />
      )}
      {viewing && (
        <PdfViewerModal
          doc={viewing.doc}
          blobUrl={viewing.blobUrl}
          onClose={closeView}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Upload / Edit modal.                                                */
/* ------------------------------------------------------------------ */
function DocumentFormModal({ mode, doc, onClose, onSaved }) {
  const toast = useToast();
  const isEdit = mode === 'edit';
  const [title, setTitle]         = useState(doc?.title || '');
  const [description, setDesc]    = useState(doc?.description || '');
  const [effective, setEffective] = useState(doc?.effectiveDate ? new Date(doc.effectiveDate).toISOString().slice(0, 10) : '');
  const [visible, setVisible]     = useState(doc ? !!doc.visibleToEmployees : true);
  const [file, setFile]           = useState(null);
  const [saving, setSaving]       = useState(false);

  const canSubmit = title.trim().length > 0 && (isEdit || !!file) && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      if (isEdit) {
        await api.patch(`/company-documents/${doc._id}`, {
          title: title.trim(),
          description: description.trim(),
          effectiveDate: effective || null,
          visibleToEmployees: !!visible,
        });
        toast.success('Document updated.');
      } else {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('title', title.trim());
        fd.append('description', description.trim());
        if (effective) fd.append('effectiveDate', effective);
        fd.append('visibleToEmployees', String(!!visible));
        await api.post('/company-documents', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        toast.success('Document uploaded.');
      }
      onSaved && onSaved();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={isEdit ? 'Edit document' : 'Upload document'}
      size="md"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={!canSubmit}>
            {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Upload')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">Title <span className="text-red-600">*</span></label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. HR Policy" />
        </div>
        <div>
          <label className="label">Description (optional)</label>
          <textarea className="input" rows={2} value={description} onChange={(e) => setDesc(e.target.value)} placeholder="Short summary shown alongside the title." />
        </div>
        {!isEdit && (
          <div>
            <label className="label">PDF file <span className="text-red-600">*</span></label>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-slate-700"
            />
            <div className="text-[11px] text-slate-500 mt-1">PDF only. Max 10 MB.</div>
          </div>
        )}
        <div>
          <label className="label">Effective date (optional)</label>
          <input type="date" className="input" value={effective} onChange={(e) => setEffective(e.target.value)} />
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
            Visible to employees
          </label>
          <div className="text-[11px] text-slate-500 ml-6">
            When off, only HR / Super Admin see this document.
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Replace file modal.                                                 */
/* ------------------------------------------------------------------ */
function ReplaceFileModal({ doc, onClose, onSaved }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!file) return;
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.put(`/company-documents/${doc._id}/file`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('File replaced.');
      onSaved && onSaved();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Replace file for "${doc.title}"`}
      size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={!file || saving}>
            {saving ? 'Uploading…' : 'Replace'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="text-xs text-slate-500">
          Uploading a new PDF replaces the current file. Metadata (title, description, effective date) is preserved.
        </div>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="block w-full text-sm text-slate-700"
        />
        <div className="text-[11px] text-slate-500">PDF only. Max 10 MB.</div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Fullscreen PDF viewer.  Uses a blob URL so the browser's built-in    */
/* PDF renderer takes over -- scroll, zoom and pagination come for      */
/* free without pulling in a heavy PDF.js dependency.                   */
/* ------------------------------------------------------------------ */
function PdfViewerModal({ doc, blobUrl, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex flex-col">
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{doc.title}</div>
          <div className="text-[11px] text-slate-500 truncate">
            {doc.fileName}
            {doc.effectiveDate ? ` · Effective ${new Date(doc.effectiveDate).toLocaleDateString()}` : ''}
          </div>
        </div>
        <button className="btn-secondary" onClick={onClose}>Close</button>
      </header>
      <div className="flex-1 bg-slate-900">
        <iframe
          title={doc.title}
          src={blobUrl}
          className="w-full h-full border-0 bg-slate-900"
        />
      </div>
    </div>
  );
}
