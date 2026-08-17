import BossDailyReport from '../models/BossDailyReport.js';
import { config } from '../config/appConfig.js';
import {
  getKarachiDateKey,
  getPreviousWorkingDay,
  isWeekend,
  isNonWorkingDay,
} from './pairService.js';
import { analyzeMeetingDay } from './aiAnalyzeService.js';
import {
  sendMatrixMessageToRoom,
  joinMatrixRoom,
} from './matrixService.js';
import { logOutgoingMessage } from './roomMessageService.js';
import {
  claimCronJob,
  completeCronJob,
  releaseCronJob,
} from './cronJobService.js';

export const getBossRoomId = () =>
  (config.boss?.roomId || process.env.BOSS_MATRIX_ROOM_ID || '').trim();

/** True once Matrix delivery succeeded (eventId is the durable lock). */
const wasDelivered = (doc) => Boolean(doc?.eventId);

const markSentIfNeeded = async (doc) => {
  if (!doc || !wasDelivered(doc)) return doc;
  if (doc.status === 'sent' && !doc.sendError) return doc;
  doc.status = 'sent';
  doc.sendError = null;
  if (!doc.sentAt) doc.sentAt = doc.updatedAt || new Date();
  await doc.save();
  return doc;
};

/** Ensure the bot is in Sir's room (safe to call on startup). */
export const joinBossRoom = async () => {
  const roomId = getBossRoomId();
  if (!roomId) {
    console.log('[boss] No BOSS_MATRIX_ROOM_ID configured — skip join');
    return { skipped: true, reason: 'No boss room configured' };
  }
  try {
    await joinMatrixRoom(roomId);
    console.log(`[boss] Joined Sir room ${roomId}`);
    return { skipped: false, roomId };
  } catch (error) {
    console.error(`[boss] Join failed: ${error.message}`);
    return { skipped: true, reason: error.message, roomId };
  }
};

/**
 * 5:58 PM weekdays — run AI analyze for yesterday's review day and stash the brief.
 */
export const prepareBossDailyReport = async (triggeredBy = 'cron') => {
  const sendDateKey = getKarachiDateKey();

  if (isNonWorkingDay(sendDateKey)) {
    return {
      skipped: true,
      reason: isWeekend(sendDateKey)
        ? 'Weekend — no boss report'
        : 'Holiday — no boss report',
    };
  }

  const roomId = getBossRoomId();
  if (!roomId) {
    return { skipped: true, reason: 'BOSS_MATRIX_ROOM_ID not set' };
  }

  const reviewDateKey = getPreviousWorkingDay(sendDateKey);
  const jobKey = `boss_report_prepare:${sendDateKey}`;

  if (triggeredBy === 'cron') {
    const claimed = await claimCronJob(jobKey, {
      jobType: 'boss_report_prepare',
      dateKey: sendDateKey,
    });
    if (!claimed) {
      return { skipped: true, reason: 'Boss report already prepared today' };
    }
  }

  try {
    let doc = await BossDailyReport.findOne({ reviewDateKey });

    // Never regenerate after Sir already received the message.
    if (wasDelivered(doc) || doc?.status === 'sent') {
      doc = await markSentIfNeeded(doc);
      if (triggeredBy === 'cron') await completeCronJob(jobKey, doc?.eventId);
      return {
        skipped: true,
        reason: 'Boss report already sent for this review day',
        doc,
      };
    }

    if (doc?.status === 'ready' && doc.brief && triggeredBy === 'cron') {
      await completeCronJob(jobKey, null);
      return { skipped: true, reason: 'Boss report already ready', doc };
    }

    if (!doc) {
      doc = await BossDailyReport.create({
        reviewDateKey,
        sendDateKey,
        roomId,
        status: 'preparing',
        prepareError: null,
      });
    } else {
      doc.sendDateKey = sendDateKey;
      doc.roomId = roomId;
      doc.status = 'preparing';
      doc.prepareError = null;
      await doc.save();
    }

    const analysis = await analyzeMeetingDay(reviewDateKey);

    // Re-check before saving ready — send may have finished mid-analyze.
    const still = await BossDailyReport.findOne({ reviewDateKey });
    if (wasDelivered(still) || still?.status === 'sent') {
      const healed = await markSentIfNeeded(still);
      if (triggeredBy === 'cron') await completeCronJob(jobKey, healed?.eventId);
      return {
        skipped: true,
        reason: 'Boss report already sent for this review day',
        doc: healed,
      };
    }

    still.brief = analysis.brief;
    still.modelId = analysis.modelId;
    still.modelName = analysis.modelName;
    still.status = 'ready';
    still.preparedAt = new Date();
    still.prepareError = null;
    still.sendDateKey = sendDateKey;
    still.roomId = roomId;
    await still.save();

    if (triggeredBy === 'cron') {
      await completeCronJob(jobKey, null);
    }

    console.log(
      `[boss] Report ready for ${reviewDateKey} (${(analysis.brief || '').length} chars)`
    );

    return { skipped: false, reviewDateKey, sendDateKey, doc: still };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    // Never overwrite a delivered report with "failed".
    await BossDailyReport.updateOne(
      {
        reviewDateKey,
        $or: [
          { eventId: { $exists: false } },
          { eventId: null },
          { eventId: '' },
        ],
        status: { $ne: 'sent' },
      },
      {
        $set: {
          status: 'failed',
          prepareError: error.message,
          sendDateKey,
          roomId,
        },
      }
    );
    throw error;
  }
};

/**
 * 6:00 PM weekdays — send the prepared AI brief to Sir's room.
 * If prepare missed, generate on the spot then send.
 */
export const sendBossDailyReport = async (triggeredBy = 'cron') => {
  const sendDateKey = getKarachiDateKey();

  if (isNonWorkingDay(sendDateKey)) {
    return {
      skipped: true,
      reason: isWeekend(sendDateKey)
        ? 'Weekend — no boss report'
        : 'Holiday — no boss report',
    };
  }

  const roomId = getBossRoomId();
  if (!roomId) {
    return { skipped: true, reason: 'BOSS_MATRIX_ROOM_ID not set' };
  }

  const reviewDateKey = getPreviousWorkingDay(sendDateKey);
  const jobKey = `boss_report_send:${sendDateKey}`;

  if (triggeredBy === 'cron') {
    const claimed = await claimCronJob(jobKey, {
      jobType: 'boss_report_send',
      dateKey: sendDateKey,
    });
    if (!claimed) {
      return { skipped: true, reason: 'Boss report already sent today' };
    }
  }

  try {
    let doc = await BossDailyReport.findOne({ reviewDateKey });

    // Durable lock: if Matrix eventId exists, NEVER send again.
    if (wasDelivered(doc) || doc?.status === 'sent') {
      doc = await markSentIfNeeded(doc);
      if (triggeredBy === 'cron') await completeCronJob(jobKey, doc?.eventId);
      return { skipped: true, reason: 'Already sent', doc };
    }

    if (!doc?.brief?.trim() || doc.status === 'failed' || doc.status === 'preparing') {
      console.log('[boss] No ready brief — preparing now before send');
      const prepared = await prepareBossDailyReport('send_fallback');
      doc = prepared.doc || (await BossDailyReport.findOne({ reviewDateKey }));

      if (wasDelivered(doc) || doc?.status === 'sent') {
        doc = await markSentIfNeeded(doc);
        if (triggeredBy === 'cron') await completeCronJob(jobKey, doc?.eventId);
        return { skipped: true, reason: 'Already sent', doc };
      }

      if (prepared.skipped && !doc?.brief?.trim()) {
        if (triggeredBy === 'cron') await releaseCronJob(jobKey);
        return {
          skipped: true,
          reason: prepared.reason || 'Could not prepare boss report',
        };
      }
    }

    if (!doc?.brief?.trim()) {
      if (triggeredBy === 'cron') await releaseCronJob(jobKey);
      return { skipped: true, reason: 'Empty boss report brief' };
    }

    // Final race guard right before Matrix send.
    const preSend = await BossDailyReport.findOne({ reviewDateKey });
    if (wasDelivered(preSend) || preSend?.status === 'sent') {
      const healed = await markSentIfNeeded(preSend);
      if (triggeredBy === 'cron') await completeCronJob(jobKey, healed?.eventId);
      return { skipped: true, reason: 'Already sent', doc: healed };
    }

    await joinMatrixRoom(roomId).catch(() => {});

    const result = await sendMatrixMessageToRoom(roomId, doc.brief, {
      kind: 'boss_daily_report',
      dateKey: reviewDateKey,
      triggeredBy,
    });

    // Atomic claim of delivery — only one process can set eventId first.
    const claimedSend = await BossDailyReport.findOneAndUpdate(
      {
        reviewDateKey,
        $or: [{ eventId: { $exists: false } }, { eventId: null }, { eventId: '' }],
      },
      {
        $set: {
          status: 'sent',
          sentAt: new Date(),
          eventId: result.event_id,
          roomId,
          sendError: null,
          prepareError: null,
          sendDateKey,
          brief: doc.brief,
        },
      },
      { new: true }
    );

    if (!claimedSend) {
      // Someone else already recorded delivery — do not treat as failure.
      const existing = await BossDailyReport.findOne({ reviewDateKey });
      const healed = await markSentIfNeeded(existing);
      console.warn(
        `[boss] Send raced — keeping existing delivery ${healed?.eventId}, new event ${result.event_id}`
      );
      if (triggeredBy === 'cron') await completeCronJob(jobKey, healed?.eventId);
      return {
        skipped: true,
        reason: 'Already sent (race)',
        doc: healed,
        extraEventId: result.event_id,
      };
    }

    await logOutgoingMessage(doc.brief, result.event_id, 'bot_boss', {
      dateKey: reviewDateKey,
      roomId,
    }).catch((error) =>
      console.warn(`[boss] History log failed: ${error.message}`)
    );

    if (triggeredBy === 'cron') {
      await completeCronJob(jobKey, result.event_id);
    }

    console.log(
      `[boss] Report sent to Sir room for ${reviewDateKey} → ${result.event_id}`
    );

    return {
      skipped: false,
      reviewDateKey,
      sendDateKey,
      eventId: result.event_id,
      roomId,
      doc: claimedSend,
    };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    // Never wipe a successful delivery if Matrix send already happened elsewhere.
    await BossDailyReport.updateOne(
      {
        reviewDateKey,
        $or: [
          { eventId: { $exists: false } },
          { eventId: null },
          { eventId: '' },
        ],
        status: { $ne: 'sent' },
      },
      {
        $set: {
          status: 'failed',
          sendError: error.message,
          roomId,
          sendDateKey,
        },
      }
    );
    throw error;
  }
};

/** Heal mislabeled reports that have an eventId but status=failed. */
export const healDeliveredBossReports = async () => {
  const result = await BossDailyReport.updateMany(
    {
      eventId: { $exists: true, $nin: [null, ''] },
      status: { $ne: 'sent' },
    },
    {
      $set: { status: 'sent', sendError: null, prepareError: null },
    }
  );
  return result;
};
