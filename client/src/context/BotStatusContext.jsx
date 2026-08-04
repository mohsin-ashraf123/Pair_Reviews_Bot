import { createContext, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import { apiUrl } from '../config/api.js';

const BotStatusContext = createContext(null);

export function BotStatusProvider({ children }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await axios.get(apiUrl('/api/pairs/status'));
      setStatus(res.data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <BotStatusContext.Provider value={{ status, loading, refresh }}>
      {children}
    </BotStatusContext.Provider>
  );
}

export const useBotStatus = () => {
  const ctx = useContext(BotStatusContext);
  if (!ctx) {
    throw new Error('useBotStatus must be used within BotStatusProvider');
  }
  return ctx;
};
