import PairReviewThread from '../models/PairReviewThread.js';
import DailyPairRecord from '../models/DailyPairRecord.js';
import RoomMessage from '../models/RoomMessage.js';
import DailyReview from '../models/DailyReview.js';
import { config } from '../config/appConfig.js';
import {
  formatDisplayDate,
  getKarachiDateKey,
  getPreviousWorkingDay,
  isNonWorkingDay,
  isWeekend,
} from './pairService.js';
import { buildPairKey, getSubmittedPairs } from './reviewService.js';
import { isNoIssuesReview } from './discussionPromptService.js';
import {
  getMatrixClient,
  sendMatrixThreadReply,
} from './matrixService.js';
import { logOutgoingMessage } from './roomMessageService.js';
import {
  claimCronJob,
  completeCronJob,
  releaseCronJob,
} from './cronJobService.js';
import { emitThreadUpdate } from './socketService.js';

const pairLabel = (pair = []) =>
  Array.isArray(pair) ? pair.join(' + ') : String(pair || '—');

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const personalRoomIds = () =>
  Object.values(config.memberRoomMap || {}).filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toThreadPayload = (doc) => {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: plain._id?.toString(),
    reviewDateKey: plain.reviewDateKey,
    reviewDateLabel: formatDisplayDate(plain.reviewDateKey),
    sendDateKey: plain.sendDateKey || null,
    status: plain.status,
    skipReason: plain.skipReason || null,
    error: plain.error || null,
    rootEventId: plain.rootEventId || null,
    rootBody: plain.rootBody || null,
    postedCount: plain.postedCount || 0,
    skippedCount: plain.skippedCount || 0,
    readyCount: (plain.replies || []).filter((r) => !r.skipped).length,
    sentAt: plain.sentAt || null,
    updatedAt: plain.updatedAt || null,
    replies: (plain.replies || []).map((r) => ({
      pair: r.pair,
      pairKey: r.pairKey || null,
      pairLabel: r.pairLabel || pairLabel(r.pair),
      senderName: r.senderName || null,
      body: r.body || null,
      reviewEventId: r.reviewEventId || null,
      threadEventId: r.threadEventId || null,
      skipped: Boolean(r.skipped),
      skipReason: r.skipReason || null,
    })),
  };
};

/** Build Element-friendly thread reply (markdown + HTML bold pair name). */
export const formatThreadReviewReply = ({ pair, body, senderName }) => {
  const label = pairLabel(pair);
  const review = String(body || '').trim();
  const plainParts = [`**${label}**`, '', review];
  if (senderName) {
    plainParts.push('', `— ${senderName}`);
  }

  const htmlParts = [
    `<strong>${escapeHtml(label)}</strong>`,
    '<br/><br/>',
    escapeHtml(review).replace(/\n/g, '<br/>'),
  ];
  if (senderName) {
    htmlParts.push(`<br/><br/>— ${escapeHtml(senderName)}`);
  }

  return {
    body: plainParts.join('\n'),
    formatted_body: htmlParts.join(''),
  };
};

const findPairsRootEvent = async (reviewDateKey) => {
  const record = await DailyPairRecord.findOne({ dateKey: reviewDateKey }).lean();
  if (record?.matrixEventId) {
    return {
      eventId: record.matrixEventId,
      body: record.message || '',
      roomId: config.matrix.roomId,
      lead: record.lead || null,
    };
  }

  const msg = await RoomMessage.findOne({
    dateKey: reviewDateKey,
    category: 'bot_pairs',
  })
    .sort({ sentAt: -1 })
    .lean();

  if (msg?.eventId) {
    return {
      eventId: msg.eventId,
      body: msg.body || '',
      roomId: msg.roomId || config.matrix.roomId,
      lead: null,
    };
  }

  return null;
};

/** Real pair reviews only (matched pairs in main room). Skip no-issues. */
export const loadThreadableReviews = async (reviewDateKey) => {
  const review = await DailyReview.findOne({ dateKey: reviewDateKey }).lean();
  if (!review?.pairsSentAt) return { review, items: [], skipped: [] };

  const submitted = getSubmittedPairs(
    review.pairs || [],
    review.reviewedMembers || []
  );
  const personal = personalRoomIds();
  const items = [];
  const skipped = [];
  const pairsToLoad = submitted.length ? submitted : review.pairs || [];

  for (const pair of pairsToLoad) {
    const pairKey = buildPairKey(pair);
    const query = {
      dateKey: reviewDateKey,
      pairKey,
      countsAsReview: true,
      deletedAt: { $exists: false },
    };
    if (personal.length) query.roomId = { $nin: personal };
    else if (config.matrix.roomId) query.roomId = config.matrix.roomId;

    const msg = await RoomMessage.findOne(query).sort({ sentAt: -1 }).lean();
    if (!msg?.body?.trim()) {
      skipped.push({
        pair,
        pairKey,
        pairLabel: pairLabel(pair),
        skipped: true,
        skipReason: 'No review message found',
      });
      continue;
    }

    if (isNoIssuesReview(msg.body)) {
      skipped.push({
        pair,
        pairKey,
        pairLabel: pairLabel(pair),
        reviewEventId: msg.eventId,
        senderName: msg.senderName || null,
        skipped: true,
        skipReason: 'No issues / no findings',
      });
      continue;
    }

    items.push({
      pair,
      pairKey,
      pairLabel: pairLabel(pair),
      reviewEventId: msg.eventId,
      senderName: msg.senderName || null,
      body: String(msg.body).trim(),
      sentAt: msg.sentAt,
    });
  }

  return { review, items, skipped };
};

/**
 * When "Pairs Today" goes out — open a live draft so the Threads page can
 * collect reviews all day (posted to Element next morning at 10:00).
 */
export const seedPairReviewThreadDraft = async ({
  dateKey,
  rootEventId,
  rootBody,
  roomId,
}) => {
  if (!config.enablePairThread) return null;
  if (!dateKey || !rootEventId) return null;

  const existing = await PairReviewThread.findOne({ reviewDateKey: dateKey });
  if (existing?.status === 'sent') return existing;

  const doc = await PairReviewThread.findOneAndUpdate(
    { reviewDateKey: dateKey },
    {
      $set: {
        rootEventId,
        rootBody: rootBody || '',
        roomId: roomId || config.matrix.roomId,
        status: 'drafting',
        skipReason: null,
        error: null,
      },
      $setOnInsert: {
        reviewDateKey: dateKey,
        replies: [],
        postedCount: 0,
        skippedCount: 0,
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  emitThreadUpdate(toThreadPayload(doc));
  console.log(`[thread] Draft opened for ${dateKey} under ${rootEventId}`);

  // Pull in any reviews already recorded for this day.
  return syncPairReviewThreadDraft(dateKey);
};

/**
 * Rebuild draft replies from real pair-review messages only.
 * Random chat never appears here (only countsAsReview + matched pairKey).
 */
export const syncPairReviewThreadDraft = async (dateKey) => {
  if (!config.enablePairThread) return null;
  if (!dateKey) return null;

  const existing = await PairReviewThread.findOne({ reviewDateKey: dateKey });
  if (existing?.status === 'sent') return existing;

  const root = await findPairsRootEvent(dateKey);
  if (!root?.eventId && !existing) return null;

  const { items, skipped } = await loadThreadableReviews(dateKey);
  const prevByKey = new Map(
    (existing?.replies || [])
      .filter((r) => r.pairKey)
      .map((r) => [r.pairKey, r])
  );

  const replies = [
    ...items.map((item) => {
      const formatted = formatThreadReviewReply(item);
      const prev = prevByKey.get(item.pairKey);
      return {
        pair: item.pair,
        pairKey: item.pairKey,
        pairLabel: item.pairLabel,
        reviewEventId: item.reviewEventId,
        threadEventId: prev?.threadEventId || null,
        senderName: item.senderName,
        body: formatted.body,
        skipped: false,
        skipReason: null,
      };
    }),
    ...skipped,
  ];

  const readyCount = replies.filter((r) => !r.skipped).length;
  const status = readyCount > 0 ? 'ready' : 'drafting';

  const doc = await PairReviewThread.findOneAndUpdate(
    { reviewDateKey: dateKey },
    {
      $set: {
        rootEventId: root?.eventId || existing?.rootEventId || null,
        rootBody: root?.body || existing?.rootBody || '',
        roomId: root?.roomId || existing?.roomId || config.matrix.roomId,
        status,
        replies,
        skippedCount: skipped.length,
        postedCount: replies.filter((r) => r.threadEventId).length,
        skipReason: null,
        error: null,
      },
      $setOnInsert: { reviewDateKey: dateKey },
    },
    { upsert: Boolean(root?.eventId), returnDocument: 'after', setDefaultsOnInsert: true }
  );

  if (doc) emitThreadUpdate(toThreadPayload(doc));
  return doc;
};

/**
 * 10:00 AM — post the prepared draft (yesterday's reviews) as Element thread
 * replies under that day's Pairs Today message. Also save to History.
 */
export const postPairReviewThreadDigest = async (triggeredBy = 'cron') => {
  if (!config.enablePairThread) {
    return {
      skipped: true,
      reason: 'Pair review thread disabled (ENABLE_PAIR_THREAD≠true)',
    };
  }

  const sendDateKey = getKarachiDateKey();

  if (isNonWorkingDay(sendDateKey) && triggeredBy === 'cron') {
    return {
      skipped: true,
      reason: isWeekend(sendDateKey)
        ? 'Weekend — no review thread'
        : 'Holiday — no review thread',
    };
  }

  const reviewDateKey = getPreviousWorkingDay(sendDateKey);
  const jobKey = `pair_review_thread:${sendDateKey}:for:${reviewDateKey}`;

  if (triggeredBy === 'cron') {
    const claimed = await claimCronJob(jobKey, {
      jobType: 'pair_review_thread',
      dateKey: sendDateKey,
    });
    if (!claimed) {
      return { skipped: true, reason: 'Review thread already posted today' };
    }
  }

  try {
    let doc = await syncPairReviewThreadDraft(reviewDateKey);
    doc = doc || (await PairReviewThread.findOne({ reviewDateKey }));

    if (doc?.status === 'sent' && doc.postedCount > 0 && triggeredBy === 'cron') {
      await completeCronJob(jobKey, doc.rootEventId);
      return { skipped: true, reason: 'Thread already sent for this review day', doc };
    }

    const root = await findPairsRootEvent(reviewDateKey);
    if (!root?.eventId) {
      const skippedDoc = await PairReviewThread.findOneAndUpdate(
        { reviewDateKey },
        {
          $set: {
            sendDateKey,
            status: 'skipped',
            skipReason: 'No Pairs Today message found for that day',
            roomId: config.matrix.roomId,
          },
          $setOnInsert: { reviewDateKey, replies: [] },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      );
      if (triggeredBy === 'cron') await completeCronJob(jobKey, null);
      return {
        skipped: true,
        reason: 'No Pairs Today message found for that day',
        doc: skippedDoc,
      };
    }

    const { items, skipped } = await loadThreadableReviews(reviewDateKey);
    const alreadyPosted = new Map(
      (doc?.replies || [])
        .filter((r) => r.pairKey && r.threadEventId)
        .map((r) => [r.pairKey, r])
    );

    const toPost = items.filter((item) => !alreadyPosted.has(item.pairKey));

    if (!toPost.length && alreadyPosted.size === 0) {
      const skippedDoc = await PairReviewThread.findOneAndUpdate(
        { reviewDateKey },
        {
          $set: {
            sendDateKey,
            roomId: root.roomId,
            rootEventId: root.eventId,
            rootBody: root.body,
            status: 'skipped',
            skipReason: 'No reviews with findings to thread',
            replies: skipped,
            postedCount: 0,
            skippedCount: skipped.length,
          },
          $setOnInsert: { reviewDateKey },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      );
      if (triggeredBy === 'cron') await completeCronJob(jobKey, null);
      return {
        skipped: true,
        reason: 'No reviews with findings to thread',
        doc: skippedDoc,
      };
    }

    if (toPost.length) {
      await getMatrixClient();
    }

    for (const item of toPost) {
      const content = formatThreadReviewReply(item);
      const result = await sendMatrixThreadReply(
        root.roomId,
        root.eventId,
        content.body,
        {
          formattedBody: content.formatted_body,
          kind: 'pair_review_thread',
          dateKey: reviewDateKey,
          member: item.pairLabel,
          triggeredBy,
        }
      );

      await logOutgoingMessage(content.body, result.event_id, 'bot_thread', {
        dateKey: reviewDateKey,
        roomId: root.roomId,
      }).catch((error) =>
        console.warn(`[thread] History log failed: ${error.message}`)
      );

      alreadyPosted.set(item.pairKey, {
        pair: item.pair,
        pairKey: item.pairKey,
        pairLabel: item.pairLabel,
        reviewEventId: item.reviewEventId,
        threadEventId: result.event_id,
        senderName: item.senderName,
        body: content.body,
        skipped: false,
        skipReason: null,
      });

      await sleep(400);
    }

    const finalReplies = [
      ...[...alreadyPosted.values()],
      ...skipped.filter((s) => !alreadyPosted.has(s.pairKey)),
    ];

    doc = await PairReviewThread.findOneAndUpdate(
      { reviewDateKey },
      {
        $set: {
          sendDateKey,
          roomId: root.roomId,
          rootEventId: root.eventId,
          rootBody: root.body,
          status: 'sent',
          skipReason: null,
          error: null,
          replies: finalReplies,
          postedCount: alreadyPosted.size,
          skippedCount: skipped.length,
          sentAt: new Date(),
        },
        $setOnInsert: { reviewDateKey },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    if (triggeredBy === 'cron') {
      await completeCronJob(jobKey, root.eventId);
    }

    emitThreadUpdate(toThreadPayload(doc));
    console.log(
      `[thread] Posted ${alreadyPosted.size} review(s) under Pairs Today for ${reviewDateKey}`
    );

    return {
      skipped: false,
      reviewDateKey,
      sendDateKey,
      rootEventId: root.eventId,
      postedCount: alreadyPosted.size,
      skippedCount: skipped.length,
      doc,
    };
  } catch (error) {
    if (triggeredBy === 'cron') {
      await releaseCronJob(jobKey);
    }
    await PairReviewThread.findOneAndUpdate(
      { reviewDateKey },
      {
        $set: {
          sendDateKey,
          status: 'failed',
          error: error.message,
          roomId: config.matrix.roomId,
        },
        $setOnInsert: { reviewDateKey },
      },
      { upsert: true }
    );
    throw error;
  }
};

export const listPairReviewThreads = async (limit = 40) => {
  const todayKey = getKarachiDateKey();
  // Keep today's draft fresh when the page loads.
  await syncPairReviewThreadDraft(todayKey).catch(() => null);

  const items = await PairReviewThread.find({})
    .sort({ reviewDateKey: -1 })
    .limit(Math.min(Number(limit) || 40, 100))
    .lean();

  return {
    todayKey,
    defaultReviewKey: todayKey,
    items: items.map((doc) => toThreadPayload(doc)),
  };
};

export const getPairReviewThreadDetail = async (reviewDateKey) => {
  if (reviewDateKey) {
    await syncPairReviewThreadDraft(reviewDateKey).catch(() => null);
  }
  const list = await listPairReviewThreads(120);
  const item =
    list.items.find((row) => row.reviewDateKey === reviewDateKey) || null;
  return {
    todayKey: list.todayKey,
    defaultReviewKey: list.defaultReviewKey,
    item,
  };
};
