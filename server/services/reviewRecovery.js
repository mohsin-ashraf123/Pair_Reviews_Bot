// Cover weekends and short outages without scanning unlimited room history.
export const REVIEW_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export class DecryptionRetryCache {
  constructor({ cooldownMs = 60_000, maxEntries = 2000 } = {}) {
    this.cooldownMs = cooldownMs;
    this.maxEntries = maxEntries;
    this.failures = new Map();
  }

  add(eventId, now = Date.now()) {
    if (!eventId) return;
    this.failures.delete(eventId);
    this.failures.set(eventId, now + this.cooldownMs);
    if (this.failures.size > this.maxEntries) {
      this.failures.delete(this.failures.keys().next().value);
    }
  }

  has(eventId, now = Date.now()) {
    const retryAt = this.failures.get(eventId);
    if (retryAt === undefined) return false;
    if (now < retryAt) return true;
    this.failures.delete(eventId);
    return false;
  }

  delete(eventId) { this.failures.delete(eventId); }
  get size() { return this.failures.size; }
}

export const fetchRecoveryEvents = async (client, roomId, {
  limit = 50, oldestAllowed, maxPages = 20,
}) => {
  const events = new Map();
  let from;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await client.doRequest('GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
      { dir: 'b', limit: Math.max(1, Math.min(Number(limit) || 50, 100)), ...(from ? { from } : {}) });
    const chunk = response?.chunk || [];
    for (const event of chunk) {
      if (event.event_id && Number(event.origin_server_ts) >= oldestAllowed) {
        events.set(event.event_id, event);
      }
    }
    if (!chunk.length || chunk.some(e => Number(e.origin_server_ts) < oldestAllowed)
      || !response.end || response.end === from) break;
    from = response.end;
  }
  return [...events.values()].sort((a, b) => a.origin_server_ts - b.origin_server_ts);
};
