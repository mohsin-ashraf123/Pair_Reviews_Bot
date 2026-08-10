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
  sendReviewReminder,
  sendDiscussionFollowUps,
} from '../services/pairBotService.js';
import { sendLeadEveningNudge } from '../services/leadReportService.js';
import { getMemberRoomsOverview } from '../services/memberRoomViewService.js';
import {
  getLeadReportDetail,
  getLeadReportHistory,
} from '../services/leadReportViewService.js';
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
import {
  getAiSettingsPublic,
  saveAiSettings,
  fetchOpenRouterModels,
} from '../services/aiService.js';
import {
  analyzeMeetingDay,
  listAnalyzeDates,
} from '../services/aiAnalyzeService.js';

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
    // Chronological (oldest → newest) so the latest sits at the bottom in chat UIs.
    res.json(messages);
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
        title: info.title || job.title,
        destination: info.destination || job.destination,
        description: info.description || '',
        example: info.example || '',
        exampleNote: info.exampleNote || null,
        exampleForDate: info.exampleForDate || null,
        recipients: info.recipients || [],
        messages: info.messages || [],
        skipped: info.skipped || [],
        days: info.days || 'Mon–Fri',
      };
    });

    res.json({
      preview,
      countdown,
      review,
      messages,
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
    const { getBotSendFailures } = await import('../services/botSendLogService.js');

    const [pairs, botNotices, reviews, failures] = await Promise.all([
      getMessageHistory(limit),
      RoomMessage.find({
        category: { $in: ['bot_reminder', 'bot_missed', 'bot_wrong_pair', 'bot_duplicate'] },
      })
        .sort({ sentAt: -1 })
        .limit(limit),
      getArchivedReviewMessages(limit),
      getBotSendFailures(limit),
    ]);

    res.json({ pairs, botNotices, reviews, failures });
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
    const limit = Math.min(Number(req.query.limit) || 40, 80);
    res.json(await getMemberRoomsOverview(limit));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/** Proxy Matrix profile picture for a team member (for dashboard avatars). */
router.get('/member-avatar/:member', async (req, res) => {
  try {
    const member = String(req.params.member || '').trim();
    if (!member) return res.status(400).end();

    const { getMemberAvatarBytes } = await import('../services/avatarService.js');
    const avatar = await getMemberAvatarBytes(member);
    if (!avatar?.buffer?.length) {
      return res.status(404).end();
    }

    res.set({
      'Content-Type': avatar.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
    });
    res.send(avatar.buffer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/lead-reports', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 60, 120);
    res.json(await getLeadReportHistory(limit));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/lead-reports/:dateKey', async (req, res) => {
  try {
    res.json(await getLeadReportDetail(req.params.dateKey));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/lead-report', async (req, res) => {
  try {
    res.json(await getLeadReportDetail(req.query.dateKey || null));
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
    const leadOverride = req.body?.lead || req.body?.member || null;
    const force = Boolean(req.body?.force);
    const result = await sendMissingReviewFollowUps('manual', { leadOverride, force });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/member-rooms/send-lead-nudge', async (req, res) => {
  try {
    const dateKey = req.body?.dateKey || undefined;
    const leadOverride = req.body?.lead || null;
    const result = await sendLeadEveningNudge(dateKey, { leadOverride });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/** Drive a lead personal-room reply through the same handler Matrix uses. */
router.post('/member-rooms/lead-reply', async (req, res) => {
  try {
    const member = req.body?.member || 'Mohsin';
    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ message: 'body is required' });
    }

    const { getRoomIdForMember } = await import('../services/memberRoomService.js');
    const { handleLeadReply } = await import('../services/leadReportService.js');
    const roomId = getRoomIdForMember(member);
    if (!roomId) {
      return res.status(400).json({ message: `No personal room for ${member}` });
    }

    const result = await handleLeadReply(
      member,
      roomId,
      body,
      `api-test-${Date.now()}`
    );

    if (result?.ack) {
      const { sendMatrixMessageToRoom } = await import('../services/matrixService.js');
      const { logMemberRoomMessage } = await import('../services/roomMessageService.js');
      const sent = await sendMatrixMessageToRoom(roomId, result.ack);
      await logMemberRoomMessage({
        member,
        roomId,
        body: result.ack,
        eventId: sent.event_id,
        category: 'bot_dm_ack',
      });
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/** Resend the current lead-report prompt for the active session (no stage advance). */
router.post('/member-rooms/resend-lead-prompt', async (req, res) => {
  try {
    const member = req.body?.member || 'Mohsin';
    const LeadReportSession = (await import('../models/LeadReportSession.js')).default;
    const {
      formatLeadReportKickoff,
      formatSinglePairVerifyQuestion,
      formatPairChoiceQuestion,
      formatForgotReasonQuestion,
    } = await import('../services/leadReportService.js');
    const { sendMatrixMessageToRoom } = await import('../services/matrixService.js');
    const { logMemberRoomMessage } = await import('../services/roomMessageService.js');
    const { getRoomIdForMember } = await import('../services/memberRoomService.js');

    const session = await LeadReportSession.findOne({
      lead: member,
      stage: {
        $in: [
          'awaiting_ready',
          'awaiting_verify',
          'awaiting_pair_choice',
          'awaiting_forgot_reason',
        ],
      },
    }).sort({ updatedAt: -1 });

    if (!session) {
      return res.status(404).json({ message: `No active lead session for ${member}` });
    }

    const roomId = session.roomId || getRoomIdForMember(member);
    let message = null;

    if (session.stage === 'awaiting_ready') {
      message = formatLeadReportKickoff(session.lead, session.dateKey);
    } else if (session.stage === 'awaiting_verify') {
      const pair = (session.submittedPairs || [])[session.currentVerifyIndex || 0];
      if (!pair) {
        return res.status(400).json({ message: 'No submitted pair left to verify' });
      }
      message = await formatSinglePairVerifyQuestion(
        session.dateKey,
        pair,
        session.currentVerifyIndex || 0,
        (session.submittedPairs || []).length
      );
    } else if (session.stage === 'awaiting_pair_choice') {
      const pair = session.pendingPairs[session.currentPairIndex];
      message = formatPairChoiceQuestion(
        pair,
        session.currentPairOptions || [],
        session.currentPairIndex,
        (session.pendingPairs || []).length
      );
    } else if (session.stage === 'awaiting_forgot_reason') {
      const pair = session.pendingPairs[session.currentPairIndex];
      message = formatForgotReasonQuestion(pair);
    }

    if (!message) {
      return res.status(400).json({ message: `Nothing to resend for stage ${session.stage}` });
    }

    const sent = await sendMatrixMessageToRoom(roomId, message);
    await logMemberRoomMessage({
      member,
      roomId,
      body: message,
      eventId: sent.event_id,
      category: 'bot_dm_prompt',
      dateKey: session.dateKey,
    });

    res.json({
      ok: true,
      stage: session.stage,
      eventId: sent.event_id,
      message,
    });
  } catch (error) {
    console.error('[resend-lead-prompt]', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * One-shot live test: Mohsin as lead — evening nudge + morning report + scripted replies.
 * Body: { driveReplies?: boolean } (default true)
 */
router.post('/member-rooms/test-lead-mohsin', async (req, res) => {
  try {
    // Default: only kick off the morning report and wait for real Element replies.
    const driveReplies = req.body?.driveReplies === true;
    const sendNudge = req.body?.sendNudge === true;
    const LEAD = 'Mohsin';

    const DailyReview = (await import('../models/DailyReview.js')).default;
    const LeadReportSession = (await import('../models/LeadReportSession.js')).default;
    const {
      getKarachiDateKey,
      getPreviousWorkingDay,
      buildDailyPairsFromDateKey,
    } = await import('../services/pairService.js');
    const { getPendingPairs } = await import('../services/reviewService.js');
    const {
      sendLeadEveningNudge,
      startLeadMorningReport,
      handleLeadReply,
    } = await import('../services/leadReportService.js');
    const { getRoomIdForMember } = await import('../services/memberRoomService.js');
    const { sendMatrixMessageToRoom } = await import('../services/matrixService.js');
    const { logMemberRoomMessage } = await import('../services/roomMessageService.js');

    const roomId = getRoomIdForMember(LEAD);
    if (!roomId) {
      return res.status(400).json({ message: 'No personal room for Mohsin' });
    }

    const todayKey = getKarachiDateKey();
    const yesterdayKey = getPreviousWorkingDay(todayKey);
    const steps = [];

    const ensureReview = async (dateKey) => {
      let review = await DailyReview.findOne({ dateKey });
      const scheduled = buildDailyPairsFromDateKey(dateKey);
      if (!review) {
        const pairs = scheduled.allPairs;
        review = await DailyReview.create({
          dateKey,
          lead: LEAD,
          pairs,
          pairsSentAt: new Date(),
          reviewedMembers: [...(pairs[0] || [])],
        });
      } else {
        review.lead = LEAD;
        if (!review.pairsSentAt) review.pairsSentAt = new Date();
        if (!review.pairs?.length) review.pairs = scheduled.allPairs;
        let pending = getPendingPairs(review.pairs, review.reviewedMembers);
        if (!pending.length) {
          const lastPair = review.pairs[review.pairs.length - 1] || [];
          review.reviewedMembers = (review.reviewedMembers || []).filter(
            (name) => !lastPair.includes(name)
          );
        }
        pending = getPendingPairs(review.pairs, review.reviewedMembers);
        if (pending.length === review.pairs.length && review.pairs.length > 1) {
          for (const name of review.pairs[0]) {
            if (!review.reviewedMembers.includes(name)) {
              review.reviewedMembers.push(name);
            }
          }
        }
        await review.save();
      }
      await LeadReportSession.deleteOne({ dateKey });
      return DailyReview.findOne({ dateKey });
    };

    const todayReview = await DailyReview.findOne({ dateKey: todayKey });
    if (sendNudge) {
      await ensureReview(todayKey);
      const nudge = await sendLeadEveningNudge(todayKey, { leadOverride: LEAD });
      steps.push({
        step: 'evening_nudge',
        result: {
          skipped: nudge.skipped,
          reason: nudge.reason,
          message: nudge.message,
          lead: nudge.lead,
        },
      });
    } else {
      steps.push({
        step: 'evening_nudge',
        result: { skipped: true, reason: 'Skipped — only morning report requested' },
      });
    }

    await ensureReview(yesterdayKey);
    const report = await startLeadMorningReport(yesterdayKey, {
      leadOverride: LEAD,
      force: true,
    });
    steps.push({ step: 'morning_report', result: {
      skipped: report.skipped,
      reason: report.reason,
      message: report.message,
      lead: report.lead,
    }});

    const reply = async (body, label) => {
      const result = await handleLeadReply(
        LEAD,
        roomId,
        body,
        `test-${Date.now()}-${Math.random()}`
      );
      if (result?.ack) {
        const sent = await sendMatrixMessageToRoom(roomId, result.ack);
        await logMemberRoomMessage({
          member: LEAD,
          roomId,
          body: result.ack,
          eventId: sent.event_id,
          category: 'bot_dm_ack',
          dateKey: yesterdayKey,
        });
      }
      steps.push({ step: label, body, result: { status: result.status, ack: result.ack } });
      return result;
    };

    if (driveReplies && !report.skipped) {
      await reply('YES', 'ready');
      let session = await LeadReportSession.findOne({ dateKey: yesterdayKey });
      if (session?.stage === 'awaiting_verify') {
        await reply('YES', 'verify');
      }

      for (let i = 0; i < 12; i += 1) {
        session = await LeadReportSession.findOne({ dateKey: yesterdayKey });
        if (!session || session.stage === 'completed') break;

        if (session.stage === 'awaiting_pair_choice') {
          const options = session.currentPairOptions || [];
          const forgot = options.find((o) => o.type === 'forgot');
          const pick =
            session.currentPairIndex === 0 && forgot
              ? forgot.letter
              : options[0]?.letter || 'A';
          await reply(pick, `pair_choice_${session.currentPairIndex + 1}`);
          continue;
        }

        if (session.stage === 'awaiting_forgot_reason') {
          await reply(
            'Was busy in a client call and forgot to follow up',
            'forgot_reason'
          );
          continue;
        }

        if (session.stage === 'awaiting_verify') {
          await reply('YES', 'verify_retry');
          continue;
        }

        if (session.stage === 'awaiting_ready') {
          await reply('YES', 'ready_retry');
          continue;
        }

        break;
      }
    }

    const finalSession = await LeadReportSession.findOne({ dateKey: yesterdayKey });
    const finalReview = await DailyReview.findOne({ dateKey: yesterdayKey });

    res.json({
      ok: true,
      lead: LEAD,
      roomId,
      todayKey,
      yesterdayKey,
      todayPending: todayReview
        ? getPendingPairs(todayReview.pairs, todayReview.reviewedMembers).length
        : 0,
      steps,
      session: finalSession
        ? {
            stage: finalSession.stage,
            reviewsVerified: finalSession.reviewsVerified,
            pairDecisions: finalSession.pairDecisions,
          }
        : null,
      attendance: {
        absent: finalReview?.absentMembers || [],
        halfDay: finalReview?.halfDayMembers || [],
        forgot: finalReview?.lateReviewedMembers || [],
        excused: finalReview?.excusedMembers || [],
      },
    });
  } catch (error) {
    console.error('[test-lead-mohsin]', error);
    res.status(500).json({ message: error.message, stack: error.stack });
  }
});

router.post('/reminder/send', async (req, res) => {
  try {
    const leadOverride = req.body?.lead || null;
    res.json(await sendReviewReminder('manual', { leadOverride }));
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

router.post('/discussion-prompts/send', async (req, res) => {
  try {
    const force = Boolean(req.body?.force);
    res.json(await sendDiscussionFollowUps('manual', { force }));
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

router.get('/ai', async (req, res) => {
  try {
    res.json(await getAiSettingsPublic());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/ai', async (req, res) => {
  try {
    const { apiKey, modelId, modelName, clearKey } = req.body || {};
    res.json(
      await saveAiSettings({
        apiKey,
        modelId,
        modelName,
        clearKey: Boolean(clearKey),
      })
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/ai/models', async (req, res) => {
  try {
    res.json(await fetchOpenRouterModels());
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/ai/models', async (req, res) => {
  try {
    const key = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    res.json(await fetchOpenRouterModels(key || undefined));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/ai/analyze/dates', async (req, res) => {
  try {
    res.json(await listAnalyzeDates(Number(req.query.limit) || 40));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/ai/analyze', async (req, res) => {
  try {
    const dateKey =
      typeof req.body?.dateKey === 'string' && req.body.dateKey.trim()
        ? req.body.dateKey.trim()
        : undefined;
    res.json(await analyzeMeetingDay(dateKey));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
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
        discussionCron: config.discussionCronSchedule,
        discussionDescription: `Weekdays at ${cronTimeLabel(config.discussionCronSchedule, 17, 0)}`,
      },
      team: {
        developers: config.developers,
        qaTeam: config.qaTeam,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
