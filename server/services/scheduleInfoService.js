import DailyReview from '../models/DailyReview.js';
import { config } from '../config/appConfig.js';
import {
  formatDailyMessage,
  buildDailyPairs,
  formatDisplayDate,
  getPreviousWorkingDay,
  getKarachiDateKey,
  cronTimeLabel,
} from './pairService.js';
import {
  formatReminderMessage,
  formatMissedReviewMessage,
  getPendingPairs,
  buildPairKey,
} from './reviewService.js';
import {
  buildPromptOptions,
  formatPromptMessage,
  getPromptSummary,
  summarizePairResponses,
} from './missingReviewPromptService.js';

export const getScheduledMessagesInfo = async () => {
  const pairsData = buildDailyPairs();
  const dailyPairsMessage = formatDailyMessage(pairsData);

  const sampleLead = pairsData.lead;
  const samplePending = pairsData.allPairs.slice(0, 2);
  const reminderMessage = formatReminderMessage(sampleLead, samplePending);

  const todayKey = getKarachiDateKey();
  const yesterdayKey = getPreviousWorkingDay(todayKey);
  const yesterdayReview = await DailyReview.findOne({ dateKey: yesterdayKey });

  let missedReviewMessage;
  let missedReviewNote;
  let promptMessage;
  let promptNote;

  const { byPair } = await getPromptSummary(yesterdayKey);
  const responseByPair = new Map();
  for (const [key, entry] of byPair) {
    const summary = summarizePairResponses(entry);
    if (summary) responseByPair.set(key, summary);
  }

  if (yesterdayReview?.pairsSentAt) {
    const actualPending = getPendingPairs(
      yesterdayReview.pairs,
      yesterdayReview.reviewedMembers
    );

    if (actualPending.length) {
      missedReviewMessage = formatMissedReviewMessage(
        yesterdayKey,
        actualPending,
        responseByPair
      );
      const answered = actualPending.filter((pair) =>
        responseByPair.has(buildPairKey(pair))
      ).length;
      missedReviewNote = `Live preview — ${actualPending.length} pair(s) missing review, ${answered} answered in their personal room.`;

      const [samplePair] = actualPending;
      const sampleMember = samplePair[0];
      const options = buildPromptOptions(sampleMember, samplePair, yesterdayKey);
      promptMessage = formatPromptMessage(
        sampleMember,
        samplePair,
        yesterdayKey,
        options
      );
      promptNote = `Live preview — each member of ${actualPending.length} pair(s) gets this in their own room.`;
    } else {
      missedReviewMessage =
        `Yesterday (${formatDisplayDate(yesterdayKey)}) — all pairs submitted their review.\n\n` +
        'No missed review notice would be sent today.';
      missedReviewNote = 'All yesterday reviews are complete — cron skips this message.';
    }
  } else {
    missedReviewMessage = formatMissedReviewMessage(yesterdayKey, [
      ['Pair Member A', 'Pair Member B'],
    ]);
    missedReviewNote =
      'Example only — only pairs that did not submit review yesterday are listed.';
  }

  if (!promptMessage) {
    const examplePair = pairsData.developerPairs[0] || ['Member A', 'Member B'];
    const exampleMember = examplePair[0];
    const options = buildPromptOptions(exampleMember, examplePair, yesterdayKey);
    promptMessage = formatPromptMessage(
      exampleMember,
      examplePair,
      yesterdayKey,
      options
    );
    promptNote =
      promptNote ||
      'Example only — sent privately to every member whose pair review was missing.';
  }

  const qaPair = pairsData.qaPair;
  const qaMember = qaPair[0];
  const qaPromptExample = qaMember
    ? formatPromptMessage(
        qaMember,
        qaPair,
        yesterdayKey,
        buildPromptOptions(qaMember, qaPair, yesterdayKey)
      )
    : null;

  return {
    timezone: config.timezone,
    schedules: [
      {
        id: 'missing_review_prompts',
        time: cronTimeLabel(config.missingReviewPromptCronSchedule, 10, 50),
        days: 'Mon–Fri',
        cron: config.missingReviewPromptCronSchedule,
        title: 'Personal Missing-Review Follow-up',
        description:
          'Private message in each member’s own room asking why yesterday’s pair review was missing. Their reply updates attendance.',
        example: promptMessage,
        exampleForDate: formatDisplayDate(yesterdayKey),
        exampleNote: promptNote,
        secondaryExampleTitle: qaPromptExample ? 'QA trio version (5 options)' : null,
        secondaryExample: qaPromptExample,
      },
      {
        id: 'missed_review',
        time: cronTimeLabel(config.missedReviewCronSchedule, 11, 20),
        days: 'Mon–Fri',
        cron: config.missedReviewCronSchedule,
        title: 'Missed Review Notice',
        description:
          'Posts yesterday’s missing pairs to the main room, including whatever each member answered in their personal room.',
        example: missedReviewMessage,
        exampleForDate: formatDisplayDate(yesterdayKey),
        exampleNote: missedReviewNote,
      },
      {
        id: 'daily_pairs',
        time: cronTimeLabel(config.cronSchedule, 11, 30),
        days: 'Mon–Fri',
        cron: config.cronSchedule,
        title: 'Daily Pairs Message',
        description: 'Posts today’s pair assignments to the Element room.',
        example: dailyPairsMessage,
      },
      {
        id: 'review_reminder',
        time: cronTimeLabel(config.reminderCronSchedule, 18, 50),
        days: 'Mon–Fri',
        cron: config.reminderCronSchedule,
        title: 'Review Reminder',
        description:
          'Same-day reminder for pairs that have not submitted their review yet.',
        example: reminderMessage,
      },
    ],
  };
};
