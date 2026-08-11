import DailyReview from '../models/DailyReview.js';
import LeadReportSession from '../models/LeadReportSession.js';
import RoomMessage from '../models/RoomMessage.js';
import { config } from '../config/appConfig.js';
import { formatDisplayDate, getKarachiDateKey } from './pairService.js';
import { getPendingPairs, getSubmittedPairs, buildPairKey, buildReviewState } from './reviewService.js';
import { sendMatrixMessageToRoom } from './matrixService.js';
import { getRoomIdForMember, touchMemberRoom } from './memberRoomService.js';
import { logMemberRoomMessage } from './roomMessageService.js';
import { emitMemberRoomUpdate, emitReviewUpdate } from './socketService.js';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

const yesRe = /^(y|yes|yeah|yep|haan|han|ha|ok|okay|ready|ji)\b/i;
const noRe = /^(n|no|nah|nope|nahi|nai)\b/i;

const formatPairLabel = (pair = []) => pair.join(' + ');

/** Options the lead picks from for one missing pair (scoped to still-missing members). */
export const buildLeadPairOptions = (pair = [], missingMembers = null) => {
  const targets =
    Array.isArray(missingMembers) && missingMembers.length
      ? missingMembers
      : [...pair];

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

  for (const member of targets) {
    push(`${member} was absent`, 'member_absent', [member]);
  }
  for (const member of targets) {
    push(`${member} was on half day leave`, 'member_half_day', [], [member]);
  }
  if (targets.length > 1 && targets.length === pair.length) {
    push(
      pair.length === 2 ? 'Both were absent' : 'All were absent',
      'all_absent',
      [...pair]
    );
  }
  push('They forgot to send the review', 'forgot', []);

  return options;
};

export const formatLeadEveningNudge = (lead, dateKey, pendingPairs) => {
  const displayDate = formatDisplayDate(dateKey);
  const lines = pendingPairs.map((pair) => `• ${formatPairLabel(pair)}`);

  return [
    `👋 Hi ${lead},`,
    '',
    `You are today’s lead (${displayDate}).`,
    '',
    'Please make sure every pair submits their review in the Pair Reviews room today.',
    ...(pendingPairs.length
      ? ['', 'Still pending:', '', ...lines]
      : []),
    '',
    'If reviews are missing, you will be responsible for explaining why tomorrow morning.',
    '',
    'Thanks!',
  ].join('\n');
};

export const formatLeadReportKickoff = (lead, dateKey) => {
  const displayDate = formatDisplayDate(dateKey);
  return [
    `📋 Team Report — ${displayDate}`,
    '',
    `Hi ${lead},`,
    '',
    `You were the team lead on ${displayDate}.`,
    'I need to collect yesterday’s pair-review report from you.',
    '',
    'Are you ready?',
    '',
    'Reply: YES',
  ].join('\n');
};

/** One submitted pair at a time for the lead to verify. */
export const formatSinglePairVerifyQuestion = async (
  dateKey,
  pair,
  index,
  total
) => {
  const pairKey = buildPairKey(pair);
  const personal = Object.values(config.memberRoomMap || {}).filter(Boolean);
  const reviewQuery = {
    dateKey,
    pairKey,
    countsAsReview: true,
    deletedAt: { $exists: false },
  };
  if (personal.length) reviewQuery.roomId = { $nin: personal };
  else if (config.matrix.roomId) reviewQuery.roomId = config.matrix.roomId;

  const msg = await RoomMessage.findOne(reviewQuery).sort({ sentAt: -1 });

  const lines = [
    `Submitted review ${index + 1}/${total}: ${formatPairLabel(pair)}`,
    '',
  ];

  if (msg?.body) {
    // Full review text (not just the first line / pair header).
    const fullBody = String(msg.body).trim();
    lines.push('Review message:');
    lines.push(fullBody);
    if (msg.senderName) {
      lines.push('');
      lines.push(`— ${msg.senderName}`);
    }
    lines.push('');
  } else {
    lines.push('(Review was marked submitted, but the message text was not found.)');
    lines.push('');
  }

  lines.push('Did you verify this review?');
  lines.push('');
  lines.push('Reply: YES or NO');
  return lines.join('\n');
};

/** Full review body for one pair — used by dashboard previews too. */
export const formatSubmittedReviewsBlock = async (dateKey, submittedPairs) => {
  if (!submittedPairs.length) {
    return 'No pair reviews were recorded in the room for that day.';
  }

  const lines = [];
  for (const pair of submittedPairs) {
    const pairKey = buildPairKey(pair);
    const personal = Object.values(config.memberRoomMap || {}).filter(Boolean);
    const reviewQuery = {
      dateKey,
      pairKey,
      countsAsReview: true,
      deletedAt: { $exists: false },
    };
    if (personal.length) reviewQuery.roomId = { $nin: personal };
    else if (config.matrix.roomId) reviewQuery.roomId = config.matrix.roomId;

    const msg = await RoomMessage.findOne(reviewQuery).sort({ sentAt: -1 });

    lines.push(`• ${formatPairLabel(pair)}`);
    if (msg?.body) {
      lines.push(String(msg.body).trim());
      if (msg.senderName) lines.push(`— ${msg.senderName}`);
    } else {
      lines.push('(message not found)');
    }
    lines.push('');
  }

  return ['Reviews that were submitted:', '', ...lines].join('\n').trim();
};

/** @deprecated Prefer formatSinglePairVerifyQuestion — kept for dashboard previews. */
export const formatVerifyQuestion = (submittedBlock) =>
  [
    submittedBlock,
    '',
    'Did you verify this review?',
    '',
    'Reply: YES or NO',
  ].join('\n');

export const formatPairChoiceQuestion = (pair, options, index, total) => {
  const optionLines = options.map((opt) => `${opt.letter} — ${opt.label}`);
  const multiHint =
    options.filter((o) => o.type !== 'forgot' && o.type !== 'all_absent').length >
    2
      ? 'You can reply with more than one letter (one reason per person), e.g. A C'
      : 'Reply with one letter';

  return [
    `Missing review ${index + 1}/${total}: ${formatPairLabel(pair)}`,
    '',
    `Why was this review missing? ${multiHint}:`,
    '',
    ...optionLines,
  ].join('\n');
};

export const formatForgotReasonQuestion = (pair) =>
  [
    `You marked ${formatPairLabel(pair)} as forgot to send the review.`,
    '',
    'Please reply with the reason (short text).',
  ].join('\n');

export const formatLeadReportComplete = (session) => {
  const verified = (session.verifyDecisions || []).filter((d) => d.verified).length;
  const totalVerified = (session.verifyDecisions || []).length;
  const missingLines = (session.pairDecisions || []).map((decision) => {
    const reason = decision.forgotReason
      ? `${decision.label} — reason: ${decision.forgotReason}`
      : decision.label;
    return `• ${formatPairLabel(decision.pair)} — ${reason}`;
  });

  return [
    '✅ Report complete.',
    '',
    totalVerified
      ? `Verified reviews: ${verified}/${totalVerified}`
      : null,
    missingLines.length
      ? ['Missing pairs:', '', ...missingLines].join('\n')
      : null,
    '',
    'Thanks for your time!',
  ]
    .filter((line) => line !== null)
    .join('\n');
};

const parseYesNo = (body) => {
  const trimmed = (body || '').trim();
  if (yesRe.test(trimmed)) return 'yes';
  if (noRe.test(trimmed)) return 'no';
  return null;
};

/**
 * Parse one or more option letters.
 * One reason per member — Adil absent + Adil half-day is rejected.
 * `forgot` / `all_absent` must stand alone.
 */
export const parseLeadPairReply = (body, options = []) => {
  const trimmed = (body || '').trim();
  if (!trimmed) return { error: 'empty' };

  const cleaned = trimmed.replace(/^option[s]?\s*/i, '');
  const letters = [
    ...new Set(
      (cleaned.match(/\b[a-jA-J]\b/g) || []).map((letter) => letter.toUpperCase())
    ),
  ];
  if (!letters.length) return { error: 'no_letter' };

  const matched = letters
    .map((letter) => options.find((opt) => opt.letter === letter))
    .filter(Boolean);
  if (!matched.length) return { error: 'unknown' };
  if (matched.length !== letters.length) return { error: 'unknown' };

  if (matched.length === 1) {
    return { option: matched[0] };
  }

  if (matched.some((opt) => opt.type === 'forgot')) {
    return {
      error: 'forgot_alone',
      message:
        '“Forgot to send” cannot be combined with other letters. Reply with that letter alone, or pick per-person reasons.',
    };
  }
  if (matched.some((opt) => opt.type === 'all_absent')) {
    return {
      error: 'all_alone',
      message:
        '“All/Both were absent” cannot be combined with other letters. Reply with that letter alone, or pick per-person reasons.',
    };
  }

  const claimed = new Map(); // member → option label
  for (const opt of matched) {
    const names = [
      ...(opt.absentMembers || []),
      ...(opt.halfDayMembers || []),
    ];
    for (const name of names) {
      if (claimed.has(name)) {
        return {
          error: 'conflict',
          message: `${name} already has a reason (${claimed.get(name)}). Pick only one reason per person.`,
        };
      }
      claimed.set(name, opt.label);
    }
  }

  return {
    option: {
      letter: matched.map((opt) => opt.letter).join('+'),
      label: matched.map((opt) => opt.label).join(' · '),
      type: 'combined',
      absentMembers: [
        ...new Set(matched.flatMap((opt) => opt.absentMembers || [])),
      ],
      halfDayMembers: [
        ...new Set(matched.flatMap((opt) => opt.halfDayMembers || [])),
      ],
    },
  };
};

const missingMembersForPair = (pair = [], review) => {
  const accounted = new Set([
    ...(review?.reviewedMembers || []),
    ...(review?.absentMembers || []),
    ...(review?.halfDayMembers || []),
    ...(review?.excusedMembers || []),
    ...(review?.lateReviewedMembers || []),
  ]);
  return pair.filter((name) => !accounted.has(name));
};

/** Rebuild attendance from the lead's pair decisions for that day. */
export const recomputeAttendanceFromLeadReport = async (dateKey) => {
  const review = await DailyReview.findOne({ dateKey });
  if (!review) return null;

  const session = await LeadReportSession.findOne({ dateKey });
  if (!session) return review;

  const absent = new Set();
  const halfDay = new Set();
  const late = new Set();
  const excused = new Set();

  for (const decision of session.pairDecisions || []) {
    const pair = decision.pair || [];
    if (decision.type === 'forgot') {
      for (const name of pair) late.add(name);
      continue;
    }
    for (const name of decision.halfDayMembers || []) halfDay.add(name);
    for (const name of decision.absentMembers || []) absent.add(name);
  }

  for (const name of halfDay) absent.delete(name);
  for (const name of late) {
    absent.delete(name);
    halfDay.delete(name);
  }

  for (const decision of session.pairDecisions || []) {
    const pair = decision.pair || [];
    for (const name of pair) {
      if (absent.has(name) || halfDay.has(name) || late.has(name)) continue;
      const partnerBlocked = pair.some(
        (other) =>
          other !== name && (absent.has(other) || halfDay.has(other))
      );
      if (partnerBlocked) excused.add(name);
    }
  }

  review.absentMembers = [...absent];
  review.halfDayMembers = [...halfDay];
  review.lateReviewedMembers = [...late];
  review.excusedMembers = [...excused];
  await review.save();

  emitReviewUpdate(buildReviewState(review));
  return review;
};

const sendToLead = async (session, body, category = 'bot_dm_prompt') => {
  const result = await sendMatrixMessageToRoom(session.roomId, body, {
    kind: 'lead_report',
    member: session.lead,
    dateKey: session.dateKey,
  });
  await logMemberRoomMessage({
    member: session.lead,
    roomId: session.roomId,
    body,
    eventId: result.event_id,
    category,
    dateKey: session.dateKey,
  });
  await touchMemberRoom(session.lead, { lastPromptAt: new Date() });
  return result;
};

const ensureSessionFromReview = async (review, { leadOverride = null } = {}) => {
  const lead = leadOverride || review.lead;
  const roomId = getRoomIdForMember(lead);
  if (!roomId) {
    throw new Error(`No personal room configured for lead ${lead}`);
  }

  const pendingPairs = getPendingPairs(review.pairs, review);
  const submittedPairs = getSubmittedPairs(review.pairs, review.reviewedMembers);

  return LeadReportSession.findOneAndUpdate(
    { dateKey: review.dateKey },
    {
      $set: {
        lead,
        roomId,
        pairs: review.pairs,
        submittedPairs,
        pendingPairs,
      },
      $setOnInsert: {
        stage: 'idle',
        currentPairIndex: 0,
        pairDecisions: [],
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
};

/** 6:50 PM — personal nudge to today's lead (alongside the room reminder). */
export const sendLeadEveningNudge = async (
  dateKey = getKarachiDateKey(),
  { leadOverride = null } = {}
) => {
  const review = await DailyReview.findOne({ dateKey });
  if (!review?.pairsSentAt) {
    return { skipped: true, reason: 'Daily pairs not sent yet' };
  }

  const pendingPairs = getPendingPairs(review.pairs, review);
  if (!pendingPairs.length) {
    return { skipped: true, reason: 'All reviews completed — no lead nudge' };
  }

  const session = await ensureSessionFromReview(review, { leadOverride });
  if (session.nudgeSentAt) {
    return { skipped: true, reason: 'Lead evening nudge already sent', session };
  }

  const message = formatLeadEveningNudge(session.lead, dateKey, pendingPairs);
  const result = await sendToLead(session, message, 'bot_dm_prompt');

  session.nudgeSentAt = new Date();
  session.nudgeEventId = result.event_id;
  session.nudgeMessage = message;
  await session.save();

  emitMemberRoomUpdate({ dateKey, leadReport: session.toObject() });

  return { skipped: false, message, session, lead: session.lead };
};

/** 10:50 AM — ask yesterday's lead if they are ready to give the report. */
export const startLeadMorningReport = async (
  dateKey,
  { leadOverride = null, force = false } = {}
) => {
  const review = await DailyReview.findOne({ dateKey });
  if (!review?.pairsSentAt) {
    return { skipped: true, reason: 'No pairs were sent on that day' };
  }

  const session = await ensureSessionFromReview(review, { leadOverride });

  // Refresh pending/submitted in case reviews arrived overnight.
  session.pendingPairs = getPendingPairs(review.pairs, review);
  session.submittedPairs = getSubmittedPairs(review.pairs, review.reviewedMembers);
  session.pairs = review.pairs;

  if (session.stage === 'completed' && !force) {
    return { skipped: true, reason: 'Lead report already completed', session };
  }

  if (session.reportSentAt && session.stage !== 'idle' && !force) {
    return { skipped: true, reason: 'Lead morning report already started', session };
  }

  const message = formatLeadReportKickoff(session.lead, dateKey);
  const result = await sendToLead(session, message, 'bot_dm_prompt');

  session.reportSentAt = new Date();
  session.reportEventId = result.event_id;
  session.stage = 'awaiting_ready';
  session.currentPairIndex = 0;
  session.currentVerifyIndex = 0;
  session.currentPairOptions = [];
  session.pendingForgotOption = undefined;
  if (force) {
    session.pairDecisions = [];
    session.verifyDecisions = [];
    session.reviewsVerified = null;
  }
  await session.save();

  review.missingReviewPromptsSentAt = new Date();
  await review.save();

  emitMemberRoomUpdate({ dateKey, leadReport: session.toObject() });

  return { skipped: false, message, session, lead: session.lead };
};

const askAboutCurrentPair = async (session) => {
  const pending = session.pendingPairs || [];
  if (session.currentPairIndex >= pending.length) {
    session.stage = 'completed';
    session.currentPairOptions = [];
    const decisions = session.verifyDecisions || [];
    session.reviewsVerified = decisions.length
      ? decisions.every((d) => d.verified)
      : null;
    await session.save();
    await recomputeAttendanceFromLeadReport(session.dateKey);
    const done = formatLeadReportComplete(session);
    await sendToLead(session, done, 'bot_dm_ack');
    emitMemberRoomUpdate({ dateKey: session.dateKey, leadReport: session.toObject() });
    // Already sent above — do not return ack or roomMessageService will double-post.
    return { status: 'completed', ack: null };
  }

  const pair = pending[session.currentPairIndex];
  const review = await DailyReview.findOne({ dateKey: session.dateKey });
  const missing = missingMembersForPair(pair, review);
  const options = buildLeadPairOptions(pair, missing);
  session.stage = 'awaiting_pair_choice';
  session.currentPairOptions = options;
  session.markModified('currentPairOptions');
  await session.save();

  const question = formatPairChoiceQuestion(
    pair,
    options,
    session.currentPairIndex,
    pending.length
  );
  await sendToLead(session, question, 'bot_dm_prompt');
  emitMemberRoomUpdate({ dateKey: session.dateKey, leadReport: session.toObject() });
  return { status: 'awaiting_pair_choice', ack: null };
};

/** Show the next submitted pair for one-by-one verification. */
const askAboutCurrentSubmittedPair = async (session) => {
  const submitted = session.submittedPairs || [];
  if (session.currentVerifyIndex >= submitted.length) {
    session.currentPairIndex = 0;
    return askAboutCurrentPair(session);
  }

  const pair = submitted[session.currentVerifyIndex];
  session.stage = 'awaiting_verify';
  await session.save();

  const question = await formatSinglePairVerifyQuestion(
    session.dateKey,
    pair,
    session.currentVerifyIndex,
    submitted.length
  );
  await sendToLead(session, question, 'bot_dm_prompt');
  emitMemberRoomUpdate({ dateKey: session.dateKey, leadReport: session.toObject() });
  return { status: 'awaiting_verify', ack: null };
};

/** Handle a reply in the lead's personal room for an active report session. */
export const handleLeadReply = async (member, roomId, body, eventId) => {
  // Prefer the active session for this lead; don't require exact roomId match
  // (stale roomId on the doc must not fall through to legacy member prompts).
  let session = await LeadReportSession.findOne({
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

  if (!session && roomId) {
    session = await LeadReportSession.findOne({
      roomId,
      stage: {
        $in: [
          'awaiting_ready',
          'awaiting_verify',
          'awaiting_pair_choice',
          'awaiting_forgot_reason',
        ],
      },
    }).sort({ updatedAt: -1 });
  }

  if (!session) return { status: 'no_session' };

  if (roomId && session.roomId !== roomId) {
    session.roomId = roomId;
    await session.save();
  }

  if (session.stage === 'awaiting_ready') {
    const answer = parseYesNo(body);
    if (answer !== 'yes') {
      return {
        status: 'invalid',
        ack: 'Please reply YES when you are ready to give the team report.',
      };
    }

    session.currentVerifyIndex = 0;
    session.verifyDecisions = [];
    await session.save();

    if ((session.submittedPairs || []).length) {
      return askAboutCurrentSubmittedPair(session);
    }

    // No submitted reviews — go straight to missing pairs (or finish).
    return askAboutCurrentPair(session);
  }

  if (session.stage === 'awaiting_verify') {
    const answer = parseYesNo(body);
    if (!answer) {
      return {
        status: 'invalid',
        ack: 'Please reply YES or NO — did you verify this review?',
      };
    }

    const pair = (session.submittedPairs || [])[session.currentVerifyIndex];
    if (pair) {
      session.verifyDecisions.push({
        pair,
        verified: answer === 'yes',
        decidedAt: new Date(),
      });
    }
    session.currentVerifyIndex += 1;
    await session.save();
    return askAboutCurrentSubmittedPair(session);
  }

  if (session.stage === 'awaiting_pair_choice') {
    const parsed = parseLeadPairReply(body, session.currentPairOptions || []);
    if (parsed.error) {
      const optionLines = (session.currentPairOptions || [])
        .map((opt) => `${opt.letter} — ${opt.label}`)
        .join('\n');
      const hint =
        parsed.message ||
        'Please reply with letter(s) from the list (one reason per person).';
      return {
        status: 'invalid',
        ack: `${hint}\n\n${optionLines}`,
      };
    }

    const option = parsed.option;
    const pair = session.pendingPairs[session.currentPairIndex];

    if (option.type === 'forgot') {
      session.stage = 'awaiting_forgot_reason';
      session.pendingForgotOption = option;
      await session.save();
      const question = formatForgotReasonQuestion(pair);
      await sendToLead(session, question, 'bot_dm_prompt');
      emitMemberRoomUpdate({ dateKey: session.dateKey, leadReport: session.toObject() });
      return { status: 'awaiting_forgot_reason', ack: null };
    }

    session.pairDecisions.push({
      pair,
      letter: option.letter,
      label: option.label,
      type: option.type,
      absentMembers: option.absentMembers || [],
      halfDayMembers: option.halfDayMembers || [],
      decidedAt: new Date(),
    });
    session.currentPairIndex += 1;
    session.currentPairOptions = [];
    await session.save();
    await recomputeAttendanceFromLeadReport(session.dateKey);
    return askAboutCurrentPair(session);
  }

  if (session.stage === 'awaiting_forgot_reason') {
    const reason = (body || '').trim();
    if (reason.length < 2) {
      return {
        status: 'invalid',
        ack: 'Please send a short reason why the review was forgotten.',
      };
    }

    const pair = session.pendingPairs[session.currentPairIndex];
    const option = session.pendingForgotOption || {
      letter: '?',
      label: 'They forgot to send the review',
      type: 'forgot',
      absentMembers: [],
      halfDayMembers: [],
    };

    session.pairDecisions.push({
      pair,
      letter: option.letter,
      label: option.label,
      type: 'forgot',
      absentMembers: [],
      halfDayMembers: [],
      forgotReason: reason,
      decidedAt: new Date(),
    });
    session.currentPairIndex += 1;
    session.currentPairOptions = [];
    session.pendingForgotOption = undefined;
    session.stage = 'awaiting_pair_choice';
    await session.save();
    await recomputeAttendanceFromLeadReport(session.dateKey);
    return askAboutCurrentPair(session);
  }

  return { status: 'ignored' };
};

/** Feed the 11:20 room notice from lead decisions. */
export const getLeadReportSummary = async (dateKey) => {
  const session = await LeadReportSession.findOne({ dateKey });
  const responseByPair = new Map();

  if (!session) return { session: null, responseByPair };

  for (const decision of session.pairDecisions || []) {
    const key = buildPairKey(decision.pair || []);
    if (decision.type === 'forgot') {
      const reason = decision.forgotReason
        ? `they forgot to send review (${decision.forgotReason})`
        : 'they forgot to send review';
      responseByPair.set(key, reason);
      continue;
    }

    const parts = [];
    if (decision.absentMembers?.length) {
      parts.push(`${decision.absentMembers.join(', ')} absent`);
    }
    if (decision.halfDayMembers?.length) {
      parts.push(`${decision.halfDayMembers.join(', ')} half day leave`);
    }
    responseByPair.set(key, parts.join(', ') || decision.label);
  }

  return { session, responseByPair };
};

export const getActiveLeadSessionForMember = (member) =>
  LeadReportSession.findOne({
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
