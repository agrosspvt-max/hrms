import { useState } from 'react';
import api from '../api/axios';
import { useToast } from '../context/ToastContext.jsx';
import { errMsg } from '../utils/helpers';

export default function ChangePassword() {
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: cur, newPassword: nw });
      toast.success('Password updated');
      setCur(''); setNw('');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-md">
      <h1 className="text-xl font-bold text-slate-900 mb-4">Change password</h1>
      <form onSubmit={submit} className="card card-body space-y-3">
        <div>
          <label className="label">Current password</label>
          <input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} required />
        </div>
        <div>
          <label className="label">New password</label>
          <input className="input" type="password" value={nw} onChange={(e) => setNw(e.target.value)} required minLength={6} />
        </div>
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Updating...' : 'Update password'}</button>
      </form>
    </div>
  );
}
