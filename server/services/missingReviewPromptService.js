import DailyReview from '../models/DailyReview.js';
import MissingReviewPrompt from '../models/MissingReviewPrompt.js';
import { formatDisplayDate, getKarachiDateKey } from './pairService.js';
import { getPendingPairs, buildReviewState } from './reviewService.js';
import { sendMatrixMessageToRoom } from './matrixService.js';
import { getRoomIdForMember, touchMemberRoom } from './memberRoomService.js';
import { logMemberRoomMessage } from './roomMessageService.js';
import { emitMemberRoomUpdate, emitReviewUpdate } from './socketService.js';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/**
 * Options depend on pair size. Each member can report absences and half-day
 * leave for themselves or for a partner.
 *
 * 2-member pair example:
 *   A partner absent · B I was absent · C both absent
 *   D partner half day · E I was half day · F forgot
 *
 * QA trio adds one absent + one half-day option per partner.
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

  for (const partner of partners) {
    push(`${partner} was on half day leave`, 'partner_half_day', [], [partner]);
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

/** Options when a QA review named 2 of 3 — ask why the missing member was out. */
export const buildPartialQaPromptOptions = (missingMembers = []) => {
  const options = [];
  let index = 0;
  const push = (
    label,
    type,
    absentMembers = [],
    halfDayMembers = [],
    lateMembers = []
  ) => {
    options.push({
      letter: LETTERS[index],
      label,
      type,
      absentMembers,
      halfDayMembers,
      lateMembers,
    });
    index += 1;
  };

  for (const name of missingMembers) {
    push(`${name} was absent`, 'partner_absent', [name]);
  }
  for (const name of missingMembers) {
    push(`${name} was on half day leave`, 'partner_half_day', [], [name]);
  }
  for (const name of missingMembers) {
    push(`Forgot to include ${name} in the review`, 'forgot', [], [], [name]);
  }

  return options;
};

export const formatPartialQaPromptMessage = (
  member,
  pair,
  presentMembers,
  missingMembers,
  dateKey,
  options
) => {
  const displayDate = formatDisplayDate(dateKey);
  const optionLines = options.map((opt) => `${opt.letter} — ${opt.label}`);
  const missingLabel = missingMembers.join(' + ');
  const presentLabel = presentMembers.join(' + ');

  return [
    `🔔 Incomplete QA Review — ${displayDate}`,
    '',
    `Hi ${member},`,
    '',
    `A review came in for ${presentLabel}, but ${missingLabel} was missing.`,
    `Today’s QA pair is ${pair.join(' + ')}.`,
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
 * Multiple letters ("A B" / "A,C") merge — one reason per person
 * (half-day wins over absent for the same name).
 */
export const parsePromptReply = (body, options) => {
  const trimmed = (body || '').trim();
  if (!trimmed) return null;

  const cleaned = trimmed.replace(/^option[s]?\s*/i, '');
  const letters = [
    ...new Set(
      (cleaned.match(/\b[a-hA-H]\b/g) || []).map((letter) => letter.toUpperCase())
    ),
  ];
  const matched = letters
    .map((letter) => options.find((opt) => opt.letter === letter))
    .filter(Boolean);

  if (matched.length === 1) return matched[0];

  if (matched.length > 1) {
    const forgot = matched.find((opt) => opt.type === 'forgot');
    if (forgot) return forgot;

    const absent = new Set();
    const halfDay = new Set();
    for (const opt of matched) {
      for (const name of opt.halfDayMembers || []) halfDay.add(name);
      for (const name of opt.absentMembers || []) absent.add(name);
    }
    for (const name of halfDay) absent.delete(name);

    return {
      letter: matched.map((opt) => opt.letter).join('+'),
      label: matched.map((opt) => opt.label).join(' · '),
      type: 'combined',
      absentMembers: [...absent],
      halfDayMembers: [...halfDay],
    };
  }

  const lower = trimmed.toLowerCase();
  return options.find((opt) => opt.label.toLowerCase() === lower) || null;
};

/**
 * Rebuild attendance for a date from every answered follow-up.
 * Self half-day reports win over a partner later saying "was absent".
 */
export const recomputeAttendanceFromPrompts = async (dateKey) => {
  const review = await DailyReview.findOne({ dateKey });
  if (!review) return null;

  const prompts = await MissingReviewPrompt.find({
    dateKey,
    status: 'answered',
  });

  const absent = new Set();
  const halfDay = new Set();
  const late = new Set();
  const selfHalfDay = new Set();
  const selfAbsent = new Set();
  const touchedPairs = [];

  for (const prompt of prompts) {
    const response = prompt.response || {};
    touchedPairs.push(prompt.pair || []);

    if (response.type === 'forgot') {
      const lateNames =
        response.lateMembers?.length > 0
          ? response.lateMembers
          : prompt.pair || [];
      for (const name of lateNames) late.add(name);
      continue;
    }

    let halfDayNames = [...(response.halfDayMembers || [])];
    // Older replies stored type=half_day but left halfDayMembers empty.
    if (!halfDayNames.length && response.type === 'half_day') {
      halfDayNames = [prompt.member];
    }

    for (const name of halfDayNames) {
      halfDay.add(name);
      if (name === prompt.member) selfHalfDay.add(name);
    }

    for (const name of response.absentMembers || []) {
      absent.add(name);
      if (name === prompt.member) selfAbsent.add(name);
    }
  }

  // Half day is more specific than full absent — keep the half-day claim.
  // A member's own half-day reply always beats a partner calling them absent.
  for (const name of halfDay) {
    absent.delete(name);
  }
  for (const name of selfHalfDay) {
    absent.delete(name);
    halfDay.add(name);
  }

  const excused = new Set();
  for (const pair of touchedPairs) {
    for (const name of pair) {
      if (absent.has(name) || halfDay.has(name) || late.has(name)) continue;
      const partnerBlocked = pair.some(
        (other) =>
          other !== name &&
          (absent.has(other) || halfDay.has(other))
      );
      if (partnerBlocked) excused.add(name);
    }
  }

  for (const name of late) {
    absent.delete(name);
    halfDay.delete(name);
    excused.delete(name);
  }

  review.absentMembers = [...absent];
  review.halfDayMembers = [...halfDay];
  review.excusedMembers = [...excused];
  review.lateReviewedMembers = [...late];
  await review.save();
  return review;
};

const applyAnswerToReview = async (prompt, option) => {
  // Ensure halfDayMembers is present even when older replies omitted it.
  if (prompt.response) {
    prompt.response.absentMembers = option.absentMembers || prompt.response.absentMembers || [];
    prompt.response.halfDayMembers =
      option.halfDayMembers || prompt.response.halfDayMembers || [];
    prompt.response.type = option.type || prompt.response.type;
  }

  return recomputeAttendanceFromPrompts(prompt.dateKey);
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

  const pendingPairs = getPendingPairs(review.pairs, review);
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
        const result = await sendMatrixMessageToRoom(roomId, message, {
          kind: 'missing_review_dm',
          member,
          dateKey,
        });

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

/**
 * After a 2-of-3 QA review lands, DM one present member about the missing person.
 */
export const sendPartialQaMissingPrompt = async ({
  dateKey,
  pair,
  presentMembers = [],
  missingMembers = [],
}) => {
  if (!missingMembers.length || !presentMembers.length) {
    return { skipped: true, reason: 'Nothing missing' };
  }

  const candidates = presentMembers.filter((name) => getRoomIdForMember(name));
  if (!candidates.length) {
    return { skipped: true, reason: 'No personal room for present members' };
  }

  // Prefer someone who does not already have an open/answered prompt today.
  let member = null;
  for (const name of candidates) {
    const existing = await MissingReviewPrompt.findOne({ dateKey, member: name });
    if (!existing || existing.status === 'failed') {
      member = name;
      break;
    }
  }
  if (!member) {
    return {
      skipped: true,
      reason: 'Present members already have a follow-up prompt for this day',
    };
  }

  const roomId = getRoomIdForMember(member);
  const options = buildPartialQaPromptOptions(missingMembers);
  const message = formatPartialQaPromptMessage(
    member,
    pair,
    presentMembers,
    missingMembers,
    dateKey,
    options
  );

  try {
    const result = await sendMatrixMessageToRoom(roomId, message, {
      kind: 'partial_qa_missing_dm',
      member,
      dateKey,
    });

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
    emitMemberRoomUpdate({ dateKey, prompts: [promptToPayload(saved)] });

    console.log(
      `[prompt] Partial QA follow-up → ${member} about ${missingMembers.join(', ')} (${dateKey})`
    );

    return { skipped: false, prompt: promptToPayload(saved), member, missingMembers };
  } catch (error) {
    console.error(`[prompt] Partial QA DM failed for ${member}: ${error.message}`);
    return { skipped: true, reason: error.message };
  }
};

/** Handle a member's reply inside their personal room. */
export const handleMemberReply = async (member, roomId, body, eventId) => {
  // Only open (pending) prompts — never spam "already replied" on chit-chat
  // after a meeting-check YES (that was matching old answered Aug prompts).
  let prompt = await MissingReviewPrompt.findOne({
    member,
    roomId,
    status: 'pending',
  }).sort({ sentAt: -1 });

  if (!prompt) {
    prompt = await MissingReviewPrompt.findOne({
      member,
      status: 'pending',
    }).sort({ sentAt: -1 });
  }

  if (!prompt) {
    // If they send a letter for a recently answered prompt, remind once.
    const recent = await MissingReviewPrompt.findOne({
      member,
      status: 'answered',
    }).sort({ sentAt: -1 });
    if (recent?.options?.length && parsePromptReply(body, recent.options)) {
      return {
        status: 'already_answered',
        prompt: recent,
        ack: formatAlreadyAnsweredAck(recent),
      };
    }
    return { status: 'no_prompt' };
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
    absentMembers: option.absentMembers || [],
    halfDayMembers: option.halfDayMembers || [],
    lateMembers: option.lateMembers || [],
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
