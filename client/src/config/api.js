import axios from 'axios';

export const AUTH_KEY = 'bot_session';
export const getSession = () => {
  try { return JSON.parse(sessionStorage.getItem(AUTH_KEY)) || null; } catch { return null; }
};
/** Backend base URL — empty in local dev (Vite proxy), set in production build. */
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export const apiUrl = (path) => `${API_BASE}${path}`;

export const API = apiUrl('/api/pairs');

axios.interceptors.request.use((request) => {
  const url = new URL(request.url, window.location.origin);
  const base = new URL(API, window.location.origin);
  if (url.origin === base.origin && url.pathname.startsWith('/api/pairs')) {
    const token = getSession()?.token;
    if (token) request.headers.Authorization = `Bearer ${token}`;
  }
  return request;
});
axios.interceptors.response.use(response => response, error => {
  if (error.response?.status === 401 && error.response?.data?.code === 'AUTH_REQUIRED') {
    sessionStorage.removeItem(AUTH_KEY);
    window.dispatchEvent(new Event('auth-expired'));
  }
  return Promise.reject(error);
});

export const createSocket = (io) =>
  io(API_BASE || undefined, { path: '/socket.io', auth: { token: getSession()?.token } });
