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
import {
  claimCronJob,
  completeCronJob,
  releaseCronJob,
} from './cronJobService.js';

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

/** Submitted reviews with real findings (skip no-issues). */
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
 * 10:00 AM weekdays — post yesterday's meaningful pair reviews as thread
 * replies under that day's "Pairs Today" message.
 */
export const postPairReviewThreadDigest = async (triggeredBy = 'cron') => {
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
    let doc = await PairReviewThread.findOne({ reviewDateKey });
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
    if (!items.length) {
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

    // Ensure Matrix client is warm before threaded sends.
    await getMatrixClient();

    const posted = [];
    for (const item of items) {
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

      posted.push({
        pair: item.pair,
        pairKey: item.pairKey,
        pairLabel: item.pairLabel,
        reviewEventId: item.reviewEventId,
        threadEventId: result.event_id,
        senderName: item.senderName,
        body: content.body,
        skipped: false,
      });

      await sleep(400);
    }

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
          replies: [...posted, ...skipped],
          postedCount: posted.length,
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

    console.log(
      `[thread] Posted ${posted.length} review(s) under Pairs Today for ${reviewDateKey}`
    );

    return {
      skipped: false,
      reviewDateKey,
      sendDateKey,
      rootEventId: root.eventId,
      postedCount: posted.length,
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
  const items = await PairReviewThread.find({})
    .sort({ reviewDateKey: -1 })
    .limit(Math.min(Number(limit) || 40, 100))
    .lean();

  return {
    todayKey: getKarachiDateKey(),
    defaultReviewKey: getPreviousWorkingDay(getKarachiDateKey()),
    items: items.map((doc) => ({
      id: doc._id?.toString(),
      reviewDateKey: doc.reviewDateKey,
      reviewDateLabel: formatDisplayDate(doc.reviewDateKey),
      sendDateKey: doc.sendDateKey || null,
      status: doc.status,
      skipReason: doc.skipReason || null,
      error: doc.error || null,
      rootEventId: doc.rootEventId || null,
      rootBody: doc.rootBody || null,
      postedCount: doc.postedCount || 0,
      skippedCount: doc.skippedCount || 0,
      sentAt: doc.sentAt || null,
      replies: (doc.replies || []).map((r) => ({
        pair: r.pair,
        pairLabel: r.pairLabel || pairLabel(r.pair),
        senderName: r.senderName || null,
        body: r.body || null,
        threadEventId: r.threadEventId || null,
        skipped: Boolean(r.skipped),
        skipReason: r.skipReason || null,
      })),
    })),
  };
};

export const getPairReviewThreadDetail = async (reviewDateKey) => {
  const list = await listPairReviewThreads(120);
  const item =
    list.items.find((row) => row.reviewDateKey === reviewDateKey) || null;
  return {
    todayKey: list.todayKey,
    defaultReviewKey: list.defaultReviewKey,
    item,
  };
};
