import test from 'node:test';
import assert from 'node:assert/strict';
import AiConfig from '../models/AiConfig.js';
import RoomMessage from '../models/RoomMessage.js';
import MonthlyMemberInsight from '../models/MonthlyMemberInsight.js';
import MonthlyRankingReport from '../models/MonthlyRankingReport.js';
import InsightProcessingState from '../models/InsightProcessingState.js';
import { parseReviewInsights, processDateReviews, generateMonthlyReport, backfillDateRange } from '../services/rankingService.js';

test('ordinary reviews parse without referencing monthly report generation state', async t => {
  t.mock.method(AiConfig, 'findOne', async () => ({ apiKey: '', modelId: '' }));
  t.mock.method(MonthlyRankingReport, 'findOne', () => assert.fail('Parsing must not look up a monthly report'));
  const parsed = await parseReviewInsights('Uzair + Mohsin\nSuggestion:\nUzair: Add validation\nIssue:\nMohsin: Fix delayed loading', ['Uzair', 'Mohsin'], 'developer');
  assert.deepEqual(parsed.items.map(({ member, type }) => [member, type]), [['Uzair', 'suggestion'], ['Mohsin', 'issue']]);
});

test('insight recovery saves, skips unchanged sources, and refreshes edited/deleted reviews', async t => {
  let messages = [{ eventId: 'one', body: 'Uzair + Mohsin\nSuggestion:\nUzair: Add validation', matchedPair: ['Uzair', 'Mohsin'] }];
  let state;
  const rows = new Map();
  t.mock.method(AiConfig, 'findOne', async () => ({ apiKey: '', modelId: '' }));
  t.mock.method(RoomMessage, 'find', () => ({ sort: () => ({ lean: async () => messages }) }));
  t.mock.method(InsightProcessingState, 'findOne', () => ({ lean: async () => state }));
  t.mock.method(InsightProcessingState, 'findOneAndUpdate', async (_q, update) => { state = update.$set; });
  t.mock.method(MonthlyMemberInsight, 'findOneAndUpdate', async (q, update) => rows.set(q.member, update.$set));
  t.mock.method(MonthlyMemberInsight, 'deleteMany', async q => {
    for (const member of rows.keys()) if (!q.member.$nin.includes(member)) rows.delete(member);
  });
  assert.equal((await processDateReviews('2026-10-01')).processed, 2);
  assert.equal(rows.get('Uzair').items[0].text, 'Add validation');
  assert.equal(rows.get('Mohsin').emptyReview, false);
  assert.equal((await processDateReviews('2026-10-01')).skipped, 'Already processed');
  messages[0].body = 'Uzair + Mohsin\nIssue:\nMohsin: Fix loading';
  await processDateReviews('2026-10-01');
  assert.deepEqual(rows.get('Uzair').items, []);
  assert.equal(rows.get('Mohsin').items[0].type, 'issue');
  messages = [];
  await processDateReviews('2026-10-01');
  assert.equal(rows.size, 0);
});

test('a processing failure does not mark the date complete or clear existing insights', async t => {
  t.mock.method(RoomMessage, 'find', () => ({ sort: () => ({ lean: async () => [{ eventId: 'one', body: 'Uzair: Suggestion', matchedPair: ['Uzair', 'Mohsin'] }] }) }));
  t.mock.method(InsightProcessingState, 'findOne', () => ({ lean: async () => null }));
  t.mock.method(AiConfig, 'findOne', async () => { throw Error('settings unavailable'); });
  t.mock.method(InsightProcessingState, 'findOneAndUpdate', () => assert.fail('Must remain retryable'));
  t.mock.method(MonthlyMemberInsight, 'deleteMany', () => assert.fail('Must preserve existing data'));
  await assert.rejects(processDateReviews('2026-10-02'), /settings unavailable/);
});

test('sent monthly reports cannot be regenerated, while insight parsing remains independent', async t => {
  t.mock.method(MonthlyRankingReport, 'findOne', async () => ({ eventId: 'already-sent' }));
  t.mock.method(MonthlyRankingReport, 'updateOne', async () => {});
  await assert.rejects(generateMonthlyReport('2026-09'), /already been sent/);
});

test('manual backfill stops at the selected month instead of processing later months', async t => {
  const queried = [];
  t.mock.method(RoomMessage, 'find', q => { queried.push(q.dateKey); return { sort: () => ({ lean: async () => [] }) }; });
  t.mock.method(InsightProcessingState, 'findOne', () => ({ lean: async () => null }));
  const result = await backfillDateRange('2026-09-01', '2026-09-30');
  assert.equal(result.endDateKey, '2026-09-30');
  assert.ok(queried.length > 0);
  assert.ok(queried.every(date => date.startsWith('2026-09-')));
  assert.equal(result.failedDays, 0);
});
