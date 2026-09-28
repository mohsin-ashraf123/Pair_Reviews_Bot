// Serialize changes to one conversation/day without blocking unrelated members.
export const createKeyedQueue = () => {
  const pending = new Map();
  return async (key, action) => {
    const previous = pending.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    pending.set(key, next);
    try { return await next; }
    finally { if (pending.get(key) === next) pending.delete(key); }
  };
};
