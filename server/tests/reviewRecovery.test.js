import test from 'node:test';
import assert from 'node:assert/strict';
import { DecryptionRetryCache, fetchRecoveryEvents, REVIEW_RECOVERY_WINDOW_MS } from '../services/reviewRecovery.js';
import { parseMentionedMembers, findMatchingPair } from '../services/reviewService.js';

test('screenshot review identifies both assigned members', () => {
  const body = 'Uzair + Mohsin:\nReview completed. No issues, concerns, or improvement recommendations identified';
  assert.deepEqual(findMatchingPair(parseMentionedMembers(body), [['Uzair', 'Mohsin']]), ['Uzair', 'Mohsin']);
});

test('failed decryption retries after keys have had time to arrive', () => {
  const cache = new DecryptionRetryCache({ cooldownMs: 100 });
  cache.add('review', 1000);
  assert.equal(cache.has('review', 1099), true);
  assert.equal(cache.has('review', 1100), false);
  cache.add('review', 1200);
  cache.delete('review');
  assert.equal(cache.has('review', 1201), false);
});

test('retry cache bounds memory', () => {
  const cache = new DecryptionRetryCache({ maxEntries: 2 });
  for (const id of ['a', 'b', 'c']) cache.add(id, 0);
  assert.equal(cache.size, 2);
  assert.equal(cache.has('a', 1), false);
});

test('Monday recovery paginates past recent traffic to a Friday review', async () => {
  const monday = Date.parse('2026-09-28T06:00:00Z');
  const friday = Date.parse('2026-09-25T14:20:00Z');
  const pages = [
    { chunk: [{ event_id: 'new', origin_server_ts: monday }], end: 'page2' },
    { chunk: [{ event_id: 'review', origin_server_ts: friday }], end: 'page3' },
    { chunk: [{ event_id: 'old', origin_server_ts: monday - REVIEW_RECOVERY_WINDOW_MS - 1 }], end: 'page4' },
  ];
  const calls = [];
  const client = { doRequest: async (...args) => { calls.push(args); return pages.shift(); } };
  const result = await fetchRecoveryEvents(client, '!room', { oldestAllowed: monday - REVIEW_RECOVERY_WINDOW_MS });
  assert.deepEqual(result.map(e => e.event_id), ['review', 'new']);
  assert.equal(calls[1][2].from, 'page2');
  assert.equal(calls.length, 3);
});

test('repeated pagination token cannot loop forever', async () => {
  let calls = 0;
  const client = { doRequest: async () => { calls++; return { chunk: [{ event_id: 'a', origin_server_ts: 10 }], end: 'same' }; } };
  const result = await fetchRecoveryEvents(client, '!room', { oldestAllowed: 0 });
  assert.equal(calls, 2);
  assert.equal(result.length, 1);
});
