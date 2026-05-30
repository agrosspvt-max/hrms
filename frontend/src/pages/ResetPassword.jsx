import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api/axios';
import { useToast } from '../context/ToastContext.jsx';
import { errMsg } from '../utils/helpers';

/**
 * Public reset-password landing page.  Pull `token` from the URL,
 * validate it on mount, and present a two-field new-password form.
 */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [state, setState] = useState({ loading: true, valid: false, employee: null, error: '' });
  const [pwd, setPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const toast = useToast();
  const nav = useNavigate();

  useEffect(() => {
    if (!token) {
      setState({ loading: false, valid: false, error: 'Missing token in URL.' });
      return;
    }
    api.get('/password-reset/validate', { params: { token } })
      .then(({ data }) => setState({ loading: false, valid: true, employee: data.employee, error: '' }))
      .catch((err) => setState({ loading: false, valid: false, error: errMsg(err) }));
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (pwd.length < 6) {
      toast.error('Password must be at least 6 characters.');
      return;
    }
    if (pwd !== confirmPwd) {
      toast.error('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/password-reset/reset', { token, newPassword: pwd });
      toast.success('Password reset successful.');
      setDone(true);
      setTimeout(() => nav('/login'), 1800);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-50 via-white to-slate-100 p-4">
      <div className="card w-full max-w-md">
        <div className="card-body">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-lg bg-brand-600 text-white grid place-items-center font-bold text-lg">H</div>
            <div>
              <div className="font-semibold text-slate-900">HRMS Platform</div>
              <div className="text-xs text-slate-500">Set a new password</div>
            </div>
          </div>

          {state.loading && (
            <div className="text-sm text-slate-500 flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              Validating link...
            </div>
          )}

          {!state.loading && !state.valid && (
            <div className="space-y-3">
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                <div className="font-semibold mb-1">Invalid or expired reset link.</div>
                <div>{state.error}</div>
              </div>
              <p className="text-xs text-slate-500">
                Ask HR to issue a fresh approval, or request a new reset from the login page.
              </p>
              <Link to="/login" className="btn-primary w-full">Back to login</Link>
            </div>
          )}

          {!state.loading && state.valid && !done && (
            <form onSubmit={submit} className="space-y-4">
              <div className="bg-slate-50 rounded-lg p-3 text-sm">
                Resetting password for <b>{state.employee?.name}</b>
                <div className="text-[11px] text-slate-500">{state.employee?.email}</div>
              </div>
              <div>
                <label className="label">New password</label>
                <input
                  className="input"
                  type="password"
                  minLength={6}
                  required
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                  placeholder="At least 6 characters"
                />
              </div>
              <div>
                <label className="label">Confirm new password</label>
                <input
                  className="input"
                  type="password"
                  minLength={6}
                  required
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                />
                {confirmPwd && pwd !== confirmPwd && (
                  <div className="text-xs text-red-600 mt-1">Passwords don't match.</div>
                )}
              </div>
              <button className="btn-primary w-full" disabled={busy}>
                {busy ? 'Resetting...' : 'Reset Password'}
              </button>
              <div className="text-[11px] text-slate-500 text-center">
                This link can only be used once and will expire shortly.
              </div>
            </form>
          )}

          {done && (
            <div className="space-y-3">
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
                <div className="font-semibold">Password reset successful.</div>
                <div className="text-xs">Redirecting to login...</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
