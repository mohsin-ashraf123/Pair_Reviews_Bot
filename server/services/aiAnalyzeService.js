import DiscussionPrompt from '../models/DiscussionPrompt.js';
import LeadReportSession from '../models/LeadReportSession.js';
import RoomMessage from '../models/RoomMessage.js';
import DailyReview from '../models/DailyReview.js';
import BossDailyReport from '../models/BossDailyReport.js';
import { config } from '../config/appConfig.js';
import {
  formatDisplayDate,
  getKarachiDateKey,
  getPreviousWorkingDay,
  addCalendarDays,
  isWeekend,
  isNonWorkingDay,
} from './pairService.js';
import { getLeadReportDetail } from './leadReportViewService.js';
import { buildPairKey, getSubmittedPairs } from './reviewService.js';
import { chatCompletion, getAiSettingsPublic } from './aiService.js';

const pairLabel = (pair = []) =>
  Array.isArray(pair) ? pair.join(' + ') : String(pair || '—');

const clip = (text, max = 500) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
};

const personalRoomIds = () =>
  Object.values(config.memberRoomMap || {}).filter(Boolean);

/** Next Mon–Fri after dateKey. */
const getNextWorkingDay = (dateKey) => {
  let current = addCalendarDays(dateKey, 1);
  while (isNonWorkingDay(current)) {
    current = addCalendarDays(current, 1);
  }
  return current;
};

/** Submitted pair reviews (main room) for the review day. */
const loadSubmittedReviews = async (reviewDateKey) => {
  const review = await DailyReview.findOne({ dateKey: reviewDateKey }).lean();
  if (!review?.pairsSentAt) return [];

  const submitted = getSubmittedPairs(
    review.pairs || [],
    review.reviewedMembers || []
  );
  const personal = personalRoomIds();
  const items = [];
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
    if (!msg?.body) continue;

    items.push({
      pair,
      pairLabel: pairLabel(pair),
      senderName: msg.senderName || null,
      body: String(msg.body).trim(),
      sentAt: msg.sentAt,
    });
  }

  if (!items.length) {
    const query = {
      dateKey: reviewDateKey,
      countsAsReview: true,
      deletedAt: { $exists: false },
    };
    if (personal.length) query.roomId = { $nin: personal };
    const msgs = await RoomMessage.find(query).sort({ sentAt: 1 }).lean();
    for (const msg of msgs) {
      items.push({
        pair: msg.matchedPair || [],
        pairLabel: pairLabel(msg.matchedPair || []) || 'Pair',
        senderName: msg.senderName || null,
        body: String(msg.body || '').trim(),
        sentAt: msg.sentAt,
      });
    }
  }

  return items;
};

const buildSystemPrompt = () =>
  [
    'You write a clean, SHORT daily pair-review report for a manager (Sir).',
    'Output ONLY the report text — no markdown fences, no preamble, no commentary.',
    'Element supports **bold** via double asterisks — use **bold** for section titles, pair names, and the best-review mark.',
    '',
    'Use this exact structure (plain text, easy to paste into Element):',
    '',
    '📋 **Pair Review Report — {Review Date}**',
    '',
    '**Lead:** {name}',
    '',
    '**1) Attendance / Missing**',
    '- EXACTLY one short line',
    '- ONLY list people who are: absent, half-day leave, or forgot',
    '- Do NOT mention excused / present / reviewed members',
    '- Do NOT repeat pair labels unless needed for forgot',
    '- Example: "- **Adil** absent · **Saad** half-day"',
    '- if nobody absent/half-day/forgot: omit this whole section (skip heading too)',
    '',
    '**2) Reviews**',
    '- one short line per submitted pair that has REAL findings',
    '- format: "• **{Pair}:** {very short summary}"',
    '- If the review says no issues / no concerns / no recommendations / "No review": SKIP that pair entirely — do not list it',
    '- Otherwise: max 8–12 words — only the core suggestion/finding',
    '- Mark the best one inline on the same line among the listed reviews, e.g.:',
    '  "• **Farhan + Mohsin:** short summary  ⭐ **Best** — {3–6 word why}"',
    '- Do NOT make a separate "Best Review" section',
    '- If every review was no-issues: write "- No notable reviews"',
    '',
    '**3) Meeting Checks**',
    '- one short line per YES/NO, or "No meeting checks"',
    '',
    'Rules:',
    '- Keep the whole report short and scannable',
    '- Always include the review date in the title',
    '- Do not invent reviews',
    '- Never paste the full review body — only a tiny summary',
    '- No separate Best Review heading',
  ].join('\n');

const buildUserPrompt = ({
  meetingDateKey,
  reviewDateKey,
  leadBlock,
  meetingBlock,
  reviewsBlock,
}) =>
  [
    `Review day (use this date in the title): ${formatDisplayDate(reviewDateKey)} (${reviewDateKey})`,
    `Meeting / follow-up day: ${formatDisplayDate(meetingDateKey)} (${meetingDateKey})`,
    '',
    '=== SUBMITTED REVIEWS (summarize each; rank the best) ===',
    reviewsBlock,
    '',
    '=== LEAD REPORT + ATTENDANCE ===',
    leadBlock,
    '',
    '=== MEETING DISCUSSION CHECKS ===',
    meetingBlock,
    '',
    'Write the full Sir-ready report now using the required template.',
    'Attendance: only absent / half-day / forgot names — never excused.',
    'Reviews: skip all no-issues pairs. Best mark inline only. Keep ultra-short.',
  ].join('\n');

const formatLeadBlock = (detail) => {
  if (!detail?.lead && !(detail?.messages || []).length) {
    return 'No lead-report conversation found for this review day.';
  }

  const lines = [
    `Lead: ${detail.lead || '—'}`,
    `Stage: ${detail.session?.stageLabel || detail.session?.stage || 'n/a'}`,
  ];

  const att = detail.attendance || {};
  if (att.absent?.length) lines.push(`Absent (include): ${att.absent.join(', ')}`);
  if (att.halfDay?.length) lines.push(`Half-day (include): ${att.halfDay.join(', ')}`);
  if (att.forgot?.length) lines.push(`Forgot/late (include): ${att.forgot.join(', ')}`);
  if (att.excused?.length) {
    lines.push(
      `Excused (DO NOT mention in Attendance section): ${att.excused.join(', ')}`
    );
  }
  if (detail.pendingPairs?.length) {
    lines.push(
      `Still pending / missing pairs: ${detail.pendingPairs.map(pairLabel).join(' | ')}`
    );
  }

  const decisions = detail.session?.pairDecisions || [];
  if (decisions.length) {
    lines.push('', 'Lead decisions:');
    for (const d of decisions) {
      const reason = d.forgotReason
        ? `${d.label} — ${d.forgotReason}`
        : d.label;
      lines.push(`- ${pairLabel(d.pair)}: ${reason}`);
    }
  }

  lines.push('', 'Lead chat (context):');
  const msgs = detail.messages || [];
  if (!msgs.length) {
    lines.push('(no messages)');
  } else {
    for (const m of msgs.slice(-40)) {
      const who =
        m.direction === 'out' || m.senderName === 'Bot'
          ? 'Bot'
          : m.senderName || detail.lead || 'Lead';
      lines.push(`- ${who}: ${clip(m.body, 280)}`);
    }
  }

  return lines.join('\n');
};

const formatMeetingBlock = (prompts = []) => {
  if (!prompts.length) {
    return 'No meeting-discussion prompts for this day.';
  }

  return prompts
    .map((p) => {
      const status = p.status || 'pending';
      const answer =
        status === 'answered'
          ? String(p.response?.answer || '?').toUpperCase()
          : status.toUpperCase();
      const reply = p.response?.body
        ? ` (reply: ${clip(p.response.body, 80)})`
        : '';
      return `- ${p.member} · ${pairLabel(p.pair)} · ${answer}${reply}`;
    })
    .join('\n');
};

const formatReviewsBlock = (reviews = []) => {
  if (!reviews.length) {
    return 'No submitted pair-review messages found for this day.';
  }

  const noIssuesRe =
    /review\s+completed\.?\s*no\s+issues,\s*concerns,\s*or\s+improvement\s+recommendations\s+identified/i;

  return reviews
    .map((r, i) => {
      const who = r.senderName ? ` (by ${r.senderName})` : '';
      const skipNote = noIssuesRe.test(r.body)
        ? '\n[SKIP in report — no-issues / No review]'
        : '';
      return [
        `Review ${i + 1}: ${r.pairLabel}${who}${skipNote}`,
        clip(r.body, 1200),
      ].join('\n');
    })
    .join('\n\n———\n\n');
};

/**
 * Analyze a review day: load reviews + lead report + meeting checks,
 * then produce a Sir-ready template.
 * `dateKey` = review day (the date that appears in the report title).
 */
export const analyzeMeetingDay = async (dateKeyInput) => {
  const reviewDateKey = dateKeyInput || getPreviousWorkingDay(getKarachiDateKey());
  const meetingDateKey = getNextWorkingDay(reviewDateKey);

  const settings = await getAiSettingsPublic();
  if (!settings.configured) {
    const err = new Error('Configure OpenRouter API key in Settings first');
    err.status = 400;
    throw err;
  }
  if (!settings.modelId) {
    const err = new Error('Select an AI model in Settings first');
    err.status = 400;
    throw err;
  }

  const [leadDetail, discussions, reviews, bossDoc] = await Promise.all([
    getLeadReportDetail(reviewDateKey),
    DiscussionPrompt.find({
      $or: [{ reviewDateKey }, { meetingDateKey }],
    })
      .sort({ member: 1 })
      .lean(),
    loadSubmittedReviews(reviewDateKey),
    BossDailyReport.findOne({ reviewDateKey }).lean(),
  ]);

  const leadBlock = formatLeadBlock(leadDetail);
  const meetingBlock = formatMeetingBlock(discussions);
  const reviewsBlock = formatReviewsBlock(reviews);

  const completion = await chatCompletion({
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      {
        role: 'user',
        content: buildUserPrompt({
          meetingDateKey,
          reviewDateKey,
          leadBlock,
          meetingBlock,
          reviewsBlock,
        }),
      },
    ],
    temperature: 0.25,
  });

  const raw =
    completion?.choices?.[0]?.message?.content ||
    completion?.choices?.[0]?.text ||
    '';
  const brief = String(raw)
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  if (!brief) {
    const err = new Error('AI returned an empty response');
    err.status = 502;
    throw err;
  }

  return {
    meetingDateKey,
    meetingDateLabel: formatDisplayDate(meetingDateKey),
    reviewDateKey,
    reviewDateLabel: formatDisplayDate(reviewDateKey),
    modelId: settings.modelId,
    modelName: settings.modelName || settings.modelId,
    brief,
    /** Exact text already sent (or prepared) for Ayaaz Sir — for AI page display. */
    sirReport: bossDoc
      ? {
          status: bossDoc.eventId ? 'sent' : bossDoc.status,
          brief: bossDoc.brief || '',
          sentAt: bossDoc.sentAt || null,
          preparedAt: bossDoc.preparedAt || null,
          eventId: bossDoc.eventId || null,
          modelId: bossDoc.modelId || null,
          modelName: bossDoc.modelName || null,
        }
      : null,
    sources: {
      lead: leadDetail.lead || null,
      leadStage:
        leadDetail.session?.stageLabel || leadDetail.session?.stage || null,
      leadMessageCount: (leadDetail.messages || []).length,
      reviewCount: reviews.length,
      reviews: reviews.map((r) => ({
        pair: r.pair,
        pairLabel: r.pairLabel,
        senderName: r.senderName,
      })),
      discussions: discussions.map((p) => ({
        member: p.member,
        pair: p.pair,
        status: p.status,
        answer: p.response?.answer || null,
      })),
    },
  };
};

/** Load the Sir report for a review day without re-running AI. */
export const getSirReportForReviewDay = async (dateKeyInput) => {
  const reviewDateKey =
    dateKeyInput || getPreviousWorkingDay(getKarachiDateKey());
  const doc = await BossDailyReport.findOne({ reviewDateKey }).lean();
  if (!doc) {
    return {
      reviewDateKey,
      reviewDateLabel: formatDisplayDate(reviewDateKey),
      sirReport: null,
    };
  }

  // eventId means it already went to Sir — surface as sent even if DB was mislabeled.
  const status = doc.eventId ? 'sent' : doc.status;

  return {
    reviewDateKey,
    reviewDateLabel: formatDisplayDate(reviewDateKey),
    sirReport: {
      status,
      brief: doc.brief || '',
      sentAt: doc.sentAt || null,
      preparedAt: doc.preparedAt || null,
      eventId: doc.eventId || null,
      modelId: doc.modelId || null,
      modelName: doc.modelName || null,
    },
  };
};

/** Review days available for analysis. */
export const listAnalyzeDates = async (limit = 40) => {
  const todayKey = getKarachiDateKey();
  const defaultReviewKey = getPreviousWorkingDay(todayKey);

  const [leadKeys, discussionReviewKeys, dailyKeys, bossKeys] = await Promise.all([
    LeadReportSession.find({})
      .select('dateKey')
      .sort({ dateKey: -1 })
      .limit(limit)
      .lean()
      .then((rows) => rows.map((r) => r.dateKey)),
    DiscussionPrompt.find({})
      .select('reviewDateKey')
      .sort({ reviewDateKey: -1 })
      .limit(limit)
      .lean()
      .then((rows) => rows.map((r) => r.reviewDateKey).filter(Boolean)),
    DailyReview.find({ pairsSentAt: { $exists: true, $ne: null } })
      .select('dateKey')
      .sort({ dateKey: -1 })
      .limit(limit)
      .lean()
      .then((rows) => rows.map((r) => r.dateKey)),
    BossDailyReport.find({})
      .select('reviewDateKey')
      .sort({ reviewDateKey: -1 })
      .limit(limit)
      .lean()
      .then((rows) => rows.map((r) => r.reviewDateKey).filter(Boolean)),
  ]);

  const items = [
    ...new Set([
      defaultReviewKey,
      todayKey,
      ...leadKeys,
      ...discussionReviewKeys,
      ...dailyKeys,
      ...bossKeys,
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit)
    .map((dateKey) => ({
      dateKey,
      dateLabel: formatDisplayDate(dateKey),
      isToday: dateKey === todayKey,
      isDefault: dateKey === defaultReviewKey,
    }));

  return { todayKey, defaultReviewKey, items };
};
