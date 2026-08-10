import DailyReview from '../models/DailyReview.js';
import LeadReportSession from '../models/LeadReportSession.js';
import DiscussionPrompt from '../models/DiscussionPrompt.js';
import MissingReviewPrompt from '../models/MissingReviewPrompt.js';
import RoomMessage from '../models/RoomMessage.js';
import { config } from '../config/appConfig.js';
import { getMemberRooms } from './memberRoomService.js';
import { formatLeadReportKickoff } from './leadReportService.js';
import { previewDiscussionPrompts } from './discussionPromptService.js';
import { memberAvatarApiPath } from './avatarService.js';
import {
  getKarachiDateKey,
  getFollowUpTargetDateKey,
  formatDisplayDate,
  buildDailyPairsFromDateKey,
  cronTimeLabel,
} from './pairService.js';
import { getPendingPairs } from './reviewService.js';

const findMemberPair = (member, pairs = []) =>
  pairs.find((pair) => pair.includes(member)) || null;

const toMsg = (msg) => ({
  id: msg._id?.toString() || msg.id || msg.eventId,
  eventId: msg.eventId,
  body: msg.body,
  direction: msg.direction || 'out',
  category: msg.category || 'bot_dm_prompt',
  senderName: msg.senderName || 'Bot',
  sentAt: msg.sentAt,
  scheduled: Boolean(msg.scheduled),
  scheduleKind: msg.scheduleKind || null,
});

/** Real + scheduled personal-room messages for one member. */
const loadMemberThread = async ({
  member,
  roomId,
  isLead,
  leadSession,
  limit,
}) => {
  const found = await RoomMessage.find({
    $or: [{ roomId }, { memberName: member }],
  })
    .sort({ sentAt: -1 })
    .limit(limit)
    .lean();

  const byId = new Map();
  for (const msg of found) {
    const key = msg.eventId || msg._id?.toString();
    if (!byId.has(key)) byId.set(key, toMsg(msg));
  }

  if (isLead && leadSession) {
    if (leadSession.nudgeMessage && leadSession.nudgeSentAt) {
      const key = leadSession.nudgeEventId || `nudge-${leadSession.dateKey}`;
      if (!byId.has(key)) {
        byId.set(
          key,
          toMsg({
            id: key,
            eventId: key,
            body: leadSession.nudgeMessage,
            direction: 'out',
            category: 'bot_dm_prompt',
            senderName: 'Bot',
            sentAt: leadSession.nudgeSentAt,
          })
        );
      }
    }
  }

  const [discussion, missing] = await Promise.all([
    DiscussionPrompt.find({ member }).sort({ sentAt: -1 }).limit(5).lean(),
    MissingReviewPrompt.find({ member }).sort({ sentAt: -1 }).limit(5).lean(),
  ]);

  for (const p of discussion) {
    if (!p.message || !p.sentAt) continue;
    const key = p.eventId || `discussion-${p._id}`;
    if (byId.has(key)) continue;
    byId.set(
      key,
      toMsg({
        id: key,
        eventId: key,
        body: p.message,
        direction: 'out',
        category: 'bot_dm_prompt',
        senderName: 'Bot',
        sentAt: p.sentAt,
      })
    );
    if (p.response?.body) {
      const rk = p.response.eventId || `discussion-reply-${p._id}`;
      byId.set(
        rk,
        toMsg({
          id: rk,
          eventId: rk,
          body: p.response.body,
          direction: 'in',
          category: 'member_dm_reply',
          senderName: member,
          sentAt: p.response.respondedAt || p.updatedAt,
        })
      );
    }
  }

  for (const p of missing) {
    if (!p.message || !p.sentAt) continue;
    const key = p.eventId || `missing-${p._id}`;
    if (byId.has(key)) continue;
    byId.set(
      key,
      toMsg({
        id: key,
        eventId: key,
        body: p.message,
        direction: 'out',
        category: 'bot_dm_prompt',
        senderName: 'Bot',
        sentAt: p.sentAt,
      })
    );
    if (p.response?.body) {
      const rk = p.response.eventId || `missing-reply-${p._id}`;
      byId.set(
        rk,
        toMsg({
          id: rk,
          eventId: rk,
          body: p.response.body,
          direction: 'in',
          category: 'member_dm_reply',
          senderName: member,
          sentAt: p.response.respondedAt || p.updatedAt,
        })
      );
    }
  }

  return [...byId.values()].sort(
    (a, b) => new Date(a.sentAt || 0) - new Date(b.sentAt || 0)
  );
};

/**
 * Per-member view of personal rooms + lead / 5 PM discussion queues.
 */
export const getMemberRoomsOverview = async (limit = 40) => {
  const todayKey = getKarachiDateKey();
  const targetKey = getFollowUpTargetDateKey();
  const sendTimeLabel = cronTimeLabel(
    config.missingReviewPromptCronSchedule,
    10,
    50
  );
  const discussionTimeLabel = cronTimeLabel(
    config.discussionCronSchedule,
    17,
    0
  );

  const [rooms, review, leadSession, discussionPreview, todaysDiscussion] =
    await Promise.all([
      getMemberRooms(),
      DailyReview.findOne({ dateKey: targetKey }),
      LeadReportSession.findOne({ dateKey: targetKey }),
      previewDiscussionPrompts(todayKey),
      DiscussionPrompt.find({ meetingDateKey: todayKey }).lean(),
    ]);

  const discussionByMember = new Map(
    (discussionPreview.prompts || []).map((p) => [p.member, p])
  );
  const discussionStatusByMember = new Map();
  for (const p of todaysDiscussion) {
    discussionStatusByMember.set(p.member, p.status);
  }

  const scheduledPairs = buildDailyPairsFromDateKey(targetKey).allPairs;
  const pairs = review?.pairsSentAt ? review.pairs : scheduledPairs;
  const pendingPairs = review?.pairsSentAt
    ? getPendingPairs(review.pairs, review.reviewedMembers)
    : [];
  const pendingMembers = new Set(pendingPairs.flat());
  const reviewedMembers = new Set(review?.reviewedMembers || []);
  const leadName = leadSession?.lead || review?.lead || null;

  const items = await Promise.all(
    rooms.map(async (room) => {
      const isLead = leadName === room.member;
      const pair = findMemberPair(room.member, pairs);
      const isPending = pendingMembers.has(room.member);
      const reviewSubmitted = reviewedMembers.has(room.member);

      let preview = null;
      if (isLead && review?.pairsSentAt) {
        const willSend = !leadSession?.reportSentAt;
        preview = {
          message: formatLeadReportKickoff(room.member, targetKey),
          willSend,
          kind: 'lead_report',
          sendAtLabel: sendTimeLabel,
        };
      }

      const discussionPlan = discussionByMember.get(room.member) || null;
      const discussionDocStatus = discussionStatusByMember.get(room.member);
      const discussion = discussionPlan
        ? {
            pair: discussionPlan.pair,
            message: discussionPlan.message,
            sendAtLabel: discussionTimeLabel,
            status: discussionDocStatus || discussionPlan.status || 'queued',
            willSend:
              (!discussionDocStatus || discussionDocStatus === 'failed') &&
              discussionDocStatus !== 'answered',
          }
        : discussionDocStatus
          ? {
              pair: null,
              message: null,
              sendAtLabel: discussionTimeLabel,
              status: discussionDocStatus,
              willSend: false,
            }
          : null;

      const messages = await loadMemberThread({
        member: room.member,
        roomId: room.roomId,
        isLead,
        leadSession: isLead ? leadSession : null,
        limit,
      });

      if (preview?.willSend && preview.message) {
        const already = messages.some((m) => m.body === preview.message);
        if (!already) {
          messages.push(
            toMsg({
              id: `scheduled-lead-${room.member}`,
              eventId: `scheduled-lead-${room.member}`,
              body: preview.message,
              direction: 'out',
              category: 'bot_dm_prompt',
              senderName: 'Bot',
              sentAt: null,
              scheduled: true,
              scheduleKind: 'lead_report',
            })
          );
        }
      }

      if (discussion?.willSend && discussion.message) {
        const already = messages.some((m) => m.body === discussion.message);
        if (!already) {
          messages.push(
            toMsg({
              id: `scheduled-discussion-${room.member}`,
              eventId: `scheduled-discussion-${room.member}`,
              body: discussion.message,
              direction: 'out',
              category: 'bot_dm_prompt',
              senderName: 'Bot',
              sentAt: null,
              scheduled: true,
              scheduleKind: 'discussion',
            })
          );
        }
      }

      const lastReal = [...messages].reverse().find((m) => !m.scheduled);
      const scheduledPreview = [...messages]
        .reverse()
        .find((m) => m.scheduled);

      return {
        member: room.member,
        roomId: room.roomId,
        team: room.team,
        joined: room.joined,
        joinError: room.joinError || null,
        pair,
        isLead,
        avatarUrl: memberAvatarApiPath(room.member),
        lastPromptAt: room.lastPromptAt || null,
        lastReplyAt: room.lastReplyAt || null,
        reviewPending: isPending,
        reviewSubmitted,
        preview,
        discussion,
        prompt: null,
        lastMessagePreview:
          lastReal?.body || scheduledPreview?.body || preview?.message || null,
        messages,
      };
    })
  );

  const leadQueued = items
    .filter((item) => item.preview?.willSend)
    .map((i) => i.member);

  const discussionQueued = items
    .filter((item) => item.discussion?.willSend)
    .map((i) => ({
      member: i.member,
      pair: i.discussion.pair,
      message: i.discussion.message,
    }));

  return {
    targetDateKey: targetKey,
    targetDateLabel: formatDisplayDate(targetKey),
    todayKey,
    sendTimeLabel,
    discussionTimeLabel,
    discussionReviewDateLabel: formatDisplayDate(
      discussionPreview.reviewDateKey
    ),
    discussionNote: discussionPreview.note,
    pairsSent: Boolean(review?.pairsSentAt),
    pendingPairs,
    queued: leadQueued,
    discussionQueued,
    lead: leadName,
    members: items,
  };
};
