import {
  buildDailyPairs,
  buildDailyPairsFromDateKey,
  formatDailyMessage,
  getActivePreviewTarget,
  getCurrentMonthParts,
  getKarachiDateKey,
  getMonthSchedule,
  getPreviousWorkingDay,
  getFollowUpTargetDateKey,
  isPastCronTimeToday,
  isWeekend,
} from './pairService.js';
import { config } from '../config/appConfig.js';
import { sendMatrixMessage } from './matrixService.js';
import { logOutgoingMessage } from './roomMessageService.js';
import {
  ensureDailyReview,
  formatReminderMessage,
  formatMissedReviewMessage,
  getPendingPairs,
  buildReviewState,
} from './reviewService.js';
import { savePairRecord, getLastPairRecord, getPairHistory, getPairRecordByDate } from './pairRecordService.js';
import { claimCronJob, completeCronJob, releaseCronJob } from './cronJobService.js';
import {
  sendMissingReviewPrompts,
  getPromptSummary,
  summarizePairResponses,
} from './missingReviewPromptService.js';
import DailyReview from '../models/DailyReview.js';

export const getTodayPreview = async () => {
  const target = getActivePreviewTarget();
  const pairsData = buildDailyPairsFromDateKey(target.previewDateKey);
  const message = formatDailyMessage(pairsData);
  const lastSent = await getLastSent();
  const todayKey = getKarachiDateKey();
  const todayAlreadySent = Boolean(
    lastSent && lastSent.dateKey === todayKey
  );

  return {
    ...pairsData,
    message,
    previewFor: target.previewFor,
    previewLabel: target.label,
    todayDateKey: todayKey,
    todayAlreadySent,
    lastSent: lastSent
      ? {
          dateKey: lastSent.dateKey,
          sentAt: lastSent.sentAt,
          triggeredBy: lastSent.triggeredBy,
        }
      : null,
  };
};

/** Always sends the real calendar-day pairs (today), not the "next day" preview. */
export const sendDailyPairs = async (triggeredBy = 'manual') => {
  const dateKey = getKarachiDateKey();

  if (isWeekend(dateKey) && triggeredBy === 'cron') {
    return { skipped: true, reason: 'Weekend — no pairs today' };
  }

  const pairsData = buildDailyPairs();
  const message = formatDailyMessage(pairsData);
  const jobKey = `daily_pairs:${dateKey}`;

  if (triggeredBy === 'cron') {
    if (!isPastCronTimeToday(config.cronSchedule, 11, 30)) {
      return { skipped: true, reason: 'Too early for daily pairs (waits until 11:30 AM)' };
    }
    const claimed = await claimCronJob(jobKey, { jobType: 'daily_pairs', dateKey });
    if (!claimed) {
      return { skipped: true, reason: 'Already sent today', pairsData, message };
    }
  } else {
    const existingToday = await getPairRecordByDate(dateKey);
    if (existingToday) {
      return { skipped: true, reason: 'Already sent today', pairsData, message };
    }
  }

  try {
    const result = await sendMatrixMessage(message);
    await logOutgoingMessage(message, result.event_id, 'bot_pairs');

    const review = await ensureDailyReview({
      dateKey,
      lead: pairsData.lead,
      pairs: pairsData.allPairs,
      pairsSentAt: new Date(),
    });
    const { emitReviewUpdate } = await import('./socketService.js');
    emitReviewUpdate(buildReviewState(review));

    const log = await savePairRecord({
      dateKey,
      pairsData,
      message,
      matrixEventId: result.event_id,
      triggeredBy,
    });

    if (triggeredBy === 'cron') {
      await completeCronJob(jobKey, result.event_id);
    }

    return { skipped: false, pairsData, message, log };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    throw error;
  }
};

export const getMessageHistory = (limit = 14) => getPairHistory(limit);

export const getLastSent = () => getLastPairRecord();

export const getMonthlyPairs = (year, month) => {
  const y = Number(year);
  const m = Number(month);
  if (!y || !m || m < 1 || m > 12) {
    throw new Error('Invalid year or month');
  }

  return {
    year: y,
    month: m,
    schedule: getMonthSchedule(y, m),
  };
};

export const getDefaultMonthlyPairs = () => {
  const { year, month } = getCurrentMonthParts();
  return getMonthlyPairs(year, month);
};

/** Weekday 6:50 PM reminder for pairs with pending reviews. */
export const sendReviewReminder = async (triggeredBy = 'cron') => {
  const dateKey = getKarachiDateKey();

  if (isWeekend(dateKey)) {
    return { skipped: true, reason: 'Weekend — no reminder' };
  }

  const review = await DailyReview.findOne({ dateKey });
  if (!review?.pairsSentAt) {
    return { skipped: true, reason: 'Daily pairs not sent yet' };
  }

  const pendingPairs = getPendingPairs(review.pairs, review.reviewedMembers);
  if (pendingPairs.length === 0) {
    return { skipped: true, reason: 'All reviews completed', pendingPairs: [] };
  }

  const jobKey = `review_reminder:${dateKey}`;

  if (triggeredBy === 'cron') {
    const claimed = await claimCronJob(jobKey, { jobType: 'review_reminder', dateKey });
    if (!claimed) {
      return { skipped: true, reason: 'Reminder already sent today' };
    }
  } else if (review.reminderSentAt) {
    return { skipped: true, reason: 'Reminder already sent today' };
  }

  const message = formatReminderMessage(review.lead, pendingPairs);

  try {
    const result = await sendMatrixMessage(message);
    await logOutgoingMessage(message, result.event_id, 'bot_reminder');

    review.reminderSentAt = new Date();
    await review.save();

    if (triggeredBy === 'cron') {
      await completeCronJob(jobKey, result.event_id);
    }

    return {
      skipped: false,
      message,
      pendingPairs,
      reviewedMembers: review.reviewedMembers,
    };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    throw error;
  }
};

/**
 * Weekday 10:50 AM — DM each member of yesterday's pairs that missed review,
 * asking why. Their reply drives attendance and the 11:20 AM room notice.
 */
export const sendMissingReviewFollowUps = async (
  triggeredBy = 'cron',
  { onlyMember = null } = {}
) => {
  const todayKey = getKarachiDateKey();

  if (isWeekend(todayKey)) {
    return { skipped: true, reason: 'Weekend — no follow-ups' };
  }

  // Cron always chases the previous working day; a manual run from the
  // dashboard chases whatever the dashboard is currently showing.
  const yesterdayKey =
    triggeredBy === 'cron' ? getPreviousWorkingDay(todayKey) : getFollowUpTargetDateKey();
  const jobKey = `missing_review_prompts:${todayKey}:for:${yesterdayKey}`;

  if (triggeredBy === 'cron') {
    const claimed = await claimCronJob(jobKey, {
      jobType: 'missing_review_prompts',
      dateKey: todayKey,
    });
    if (!claimed) {
      return { skipped: true, reason: 'Follow-ups already sent today' };
    }
  }

  try {
    const result = await sendMissingReviewPrompts(yesterdayKey, { onlyMember });

    if (triggeredBy === 'cron') {
      if (result.skipped) {
        await releaseCronJob(jobKey);
      } else {
        await completeCronJob(jobKey, null);
      }
    }

    return { ...result, forDate: yesterdayKey };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    throw error;
  }
};

/** Weekday 11:20 AM — notify the main room about yesterday's missed reviews. */
export const sendMissedReviewNotice = async (triggeredBy = 'cron') => {
  const todayKey = getKarachiDateKey();

  if (isWeekend(todayKey)) {
    return { skipped: true, reason: 'Weekend — no notice' };
  }

  // Never post the room summary in the same window as the personal DMs —
  // members need time to reply. Stale Railway env used to fire both at 10:50.
  if (
    triggeredBy === 'cron' &&
    !isPastCronTimeToday(config.missedReviewCronSchedule, 11, 20)
  ) {
    return {
      skipped: true,
      reason: 'Too early — room notice waits until after personal follow-ups',
    };
  }

  const yesterdayKey = getPreviousWorkingDay(todayKey);
  const review = await DailyReview.findOne({ dateKey: yesterdayKey });

  if (!review?.pairsSentAt) {
    return { skipped: true, reason: 'No pairs sent yesterday' };
  }

  const pendingPairs = getPendingPairs(review.pairs, review.reviewedMembers);
  if (pendingPairs.length === 0) {
    return { skipped: true, reason: 'All yesterday reviews completed' };
  }

  if (triggeredBy === 'cron' && !review.missingReviewPromptsSentAt) {
    return {
      skipped: true,
      reason: 'Personal follow-ups not sent yet — room notice waits for replies',
    };
  }

  const jobKey = `missed_review:${todayKey}:for:${yesterdayKey}`;

  if (triggeredBy === 'cron') {
    const claimed = await claimCronJob(jobKey, { jobType: 'missed_review', dateKey: todayKey });
    if (!claimed) {
      return { skipped: true, reason: 'Missed review notice already sent' };
    }
  } else if (review.missedReviewNoticeSentAt) {
    return { skipped: true, reason: 'Missed review notice already sent' };
  }

  const { byPair } = await getPromptSummary(yesterdayKey);
  const responseByPair = new Map();
  for (const [key, entry] of byPair) {
    const summary = summarizePairResponses(entry);
    if (summary) responseByPair.set(key, summary);
  }

  const message = formatMissedReviewMessage(yesterdayKey, pendingPairs, responseByPair);

  try {
    const result = await sendMatrixMessage(message);
    await logOutgoingMessage(message, result.event_id, 'bot_missed');

    review.missedReviewNoticeSentAt = new Date();
    await review.save();

    if (triggeredBy === 'cron') {
      await completeCronJob(jobKey, result.event_id);
    }

    return {
      skipped: false,
      message,
      pendingPairs,
      forDate: yesterdayKey,
    };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    throw error;
  }
};
