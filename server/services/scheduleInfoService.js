import DailyReview from '../models/DailyReview.js';
import { config } from '../config/appConfig.js';
import {
  formatDailyMessage,
  buildDailyPairs,
  formatDisplayDate,
  getPreviousWorkingDay,
  getKarachiDateKey,
} from './pairService.js';
import {
  formatReminderMessage,
  formatMissedReviewMessage,
  getPendingPairs,
} from './reviewService.js';

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

  if (yesterdayReview?.pairsSentAt) {
    const actualPending = getPendingPairs(
      yesterdayReview.pairs,
      yesterdayReview.reviewedMembers
    );
    if (actualPending.length) {
      missedReviewMessage = formatMissedReviewMessage(yesterdayKey, actualPending);
      missedReviewNote = `Live preview — ${actualPending.length} pair(s) still missing review for yesterday.`;
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
      'Example only — at 10:50 AM only pairs that did not submit review yesterday are listed.';
  }

  return {
    timezone: config.timezone,
    schedules: [
      {
        id: 'daily_pairs',
        time: '11:00 AM',
        days: 'Mon–Fri',
        cron: config.cronSchedule,
        title: 'Daily Pairs Message',
        description: 'Posts today’s pair assignments to the Element room.',
        example: dailyPairsMessage,
      },
      {
        id: 'missed_review',
        time: '10:50 AM',
        days: 'Mon–Fri',
        cron: config.missedReviewCronSchedule,
        title: 'Missed Review Notice',
        description:
          'Sent before daily pairs. Checks yesterday’s pairs and lists only those that did not submit their review.',
        example: missedReviewMessage,
        exampleForDate: formatDisplayDate(yesterdayKey),
        exampleNote: missedReviewNote,
      },
      {
        id: 'review_reminder',
        time: '6:50 PM',
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
