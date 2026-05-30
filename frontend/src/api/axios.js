import axios from "axios";
// change1
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "/api",
});

// Attach JWT on every request if we have one
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("hrms_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// 401 -> clear session and bounce to login
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      localStorage.removeItem("hrms_token");
      localStorage.removeItem("hrms_user");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

export default api;
