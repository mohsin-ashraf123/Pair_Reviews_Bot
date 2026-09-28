import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedQueue } from '../services/keyedQueue.js';
import { mergeSubmittedPairs, nextUnverifiedIndex } from '../services/leadQueue.js';
import { isValidDateKey, validateMonth, previousMonthKey } from '../services/dateValidation.js';
import { parseYesNo } from '../services/yesNoParse.js';
import { issueToken, verifyToken, requireDashboardAuth, loginDashboard } from '../services/dashboardAuth.js';
import DailyReview from '../models/DailyReview.js';
import RoomMessage from '../models/RoomMessage.js';
import { config } from '../config/appConfig.js';
import { recordReviewFromMessage, handleReviewMessageDeleted } from '../services/reviewService.js';
import express from 'express';
import { persistAndBroadcastMessage, handleIncomingMatrixMessage } from '../services/roomMessageService.js';

test('late submission preserves displayed verification and skips completed decisions', () => {
  const a = ['Uzair', 'Mohsin'], b = ['Farhan', 'Faz'], c = ['Habiba', 'Aqeel', 'Adil'];
  const merged = mergeSubmittedPairs([b, c], [a, b, c]);
  assert.deepEqual(merged, [b, c, a]);
  assert.equal(nextUnverifiedIndex(merged, [{ pair: b }, { pair: c }]), 2);
});

test('one conversation serializes replies; a failure does not block later replies', async () => {
  const queue = createKeyedQueue();
  const steps = [];
  await Promise.all([
    queue('lead', async () => { await Promise.resolve(); steps.push(1); throw Error('send failed'); }).catch(() => {}),
    queue('lead', async () => { steps.push(2); }),
  ]);
  assert.deepEqual(steps, [1, 2]);
});

test('date validation rejects rollover dates and fractional/unbounded months', () => {
  assert.equal(isValidDateKey('2026-02-30'), false);
  assert.equal(isValidDateKey('2028-02-29'), true);
  for (const [y, m] of [[2026, 1.5], [Infinity, 1], [2026, 13], [100000, 1]]) assert.throws(() => validateMonth(y, m));
  assert.equal(previousMonthKey('2026-01-01'), '2025-12');
  assert.equal(previousMonthKey('2026-10-01'), '2026-09');
});

test('ordinary words no longer count as NO', () => {
  for (const word of ['now', 'go', 'do', 'not']) assert.equal(parseYesNo(word), null);
  assert.equal(parseYesNo('NO!'), 'no');
  assert.equal(parseYesNo('Yse'), 'yes');
});

test('dashboard rejects anonymous, tampered and expired access, and validates server credentials', () => {
  const before = { password: process.env.ADMIN_PASSWORD, username: process.env.ADMIN_USERNAME };
  process.env.ADMIN_PASSWORD = 'test-only-long-password';
  process.env.ADMIN_USERNAME = 'TestAdmin';
  try {
    const token = issueToken('TestAdmin', 1000);
    assert.equal(verifyToken(token, 1001)?.username, 'TestAdmin');
    assert.equal(verifyToken(token + 'x', 1001), null);
    assert.equal(verifyToken(token, 1000 + 12 * 60 * 60 * 1000), null);
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    requireDashboardAuth({ headers: {} }, res, () => assert.fail('anonymous access'));
    assert.equal(res.code, 401);
    loginDashboard({ ip: 'test', body: { username: 'TestAdmin', password: 'wrong' } }, res);
    assert.equal(res.code, 401);
    loginDashboard({ ip: 'test', body: { username: 'TestAdmin', password: process.env.ADMIN_PASSWORD } }, res);
    assert.ok(res.body.token);
    delete process.env.ADMIN_PASSWORD;
    assert.equal(verifyToken(token, 1001), null);
  } finally {
    for (const [key, value] of [['ADMIN_PASSWORD', before.password], ['ADMIN_USERNAME', before.username]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('review provenance, full QA after partial, duplicate fallback and redaction', async t => {
  const pair = ['Habiba', 'Aqeel', 'Adil'];
  const dateKey = '2026-09-25';
  const review = { dateKey, pairs: [pair], pairsSentAt: new Date(), reviewedMembers: [], save: async () => {} };
  const first = { eventId: 'first', dateKey, roomId: config.matrix.roomId, direction: 'in', countsAsReview: true, matchedPair: pair.slice(0, 2), pairKey: 'Adil|Aqeel|Habiba' };
  const second = { eventId: 'second', dateKey, roomId: config.matrix.roomId, direction: 'in', countsAsReview: false };
  const messages = [first, second];
  t.mock.method(DailyReview, 'findOne', async () => review);
  t.mock.method(RoomMessage, 'findOne', async query => query.eventId && typeof query.eventId === 'string'
    ? messages.find(m => m.eventId === query.eventId)
    : messages.find(m => m.eventId !== query.eventId?.$ne && m.countsAsReview && !m.deletedAt));
  t.mock.method(RoomMessage, 'find', async () => messages.filter(m => m.countsAsReview && !m.deletedAt));
  t.mock.method(RoomMessage, 'updateMany', async () => {});
  t.mock.method(RoomMessage, 'updateOne', async (query, change) => {
    const msg = messages.find(m => m.eventId === query.eventId);
    Object.assign(msg, change.$set || change);
    for (const key of Object.keys(change.$unset || {})) delete msg[key];
  });
  second.roomId = '!unrelated';
  assert.equal((await recordReviewFromMessage(pair.join(' + '), dateKey, 'second')).status, 'ignored');
  second.roomId = config.matrix.roomId;
  assert.equal((await recordReviewFromMessage(pair.join(' + '), dateKey, 'second')).status, 'success');
  assert.deepEqual(new Set(review.reviewedMembers), new Set(pair));
  first.matchedPair = pair;
  assert.equal((await recordReviewFromMessage(pair.join(' + '), dateKey, 'second')).status, 'duplicate_pair');
  await handleReviewMessageDeleted('first');
  assert.ok(first.deletedAt);
  assert.deepEqual(new Set(review.reviewedMembers), new Set(pair));
  assert.equal((await recordReviewFromMessage(pair.join(' + '), dateKey, 'first')).status, 'ignored');
});

test('HTTP API requires a real login token', async () => {
  const original = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = 'local-integration-only-password';
  const app = express();
  app.use(express.json());
  app.post('/login', loginDashboard);
  app.get('/private', requireDashboardAuth, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/private`)).status, 401);
    const response = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: process.env.ADMIN_USERNAME || 'Admin', password: process.env.ADMIN_PASSWORD }) });
    const { token } = await response.json();
    assert.ok(token);
    assert.equal((await fetch(`${base}/private`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (original === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = original;
  }
});

test('another sender cannot edit a saved review', async t => {
  const original = { eventId: 'original', roomId: '!main', senderId: '@owner', body: 'original body', save: () => assert.fail('must not save') };
  t.mock.method(RoomMessage, 'findOne', async ({ eventId }) => eventId === 'original' ? original : null);
  const result = await persistAndBroadcastMessage({ eventId: 'edit', replacesEventId: 'original', roomId: '!main', senderId: '@someone-else', body: 'changed' });
  assert.equal(result.body, 'original body');
});

test('a stored message is retryable after attendance processing fails', async t => {
  const eventId = 'retry-after-db-failure';
  const stored = { _id: 'id', eventId, direction: 'in', category: 'team_review', dateKey: '2026-09-25',
    roomId: config.matrix.roomId, senderId: '@member', body: 'hello', sentAt: new Date('2026-09-25T14:00:00Z') };
  let attempts = 0;
  t.mock.method(RoomMessage, 'findOne', async () => stored);
  t.mock.method(RoomMessage, 'findOneAndUpdate', async () => assert.fail('existing body must not be overwritten'));
  t.mock.method(RoomMessage, 'updateOne', async (_query, update) => Object.assign(stored, update.$set));
  t.mock.method(DailyReview, 'findOne', async () => {
    if (++attempts === 1) throw Error('temporary database failure');
    return { pairsSentAt: new Date(), pairs: [['Uzair', 'Mohsin']] };
  });
  const event = { event_id: eventId, origin_server_ts: stored.sentAt.getTime(), sender: '@member', content: { body: 'hello', msgtype: 'm.text' } };
  await handleIncomingMatrixMessage(config.matrix.roomId, event, '@bot');
  assert.equal(stored.reviewProcessedAt, undefined);
  await handleIncomingMatrixMessage(config.matrix.roomId, event, '@bot');
  assert.equal(attempts, 2);
  assert.ok(stored.reviewProcessedAt);
  await handleIncomingMatrixMessage(config.matrix.roomId, event, '@bot');
  assert.equal(attempts, 2);
});
