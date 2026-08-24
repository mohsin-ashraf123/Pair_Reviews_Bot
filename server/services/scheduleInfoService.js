import DailyReview from '../models/DailyReview.js';
import { config } from '../config/appConfig.js';
import {
  formatDailyMessage,
  buildDailyPairs,
  formatDisplayDate,
  getPreviousWorkingDay,
  getKarachiDateKey,
  cronTimeLabel,
} from './pairService.js';
import {
  formatReminderMessage,
  formatMissedReviewMessage,
  getPendingPairs,
  getSubmittedPairs,
  buildPairKey,
} from './reviewService.js';
import {
  formatLeadEveningNudge,
  formatLeadReportKickoff,
  formatPairChoiceQuestion,
  formatSinglePairVerifyQuestion,
  formatMominCheckQuestion,
  buildLeadPairOptions,
  getLeadReportSummary,
} from './leadReportService.js';
import {
  previewDiscussionPrompts,
  getUndiscussedPairsForMeeting,
} from './discussionPromptService.js';

const pairLabel = (pair = []) => pair.join(' + ');

let scheduleInfoCache = { at: 0, value: null, inflight: null };
const SCHEDULE_INFO_TTL_MS = 20_000;

/**
 * Live previews for every scheduled bot action — real recipients + real message
 * bodies in send order (not placeholder examples).
 */
export const getScheduledMessagesInfo = async ({ force = false } = {}) => {
  if (
    !force &&
    scheduleInfoCache.value &&
    Date.now() - scheduleInfoCache.at < SCHEDULE_INFO_TTL_MS
  ) {
    return scheduleInfoCache.value;
  }

  if (!force && scheduleInfoCache.inflight) {
    return scheduleInfoCache.inflight;
  }

  const build = buildScheduledMessagesInfo();
  scheduleInfoCache.inflight = build;
  try {
    const value = await build;
    scheduleInfoCache = { at: Date.now(), value, inflight: null };
    return value;
  } catch (error) {
    scheduleInfoCache.inflight = null;
    throw error;
  }
};

const buildScheduledMessagesInfo = async () => {
  const todayKey = getKarachiDateKey();
  const yesterdayKey = getPreviousWorkingDay(todayKey);
  const pairsData = buildDailyPairs();
  const dailyPairsMessage = formatDailyMessage(pairsData);

  const [todayReview, yesterdayReview, leadSummary, undiscussedPairs, discussionPreview] =
    await Promise.all([
      DailyReview.findOne({ dateKey: todayKey }).lean(),
      DailyReview.findOne({ dateKey: yesterdayKey }).lean(),
      getLeadReportSummary(yesterdayKey),
      getUndiscussedPairsForMeeting(yesterdayKey),
      previewDiscussionPrompts(todayKey),
    ]);

  const { responseByPair } = leadSummary;

  // --- 10:50 Lead team report (yesterday’s lead only) ---
  const leadFollowUps = {
    id: 'missing_review_prompts',
    time: cronTimeLabel(config.missingReviewPromptCronSchedule, 10, 50),
    days: 'Mon–Fri',
    cron: config.missingReviewPromptCronSchedule,
    title: 'Lead team report',
    destination: 'Yesterday’s lead — personal room only',
    destinationKind: 'personal',
    description:
      'Private conversation with yesterday’s lead: ready check → verify each submitted review → reason for each missing pair.',
    exampleForDate: formatDisplayDate(yesterdayKey),
    recipients: [],
    messages: [],
    exampleNote: null,
    example: '',
  };

  if (yesterdayReview?.pairsSentAt) {
    const lead = yesterdayReview.lead;
    const pending = getPendingPairs(yesterdayReview.pairs, yesterdayReview);
    const submitted = getSubmittedPairs(
      yesterdayReview.pairs,
      yesterdayReview.reviewedMembers
    );

    leadFollowUps.recipients = [
      {
        name: lead,
        role: 'Yesterday’s lead',
        via: 'Personal room',
      },
    ];

    leadFollowUps.messages.push({
      label: '1 · Kickoff (first message)',
      to: lead,
      body: formatLeadReportKickoff(lead, yesterdayKey),
    });

    const verifyBodies = await Promise.all(
      submitted.map((pair, i) =>
        formatSinglePairVerifyQuestion(yesterdayKey, pair, i, submitted.length)
      )
    );
    verifyBodies.forEach((body, i) => {
      leadFollowUps.messages.push({
        label: `2 · Verify submitted ${i + 1}/${submitted.length}`,
        to: lead,
        body,
      });
      leadFollowUps.messages.push({
        label: `2b · Momin check ${i + 1}/${submitted.length}`,
        to: lead,
        body: formatMominCheckQuestion(submitted[i], i, submitted.length),
      });
    });

    for (let i = 0; i < pending.length; i += 1) {
      const pair = pending[i];
      const accounted = new Set([
        ...(yesterdayReview.reviewedMembers || []),
        ...(yesterdayReview.absentMembers || []),
        ...(yesterdayReview.halfDayMembers || []),
        ...(yesterdayReview.excusedMembers || []),
        ...(yesterdayReview.lateReviewedMembers || []),
      ]);
      const missing = pair.filter((name) => !accounted.has(name));
      leadFollowUps.messages.push({
        label: `3 · Missing pair ${i + 1}/${pending.length}`,
        to: lead,
        body: formatPairChoiceQuestion(
          pair,
          buildLeadPairOptions(pair, missing),
          i,
          pending.length
        ),
      });
    }

    leadFollowUps.exampleNote =
      pending.length || submitted.length
        ? `Live for ${formatDisplayDate(yesterdayKey)} — lead ${lead}: ${submitted.length} to verify, ${pending.length} missing.`
        : `Live for ${formatDisplayDate(yesterdayKey)} — all reviews were in; morning lead report is usually skipped.`;

    if (!pending.length && !submitted.length) {
      leadFollowUps.messages = [
        {
          label: 'Status',
          to: '—',
          body: `No lead report needed for ${formatDisplayDate(yesterdayKey)} — nothing to verify or collect.`,
        },
      ];
    }
  } else {
    leadFollowUps.exampleNote = `No pair send recorded for ${formatDisplayDate(yesterdayKey)} — this job would skip.`;
    leadFollowUps.messages = [
      {
        label: 'Status',
        to: '—',
        body: `Skipped — pairs were not sent on ${formatDisplayDate(yesterdayKey)}.`,
      },
    ];
  }

  leadFollowUps.example = leadFollowUps.messages.map((m) => m.body).join('\n\n———\n\n');

  // --- 11:20 Missed / not-discussed notice (main room) ---
  const missedNotice = {
    id: 'missed_review',
    time: cronTimeLabel(config.missedReviewCronSchedule, 11, 20),
    days: 'Mon–Fri',
    cron: config.missedReviewCronSchedule,
    title: 'Missed review notice',
    destination: 'Main Pair Reviews room',
    destinationKind: 'main',
    description:
      'Posts yesterday’s missing pairs (with lead reasons) and any reviews marked not discussed in the meeting.',
    exampleForDate: formatDisplayDate(yesterdayKey),
    recipients: [{ name: 'Main Pair Reviews', role: 'Room', via: 'Main room' }],
    messages: [],
    exampleNote: null,
    example: '',
  };

  if (yesterdayReview?.pairsSentAt) {
    const actualPending = getPendingPairs(
      yesterdayReview.pairs,
      yesterdayReview
    );

    if (actualPending.length || undiscussedPairs.length) {
      const body = formatMissedReviewMessage(
        yesterdayKey,
        actualPending,
        responseByPair,
        undiscussedPairs
      );
      missedNotice.messages.push({
        label: '1 · Main room notice',
        to: 'Main Pair Reviews',
        body,
      });
      const answered = actualPending.filter((pair) =>
        responseByPair.has(buildPairKey(pair))
      ).length;
      missedNotice.exampleNote = `Live — ${actualPending.length} missing (${answered} with lead reason), ${undiscussedPairs.length} not discussed.`;
    } else {
      missedNotice.exampleNote = 'Nothing pending — this notice would not be sent.';
      missedNotice.messages.push({
        label: 'Status',
        to: '—',
        body: `Yesterday (${formatDisplayDate(yesterdayKey)}) — all pairs submitted and none were marked “not discussed”. No 11:20 notice.`,
      });
    }
  } else {
    missedNotice.exampleNote = `No pair send for ${formatDisplayDate(yesterdayKey)} — skipped.`;
    missedNotice.messages.push({
      label: 'Status',
      to: '—',
      body: `Skipped — no daily pairs record for ${formatDisplayDate(yesterdayKey)}.`,
    });
  }

  missedNotice.example = missedNotice.messages.map((m) => m.body).join('\n\n———\n\n');

  // --- 11:30 Daily pairs (main room) ---
  const dailyPairs = {
    id: 'daily_pairs',
    time: cronTimeLabel(config.cronSchedule, 11, 30),
    days: 'Mon–Fri',
    cron: config.cronSchedule,
    title: 'Today’s pairs',
    destination: 'Main Pair Reviews room',
    destinationKind: 'main',
    description: 'Posts today’s pair assignments and lead to the main Element room.',
    exampleForDate: formatDisplayDate(todayKey),
    recipients: [{ name: 'Main Pair Reviews', role: 'Room', via: 'Main room' }],
    messages: [
      {
        label: '1 · Pairs broadcast',
        to: 'Main Pair Reviews',
        body: dailyPairsMessage,
      },
    ],
    exampleNote: `Live for ${formatDisplayDate(todayKey)} — lead ${pairsData.lead}.`,
    example: dailyPairsMessage,
  };

  // --- 5:00 Discussion check (one member per eligible pair) ---
  const discussion = {
    id: 'discussion_prompts',
    time: cronTimeLabel(config.discussionCronSchedule, 17, 0),
    days: 'Mon–Fri',
    cron: config.discussionCronSchedule,
    title: 'Meeting discussion check',
    destination: 'One member per pair — personal room',
    destinationKind: 'personal',
    description:
      'Asks one rotating member per submitted pair (with real findings) if yesterday’s review was discussed today. Skips missing and “no issues” reviews.',
    exampleForDate: formatDisplayDate(discussionPreview.reviewDateKey),
    recipients: discussionPreview.prompts.map((p) => ({
      name: p.member,
      role: `Pair: ${pairLabel(p.pair)}`,
      via: 'Personal room',
    })),
    messages: discussionPreview.prompts.map((p, i) => ({
      label: `${i + 1} · DM to ${p.member}`,
      to: p.member,
      body: p.message,
    })),
    exampleNote: discussionPreview.note,
    example: '',
    skipped: (discussionPreview.skippedPairs || []).map((s) => ({
      pair: pairLabel(s.pair),
      reason: s.reason,
    })),
  };

  if (!discussion.messages.length) {
    discussion.messages = [
      {
        label: 'Status',
        to: '—',
        body: discussionPreview.note || 'No discussion DMs would be sent.',
      },
    ];
  }

  discussion.example = discussion.messages.map((m) => m.body).join('\n\n———\n\n');

  // --- 6:00 Sir AI report (prepared at 5:58) ---
  const bossReviewKey = yesterdayKey;
  let bossDraft = null;
  try {
    const BossDailyReport = (await import('../models/BossDailyReport.js')).default;
    bossDraft = await BossDailyReport.findOne({ reviewDateKey: bossReviewKey }).lean();
  } catch {
    bossDraft = null;
  }

  const bossRoomId = (config.boss?.roomId || '').trim();
  const bossReport = {
    id: 'boss_daily_report',
    time: cronTimeLabel(config.bossReportSendCronSchedule, 18, 0),
    days: 'Mon–Fri',
    cron: config.bossReportSendCronSchedule,
    title: 'Ayaaz Sir report',
    destination: 'Sir personal room',
    destinationKind: 'personal',
    description:
      'AI analyzes yesterday’s reviews + lead report + meeting checks. Prepared at 5:58 PM, sent to Ayaaz Sir’s room at 6:00 PM.',
    exampleForDate: formatDisplayDate(bossReviewKey),
    recipients: bossRoomId
      ? [{ name: 'Ayaaz Sir', role: 'Boss report', via: 'Personal room' }]
      : [],
    messages: [],
    exampleNote: null,
    example: '',
  };

  if (!bossRoomId) {
    bossReport.exampleNote = 'BOSS_MATRIX_ROOM_ID is not configured.';
    bossReport.messages = [
      {
        label: 'Status',
        to: '—',
        body: 'Set BOSS_MATRIX_ROOM_ID to enable the 6:00 PM Sir report.',
      },
    ];
  } else if (bossDraft?.status === 'sent' && bossDraft.brief) {
    bossReport.exampleNote = `Already sent for ${formatDisplayDate(bossReviewKey)}.`;
    bossReport.messages = [
      {
        label: '1 · Sent report',
        to: 'Ayaaz Sir',
        body: bossDraft.brief,
      },
    ];
  } else if (bossDraft?.status === 'ready' && bossDraft.brief) {
    bossReport.exampleNote = 'Prepared at 5:58 — waiting for 6:00 PM send.';
    bossReport.messages = [
      {
        label: '1 · Ready report',
        to: 'Ayaaz Sir',
        body: bossDraft.brief,
      },
    ];
  } else {
    bossReport.exampleNote =
      'At 5:58 PM the AI builds this report; at 6:00 PM it goes to Sir’s room.';
    bossReport.messages = [
      {
        label: '1 · Preview shape',
        to: 'Ayaaz Sir',
        body: [
          `📋 Pair Review Report — ${formatDisplayDate(bossReviewKey)}`,
          '',
          '(AI will fill attendance, short review summaries, best mark, and meeting checks.)',
        ].join('\n'),
      },
    ];
  }

  bossReport.example = bossReport.messages.map((m) => m.body).join('\n\n———\n\n');

  // --- 6:50 Reminder + lead nudge ---
  const reminder = {
    id: 'review_reminder',
    time: cronTimeLabel(config.reminderCronSchedule, 18, 50),
    days: 'Mon–Fri',
    cron: config.reminderCronSchedule,
    title: 'Review reminder',
    destination: 'Main room + today’s lead personal room',
    destinationKind: 'main',
    description:
      'Main-room reminder for pairs still pending today, plus a private nudge to today’s lead.',
    exampleForDate: formatDisplayDate(todayKey),
    recipients: [],
    messages: [],
    exampleNote: null,
    example: '',
  };

  if (todayReview?.pairsSentAt) {
    const pendingToday = getPendingPairs(todayReview.pairs, todayReview);
    const lead = todayReview.lead;

    reminder.recipients = [
      { name: 'Main Pair Reviews', role: 'Room', via: 'Main room' },
      { name: lead, role: 'Today’s lead', via: 'Personal room' },
    ];

    if (pendingToday.length) {
      reminder.messages.push({
        label: '1 · Main room reminder',
        to: 'Main Pair Reviews',
        body: formatReminderMessage(lead, pendingToday),
      });
      reminder.messages.push({
        label: '2 · Lead personal DM',
        to: lead,
        body: formatLeadEveningNudge(lead, todayKey, pendingToday),
      });
      reminder.exampleNote = `Live — ${pendingToday.length} pending pair(s); lead ${lead}.`;
    } else {
      reminder.exampleNote = 'All reviews in — reminder would be skipped.';
      reminder.messages.push({
        label: 'Status',
        to: '—',
        body: `No 6:50 reminder — every pair has submitted for ${formatDisplayDate(todayKey)}.`,
      });
      reminder.recipients = [];
    }
  } else {
    reminder.exampleNote =
      'Today’s pairs have not been sent yet — reminder activates after the 11:30 pairs post.';
    reminder.messages.push({
      label: 'Status',
      to: '—',
      body: `Waiting for today’s pairs message (${formatDisplayDate(todayKey)}). After pairs go out, this shows the real pending list + lead DM.`,
    });
  }

  reminder.example = reminder.messages.map((m) => m.body).join('\n\n———\n\n');

  // --- 10:00 Pair review thread under yesterday's Pairs Today ---
  let threadDraft = null;
  try {
    const PairReviewThread = (await import('../models/PairReviewThread.js'))
      .default;
    threadDraft = await PairReviewThread.findOne({
      reviewDateKey: yesterdayKey,
    }).lean();
  } catch {
    threadDraft = null;
  }

  const pairThread = {
    id: 'pair_review_thread',
    time: cronTimeLabel(config.pairThreadCronSchedule, 10, 0),
    days: 'Mon–Fri',
    cron: config.pairThreadCronSchedule,
    title: 'Review thread digest',
    destination: 'Main room — thread under yesterday’s Pairs Today',
    destinationKind: 'main',
    description:
      'Posts yesterday’s meaningful pair reviews as Element thread replies under that day’s Pairs Today. Draft fills live on Threads as reviews arrive.',
    exampleForDate: formatDisplayDate(yesterdayKey),
    recipients: [
      { name: 'Main room', role: 'Thread replies', via: 'Pairs Today thread' },
    ],
    messages: [],
    exampleNote: null,
    example: '',
  };

  const readyReplies = (threadDraft?.replies || []).filter((r) => !r.skipped);
  if (threadDraft?.status === 'sent' && readyReplies.length) {
    pairThread.exampleNote = `Already posted for ${formatDisplayDate(yesterdayKey)}.`;
    pairThread.messages = readyReplies.slice(0, 4).map((r, i) => ({
      label: `${i + 1} · ${r.pairLabel || (r.pair || []).join(' + ')}`,
      to: 'Thread',
      body: r.body || r.pairLabel,
    }));
  } else if (readyReplies.length) {
    pairThread.exampleNote = `Draft ready — ${readyReplies.length} review(s) will post at 10:00 AM.`;
    pairThread.messages = readyReplies.slice(0, 4).map((r, i) => ({
      label: `${i + 1} · ${r.pairLabel || (r.pair || []).join(' + ')}`,
      to: 'Thread',
      body: r.body || r.pairLabel,
    }));
  } else {
    pairThread.exampleNote =
      'As pair reviews arrive they show on Threads; at 10:00 AM they post under yesterday’s Pairs Today.';
    pairThread.messages = [
      {
        label: 'Status',
        to: '—',
        body: `Waiting for meaningful pair reviews for ${formatDisplayDate(yesterdayKey)} (no-issues reviews are skipped).`,
      },
    ];
  }
  pairThread.example = pairThread.messages
    .map((m) => m.body)
    .join('\n\n———\n\n');

  return {
    timezone: config.timezone,
    schedules: [
      ...(config.enablePairThread ? [pairThread] : []),
      leadFollowUps,
      missedNotice,
      dailyPairs,
      discussion,
      bossReport,
      ...(config.enableReviewReminder ? [reminder] : []),
    ],
  };
};
