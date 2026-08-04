/** Backend base URL — empty in local dev (Vite proxy), set in production build. */
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export const apiUrl = (path) => `${API_BASE}${path}`;

export const API = apiUrl('/api/pairs');

export const createSocket = (io) =>
  io(API_BASE || undefined, { path: '/socket.io' });
