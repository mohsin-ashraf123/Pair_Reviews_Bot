import DailyReview from '../models/DailyReview.js';
import DiscussionPrompt from '../models/DiscussionPrompt.js';
import RoomMessage from '../models/RoomMessage.js';
import { config } from '../config/appConfig.js';
import {
  formatDisplayDate,
  getKarachiDateKey,
  getPreviousWorkingDay,
  isWeekend,
} from './pairService.js';
import { buildPairKey, getPendingPairs } from './reviewService.js';
import { sendMatrixMessageToRoom } from './matrixService.js';
import { getRoomIdForMember, touchMemberRoom } from './memberRoomService.js';
import { logMemberRoomMessage } from './roomMessageService.js';
import { emitMemberRoomUpdate } from './socketService.js';

const NO_ISSUES_RE =
  /review\s+completed\.?\s*no\s+issues,\s*concerns,\s*or\s+improvement\s+recommendations\s+identified/i;

const yesRe = /^(y|yes|yeah|yep|haan|han|ha|ok|okay|ji)\b/i;
const noRe = /^(n|no|nah|nope|nahi|nai)\b/i;

const formatPairLabel = (pair = []) => pair.join(' + ');

export const isNoIssuesReview = (body = '') => NO_ISSUES_RE.test(String(body).trim());

const parseYesNo = (body) => {
  const trimmed = (body || '').trim();
  if (yesRe.test(trimmed)) return 'yes';
  if (noRe.test(trimmed)) return 'no';
  return null;
};

const isQaPair = (pair = []) => {
  const qa = new Set(config.qaTeam || []);
  return pair.length >= 3 && pair.every((name) => qa.has(name));
};

/** Prefer QA rotation order Habiba → Adil → Aqeel when present. */
const qaRotationOrder = (pair = []) => {
  const preferred = ['Habiba', 'Adil', 'Aqeel'];
  const inPair = preferred.filter((name) => pair.includes(name));
  const rest = pair.filter((name) => !inPair.includes(name));
  return [...inPair, ...rest];
};

const rotationOrderForPair = (pair = []) =>
  isQaPair(pair) ? qaRotationOrder(pair) : [...pair];

/** Next member to ask for this pair, rotating from the last prompt. */
export const pickMemberForPair = async (pair) => {
  const order = rotationOrderForPair(pair);
  if (!order.length) return null;

  const pairKey = buildPairKey(pair);
  const last = await DiscussionPrompt.findOne({ pairKey })
    .sort({ sentAt: -1, createdAt: -1 });

  if (!last?.member) return order[0];

  const idx = order.indexOf(last.member);
  if (idx === -1) return order[0];
  return order[(idx + 1) % order.length];
};

const getReviewMessageForPair = async (dateKey, pair) => {
  const pairKey = buildPairKey(pair);
  const personal = Object.values(config.memberRoomMap || {}).filter(Boolean);
  const query = {
    dateKey,
    pairKey,
    countsAsReview: true,
    deletedAt: { $exists: false },
  };
  if (personal.length) query.roomId = { $nin: personal };
  else if (config.matrix.roomId) query.roomId = config.matrix.roomId;
  return RoomMessage.findOne(query).sort({ sentAt: -1 });
};

export const formatDiscussionPromptMessage = (
  member,
  pair,
  reviewDateKey,
  reviewBody
) => {
  const displayDate = formatDisplayDate(reviewDateKey);
  return [
    `🗓️ Meeting check — ${displayDate}`,
    '',
    `Hi ${member},`,
    '',
    `Your pair review for ${formatPairLabel(pair)} on ${displayDate} was:`,
    '',
    String(reviewBody || '').trim(),
    '',
    'Was this discussed in today’s meeting?',
    '',
    'Reply: YES or NO',
  ].join('\n');
};

/**
 * Weekday 5:00 PM — ask one member per submitted pair (with real findings)
 * whether yesterday's review was discussed in today's meeting.
 */
export const sendDiscussionPrompts = async (
  meetingDateKey = getKarachiDateKey(),
  { force = false } = {}
) => {
  if (isWeekend(meetingDateKey)) {
    return { skipped: true, reason: 'Weekend — no discussion prompts', prompts: [] };
  }

  const reviewDateKey = getPreviousWorkingDay(meetingDateKey);
  const review = await DailyReview.findOne({ dateKey: reviewDateKey });
  if (!review?.pairsSentAt) {
    return {
      skipped: true,
      reason: `No pairs were sent on ${reviewDateKey}`,
      prompts: [],
      reviewDateKey,
      meetingDateKey,
    };
  }

  const pendingKeys = new Set(
    getPendingPairs(review.pairs, review).map((p) => buildPairKey(p))
  );

  const prompts = [];
  const skipped = [];

  for (const pair of review.pairs || []) {
    const pairKey = buildPairKey(pair);

    if (pendingKeys.has(pairKey)) {
      skipped.push({ pair, reason: 'Review missing — skipped' });
      continue;
    }

    const reviewMsg = await getReviewMessageForPair(reviewDateKey, pair);
    const reviewBody = reviewMsg?.body || '';

    if (!reviewBody.trim()) {
      skipped.push({ pair, reason: 'Review message not found — skipped' });
      continue;
    }

    if (isNoIssuesReview(reviewBody)) {
      skipped.push({ pair, reason: 'No-issues review — skipped' });
      continue;
    }

    const existing = await DiscussionPrompt.findOne({ reviewDateKey, pairKey });
    if (existing) {
      // Never wipe or re-ask after a real reply — even with force.
      if (existing.status === 'answered') {
        skipped.push({
          pair,
          reason: 'Already answered — skipped',
          member: existing.member,
          answer: existing.response?.answer || null,
        });
        continue;
      }

      // Already delivered today — don't spam; force only retries failed sends.
      if (existing.status === 'pending' && existing.eventId && !force) {
        skipped.push({
          pair,
          reason: 'Discussion prompt already sent',
          member: existing.member,
        });
        continue;
      }

      if (existing.status === 'pending' && existing.eventId && force) {
        skipped.push({
          pair,
          reason: 'Already sent (force will not re-ask answered/pending prompts)',
          member: existing.member,
        });
        continue;
      }

      // Retry only failed (or pending with no Matrix event).
      if (existing.status === 'failed' || (existing.status === 'pending' && !existing.eventId)) {
        await DiscussionPrompt.deleteOne({ _id: existing._id });
      } else if (!force) {
        skipped.push({
          pair,
          reason: 'Discussion prompt already sent',
          member: existing.member,
        });
        continue;
      } else {
        skipped.push({
          pair,
          reason: 'Discussion prompt already exists — skipped',
          member: existing.member,
        });
        continue;
      }
    }

    const member = await pickMemberForPair(pair);
    const roomId = getRoomIdForMember(member);
    if (!member || !roomId) {
      skipped.push({ pair, reason: `No personal room for ${member || 'member'}` });
      continue;
    }

    const message = formatDiscussionPromptMessage(
      member,
      pair,
      reviewDateKey,
      reviewBody
    );

    let promptDoc = await DiscussionPrompt.create({
      reviewDateKey,
      meetingDateKey,
      pair,
      pairKey,
      member,
      roomId,
      reviewBody,
      message,
      status: 'pending',
      sentAt: new Date(),
    });

    try {
      const result = await sendMatrixMessageToRoom(roomId, message, {
        kind: 'discussion_prompt',
        member,
        dateKey: reviewDateKey,
      });
      promptDoc.eventId = result.event_id;
      await promptDoc.save();

      await logMemberRoomMessage({
        member,
        roomId,
        body: message,
        eventId: result.event_id,
        category: 'bot_dm_prompt',
        dateKey: reviewDateKey,
      });
      await touchMemberRoom(member, { lastPromptAt: new Date() });

      prompts.push(promptDoc);
    } catch (error) {
      promptDoc.status = 'failed';
      promptDoc.sendError = error.message;
      await promptDoc.save();
      skipped.push({ pair, reason: error.message, member });
    }
  }

  if (prompts.length) {
    emitMemberRoomUpdate({
      dateKey: reviewDateKey,
      discussionPrompts: prompts.map((p) => p.toObject()),
    });
  }

  return {
    skipped: prompts.length === 0 && skipped.length > 0,
    reason:
      prompts.length === 0
        ? 'No discussion prompts to send'
        : undefined,
    reviewDateKey,
    meetingDateKey,
    prompts,
    skippedPairs: skipped,
  };
};

/**
 * Preview who would get a 5 PM discussion check (no sends).
 * Same skip rules as sendDiscussionPrompts.
 */
export const previewDiscussionPrompts = async (
  meetingDateKey = getKarachiDateKey()
) => {
  const reviewDateKey = getPreviousWorkingDay(meetingDateKey);
  const review = await DailyReview.findOne({ dateKey: reviewDateKey });

  if (!review?.pairsSentAt) {
    return {
      reviewDateKey,
      meetingDateKey,
      prompts: [],
      skippedPairs: [],
      note: `No pairs were sent on ${formatDisplayDate(reviewDateKey)} — nothing to ask.`,
    };
  }

  const pendingKeys = new Set(
    getPendingPairs(review.pairs, review).map((p) => buildPairKey(p))
  );

  const prompts = [];
  const skippedPairs = [];

  for (const pair of review.pairs || []) {
    const pairKey = buildPairKey(pair);

    if (pendingKeys.has(pairKey)) {
      skippedPairs.push({ pair, reason: 'Review missing — skipped' });
      continue;
    }

    const reviewMsg = await getReviewMessageForPair(reviewDateKey, pair);
    const reviewBody = reviewMsg?.body || '';

    if (!reviewBody.trim()) {
      skippedPairs.push({ pair, reason: 'Review message not found — skipped' });
      continue;
    }

    if (isNoIssuesReview(reviewBody)) {
      skippedPairs.push({ pair, reason: 'No-issues review — skipped' });
      continue;
    }

    const existing = await DiscussionPrompt.findOne({ reviewDateKey, pairKey });
    if (existing?.status === 'answered') {
      skippedPairs.push({
        pair,
        reason: `Already answered (${existing.response?.answer || '?'}) by ${existing.member}`,
        member: existing.member,
      });
      continue;
    }
    if (existing?.status === 'pending' && existing.eventId) {
      skippedPairs.push({
        pair,
        reason: `Already sent to ${existing.member} — awaiting reply`,
        member: existing.member,
      });
      continue;
    }

    const member = existing?.member || (await pickMemberForPair(pair));
    if (!member) {
      skippedPairs.push({ pair, reason: 'No member to ask' });
      continue;
    }

    prompts.push({
      member,
      pair,
      message: formatDiscussionPromptMessage(
        member,
        pair,
        reviewDateKey,
        reviewBody
      ),
      alreadySent: Boolean(existing?.eventId),
      status: existing?.status || 'queued',
    });
  }

  return {
    reviewDateKey,
    meetingDateKey,
    prompts,
    skippedPairs,
    note:
      prompts.length === 0
        ? 'No discussion prompts would be sent (all pairs skipped).'
        : `${prompts.length} personal DM(s) for ${formatDisplayDate(reviewDateKey)} reviews.`,
  };
};

export const handleDiscussionReply = async (member, roomId, body, eventId) => {
  const prompt = await DiscussionPrompt.findOne({
    member,
    roomId,
    status: 'pending',
  }).sort({ sentAt: -1 });

  if (!prompt) return { status: 'no_prompt' };

  const answer = parseYesNo(body);
  if (!answer) {
    return {
      status: 'invalid',
      prompt,
      ack: 'Please reply YES or NO — was this review discussed in today’s meeting?',
    };
  }

  prompt.status = 'answered';
  prompt.response = {
    answer,
    body,
    eventId,
    respondedAt: new Date(),
  };
  await prompt.save();
  await touchMemberRoom(member, { lastReplyAt: new Date() });

  emitMemberRoomUpdate({
    dateKey: prompt.reviewDateKey,
    discussionPrompts: [prompt.toObject()],
  });

  const ack =
    answer === 'yes'
      ? '✅ Thanks — marked as discussed in today’s meeting.'
      : '✅ Thanks — marked as not discussed. This will be noted in tomorrow’s room update.';

  return { status: 'answered', prompt, answer, ack };
};

/** Pairs that answered NO for the meeting on `meetingDateKey`. */
export const getUndiscussedPairsForMeeting = async (meetingDateKey) => {
  const prompts = await DiscussionPrompt.find({
    meetingDateKey,
    status: 'answered',
    'response.answer': 'no',
  }).sort({ member: 1 });

  return prompts.map((p) => ({
    pair: p.pair,
    pairKey: p.pairKey,
    member: p.member,
    reviewDateKey: p.reviewDateKey,
    reviewBody: p.reviewBody,
  }));
};
