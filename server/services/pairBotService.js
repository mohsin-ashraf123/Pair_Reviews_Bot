import {
  buildDailyPairs,
  buildDailyPairsFromDateKey,
  formatDailyMessage,
  getActivePreviewTarget,
  getCurrentMonthParts,
  getKarachiDateKey,
  getMonthSchedule,
  getPreviousWorkingDay,
  isWeekend,
} from './pairService.js';
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
import DailyReview from '../models/DailyReview.js';

const notYetSent = (field) => ({
  $or: [{ [field]: null }, { [field]: { $exists: false } }],
});

/** Atomically reserve a one-shot send slot so parallel cron ticks cannot double-send. */
const claimReviewSendSlot = async (dateKey, field) =>
  DailyReview.findOneAndUpdate(
    {
      dateKey,
      ...notYetSent(field),
    },
    { $set: { [field]: new Date() } },
    { new: false }
  );

const releaseReviewSendSlot = async (dateKey, field) => {
  await DailyReview.updateOne({ dateKey }, { $unset: { [field]: '' } });
};

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

  const existingToday = await getPairRecordByDate(dateKey);
  if (existingToday && triggeredBy === 'cron') {
    return { skipped: true, reason: 'Already sent today', pairsData, message };
  }

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

  return { skipped: false, pairsData, message, log };
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

  if (triggeredBy === 'cron') {
    const claimed = await claimReviewSendSlot(dateKey, 'reminderSentAt');
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

    if (triggeredBy !== 'cron') {
      review.reminderSentAt = new Date();
      await review.save();
    }

    return {
      skipped: false,
      message,
      pendingPairs,
      reviewedMembers: review.reviewedMembers,
    };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseReviewSendSlot(dateKey, 'reminderSentAt');
    }
    throw error;
  }
};

/** Weekday 10:50 AM — notify about yesterday's pairs that missed review. */
export const sendMissedReviewNotice = async (triggeredBy = 'cron') => {
  const todayKey = getKarachiDateKey();

  if (isWeekend(todayKey)) {
    return { skipped: true, reason: 'Weekend — no notice' };
  }

  const yesterdayKey = getPreviousWorkingDay(todayKey);
  const review = await DailyReview.findOne({ dateKey: yesterdayKey });

  if (!review?.pairsSentAt) {
    return { skipped: true, reason: 'No pairs sent yesterday' };
  }

  if (review.missedReviewNoticeSentAt && triggeredBy === 'cron') {
    return { skipped: true, reason: 'Missed review notice already sent' };
  }

  const pendingPairs = getPendingPairs(review.pairs, review.reviewedMembers);
  if (pendingPairs.length === 0) {
    return { skipped: true, reason: 'All yesterday reviews completed' };
  }

  if (triggeredBy === 'cron') {
    const claimed = await claimReviewSendSlot(yesterdayKey, 'missedReviewNoticeSentAt');
    if (!claimed) {
      return { skipped: true, reason: 'Missed review notice already sent' };
    }
  }

  const message = formatMissedReviewMessage(yesterdayKey, pendingPairs);

  try {
    const result = await sendMatrixMessage(message);
    await logOutgoingMessage(message, result.event_id, 'bot_missed');

    if (triggeredBy !== 'cron') {
      review.missedReviewNoticeSentAt = new Date();
      await review.save();
    }

    return {
      skipped: false,
      message,
      pendingPairs,
      forDate: yesterdayKey,
    };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseReviewSendSlot(yesterdayKey, 'missedReviewNoticeSentAt');
    }
    throw error;
  }
};
