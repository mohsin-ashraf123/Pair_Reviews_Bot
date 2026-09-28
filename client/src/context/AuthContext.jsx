import { createContext, useContext, useMemo, useState, useEffect } from 'react';
import axios from 'axios';
import { AUTH_KEY, getSession, apiUrl } from '../config/api.js';

const AuthContext = createContext(null);


export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    return getSession()?.username || null;
  });

  const login = async (username, password) => {
    const { data } = await axios.post(apiUrl('/api/auth/login'), { username, password });
    sessionStorage.setItem(AUTH_KEY, JSON.stringify(data));
    setUser(data.username);
    return true;
  };

  const logout = () => {
    sessionStorage.removeItem(AUTH_KEY);
    setUser(null);
  };

  useEffect(() => {
    const expire = () => setUser(null);
    window.addEventListener('auth-expired', expire);
    return () => window.removeEventListener('auth-expired', expire);
  }, []);

  const value = useMemo(
    () => ({
      user,
      isAuthenticated: Boolean(user),
      login,
      logout,
    }),
    [user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
