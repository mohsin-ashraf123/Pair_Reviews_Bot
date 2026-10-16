import { createHash } from 'node:crypto';

// Version the hash when parsing semantics change. Include edits, membership and
// deleted messages (by their absence) so recovery refreshes changed reviews.
export const insightSourceHash = (messages) => createHash('sha256')
  .update(JSON.stringify(['v1', messages.map(m => [m.eventId, m.body, m.matchedPair, m.senderName])]))
  .digest('hex');
