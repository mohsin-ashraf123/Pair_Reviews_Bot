import test from 'node:test';
import assert from 'node:assert/strict';
import { reportTimes, validateRankingOutput, shouldAutoSend } from '../services/monthlyReportPolicy.js';

test('September preview and delivery use October 1 Karachi time regardless of host timezone', () => {
  const times = reportTimes('2026-09');
  assert.equal(times.generateAt.toISOString(), '2026-10-01T05:00:00.000Z');
  assert.equal(times.sendAt.toISOString(), '2026-10-01T13:00:00.000Z');
  assert.equal(reportTimes('2026-12').sendAt.toISOString(), '2027-01-01T13:00:00.000Z');
  assert.throws(() => reportTimes('2026-13'));
});
test('send recovery respects preview window and never auto-sends a late draft', () => {
  const { sendAt, generateAt } = reportTimes('2026-09');
  const report = { status: 'scheduled', generatedAt: generateAt };
  assert.equal(shouldAutoSend(report, sendAt, generateAt), false);
  assert.equal(shouldAutoSend(report, sendAt, sendAt), true);
  assert.equal(shouldAutoSend({ ...report, eventId: 'sent' }, sendAt, sendAt), false);
  assert.equal(shouldAutoSend({ status: 'draft', generatedAt: new Date('2026-10-07') }, sendAt, new Date('2026-10-07')), false);
});
test('empty, missing and duplicate AI rankings cannot become scheduled reports', () => {
  const members = ['Uzair', 'Mohsin'];
  assert.throws(() => validateRankingOutput({ rankings: [], reportText: '' }, members));
  const ranking = { member: 'Uzair', score: 8, oneLiner: 'Useful reviews' };
  assert.throws(() => validateRankingOutput({ rankings: [ranking, ranking], reportText: 'text' }, members));
  const report = { rankings: [ranking, { ...ranking, member: 'Mohsin' }], reportText: 'Review summary' };
  assert.equal(validateRankingOutput(report, members), report);
});
