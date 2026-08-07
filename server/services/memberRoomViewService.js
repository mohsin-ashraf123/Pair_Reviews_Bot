import DailyReview from '../models/DailyReview.js';
import MissingReviewPrompt from '../models/MissingReviewPrompt.js';
import { config } from '../config/appConfig.js';
import { getMemberRooms } from './memberRoomService.js';
import { getMemberRoomMessages } from './roomMessageService.js';
import {
  buildPromptOptions,
  formatPromptMessage,
} from './missingReviewPromptService.js';
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

/**
 * Per-member view of the follow-up rooms: who still needs a message,
 * what the bot will send, and how each member replied.
 */
export const getMemberRoomsOverview = async (limit = 12) => {
  const todayKey = getKarachiDateKey();
  const targetKey = getFollowUpTargetDateKey();
  const sendTimeLabel = cronTimeLabel(config.missingReviewPromptCronSchedule, 10, 50);

  const [rooms, review, prompts] = await Promise.all([
    getMemberRooms(),
    DailyReview.findOne({ dateKey: targetKey }),
    MissingReviewPrompt.find({ dateKey: targetKey }),
  ]);

  const promptByMember = new Map(prompts.map((p) => [p.member, p]));
  const scheduledPairs = buildDailyPairsFromDateKey(targetKey).allPairs;
  const pairs = review?.pairsSentAt ? review.pairs : scheduledPairs;
  const pendingPairs = review?.pairsSentAt
    ? getPendingPairs(review.pairs, review.reviewedMembers)
    : [];
  const pendingMembers = new Set(pendingPairs.flat());
  const reviewedMembers = new Set(review?.reviewedMembers || []);

  const items = await Promise.all(
    rooms.map(async (room) => {
      const messages = await getMemberRoomMessages(room.roomId, limit);
      const prompt = promptByMember.get(room.member);
      const pair = findMemberPair(room.member, pairs);
      const isPending = pendingMembers.has(room.member);
      const reviewSubmitted = reviewedMembers.has(room.member);

      let preview = null;
      if (pair && isPending) {
        const options = buildPromptOptions(room.member, pair, targetKey);
        preview = {
          pair,
          options,
          message: formatPromptMessage(room.member, pair, targetKey, options),
          willSend: !prompt,
        };
      }

      return {
        member: room.member,
        roomId: room.roomId,
        team: room.team,
        joined: room.joined,
        joinError: room.joinError || null,
        pair,
        lastPromptAt: room.lastPromptAt || null,
        lastReplyAt: room.lastReplyAt || null,
        reviewPending: isPending,
        reviewSubmitted,
        preview,
        prompt: prompt
          ? {
              dateKey: prompt.dateKey,
              pair: prompt.pair,
              status: prompt.status,
              message: prompt.message,
              options: prompt.options,
              response: prompt.response,
              sentAt: prompt.sentAt,
              sendError: prompt.sendError || null,
            }
          : null,
        messages: messages.reverse().map((msg) => ({
          id: msg._id.toString(),
          eventId: msg.eventId,
          body: msg.body,
          direction: msg.direction,
          category: msg.category,
          senderName: msg.senderName,
          sentAt: msg.sentAt,
        })),
      };
    })
  );

  const queued = items.filter((item) => item.preview?.willSend).map((i) => i.member);
  const answers = items
    .filter((item) => item.prompt?.response?.letter)
    .map((item) => ({
      member: item.member,
      pair: item.prompt.pair,
      letter: item.prompt.response.letter,
      label: item.prompt.response.label,
      type: item.prompt.response.type,
      absentMembers: item.prompt.response.absentMembers || [],
      halfDayMembers: item.prompt.response.halfDayMembers || [],
      respondedAt: item.prompt.response.respondedAt,
    }));

  return {
    targetDateKey: targetKey,
    targetDateLabel: formatDisplayDate(targetKey),
    todayKey,
    sendTimeLabel,
    trackingToday: targetKey === todayKey,
    pairsSent: Boolean(review?.pairsSentAt),
    pendingPairs,
    queued,
    answers,
    awaiting: items.filter((item) => item.prompt?.status === 'pending').length,
    answered: answers.length,
    attendance: {
      absent: review?.absentMembers || [],
      halfDay: review?.halfDayMembers || [],
      excused: review?.excusedMembers || [],
      forgot: review?.lateReviewedMembers || [],
      reviewed: review?.reviewedMembers || [],
    },
    members: items,
  };
};
