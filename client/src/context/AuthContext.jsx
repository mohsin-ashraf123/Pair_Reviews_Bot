import { createContext, useContext, useMemo, useState } from 'react';

const AuthContext = createContext(null);

const VALID_USERNAME = 'Admin';
const VALID_PASSWORD = 'Admin@123';
const AUTH_KEY = 'bot_auth';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    return localStorage.getItem(AUTH_KEY);
  });

  const login = (username, password) => {
    if (username === VALID_USERNAME && password === VALID_PASSWORD) {
      localStorage.setItem(AUTH_KEY, username);
      setUser(username);
      return true;
    }
    return false;
  };

  const logout = () => {
    localStorage.removeItem(AUTH_KEY);
    setUser(null);
  };

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
