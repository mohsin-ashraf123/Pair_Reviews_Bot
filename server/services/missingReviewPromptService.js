import DailyReview from '../models/DailyReview.js';
import MissingReviewPrompt from '../models/MissingReviewPrompt.js';
import { formatDisplayDate, getKarachiDateKey } from './pairService.js';
import { getPendingPairs, buildReviewState } from './reviewService.js';
import { sendMatrixMessageToRoom } from './matrixService.js';
import { getRoomIdForMember, touchMemberRoom } from './memberRoomService.js';
import { logMemberRoomMessage } from './roomMessageService.js';
import { emitMemberRoomUpdate, emitReviewUpdate } from './socketService.js';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * Options depend on pair size. A member always reports their own half day,
 * since every member of the pair gets their own message.
 *
 * 2-member dev pair → partner absent / self absent / both absent / half day / forgot
 * 3-member QA pair  → each partner absent / self absent / all absent / half day / forgot
 */
export const buildPromptOptions = (member, pair, dateKey) => {
  const partners = pair.filter((name) => name !== member);
  const displayDate = formatDisplayDate(dateKey);
  const options = [];
  let index = 0;

  const push = (label, type, absentMembers = [], halfDayMembers = []) => {
    options.push({
      letter: LETTERS[index],
      label,
      type,
      absentMembers,
      halfDayMembers,
    });
    index += 1;
  };

  for (const partner of partners) {
    push(`${partner} was absent`, 'partner_absent', [partner]);
  }

  push('I was absent', 'self_absent', [member]);

  if (partners.length === 1) {
    push('Both of us were absent', 'all_absent', [member, ...partners]);
  } else {
    push('All of us were absent', 'all_absent', [member, ...partners]);
  }

  push('I was on half day leave', 'half_day', [], [member]);
  push(`Forgot to send the review (${displayDate})`, 'forgot', []);

  return options;
};

export const formatPromptMessage = (member, pair, dateKey, options) => {
  const displayDate = formatDisplayDate(dateKey);
  const optionLines = options.map((opt) => `${opt.letter} — ${opt.label}`);

  return [
    `🔔 Missing Review — ${displayDate}`,
    '',
    `Hi ${member},`,
    '',
    `No review was received for ${pair.join(' + ')}.`,
    '',
    'Reply with one letter only:',
    '',
    ...optionLines,
    '',
    `Example: ${options[0]?.letter || 'A'}`,
  ].join('\n');
};

export const formatPromptAck = (prompt, option) => {
  const displayDate = formatDisplayDate(prompt.dateKey);

  if (option.type === 'forgot') {
    return `✅ Noted — ${prompt.pair.join(' + ')} marked as "forgot to send review" for ${displayDate}. Thanks ${prompt.member}!`;
  }

  const parts = [];
  if (option.absentMembers?.length) {
    parts.push(`${option.absentMembers.join(', ')} marked absent`);
  }
  if (option.halfDayMembers?.length) {
    parts.push(`${option.halfDayMembers.join(', ')} marked half day leave`);
  }

  const summary = parts.length ? parts.join(' and ') : 'your reply recorded';
  return `✅ Noted — ${summary} for ${displayDate}. Thanks ${prompt.member}!`;
};

export const formatAlreadyAnsweredAck = (prompt) =>
  `You already replied "${prompt.response?.letter}" for ${formatDisplayDate(
    prompt.dateKey
  )} — ${prompt.response?.label}.`;

export const formatInvalidReplyAck = (prompt) => {
  const optionLines = prompt.options.map((opt) => `${opt.letter} — ${opt.label}`);
  return [
    `Sorry, I didn't understand that. Please reply with one letter for ${formatDisplayDate(
      prompt.dateKey
    )}:`,
    '',
    ...optionLines,
  ].join('\n');
};

/**
 * Match a reply like "A", "b.", "Option C" against the prompt options.
 * Multiple letters ("A B" / "A,B") merge into one combined answer so a
 * QA member can report both partners absent.
 */
export const parsePromptReply = (body, options) => {
  const trimmed = (body || '').trim();
  if (!trimmed) return null;

  const cleaned = trimmed.replace(/^option[s]?\s*/i, '');
  const letters = [
    ...new Set(
      (cleaned.match(/\b[a-fA-F]\b/g) || []).map((letter) => letter.toUpperCase())
    ),
  ];
  const matched = letters
    .map((letter) => options.find((opt) => opt.letter === letter))
    .filter(Boolean);

  if (matched.length === 1) return matched[0];

  if (matched.length > 1) {
    const forgot = matched.find((opt) => opt.type === 'forgot');
    if (forgot) return forgot;

    return {
      letter: matched.map((opt) => opt.letter).join('+'),
      label: matched.map((opt) => opt.label).join(' · '),
      type: 'combined',
      absentMembers: [...new Set(matched.flatMap((opt) => opt.absentMembers || []))],
      halfDayMembers: [
        ...new Set(matched.flatMap((opt) => opt.halfDayMembers || [])),
      ],
    };
  }

  const lower = trimmed.toLowerCase();
  return options.find((opt) => opt.label.toLowerCase() === lower) || null;
};

/**
 * Apply an answer to the day's attendance record. Pair members who are not
 * reported absent were present but blocked by their partner, so they are
 * excused instead of counted absent.
 */
const applyAnswerToReview = async (prompt, option) => {
  const review = await DailyReview.findOne({ dateKey: prompt.dateKey });
  if (!review) return null;

  const absent = new Set(review.absentMembers || []);
  const late = new Set(review.lateReviewedMembers || []);
  const excused = new Set(review.excusedMembers || []);
  const halfDay = new Set(review.halfDayMembers || []);

  if (option.type === 'forgot') {
    for (const name of prompt.pair) {
      late.add(name);
      absent.delete(name);
      excused.delete(name);
    }
  } else {
    for (const name of option.absentMembers || []) {
      if (late.has(name)) continue;
      absent.add(name);
      excused.delete(name);
      halfDay.delete(name);
    }

    for (const name of option.halfDayMembers || []) {
      if (late.has(name) || absent.has(name)) continue;
      halfDay.add(name);
      excused.delete(name);
    }

    for (const name of prompt.pair) {
      if (absent.has(name) || late.has(name) || halfDay.has(name)) continue;
      excused.add(name);
    }
  }

  review.absentMembers = [...absent];
  review.lateReviewedMembers = [...late];
  review.excusedMembers = [...excused];
  review.halfDayMembers = [...halfDay];
  await review.save();
  return review;
};

const promptToPayload = (prompt) => ({
  id: prompt._id?.toString(),
  dateKey: prompt.dateKey,
  member: prompt.member,
  pair: prompt.pair,
  roomId: prompt.roomId,
  status: prompt.status,
  message: prompt.message,
  options: prompt.options,
  response: prompt.response,
  sentAt: prompt.sentAt,
});

/**
 * DM every member of a pair that missed its review on `dateKey`.
 * Skips members that were already prompted for the same date.
 * `onlyMember` limits the run to one person (dashboard re-send / testing).
 */
export const sendMissingReviewPrompts = async (dateKey, { onlyMember = null } = {}) => {
  const review = await DailyReview.findOne({ dateKey });
  if (!review?.pairsSentAt) {
    return { skipped: true, reason: 'No pairs were sent on that day', prompts: [] };
  }

  const pendingPairs = getPendingPairs(review.pairs, review.reviewedMembers);
  if (!pendingPairs.length) {
    return { skipped: true, reason: 'All reviews were submitted', prompts: [] };
  }

  const targetPairs = onlyMember
    ? pendingPairs.filter((pair) => pair.includes(onlyMember))
    : pendingPairs;

  if (!targetPairs.length) {
    return {
      skipped: true,
      reason: `${onlyMember} has no missing review for ${dateKey}`,
      prompts: [],
    };
  }

  const prompts = [];

  for (const pair of targetPairs) {
    for (const member of pair) {
      if (onlyMember && member !== onlyMember) continue;

      const existing = await MissingReviewPrompt.findOne({ dateKey, member });
      if (existing && existing.status !== 'failed') {
        prompts.push(promptToPayload(existing));
        continue;
      }

      const roomId = getRoomIdForMember(member);
      if (!roomId) {
        console.warn(`[prompt] No personal room configured for ${member}`);
        continue;
      }

      const options = buildPromptOptions(member, pair, dateKey);
      const message = formatPromptMessage(member, pair, dateKey, options);

      try {
        const result = await sendMatrixMessageToRoom(roomId, message);

        const saved = await MissingReviewPrompt.findOneAndUpdate(
          { dateKey, member },
          {
            $set: {
              promptDateKey: getKarachiDateKey(),
              pair,
              partners: pair.filter((name) => name !== member),
              roomId,
              eventId: result.event_id,
              message,
              options,
              status: 'pending',
              sendError: null,
              sentAt: new Date(),
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        await logMemberRoomMessage({
          member,
          roomId,
          body: message,
          eventId: result.event_id,
          category: 'bot_dm_prompt',
          dateKey,
        });
        await touchMemberRoom(member, { lastPromptAt: new Date() });

        prompts.push(promptToPayload(saved));
      } catch (error) {
        console.error(`[prompt] Failed to DM ${member}: ${error.message}`);
        await MissingReviewPrompt.findOneAndUpdate(
          { dateKey, member },
          {
            $set: {
              promptDateKey: getKarachiDateKey(),
              pair,
              partners: pair.filter((name) => name !== member),
              roomId,
              message,
              options,
              status: 'failed',
              sendError: error.message,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }
    }
  }

  if (!onlyMember) {
    review.missingReviewPromptsSentAt = new Date();
    await review.save();
  }

  emitMemberRoomUpdate({ dateKey, prompts });

  return { skipped: false, dateKey, pendingPairs, prompts };
};

/** Handle a member's reply inside their personal room. */
export const handleMemberReply = async (member, roomId, body, eventId) => {
  const prompt = await MissingReviewPrompt.findOne({
    member,
    roomId,
    status: { $in: ['pending', 'answered'] },
  }).sort({ sentAt: -1 });

  if (!prompt) return { status: 'no_prompt' };

  if (prompt.status === 'answered') {
    return { status: 'already_answered', prompt, ack: formatAlreadyAnsweredAck(prompt) };
  }

  const option = parsePromptReply(body, prompt.options);
  if (!option) {
    return { status: 'invalid', prompt, ack: formatInvalidReplyAck(prompt) };
  }

  prompt.status = 'answered';
  prompt.response = {
    letter: option.letter,
    label: option.label,
    type: option.type,
    absentMembers: option.absentMembers,
    body,
    eventId,
    respondedAt: new Date(),
  };
  await prompt.save();

  const review = await applyAnswerToReview(prompt, option);
  await touchMemberRoom(member, { lastReplyAt: new Date() });

  if (review) {
    emitReviewUpdate(buildReviewState(review));
  }

  emitMemberRoomUpdate({ dateKey: prompt.dateKey, prompts: [promptToPayload(prompt)] });

  return {
    status: 'answered',
    prompt,
    option,
    ack: formatPromptAck(prompt, option),
  };
};

/** Pair label → answer summary, used by the room notice and the dashboard. */
export const getPromptSummary = async (dateKey) => {
  const prompts = await MissingReviewPrompt.find({ dateKey }).sort({ member: 1 });
  const byPair = new Map();

  for (const prompt of prompts) {
    const key = [...prompt.pair].sort().join('|');
    if (!byPair.has(key)) {
      byPair.set(key, { pair: prompt.pair, responses: [] });
    }
    if (prompt.status === 'answered' && prompt.response?.letter) {
      byPair.get(key).responses.push({
        member: prompt.member,
        letter: prompt.response.letter,
        label: prompt.response.label,
        type: prompt.response.type,
        absentMembers: prompt.response.absentMembers || [],
        halfDayMembers: prompt.response.halfDayMembers || [],
      });
    }
  }

  return { prompts, byPair };
};

/**
 * Short outcome text shown in brackets next to a pair in the room notice,
 * e.g. "they forgot to send review" or "Farhan absent, Hamza half day leave".
 */
export const summarizePairResponses = (entry) => {
  if (!entry || !entry.responses.length) return null;

  if (entry.responses.some((r) => r.type === 'forgot')) {
    return 'they forgot to send review';
  }

  const absent = new Set();
  const halfDay = new Set();
  for (const response of entry.responses) {
    for (const name of response.absentMembers || []) absent.add(name);
    for (const name of response.halfDayMembers || []) halfDay.add(name);
  }

  const parts = [];
  if (absent.size) parts.push(`${[...absent].join(', ')} absent`);
  if (halfDay.size) parts.push(`${[...halfDay].join(', ')} half day leave`);

  return parts.length ? parts.join(', ') : null;
};

export const getPromptsForDate = (dateKey) =>
  MissingReviewPrompt.find({ dateKey }).sort({ member: 1 });

export const getRecentPromptsForMember = (member, limit = 10) =>
  MissingReviewPrompt.find({ member }).sort({ sentAt: -1 }).limit(limit);
