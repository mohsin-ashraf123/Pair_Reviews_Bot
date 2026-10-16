import test from 'node:test';
import assert from 'node:assert/strict';
import { config, getAllMembers } from '../config/appConfig.js';
import { buildDailyPairsFromDateKey, formatDailyMessage, getMonthSchedule } from '../services/pairService.js';
import { parseMentionedMembers, findMatchingPair } from '../services/reviewService.js';
import { handleLeadReply, formatLeadReportComplete } from '../services/leadReportService.js';
import DailyReview from '../models/DailyReview.js';
import LeadReportSession from '../models/LeadReportSession.js';

test('four pairs cover all eight members once, and every eligible partnership rotates', () => {
  const partnerships = new Set();
  const leads = new Set();
  for (const month of [10, 11, 12]) {
    for (const row of getMonthSchedule(2026, month)) {
      const data = buildDailyPairsFromDateKey(row.dateKey);
      assert.equal(data.allPairs.length, 4);
      if (row.dateKey < '2026-10-08') continue;
      assert.equal(data.developerPairs.length, 2);
      assert.ok(data.developerPairs.every(pair => pair.length === 2));
      assert.equal(data.qaPair.length, 2);
      assert.equal(data.mixedPair.length, 2);
      assert.ok(data.developerPairs.flat().every(m => config.developers.includes(m)));
      assert.ok(data.qaPair.every(m => config.qaTeam.includes(m)));
      assert.ok(config.developers.includes(data.mixedPair[0]));
      assert.ok(config.qaTeam.includes(data.mixedPair[1]));
      assert.equal(data.allPairs.flat().length, 8);
      assert.deepEqual(new Set(data.allPairs.flat()), new Set(getAllMembers()));
      assert.ok(!data.allPairs.flat().includes('Hamza'));
      for (const pair of data.allPairs) {
        assert.equal(pair.length, 2);
        partnerships.add([...pair].sort().join('|'));
        assert.deepEqual(findMatchingPair(parseMentionedMembers(`${pair.join(' + ')}: Review completed. No issues.`), data.allPairs), pair);
      }
      assert.doesNotMatch(formatDailyMessage(data), /Momin|Hamza/);
      leads.add(data.lead);
    }
  }
  // Every partnership type rotates and each member has one partner per day.
  assert.ok(partnerships.size >= 18);
  assert.deepEqual(leads, new Set(getAllMembers()));
});

test('October 8 preserves the pairs actually sent on roster activation day', () => {
  const schedule = buildDailyPairsFromDateKey('2026-10-08');
  assert.deepEqual(schedule.allPairs, [
    ['Mohsin', 'Saad'],
    ['Farhan', 'Faz'],
    ['Habiba', 'Aqeel'],
    ['Uzair', 'Adil'],
  ]);
  assert.deepEqual(getMonthSchedule(2026, 10).find(row => row.dateKey === '2026-10-08').pairs, [
    'Mohsin + Saad', 'Farhan + Faz', 'Habiba + Aqeel', 'Uzair + Adil',
  ]);
});

test('no pair repeats within the previous two working days', () => {
  const weekdays = [...getMonthSchedule(2026, 10), ...getMonthSchedule(2026, 11), ...getMonthSchedule(2026, 12)].filter(row => row.dateKey >= '2026-10-08');
  for (let i = 1; i < weekdays.length; i++) {
    const recent = new Set(weekdays.slice(Math.max(0, i - 2), i).flatMap(row => row.pairs));
    for (const pair of weekdays[i].pairs) assert.ok(!recent.has(pair), `${pair} repeats on ${weekdays[i].dateKey}`);
  }
});

test('historical roster survives the resignation and month transition', () => {
  const before = buildDailyPairsFromDateKey('2026-10-07');
  assert.equal(before.developerPairs.length, 3);
  assert.equal(before.qaPair.length, 3);
  assert.ok(before.allPairs.flat().includes('Hamza'));
  assert.ok(getAllMembers('2026-09-01').includes('Hamza'));
  assert.ok(getAllMembers('2026-10-01').includes('Hamza'));
  assert.ok(!getAllMembers('2026-11-01').includes('Hamza'));
  assert.ok(!buildDailyPairsFromDateKey('2026-10-08').allPairs.flat().includes('Hamza'));
  assert.ok(parseMentionedMembers('Hamza + Uzair: review done').includes('Hamza'));
});

for (const stage of ['awaiting_verify', 'awaiting_missing_member_reason', 'awaiting_momin_check']) {
  test(`${stage} advances directly to the next review without a Momin question`, async t => {
    const pair = ['Uzair', 'Mohsin'];
    const session = {
      stage, lead: 'Farhan', roomId: '!test', dateKey: '2026-10-16',
      submittedPairs: [pair, ['Farhan', 'Faz']], currentVerifyIndex: 0,
      verifyDecisions: [], pendingVerify: { pair, verified: true },
      currentPairOptions: [{ letter: 'A', type: 'absent', absentMembers: ['Mohsin'], halfDayMembers: [] }],
      markModified() {},
      async save() {
        // Stop before message transport; a network send is never allowed in this test.
        if (this.currentVerifyIndex === 1 && this.stage === 'awaiting_verify') throw new Error('next review reached');
      },
    };
    t.mock.method(LeadReportSession, 'findOne', () => ({ sort: async () => session }));
    t.mock.method(DailyReview, 'findOne', () => ({ lean: async () => ({ reviewedMembers: pair }) }));
    await assert.rejects(handleLeadReply('Farhan', '!test', stage === 'awaiting_missing_member_reason' ? 'A' : 'YES', 'test'), /next review reached/);
    assert.equal(session.verifyDecisions.length, 1);
    assert.equal(session.verifyDecisions[0].verified, true);
    assert.equal(session.verifyDecisions[0].mominCrossChecked, undefined);
    assert.equal(session.pendingVerify, undefined);
    if (stage === 'awaiting_missing_member_reason') assert.deepEqual(session.verifyDecisions[0].absentMembers, ['Mohsin']);
    assert.doesNotMatch(formatLeadReportComplete(session), /Momin/);
  });
}
