import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';

export default function Designations() {
  const [items, setItems] = useState([]);
  const [modal, setModal] = useState(null);
  const toast = useToast();

  const load = async () => setItems((await api.get('/designations')).data);
  useEffect(() => { load(); }, []);

  const save = async (form) => {
    try {
      if (modal.mode === 'create') await api.post('/designations', form);
      else await api.put(`/designations/${modal.data._id}`, form);
      toast.success('Saved'); setModal(null); load();
    } catch (err) { toast.error(errMsg(err)); }
  };
  const del = async (id) => {
    if (!confirm('Delete designation?')) return;
    try { await api.delete(`/designations/${id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Designations</h1>
        <button className="btn-primary" onClick={() => setModal({ mode: 'create', data: { title: '', description: '' } })}>+ Add</button>
      </div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Title</th><th>Description</th><th></th></tr></thead>
          <tbody>
            {items.map((d) => (
              <tr key={d._id}>
                <td className="font-medium">{d.title}</td>
                <td className="text-slate-500">{d.description}</td>
                <td className="text-right">
                  <button className="btn-ghost" onClick={() => setModal({ mode: 'edit', data: d })}>Edit</button>
                  <button className="btn-ghost text-red-600" onClick={() => del(d._id)}>Delete</button>
                </td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan="3" className="text-center py-8 text-slate-500">No designations yet</td></tr>}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal open onClose={() => setModal(null)} title={modal.mode === 'create' ? 'Add Designation' : 'Edit Designation'}
          footer={<>
            <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => save(modal.data)}>Save</button>
          </>}>
          <div className="space-y-3">
            <div><label className="label">Title</label><input className="input" value={modal.data.title} onChange={(e) => setModal({ ...modal, data: { ...modal.data, title: e.target.value } })} /></div>
            <div><label className="label">Description</label><input className="input" value={modal.data.description || ''} onChange={(e) => setModal({ ...modal, data: { ...modal.data, description: e.target.value } })} /></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
