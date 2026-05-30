import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import api from '../api/axios';
import Modal from '../components/Modal.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { errMsg } from '../utils/helpers.js';

export default function Login() {
  const { login, user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(email, password);
      toast.success('Welcome back!');
      nav('/');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLoading(false);
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
              <div className="text-xs text-slate-500">Workflow • Attendance • Salary</div>
            </div>
          </div>
          <h1 className="text-xl font-bold text-slate-900">Sign in to your account</h1>
          <p className="text-sm text-slate-500 mt-1">Enter your credentials to continue.</p>
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label className="label">Email</label>
              <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
            </div>
            <div>
              <label className="label">Password</label>
              <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
            <div className="text-center">
              <button
                type="button"
                className="text-xs text-brand-600 hover:underline"
                onClick={() => setForgotOpen(true)}
              >
                Forgot password?
              </button>
            </div>
          </form>
        </div>
      </div>
      {forgotOpen && <ForgotPasswordModal onClose={() => setForgotOpen(false)} />}
    </div>
  );
}

function ForgotPasswordModal({ onClose }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const toast = useToast();

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/password-reset/request', { email });
      setSent(true);
      toast.success('Password reset request sent to HR for approval.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Forgot Password"
      footer={sent ? (
        <button className="btn-primary" onClick={onClose}>Done</button>
      ) : (<>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || !email} onClick={submit}>
          {busy ? 'Sending...' : 'Send Request'}
        </button>
      </>)}
    >
      {sent ? (
        <div className="text-sm text-slate-700 space-y-2">
          <div className="flex items-center gap-2 text-green-700 font-semibold">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg>
            Request submitted.
          </div>
          <p>
            We've notified HR. Once they approve your request you'll receive an email with a
            one-time secure link to set a new password.
          </p>
          <p className="text-[11px] text-slate-500">
            If you don't see anything in your inbox within 30 minutes, check your spam folder
            or contact HR directly.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-slate-600">
            Enter your registered work email. HR will review your request and email you a
            secure password reset link if approved.
          </p>
          <div>
            <label className="label">Work email</label>
            <input
              className="input"
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>
        </form>
      )}
    </Modal>
  );
}
