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
  isNonWorkingDay,
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
  sendLeadEveningNudge,
  startLeadMorningReport,
  getLeadReportSummary,
} from './leadReportService.js';
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

  if (isNonWorkingDay(dateKey) && triggeredBy === 'cron') {
    return {
      skipped: true,
      reason: isWeekend(dateKey)
        ? 'Weekend — no pairs today'
        : 'Holiday — no pairs today',
    };
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
    const result = await sendMatrixMessage(message, {
      kind: 'daily_pairs',
      dateKey,
      triggeredBy,
    });
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
export const sendReviewReminder = async (
  triggeredBy = 'cron',
  { leadOverride = null } = {}
) => {
  const dateKey = getKarachiDateKey();

  if (isNonWorkingDay(dateKey)) {
    return {
      skipped: true,
      reason: isWeekend(dateKey)
        ? 'Weekend — no reminder'
        : 'Holiday — no reminder',
    };
  }

  const review = await DailyReview.findOne({ dateKey });
  if (!review?.pairsSentAt) {
    return { skipped: true, reason: 'Daily pairs not sent yet' };
  }

  const pendingPairs = getPendingPairs(review.pairs, review);
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
    const result = await sendMatrixMessage(message, {
      kind: 'review_reminder',
      dateKey,
      triggeredBy,
    });
    await logOutgoingMessage(message, result.event_id, 'bot_reminder');

    review.reminderSentAt = new Date();
    await review.save();

    // Same moment: DM today's lead in their personal room.
    let leadNudge = null;
    try {
      leadNudge = await sendLeadEveningNudge(dateKey, { leadOverride });
    } catch (nudgeError) {
      console.error(`[lead-nudge] Failed for ${dateKey}: ${nudgeError.message}`);
      leadNudge = { skipped: true, reason: nudgeError.message };
    }

    if (triggeredBy === 'cron') {
      await completeCronJob(jobKey, result.event_id);
    }

    return {
      skipped: false,
      message,
      pendingPairs,
      reviewedMembers: review.reviewedMembers,
      leadNudge,
    };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    throw error;
  }
};

/**
 * Weekday 10:50 AM — DM yesterday's lead only and collect the team report
 * (submitted reviews verify + reasons for missing pairs).
 */
export const sendMissingReviewFollowUps = async (
  triggeredBy = 'cron',
  { leadOverride = null, force = false } = {}
) => {
  const todayKey = getKarachiDateKey();

  if (isNonWorkingDay(todayKey) && triggeredBy === 'cron') {
    return {
      skipped: true,
      reason: isWeekend(todayKey)
        ? 'Weekend — no follow-ups'
        : 'Holiday — no follow-ups',
    };
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
    const result = await startLeadMorningReport(yesterdayKey, {
      leadOverride,
      force,
    });

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

/** Weekday 11:20 AM — notify the main room about yesterday's missed reviews
 *  and any reviews marked "not discussed" from yesterday's 5 PM check. */
export const sendMissedReviewNotice = async (triggeredBy = 'cron') => {
  const todayKey = getKarachiDateKey();

  if (isNonWorkingDay(todayKey)) {
    return {
      skipped: true,
      reason: isWeekend(todayKey)
        ? 'Weekend — no notice'
        : 'Holiday — no notice',
    };
  }

  // Never post the room summary before the lead morning report —
  // the lead needs time to reply. Stale Railway env used to fire both at 10:50.
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

  const { getUndiscussedPairsForMeeting } = await import(
    './discussionPromptService.js'
  );
  const undiscussedPairs = await getUndiscussedPairsForMeeting(yesterdayKey);

  const pendingPairs = review?.pairsSentAt
    ? getPendingPairs(review.pairs, review)
    : [];

  if (!pendingPairs.length && !undiscussedPairs.length) {
    return {
      skipped: true,
      reason: 'Nothing to report — no missing reviews and nothing left undiscussed',
    };
  }

  if (pendingPairs.length && triggeredBy === 'cron' && !review?.missingReviewPromptsSentAt) {
    return {
      skipped: true,
      reason: 'Personal follow-ups not sent yet — room notice waits for replies',
    };
  }

  if (pendingPairs.length && !review?.pairsSentAt) {
    return { skipped: true, reason: 'No pairs sent yesterday' };
  }

  const jobKey = `missed_review:${todayKey}:for:${yesterdayKey}`;

  if (triggeredBy === 'cron') {
    const claimed = await claimCronJob(jobKey, { jobType: 'missed_review', dateKey: todayKey });
    if (!claimed) {
      return { skipped: true, reason: 'Missed review notice already sent' };
    }
  } else if (review?.missedReviewNoticeSentAt) {
    return { skipped: true, reason: 'Missed review notice already sent' };
  }

  const { session, responseByPair } = await getLeadReportSummary(yesterdayKey);
  const message = formatMissedReviewMessage(
    yesterdayKey,
    pendingPairs,
    responseByPair,
    undiscussedPairs
  );

  if (!message.trim()) {
    if (triggeredBy === 'cron') await releaseCronJob(jobKey);
    return { skipped: true, reason: 'Empty notice — nothing to send' };
  }

  try {
    const result = await sendMatrixMessage(message, {
      kind: 'missed_review',
      dateKey: yesterdayKey,
      triggeredBy,
    });
    await logOutgoingMessage(message, result.event_id, 'bot_missed');

    if (review) {
      review.missedReviewNoticeSentAt = new Date();
      await review.save();
    }

    if (triggeredBy === 'cron') {
      await completeCronJob(jobKey, result.event_id);
    }

    return {
      skipped: false,
      message,
      pendingPairs,
      undiscussedPairs,
      forDate: yesterdayKey,
      leadReportStage: session?.stage || null,
    };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    throw error;
  }
};

/** Weekday 5:00 PM — ask one member per pair if yesterday's review was discussed. */
export const sendDiscussionFollowUps = async (
  triggeredBy = 'cron',
  { force = false } = {}
) => {
  const todayKey = getKarachiDateKey();

  if (isNonWorkingDay(todayKey) && triggeredBy === 'cron') {
    return {
      skipped: true,
      reason: isWeekend(todayKey)
        ? 'Weekend — no discussion prompts'
        : 'Holiday — no discussion prompts',
    };
  }

  const jobKey = `discussion_prompts:${todayKey}`;

  if (triggeredBy === 'cron') {
    const claimed = await claimCronJob(jobKey, {
      jobType: 'discussion_prompts',
      dateKey: todayKey,
    });
    if (!claimed) {
      return { skipped: true, reason: 'Discussion prompts already sent today' };
    }
  }

  try {
    const { sendDiscussionPrompts } = await import('./discussionPromptService.js');
    const result = await sendDiscussionPrompts(todayKey, { force });

    if (triggeredBy === 'cron') {
      if (result.skipped || !(result.prompts || []).length) {
        await releaseCronJob(jobKey);
      } else {
        await completeCronJob(jobKey, null);
      }
    }

    return result;
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    throw error;
  }
};
