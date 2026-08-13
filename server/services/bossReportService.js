import BossDailyReport from '../models/BossDailyReport.js';
import { config } from '../config/appConfig.js';
import {
  getKarachiDateKey,
  getPreviousWorkingDay,
  isWeekend,
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

  if (isWeekend(sendDateKey)) {
    return { skipped: true, reason: 'Weekend — no boss report' };
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
    if (doc?.status === 'sent') {
      if (triggeredBy === 'cron') await completeCronJob(jobKey, doc.eventId);
      return { skipped: true, reason: 'Boss report already sent for this review day', doc };
    }
    if (doc?.status === 'ready' && doc.brief && triggeredBy === 'cron') {
      await completeCronJob(jobKey, null);
      return { skipped: true, reason: 'Boss report already ready', doc };
    }

    doc = await BossDailyReport.findOneAndUpdate(
      { reviewDateKey },
      {
        $set: {
          sendDateKey,
          roomId,
          status: 'preparing',
          prepareError: null,
        },
        $setOnInsert: { reviewDateKey },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const analysis = await analyzeMeetingDay(reviewDateKey);

    doc.brief = analysis.brief;
    doc.modelId = analysis.modelId;
    doc.modelName = analysis.modelName;
    doc.status = 'ready';
    doc.preparedAt = new Date();
    doc.prepareError = null;
    doc.sendDateKey = sendDateKey;
    doc.roomId = roomId;
    await doc.save();

    if (triggeredBy === 'cron') {
      await completeCronJob(jobKey, null);
    }

    console.log(
      `[boss] Report ready for ${reviewDateKey} (${(analysis.brief || '').length} chars)`
    );

    return { skipped: false, reviewDateKey, sendDateKey, doc };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    await BossDailyReport.findOneAndUpdate(
      { reviewDateKey },
      {
        $set: {
          status: 'failed',
          prepareError: error.message,
          sendDateKey,
          roomId,
        },
      },
      { upsert: true }
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

  if (isWeekend(sendDateKey)) {
    return { skipped: true, reason: 'Weekend — no boss report' };
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

    if (doc?.status === 'sent' && doc.eventId) {
      if (triggeredBy === 'cron') await completeCronJob(jobKey, doc.eventId);
      return { skipped: true, reason: 'Already sent', doc };
    }

    if (!doc?.brief || doc.status === 'failed' || doc.status === 'preparing') {
      console.log('[boss] No ready brief — preparing now before send');
      const prepared = await prepareBossDailyReport('send_fallback');
      if (prepared.skipped && !prepared.doc?.brief) {
        if (triggeredBy === 'cron') await releaseCronJob(jobKey);
        return {
          skipped: true,
          reason: prepared.reason || 'Could not prepare boss report',
        };
      }
      doc = prepared.doc || (await BossDailyReport.findOne({ reviewDateKey }));
    }

    if (!doc?.brief?.trim()) {
      if (triggeredBy === 'cron') await releaseCronJob(jobKey);
      return { skipped: true, reason: 'Empty boss report brief' };
    }

    await joinMatrixRoom(roomId).catch(() => {});

    const result = await sendMatrixMessageToRoom(roomId, doc.brief, {
      kind: 'boss_daily_report',
      dateKey: reviewDateKey,
      triggeredBy,
    });

    doc.status = 'sent';
    doc.sentAt = new Date();
    doc.eventId = result.event_id;
    doc.roomId = roomId;
    doc.sendError = null;
    await doc.save();

    // Persist for History + AI Analyzed pages (same text Sir received).
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
      doc,
    };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    await BossDailyReport.findOneAndUpdate(
      { reviewDateKey },
      {
        $set: {
          status: 'failed',
          sendError: error.message,
          roomId,
          sendDateKey,
        },
      },
      { upsert: true }
    );
    throw error;
  }
};
