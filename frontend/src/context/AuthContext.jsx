import { createContext, useContext, useEffect, useState } from 'react';
import api from '../api/axios';
// Phase 47 -- single SSE connection per session so cross-user updates
// land without a manual refresh.  Opens on login + on app boot when a
// token already exists; closes on logout.
import { connectRealtime, disconnectRealtime } from '../realtime';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('hrms_user');
    return raw ? JSON.parse(raw) : null;
  });
  const [loading, setLoading] = useState(false);

  const login = async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password });
    localStorage.setItem('hrms_token', data.token);
    localStorage.setItem('hrms_user', JSON.stringify(data.user));
    setUser(data.user);
    // Phase 47 -- open realtime as soon as we have a token.
    connectRealtime(data.token);
    return data.user;
  };

  const logout = () => {
    disconnectRealtime();
    localStorage.removeItem('hrms_token');
    localStorage.removeItem('hrms_user');
    setUser(null);
  };

  // Refresh /me when token exists (keeps department/designation populated)
  useEffect(() => {
    const token = localStorage.getItem('hrms_token');
    if (!token) return;
    // Phase 47 -- bootstrap the realtime stream on app reload (the user
    // is already logged in via persisted token).  Safe to call before
    // /me returns; the server doesn't need user metadata to fan out.
    connectRealtime(token);
    api.get('/auth/me').then(({ data }) => {
      localStorage.setItem('hrms_user', JSON.stringify(data));
      setUser(data);
    }).catch(() => {});
    return () => disconnectRealtime();
  }, []);

  return (
    <AuthContext.Provider value={{ user, login, logout, loading, setLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
