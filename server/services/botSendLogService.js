import BotSendFailure from '../models/BotSendFailure.js';
import MissingReviewPrompt from '../models/MissingReviewPrompt.js';
import DiscussionPrompt from '../models/DiscussionPrompt.js';
import { getKarachiDateKey } from './pairService.js';

/** Persist a failed outbound Matrix send for History / debugging. */
export const recordBotSendFailure = async ({
  kind = 'message',
  roomId = null,
  member = null,
  body = '',
  error,
  dateKey = null,
  triggeredBy = null,
} = {}) => {
  const errorText =
    (typeof error === 'string' && error) ||
    error?.message ||
    'Unknown send error';

  try {
    return await BotSendFailure.create({
      dateKey: dateKey || getKarachiDateKey(),
      kind,
      roomId: roomId || null,
      member: member || null,
      body: typeof body === 'string' ? body.slice(0, 4000) : '',
      error: String(errorText).slice(0, 2000),
      triggeredBy: triggeredBy || null,
      failedAt: new Date(),
    });
  } catch (logError) {
    console.error('[bot-send] Failed to record send failure:', logError.message);
    return null;
  }
};

/**
 * Failed sends for History: new BotSendFailure docs + older prompt failures
 * that were recorded before this log existed (deduped).
 */
export const getBotSendFailures = async (limit = 50) => {
  const [logged, missed, discussions] = await Promise.all([
    BotSendFailure.find().sort({ failedAt: -1 }).limit(limit).lean(),
    MissingReviewPrompt.find({ status: 'failed' })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean(),
    DiscussionPrompt.find({ status: 'failed' })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean(),
  ]);

  const fromPrompts = [
    ...missed.map((p) => ({
      _id: `mrp-${p._id}`,
      dateKey: p.dateKey,
      kind: 'missing_review_dm',
      member: p.member,
      roomId: p.roomId,
      body: p.message || '',
      error: p.sendError || 'Send failed',
      triggeredBy: null,
      failedAt: p.updatedAt || p.sentAt || p.createdAt,
    })),
    ...discussions.map((p) => ({
      _id: `dp-${p._id}`,
      dateKey: p.reviewDateKey || p.meetingDateKey,
      kind: 'discussion_prompt',
      member: p.member,
      roomId: p.roomId,
      body: p.message || '',
      error: p.sendError || 'Send failed',
      triggeredBy: null,
      failedAt: p.updatedAt || p.sentAt || p.createdAt,
    })),
  ];

  const seen = new Set(
    logged.map(
      (f) =>
        `${f.dateKey || ''}|${f.member || ''}|${f.kind || ''}|${String(f.error || '').slice(0, 80)}`
    )
  );

  const extras = fromPrompts.filter((p) => {
    const key = `${p.dateKey || ''}|${p.member || ''}|${p.kind || ''}|${String(p.error || '').slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return [...logged, ...extras]
    .sort((a, b) => new Date(b.failedAt || 0) - new Date(a.failedAt || 0))
    .slice(0, limit);
};
