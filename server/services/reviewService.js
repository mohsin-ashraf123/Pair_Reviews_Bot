import DailyReview from '../models/DailyReview.js';
import DailyPairRecord from '../models/DailyPairRecord.js';
import RoomMessage from '../models/RoomMessage.js';
import { getAllMembers } from '../config/appConfig.js';
import { getKarachiDateKey, formatDisplayDate } from './pairService.js';
import { isTeamMember } from './memberService.js';
import { emitReviewUpdate } from './socketService.js';

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Take the name line from messages like "Uzair + Faz Pair Review Done". */
export const extractReviewNameLine = (body) => {
  const firstLine = body.trim().split('\n')[0].trim();
  const suffixMatch = firstLine.match(
    /^(.+?)(?:\s+pair\s+review|\s+review\s+done|\s+review\b)/i
  );
  return (suffixMatch ? suffixMatch[1] : firstLine).trim();
};

/** Parse team member names mentioned in the review message line. */
export const parseMentionedMembers = (body) => {
  const line = extractReviewNameLine(body);
  if (!line) return [];

  const members = getAllMembers();
  const sorted = [...members].sort((a, b) => b.length - a.length);
  const found = [];

  for (const name of sorted) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
    if (pattern.test(line)) {
      found.push(name);
    }
  }

  return found;
};

/** Return today's pair that exactly matches the mentioned names, or null. */
export const findMatchingPair = (mentionedNames, pairs) => {
  if (!mentionedNames.length || !pairs?.length) return null;

  const mentionedSet = new Set(mentionedNames);
  if (mentionedSet.size !== mentionedNames.length) return null;

  for (const pair of pairs) {
    if (pair.length !== mentionedNames.length) continue;
    if (pair.every((member) => mentionedSet.has(member))) {
      return pair;
    }
  }

  return null;
};

/** True when the message looks like a pair review submission. */
export const looksLikePairReview = (body) => {
  const trimmed = body.trim();
  if (/pair\s+review|review\s+done|\breview\b/i.test(trimmed)) return true;

  const line = extractReviewNameLine(body);
  return /\+/.test(line) && parseMentionedMembers(body).length >= 2;
};

/** True when names look like a review but do not match any assigned pair today. */
export const isWrongPairReview = (body, pairs) => {
  if (!looksLikePairReview(body)) return false;

  const mentioned = parseMentionedMembers(body);
  if (mentioned.length < 2) return false;

  return !findMatchingPair(mentioned, pairs);
};

export const formatWrongPairAlert = (mentionedNames, pairs, senderName) => {
  const submitted = mentionedNames.join(' + ');
  const todayLines = pairs.map((pair) => pair.join(' + '));

  return [
    '⚠️ Wrong Pair Review',
    '',
    `Sent by: ${senderName || 'Unknown'}`,
    `${submitted} is not an assigned pair for today.`,
    '',
    "Today's pairs:",
    '',
    ...todayLines,
  ].join('\n');
};

export const formatDuplicatePairAlert = (matchedPair, senderName) => {
  const label = matchedPair.join(' + ');
  return [
    '⚠️ Duplicate Pair Review',
    '',
    `Sent by: ${senderName || 'Unknown'}`,
    `${label} — you already submitted a review for this pair today.`,
    'Please delete the duplicate message in Element and keep only one review.',
  ].join('\n');
};

export const buildPairKey = (pair) => [...pair].sort().join('|');

export const recomputeReviewedMembers = async (dateKey) => {
  const review = await DailyReview.findOne({ dateKey });
  if (!review?.pairsSentAt) return null;

  const activeReviews = await RoomMessage.find({
    dateKey,
    countsAsReview: true,
    deletedAt: { $exists: false },
  });

  const reviewed = new Set();
  for (const msg of activeReviews) {
    for (const member of msg.matchedPair || []) {
      reviewed.add(member);
    }
  }

  review.reviewedMembers = [...reviewed];
  await review.save();

  const state = buildReviewState(review);
  emitReviewUpdate(state);
  return state;
};

export const getPendingPairs = (pairs, reviewedMembers = []) => {
  const reviewed = new Set(reviewedMembers);
  return pairs.filter((pair) => pair.some((member) => !reviewed.has(member)));
};

export const formatReminderMessage = (lead, pendingPairs) => {
  const lines = pendingPairs.map((pair) => pair.join(' + '));
  return [
    '🔔 Review Reminder',
    '',
    'Pending Reviews',
    '',
    ...lines,
    '',
    `${lead} – Please make sure all reviews are completed and collected today.`,
  ].join('\n');
};

/**
 * `responseByPair` maps a sorted pair key to the follow-up answer collected
 * from the members' personal rooms, e.g. "Farhan absent".
 */
export const formatMissedReviewMessage = (
  dateKey,
  pendingPairs,
  responseByPair = new Map()
) => {
  const displayDate = formatDisplayDate(dateKey);
  const lines = pendingPairs.map((pair) => {
    const label = pair.join(' + ');
    const reason = responseByPair.get(buildPairKey(pair)) || 'no response yet';
    return `${label} (${reason})`;
  });

  return [
    `Yesterday (${displayDate}) the following pairs did not submit their review:`,
    '',
    ...lines,
  ].join('\n');
};

export const ensureDailyReview = async ({ dateKey, lead, pairs, pairsSentAt }) => {
  let review = await DailyReview.findOne({ dateKey });
  if (!review) {
    review = await DailyReview.create({
      dateKey,
      lead,
      pairs,
      pairsSentAt: pairsSentAt || new Date(),
      reviewedMembers: [],
    });
    return review;
  }

  review.lead = lead;
  review.pairs = pairs;
  review.pairsSentAt = pairsSentAt || review.pairsSentAt || new Date();
  await review.save();
  return review;
};

export const recordMemberReview = async (memberName, dateKey = getKarachiDateKey()) => {
  if (!memberName || !isTeamMember(memberName)) return null;

  const review = await DailyReview.findOne({ dateKey });
  if (!review?.pairsSentAt) return null;

  if (review.reviewedMembers.includes(memberName)) {
    return buildReviewState(review);
  }

  review.reviewedMembers.push(memberName);
  await review.save();

  const state = buildReviewState(review);
  emitReviewUpdate(state);
  return state;
};

/** Mark review for all members named in the message if they match a today's pair. */
export const recordReviewFromMessage = async (
  body,
  dateKey = getKarachiDateKey(),
  eventId = null
) => {
  const review = await DailyReview.findOne({ dateKey });
  if (!review?.pairsSentAt) return { status: 'inactive' };

  const mentioned = parseMentionedMembers(body);
  const matchedPair = findMatchingPair(mentioned, review.pairs);

  if (!matchedPair) {
    if (isWrongPairReview(body, review.pairs)) {
      console.log(
        `[review] Wrong pair review: ${mentioned.join(' + ')} (${dateKey})`
      );
      if (eventId) {
        await RoomMessage.updateOne(
          { eventId },
          { reviewIssue: 'wrong_pair', attemptedPair: mentioned }
        );
      }
      return {
        status: 'wrong_pair',
        mentionedNames: mentioned,
        pairs: review.pairs,
      };
    }
    return { status: 'ignored' };
  }

  const pairKey = buildPairKey(matchedPair);

  if (eventId) {
    const duplicate = await RoomMessage.findOne({
      dateKey,
      pairKey,
      countsAsReview: true,
      deletedAt: { $exists: false },
      eventId: { $ne: eventId },
    });

    if (duplicate) {
      console.log(`[review] Duplicate pair review: ${matchedPair.join(' + ')} (${dateKey})`);
      await RoomMessage.updateOne(
        { eventId },
        { reviewIssue: 'duplicate_pair', attemptedPair: matchedPair }
      );
      return { status: 'duplicate_pair', matchedPair, pairKey };
    }

    await RoomMessage.updateOne(
      { eventId },
      { countsAsReview: true, matchedPair, pairKey }
    );
  }

  await recomputeReviewedMembers(dateKey);
  console.log(`[review] Marked pair complete: ${matchedPair.join(' + ')} (${dateKey})`);

  return { status: 'success', matchedPair, pairKey };
};

/** Undo review attendance when a review message is deleted in Element. */
export const handleReviewMessageDeleted = async (eventId) => {
  const msg = await RoomMessage.findOne({ eventId });
  if (!msg) return null;

  const { dateKey, countsAsReview } = msg;

  await RoomMessage.deleteOne({ eventId });

  if (!countsAsReview) {
    return { deleted: true, eventId, reviewUpdated: false };
  }

  console.log(`[review] Review message deleted: ${eventId} (${dateKey})`);
  const state = await recomputeReviewedMembers(dateKey);

  return { deleted: true, eventId, reviewUpdated: true, state };
};

export const buildReviewState = (review) => {
  if (!review) {
    return {
      dateKey: getKarachiDateKey(),
      active: false,
      reviewedMembers: [],
      pendingPairs: [],
      allPairs: [],
      lead: '',
    };
  }

  const pendingPairs = getPendingPairs(review.pairs, review.reviewedMembers);

  return {
    dateKey: review.dateKey,
    active: Boolean(review.pairsSentAt),
    lead: review.lead,
    allPairs: review.pairs,
    reviewedMembers: review.reviewedMembers,
    pendingPairs,
    pairsSentAt: review.pairsSentAt,
    reminderSentAt: review.reminderSentAt,
  };
};

export const getTodayReviewState = async () => {
  const dateKey = getKarachiDateKey();
  let review = await DailyReview.findOne({ dateKey });

  if (!review) {
    const log = await DailyPairRecord.findOne({ dateKey });
    if (log) {
      review = await ensureDailyReview({
        dateKey,
        lead: log.lead,
        pairs: log.allPairs,
        pairsSentAt: log.sentAt,
      });
    }
  }

  return buildReviewState(review);
};
