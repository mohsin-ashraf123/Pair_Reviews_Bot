import LeadReportSession from '../models/LeadReportSession.js';
import DailyReview from '../models/DailyReview.js';
import RoomMessage from '../models/RoomMessage.js';
import {
  formatDisplayDate,
  getKarachiDateKey,
  getPreviousWorkingDay,
} from './pairService.js';
import { getPendingPairs } from './reviewService.js';
import { getRoomIdForMember } from './memberRoomService.js';
import { memberAvatarApiPath } from './avatarService.js';

const STAGE_LABELS = {
  idle: 'Not started',
  awaiting_ready: 'Awaiting ready',
  awaiting_verify: 'Verifying reviews',
  awaiting_momin_check: 'Momin cross-pair check',
  awaiting_pair_choice: 'Missing-pair answers',
  awaiting_forgot_reason: 'Awaiting forgot reason',
  completed: 'Completed',
};

const toMessagePayload = (msg) => ({
  id: msg._id?.toString() || msg.id || msg.eventId,
  eventId: msg.eventId,
  body: msg.body,
  direction: msg.direction,
  category: msg.category,
  senderName: msg.senderName,
  sentAt: msg.sentAt,
  dateKey: msg.dateKey,
});

/**
 * Messages for one lead-report day: dateKey match OR time window around the
 * session (inbound replies often get stamped with "today" during the morning
 * follow-up).
 */
const getLeadChatMessages = async (session, limit = 200) => {
  if (!session?.roomId) return [];

  const start =
    session.nudgeSentAt ||
    session.reportSentAt ||
    session.createdAt ||
    new Date(`${session.dateKey}T00:00:00+05:00`);
  const end = new Date(
    (session.updatedAt ? new Date(session.updatedAt).getTime() : Date.now()) +
      12 * 60 * 60 * 1000
  );

  const msgs = await RoomMessage.find({
    roomId: session.roomId,
    category: {
      $in: ['bot_dm_prompt', 'bot_dm_ack', 'member_dm_reply', 'bot_other'],
    },
    $or: [
      { dateKey: session.dateKey },
      { sentAt: { $gte: start, $lte: end } },
    ],
  })
    .sort({ sentAt: 1 })
    .limit(limit)
    .lean();

  const byId = new Map();
  for (const msg of msgs) {
    // Prefer messages tagged to this lead; keep untagged room msgs too.
    if (msg.memberName && msg.memberName !== session.lead) continue;
    const key = msg.eventId || msg._id?.toString();
    if (!byId.has(key)) byId.set(key, toMessagePayload(msg));
  }

  if (session.nudgeMessage && session.nudgeSentAt) {
    const already = [...byId.values()].some((m) => m.body === session.nudgeMessage);
    if (!already) {
      const key = session.nudgeEventId || `nudge-${session.dateKey}`;
      byId.set(
        key,
        toMessagePayload({
          id: key,
          eventId: key,
          body: session.nudgeMessage,
          direction: 'out',
          category: 'bot_dm_prompt',
          senderName: 'Bot',
          sentAt: session.nudgeSentAt,
          dateKey: session.dateKey,
        })
      );
    }
  }

  return [...byId.values()].sort(
    (a, b) => new Date(a.sentAt || 0) - new Date(b.sentAt || 0)
  );
};

const sessionSummary = (session) => ({
  dateKey: session.dateKey,
  dateLabel: formatDisplayDate(session.dateKey),
  lead: session.lead,
  roomId: session.roomId,
  stage: session.stage,
  stageLabel: STAGE_LABELS[session.stage] || session.stage,
  nudgeSentAt: session.nudgeSentAt || null,
  reportSentAt: session.reportSentAt || null,
  completed: session.stage === 'completed',
  reviewsVerified: session.reviewsVerified,
  verifyCount: (session.verifyDecisions || []).length,
  decisionCount: (session.pairDecisions || []).length,
  pendingCount: (session.pendingPairs || []).length,
  submittedCount: (session.submittedPairs || []).length,
  updatedAt: session.updatedAt,
});

/** History list of lead-report sessions (newest first). */
export const getLeadReportHistory = async (limit = 60) => {
  const sessions = await LeadReportSession.find({})
    .sort({ dateKey: -1 })
    .limit(Math.min(Number(limit) || 60, 120));

  return {
    todayKey: getKarachiDateKey(),
    followUpKey: getPreviousWorkingDay(getKarachiDateKey()),
    items: sessions.map(sessionSummary),
  };
};

/**
 * Full lead-report day view: session, responses, attendance, chatbot chat.
 * `dateKey` defaults to previous working day (the morning-report target).
 */
export const getLeadReportDetail = async (dateKey) => {
  const todayKey = getKarachiDateKey();
  const key = dateKey || getPreviousWorkingDay(todayKey);

  const [session, review, history] = await Promise.all([
    LeadReportSession.findOne({ dateKey: key }),
    DailyReview.findOne({ dateKey: key }),
    getLeadReportHistory(60),
  ]);

  const lead = session?.lead || review?.lead || null;
  const roomId =
    session?.roomId || (lead ? getRoomIdForMember(lead) : null);

  const pendingPairs = review?.pairsSentAt
    ? getPendingPairs(review.pairs, review)
    : session?.pendingPairs || [];

  const messages = session
    ? await getLeadChatMessages(session)
    : roomId && lead
      ? (
          await RoomMessage.find({
            roomId,
            memberName: lead,
            dateKey: key,
            category: {
              $in: ['bot_dm_prompt', 'bot_dm_ack', 'member_dm_reply', 'bot_other'],
            },
          })
            .sort({ sentAt: 1 })
            .limit(200)
            .lean()
        ).map(toMessagePayload)
      : [];

  return {
    dateKey: key,
    dateLabel: formatDisplayDate(key),
    todayKey,
    lead,
    leadAvatarUrl: lead ? memberAvatarApiPath(lead) : null,
    roomId,
    pairsSent: Boolean(review?.pairsSentAt),
    session: session
      ? {
          ...sessionSummary(session),
          pairs: session.pairs || [],
          submittedPairs: session.submittedPairs || [],
          pendingPairs: session.pendingPairs || [],
          currentVerifyIndex: session.currentVerifyIndex || 0,
          currentPairIndex: session.currentPairIndex || 0,
          verifyDecisions: session.verifyDecisions || [],
          pairDecisions: session.pairDecisions || [],
          currentPairOptions: session.currentPairOptions || [],
          nudgeMessage: session.nudgeMessage || null,
        }
      : null,
    attendance: {
      absent: review?.absentMembers || [],
      halfDay: review?.halfDayMembers || [],
      excused: review?.excusedMembers || [],
      forgot: review?.lateReviewedMembers || [],
      reviewed: review?.reviewedMembers || [],
    },
    pendingPairs,
    messages,
    history: history.items,
  };
};
