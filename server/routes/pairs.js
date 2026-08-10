import express from 'express';
import { config, isMatrixConfigured } from '../config/appConfig.js';
import {
  getTodayPreview,
  sendDailyPairs,
  getMessageHistory,
  getMonthlyPairs,
  getDefaultMonthlyPairs,
  sendMissingReviewFollowUps,
  sendMissedReviewNotice,
} from '../services/pairBotService.js';
import { getMemberRoomsOverview } from '../services/memberRoomViewService.js';
import { joinMemberRooms } from '../services/memberRoomService.js';
import { getNextDailySendTarget, getAllScheduleCountdowns, cronTimeLabel } from '../services/pairService.js';
import { getTodayReviewState } from '../services/reviewService.js';
import { getLiveRoomMessages, getArchivedReviewMessages } from '../services/roomMessageService.js';
import RoomMessage from '../models/RoomMessage.js';
import { verifyMatrixConnection } from '../services/matrixService.js';
import { getScheduledMessagesInfo } from '../services/scheduleInfoService.js';
import {
  getMonthlyPerformance,
  getDefaultMonthlyPerformance,
} from '../services/attendanceService.js';

const router = express.Router();

router.get('/today', async (req, res) => {
  try {
    const preview = await getTodayPreview();
    res.json(preview);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/countdown', (req, res) => {
  res.json(getNextDailySendTarget());
});

router.get('/reviews/today', async (req, res) => {
  try {
    res.json(await getTodayReviewState());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/messages/live', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const messages = await getLiveRoomMessages(limit);
    res.json(messages.reverse());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const [preview, countdown, review, messages, scheduleInfo, scheduleCountdowns] =
      await Promise.all([
        getTodayPreview(),
        Promise.resolve(getNextDailySendTarget()),
        getTodayReviewState(),
        getLiveRoomMessages(30),
        getScheduledMessagesInfo(),
        Promise.resolve(getAllScheduleCountdowns()),
      ]);

    const exampleById = Object.fromEntries(
      (scheduleInfo.schedules || []).map((item) => [item.id, item])
    );

    const schedules = scheduleCountdowns.map((job) => {
      const info = exampleById[job.id] || {};
      return {
        ...job,
        description: info.description || '',
        example: info.example || '',
        exampleNote: info.exampleNote || null,
        exampleForDate: info.exampleForDate || null,
        days: info.days || 'Mon–Fri',
      };
    });

    res.json({
      preview,
      countdown,
      review,
      messages: messages.reverse(),
      schedules,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/send', async (req, res) => {
  try {
    const result = await sendDailyPairs('manual');
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/month', async (req, res) => {
  try {
    const { year, month } = req.query;
    const data =
      year && month
        ? getMonthlyPairs(year, month)
        : getDefaultMonthlyPairs();
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const [pairs, botNotices, reviews] = await Promise.all([
      getMessageHistory(limit),
      RoomMessage.find({
        category: { $in: ['bot_reminder', 'bot_missed', 'bot_wrong_pair', 'bot_duplicate'] },
      })
        .sort({ sentAt: -1 })
        .limit(limit),
      getArchivedReviewMessages(limit),
    ]);

    res.json({ pairs, botNotices, reviews });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/performance', async (req, res) => {
  try {
    const { year, month } = req.query;
    const data =
      year && month
        ? await getMonthlyPerformance(year, month)
        : await getDefaultMonthlyPerformance();
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.get('/member-rooms', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 12, 50);
    res.json(await getMemberRoomsOverview(limit));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/member-rooms/join', async (req, res) => {
  try {
    await joinMemberRooms();
    res.json(await getMemberRoomsOverview());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/member-rooms/send-prompts', async (req, res) => {
  try {
    const onlyMember = req.body?.member || null;
    const result = await sendMissingReviewFollowUps('manual', { onlyMember });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/missed-review/send', async (req, res) => {
  try {
    res.json(await sendMissedReviewNotice('manual'));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/schedules', async (req, res) => {
  try {
    res.json(await getScheduledMessagesInfo());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const matrixCheck = isMatrixConfigured()
      ? await verifyMatrixConnection()
      : { ok: false, message: 'Not configured' };

    res.json({
      appName: 'Element Pair Review Bot',
      matrixConfigured: isMatrixConfigured(),
      matrixConnected: matrixCheck.ok,
      matrixUserId: matrixCheck.userId || null,
      matrixDeviceId: matrixCheck.deviceId || null,
      roomId: matrixCheck.roomId || config.matrix.roomId || null,
      roomName: matrixCheck.roomName || null,
      roomEncrypted: matrixCheck.roomEncrypted ?? null,
      e2eeReady: matrixCheck.e2eeReady ?? false,
      sessionSource: matrixCheck.sessionSource || null,
      needsPasswordLogin: matrixCheck.needsPasswordLogin ?? false,
      matrixError: matrixCheck.ok
        ? matrixCheck.message || null
        : matrixCheck.message || 'Not connected',
      schedule: {
        timezone: config.timezone,
        cron: config.cronSchedule,
        description: `Weekdays at ${cronTimeLabel(config.cronSchedule, 11, 30)}`,
        reminderCron: config.reminderCronSchedule,
        reminderDescription: `Weekdays at ${cronTimeLabel(config.reminderCronSchedule, 18, 50)}`,
        missedReviewCron: config.missedReviewCronSchedule,
        missedReviewDescription: `Weekdays at ${cronTimeLabel(config.missedReviewCronSchedule, 11, 20)}`,
        missingReviewPromptCron: config.missingReviewPromptCronSchedule,
        missingReviewPromptDescription: `Weekdays at ${cronTimeLabel(config.missingReviewPromptCronSchedule, 10, 50)}`,
      },
      team: {
        developers: config.developers,
        qaTeam: config.qaTeam,
      },
      scheduledMessages: await getScheduledMessagesInfo(),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
