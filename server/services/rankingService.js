import MonthlyMemberInsight from '../models/MonthlyMemberInsight.js';
import MonthlyRankingReport from '../models/MonthlyRankingReport.js';
import RoomMessage from '../models/RoomMessage.js';
import DailyReview from '../models/DailyReview.js';
import { config, getAllMembers } from '../config/appConfig.js';
import {
  getMonthSchedule,
  getCurrentMonthParts,
  getKarachiDateKey,
  formatDisplayDate,
  isNonWorkingDay,
  isWeekend,
  getPreviousWorkingDay,
  addCalendarDays,
} from './pairService.js';
import { chatCompletion, getAiSettingsPublic } from './aiService.js';
import {
  getMatrixClient,
  joinMatrixRoom,
  sendMatrixMessageToRoom,
  sendMatrixImage,
} from './matrixService.js';
import puppeteer from 'puppeteer';
import { logOutgoingMessage } from './roomMessageService.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const NO_ISSUES_RE =
  /review\s+completed\.?\s*no\s+issues,?\s*concerns,?\s*or\s+improvement\s+recommendations?\s+identified/i;

/** Forgot reasons that should NOT be penalized. */
const EXCUSED_FORGOT_RE = /\b(meeting|demo|client\s+call|presentation|standup)\b/i;

const personalRoomIds = () =>
  Object.values(config.memberRoomMap || {}).filter(Boolean);

/* ------------------------------------------------------------------ */
/*  AI parsing                                                         */
/* ------------------------------------------------------------------ */

const buildParseSystemPrompt = () =>
  [
    'You are a review parser. Given a pair-review message and pair metadata,',
    'extract each team member\'s SUGGESTION, CONCERN, or ISSUE entries.',
    '',
    'Developer pairs have 2 members. QA pairs have 3 members.',
    '',
    'Templates that reviews follow:',
    'Developer: [PAIR]\\n[TYPE] SUGGESTION|CONCERN|ISSUE\\nMEMBER1 : [TEXT]\\n[TYPE]\\nMEMBER2 : [TEXT]',
    'QA: [PAIR]\\n[TYPE] SUGGESTION|CONCERN|ISSUE\\nMEMBER1 : [TEXT]\\n[TYPE]\\nMEMBER2 : [TEXT]\\n[TYPE]\\nMEMBER3 : [TEXT]',
    '',
    'Important formatting details:',
    '- The pair name is always located at the very top of the review message.',
    '- The labels (SUGGESTION, CONCERN, ISSUE) and member names can be in UPPERCASE, lowercase, or MiXeD case. Treat them case-insensitively.',
    '',
    'If the message is just conversational chatter and NOT a pair review, return { "emptyReview": false, "items": [] } and do NOT invent any insights.',
    '',
    'Some reviews do NOT follow the template strictly — they may use free text.',
    'Still try to extract any mentioned suggestions/concerns/issues per member.',
    '',
    'If the review says "Review completed. No issues, concerns, or improvement recommendations identified"',
    'or similar no-issues text, return: { "emptyReview": true, "items": [] }',
    '',
    'Otherwise return JSON:',
    '{',
    '  "emptyReview": false,',
    '  "items": [',
    '    { "member": "MemberName", "type": "suggestion|concern|issue", "text": "normalized text" },',
    '    ...',
    '  ]',
    '}',
    '',
    'CRITICAL MULTI-ITEM AND ATTRIBUTION RULES:',
    '- A member can provide multiple numbered points (e.g. "1-...", "2-:...", "1.", "2.") or multiple bullet points.',
    '- Extract EACH point as a separate object in the "items" array with that member and type.',
    '- IMPORTANT: Until the next member name or next section header appears, ALL subsequent lines, numbered points, or continuation text belong to the current active member. Never drop subsequent numbered items (like "2-:" or "2.") — attribute them to the member listed above them.',
    '',
    'Rules:',
    '- Output ONLY valid JSON, no markdown fences, no commentary.',
    '- Normalize each text: clean up, remove redundant whitespace, keep it concise but preserve meaning.',
    '- "member" must be the first name only (e.g. "Mohsin", not "Mohsin Ashraf").',
    '- Match member names to the pair members list provided.',
    '- If a member has no entry in the review, do not invent one.',
    '- type must be exactly one of: suggestion, concern, issue (lowercase).',
  ].join('\n');

const buildParseUserPrompt = (reviewBody, pairLabel, pairMembers, pairType) =>
  [
    `Pair: ${pairLabel}`,
    `Pair type: ${pairType}`,
    `Pair members: ${pairMembers.join(', ')}`,
    '',
    '--- REVIEW MESSAGE ---',
    reviewBody,
    '--- END ---',
    '',
    'Parse this review and return the JSON.',
  ].join('\n');

/**
 * Use AI to parse a review message body into structured insight items.
 * Returns { emptyReview: boolean, items: [{ member, type, text }] }
 */
export const parseReviewInsights = async (reviewBody, pair, pairType) => {
  if (!reviewBody?.trim()) {
    return { emptyReview: true, items: [] };
  }

  // Fast-path: detect no-issues reviews without AI
  if (NO_ISSUES_RE.test(reviewBody)) {
    return { emptyReview: true, items: [] };
  }

  const settings = await getAiSettingsPublic();
  if (!settings.configured || !settings.modelId) {
    // Cannot use AI — try regex fallback
    return fallbackParse(reviewBody, pair);
  }

  const pairLabel = Array.isArray(pair) ? pair.join(' + ') : String(pair);
  const pairMembers = Array.isArray(pair) ? pair : [pair];

  try {
    const completion = await chatCompletion({
      messages: [
        { role: 'system', content: buildParseSystemPrompt() },
        {
          role: 'user',
          content: buildParseUserPrompt(reviewBody, pairLabel, pairMembers, pairType),
        },
      ],
      temperature: 0.1,
    });

    const raw =
      completion?.choices?.[0]?.message?.content ||
      completion?.choices?.[0]?.text ||
      '';

    const cleaned = String(raw)
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned);
    return {
      emptyReview: Boolean(parsed.emptyReview),
      items: (parsed.items || []).map((item) => ({
        member: String(item.member || '').trim(),
        type: ['suggestion', 'concern', 'issue'].includes(item.type)
          ? item.type
          : 'suggestion',
        text: String(item.text || '').trim(),
      })).filter((item) => item.member && item.text),
    };
  } catch (error) {
    console.error('[ranking] AI parse failed:', error.message);
    return fallbackParse(reviewBody, pair);
  }
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Robust regex parser when AI is unavailable.
 * Tracks current active member and attributes all subsequent lines / numbered points
 * to that member until the next member name or section header appears.
 */
const fallbackParse = (body, pair) => {
  if (NO_ISSUES_RE.test(body)) {
    return { emptyReview: true, items: [] };
  }

  const items = [];
  const members = Array.isArray(pair) ? pair : [];
  if (!members.length) return { emptyReview: true, items: [] };

  const memberNamesPattern = members.map(escapeRegExp).join('|');
  const memberStartRe = new RegExp(`^(${memberNamesPattern})\\s*[:.\\-]\\s*(.*)$`, 'i');
  const typeHeaderRe = /^\s*(SUGGESTIONS?|CONCERNS?|ISSUES?)\s*[:.\\-]?\s*$/i;
  const inlinePrefixRe = /^[([]?\s*(SUGGESTIONS?|CONCERNS?|ISSUES?)\s*[)\]]?\s*[:.\\-]\s*(.*)$/i;
  const listItemRe = /^\s*(?:(?:\d+\s*[-:.)]\s*)+|[-*•]\s+)(.*)$/;

  let currentType = 'suggestion';
  let currentMember = null;
  let currentItem = null;

  const pushCurrentItem = () => {
    if (currentItem && currentItem.text.trim()) {
      items.push({
        member: currentItem.member,
        type: currentItem.type,
        text: currentItem.text.trim(),
      });
      currentItem = null;
    }
  };

  const normalizeType = (raw) => {
    const lower = String(raw || '').toLowerCase();
    if (lower.startsWith('concern')) return 'concern';
    if (lower.startsWith('issue')) return 'issue';
    return 'suggestion';
  };

  const lines = (body || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip pair header line (e.g. 'Habiba + Adil' or 'Developer: ...')
    if (
      members.length >= 2 &&
      members.every((m) => new RegExp(`\\b${escapeRegExp(m)}\\b`, 'i').test(trimmed))
    ) {
      continue;
    }
    if (/^(developer|qa|pair)\s*[:.\\-]/i.test(trimmed)) {
      continue;
    }

    // Check pure type header (e.g. 'Concerns:', 'Suggestion:')
    const typeHeaderMatch = trimmed.match(typeHeaderRe);
    if (typeHeaderMatch) {
      pushCurrentItem();
      currentType = normalizeType(typeHeaderMatch[1]);
      currentMember = null;
      continue;
    }

    // Check if line starts with a member name (e.g. 'Habiba: ...')
    const memberMatch = trimmed.match(memberStartRe);
    if (memberMatch) {
      pushCurrentItem();
      const matchedName =
        members.find((m) => m.toLowerCase() === memberMatch[1].toLowerCase()) ||
        memberMatch[1];
      currentMember = matchedName;
      let rest = memberMatch[2].trim();

      // Check if rest starts with an inline type keyword like '(Concern): ...' or 'Concern: ...'
      const inlineMatch = rest.match(inlinePrefixRe);
      let itemType = currentType;
      if (inlineMatch) {
        itemType = normalizeType(inlineMatch[1]);
        rest = inlineMatch[2].trim();
      }

      if (rest) {
        currentItem = {
          member: currentMember,
          type: itemType,
          text: rest,
        };
      }
      continue;
    }

    // Line does NOT start with a member name
    // If we have an active member, all subsequent lines/points belong to that member
    // until the next member or section header arrives.
    if (currentMember) {
      // Check if it's a new numbered or bulleted item (e.g. '2-:', '2.', '- ')
      const listMatch = trimmed.match(listItemRe);
      if (listMatch) {
        pushCurrentItem();
        currentItem = {
          member: currentMember,
          type: currentType,
          text: trimmed,
        };
      } else {
        // Continuation line for the active member's current point
        if (currentItem) {
          currentItem.text += ' ' + trimmed;
        } else {
          currentItem = {
            member: currentMember,
            type: currentType,
            text: trimmed,
          };
        }
      }
    }
  }

  pushCurrentItem();

  return { emptyReview: items.length === 0 && !NO_ISSUES_RE.test(body), items };
};

/* ------------------------------------------------------------------ */
/*  Process daily reviews                                              */
/* ------------------------------------------------------------------ */

/**
 * Load all review messages for a dateKey, parse them via AI,
 * and upsert MonthlyMemberInsight documents.
 */
export const processDateReviews = async (dateKey) => {
  if (!dateKey) throw new Error('dateKey is required');
  const monthKey = dateKey.slice(0, 7);

  const personal = personalRoomIds();
  const query = {
    dateKey,
    countsAsReview: true,
    deletedAt: { $exists: false },
  };
  if (personal.length) query.roomId = { $nin: personal };
  else if (config.matrix.roomId) query.roomId = config.matrix.roomId;

  const messages = await RoomMessage.find(query).sort({ sentAt: 1 }).lean();
  if (!messages.length) {
    return { dateKey, processed: 0, skipped: 'No review messages found' };
  }

  const qaSet = new Set(config.qaTeam || []);
  const allMembers = getAllMembers();

  const results = [];
  const memberInsightsMap = {}; // member -> aggregated data

  for (const msg of messages) {
    const pair = msg.matchedPair || [];
    if (!pair.length) continue;

    const pairType = pair.some((m) => qaSet.has(m)) ? 'qa' : 'developer';
    const pairLabel = pair.join(' + ');

    const parsed = await parseReviewInsights(msg.body || '', pair, pairType);

    // If empty review -> create an insight for each pair member
    if (parsed.emptyReview) {
      for (const member of pair) {
        if (!allMembers.includes(member)) continue;
        if (!memberInsightsMap[member]) {
          memberInsightsMap[member] = {
            pairLabel,
            pairType,
            items: [],
            emptyReview: true,
          };
        } else {
          memberInsightsMap[member].emptyReview = true;
        }
      }
    }

    // Process parsed items
    for (const item of parsed.items) {
      const matchedMember = allMembers.find(
        (m) => m.toLowerCase() === item.member.toLowerCase()
      );
      if (!matchedMember) continue;

      if (!memberInsightsMap[matchedMember]) {
        memberInsightsMap[matchedMember] = {
          pairLabel,
          pairType,
          items: [],
          emptyReview: false,
        };
      }
      memberInsightsMap[matchedMember].items.push({
        type: item.type,
        text: item.text,
        rawSender: msg.senderName || null,
      });
      // If they have real items, it's not empty
      memberInsightsMap[matchedMember].emptyReview = false;
    }

    results.push({
      pairLabel,
      emptyReview: parsed.emptyReview,
      itemCount: parsed.items.length,
    });
  }

  // Upsert insights per member
  let upserted = 0;
  for (const [member, data] of Object.entries(memberInsightsMap)) {
    await MonthlyMemberInsight.findOneAndUpdate(
      { dateKey, member },
      {
        $set: {
          monthKey,
          pairLabel: data.pairLabel,
          pairType: data.pairType,
          items: data.items,
          emptyReview: data.emptyReview,
          processedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );
    upserted += 1;
  }

  return { dateKey, processed: upserted, reviews: results };
};

/* ------------------------------------------------------------------ */
/*  Gather member stats (for AI context)                               */
/* ------------------------------------------------------------------ */

/**
 * Check if a forgot reason is excused (meeting / demo / client call).
 */
const isForgotExcused = (reason) => {
  if (!reason) return false;
  return EXCUSED_FORGOT_RE.test(reason);
};

/**
 * Build comprehensive stats for each member in a month.
 * AI will use these stats + actual insights to determine rankings.
 */
const buildMemberStats = async (monthKey, schedule, todayKey) => {
  const allMembers = getAllMembers();
  const dateKeys = schedule.map((d) => d.dateKey);

  // Load attendance data
  const reviews = await DailyReview.find({ dateKey: { $in: dateKeys } }).lean();
  const reviewMap = Object.fromEntries(reviews.map((r) => [r.dateKey, r]));

  // Load insights
  const insights = await MonthlyMemberInsight.find({ monthKey }).lean();
  const insightsByMember = {};
  for (const ins of insights) {
    if (!insightsByMember[ins.member]) insightsByMember[ins.member] = [];
    insightsByMember[ins.member].push(ins);
  }

  // Load lead report sessions for forgot reasons
  const LeadReportSession = (await import('../models/LeadReportSession.js')).default;
  const leadSessions = await LeadReportSession.find({
    dateKey: { $in: dateKeys },
  }).lean();
  const leadSessionMap = Object.fromEntries(
    leadSessions.map((s) => [s.dateKey, s])
  );

  return allMembers.map((member) => {
    const memberInsights = insightsByMember[member] || [];

    const stats = {
      totalReviews: 0,
      emptyReviews: 0,
      suggestions: 0,
      concerns: 0,
      issues: 0,
      presentDays: 0,
      absentDays: 0,
      halfDays: 0,
      forgotDays: 0,
      forgotExcusedDays: 0,
      excusedDays: 0,
    };

    // Count attendance from DailyReview
    for (const day of schedule) {
      if (day.dateKey > todayKey) continue;
      const review = reviewMap[day.dateKey];
      if (!review?.pairsSentAt) continue;

      const inPair = (review.pairs || []).some((p) => p.includes(member));
      if (!inPair) continue;

      stats.totalReviews += 1;

      if (review.reviewedMembers?.includes(member)) {
        stats.presentDays += 1;
      } else if (review.lateReviewedMembers?.includes(member)) {
        // Check if forgot reason is meeting/demo — then excused
        const session = leadSessionMap[day.dateKey];
        const decisions = session?.pairDecisions || [];
        const memberDecision = decisions.find(
          (d) => (d.pair || []).includes(member) && d.forgotReason
        );
        if (memberDecision && isForgotExcused(memberDecision.forgotReason)) {
          stats.forgotExcusedDays += 1;
        } else {
          stats.forgotDays += 1;
        }
      } else if (review.absentMembers?.includes(member)) {
        stats.absentDays += 1;
      } else if (review.halfDayMembers?.includes(member)) {
        stats.halfDays += 1;
      } else if (review.excusedMembers?.includes(member)) {
        stats.excusedDays += 1;
      } else if (day.dateKey < todayKey) {
        stats.absentDays += 1;
      }
    }

    // Count insights
    const allItems = [];
    for (const ins of memberInsights) {
      if (ins.emptyReview) stats.emptyReviews += 1;
      for (const item of ins.items || []) {
        if (item.type === 'suggestion') stats.suggestions += 1;
        else if (item.type === 'concern') stats.concerns += 1;
        else if (item.type === 'issue') stats.issues += 1;
        allItems.push({ ...item, dateKey: ins.dateKey, pairLabel: ins.pairLabel });
      }
    }

    return { member, stats, allItems, insightCount: memberInsights.length };
  });
};

/**
 * Build ranking data for a month.
 */
export const getMonthlyRankingData = async (monthKey) => {
  if (!monthKey) {
    const { year, month } = getCurrentMonthParts();
    monthKey = `${year}-${String(month).padStart(2, '0')}`;
  }

  const [yearStr, monthStr] = monthKey.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const todayKey = getKarachiDateKey();
  const schedule = getMonthSchedule(year, month);

  const memberData = await buildMemberStats(monthKey, schedule, todayKey);

  // Check existing report for saved rankings
  const existingReport = await MonthlyRankingReport.findOne({ monthKey }).lean();

  // If we have AI-generated rankings, use those scores/oneLiners
  const savedRankMap = {};
  if (existingReport?.rankings?.length) {
    for (const r of existingReport.rankings) {
      savedRankMap[r.member] = r;
    }
  }

  const rankings = memberData.map((md) => {
    const saved = savedRankMap[md.member];
    return {
      member: md.member,
      rank: saved?.rank || 0,
      score: saved?.score || 0,
      oneLiner: saved?.oneLiner || '',
      stats: md.stats,
    };
  });

  // Sort by saved score if available, otherwise by member name
  if (existingReport?.rankings?.length) {
    rankings.sort((a, b) => b.score - a.score || a.member.localeCompare(b.member));
    rankings.forEach((r, i) => { r.rank = i + 1; });
  } else {
    rankings.sort((a, b) => a.member.localeCompare(b.member));
    rankings.forEach((r, i) => { r.rank = i + 1; });
  }

  // Processed days count
  const insights = await MonthlyMemberInsight.find({ monthKey }).lean();
  const processedDateKeys = [...new Set(insights.map((i) => i.dateKey))];
  const totalWorkingDays = schedule.filter((d) => d.dateKey <= todayKey).length;

  return {
    monthKey,
    year,
    month,
    todayKey,
    rankings,
    processedDays: processedDateKeys.length,
    totalWorkingDays,
    totalWorkingDaysInMonth: schedule.length,
    hasAiRanking: Boolean(existingReport?.rankings?.length),
    existingReport: existingReport
      ? {
          status: existingReport.status,
          generatedAt: existingReport.generatedAt,
          sentAt: existingReport.sentAt,
          eventId: existingReport.eventId,
        }
      : null,
  };
};

/* ------------------------------------------------------------------ */
/*  Monthly report generation (AI-based ranking)                       */
/* ------------------------------------------------------------------ */

const buildRankingSystemPrompt = () =>
  [
    'You are a team performance analyst. Analyze all members\' monthly pair-review data',
    'and produce a ranking with scores out of 10 and one-line performance summaries.',
    '',
    'You will receive each member\'s:',
    '- Attendance data (present, absent, half-day, forgot, excused)',
    '- Number of empty reviews (\"No issues\" = low effort)',
    '- Actual suggestions, concerns, and issues they raised (the substance of their reviews)',
    '',
    'Scoring guidelines:',
    '- Members who raise meaningful suggestions/issues/concerns in their reviews should score HIGHER',
    '- Members who consistently send empty reviews ("No issues identified") should score LOWER',
    '- Absent days and unexcused forgot days should reduce score',
    '- Half-day leaves have minor impact',
    '- Excused forgot (meeting/demo) should NOT penalize',
    '- Excused (partner absent) days should NOT penalize',
    '- Quality and specificity of suggestions/issues matters',
    '- Use your judgment to evaluate the overall contribution',
    '',
    'Output JSON ONLY (no markdown fences):',
    '{',
    '  "rankings": [',
    '    {',
    '      "member": "Name",',
    '      "score": 8.5,',
    '      "oneLiner": "Consistently raised specific UI improvement suggestions"',
    '    },',
    '    ...',
    '  ],',
    '  "reportText": "Full formatted report text for Element chat (use **bold** for headings)"',
    '}',
    '',
    'Report text format:',
    '',
    '🏆 **Monthly Pair Review Ranking — {Month Year}**',
    '',
    'For each member (ordered by rank):',
    '{medal} **{Rank}. {Name}** — {Score}/10',
    '{one-liner performance summary}',
    '',
    '📊 **Summary**',
    '- Best performer: {name}',
    '- Areas to watch: {brief note}',
    '',
    'Rules:',
    '- Medals: 🥇 rank 1, 🥈 rank 2, 🥉 rank 3',
    '- One-liners: max 15 words, specific to their actual review content',
    '- Score must be between 1.0 and 10.0',
    '- Be fair and objective in scoring',
    '- Order rankings by score descending',
  ].join('\n');

const buildRankingUserPrompt = (monthKey, memberDataList) => {
  const [yearStr, monthStr] = monthKey.split('-');
  const monthNames = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December',
  ];
  const monthLabel = `${monthNames[Number(monthStr) - 1]} ${yearStr}`;

  const lines = [`Month: ${monthLabel} (${monthKey})`, ''];

  for (const md of memberDataList) {
    const s = md.stats;
    lines.push(`=== ${md.member} ===`);
    lines.push(
      `Attendance: ${s.presentDays} present, ${s.absentDays} absent, ` +
      `${s.halfDays} half-day, ${s.forgotDays} forgot (unexcused), ` +
      `${s.forgotExcusedDays} forgot (excused: meeting/demo), ${s.excusedDays} excused`
    );
    lines.push(
      `Reviews: ${s.totalReviews} total, ${s.emptyReviews} empty ("No issues"), ` +
      `${s.suggestions} suggestions, ${s.concerns} concerns, ${s.issues} issues`
    );

    if (md.allItems.length > 0) {
      lines.push('Review content:');
      for (const item of md.allItems.slice(0, 20)) {
        lines.push(`  - [${item.type.toUpperCase()}] ${item.text} (${item.dateKey})`);
      }
      if (md.allItems.length > 20) {
        lines.push(`  ... and ${md.allItems.length - 20} more items`);
      }
    } else {
      lines.push('Review content: No substantive review items recorded.');
    }
    lines.push('');
  }

  lines.push('Analyze all members above and produce the ranking JSON.');
  return lines.join('\n');
};

/**
 * Generate the monthly ranking report — AI analyzes all data and ranks members.
 */
export const generateMonthlyReport = async (monthKeyInput) => {
  let monthKey = monthKeyInput;
  if (!monthKey) {
    const { year, month } = getCurrentMonthParts();
    monthKey = `${year}-${String(month).padStart(2, '0')}`;
  }

  const settings = await getAiSettingsPublic();
  if (!settings.configured || !settings.modelId) {
    throw Object.assign(new Error('Configure AI model in Settings first'), {
      status: 400,
    });
  }

  const [yearStr, monthStr] = monthKey.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const todayKey = getKarachiDateKey();
  const schedule = getMonthSchedule(year, month);

  const memberDataList = await buildMemberStats(monthKey, schedule, todayKey);

  const completion = await chatCompletion({
    messages: [
      { role: 'system', content: buildRankingSystemPrompt() },
      {
        role: 'user',
        content: buildRankingUserPrompt(monthKey, memberDataList),
      },
    ],
    temperature: 0.3,
  });

  const raw =
    completion?.choices?.[0]?.message?.content ||
    completion?.choices?.[0]?.text ||
    '';
  const cleaned = String(raw)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // If JSON parse fails, use the raw text as report
    console.warn('[ranking] AI did not return valid JSON, using raw text');
    parsed = { rankings: [], reportText: cleaned };
  }

  const aiRankings = (parsed.rankings || []).map((r, i) => {
    const score = Math.max(1, Math.min(10, Number(r.score) || 5));
    return {
      member: String(r.member || '').trim(),
      rank: i + 1,
      score: Math.round(score * 10) / 10,
      oneLiner: String(r.oneLiner || '').trim(),
      stats: (memberDataList.find((m) => m.member === r.member) || {}).stats || {},
    };
  });

  // Sort by score descending and reassign ranks
  aiRankings.sort((a, b) => b.score - a.score);
  aiRankings.forEach((r, i) => { r.rank = i + 1; });

  const reportText = String(parsed.reportText || '').trim();

  // Save report
  const report = await MonthlyRankingReport.findOneAndUpdate(
    { monthKey },
    {
      $set: {
        generatedAt: new Date(),
        modelId: settings.modelId,
        modelName: settings.modelName || settings.modelId,
        rankings: aiRankings,
        reportText: reportText || 'Report generation completed but text was empty.',
      },
    },
    { upsert: true, new: true }
  );

  let imageBase64 = '';
  try {
    const buffer = await generateLeaderboardImageBuffer(report);
    if (buffer) {
      imageBase64 = buffer.toString('base64');
      report.imageBase64 = imageBase64;
    }
  } catch (error) {
    console.error('[ranking] Failed to generate preview image:', error);
  }

  // Calculate the 1st of the next month at 6:00 PM
  const scheduledTime = new Date(yearStr, monthStr, 1, 18, 0, 0, 0); // monthStr is 1-indexed string, so passing it to Date as month index means the NEXT month

  // If the scheduled time is in the past (e.g. manual generation after the 1st), keep it as 'draft'
  if (scheduledTime < new Date()) {
    report.status = 'draft';
  } else {
    report.status = 'scheduled';
    report.scheduledFor = scheduledTime;
  }

  await report.save();

  return {
    monthKey,
    reportText,
    rankings: aiRankings,
    generatedAt: report.generatedAt,
    status: report.status,
  };
};

/**
 * Send the monthly report to the MAIN pair reviews room via Matrix.
 */
export const sendMonthlyReport = async (monthKeyInput) => {
  let monthKey = monthKeyInput;
  if (!monthKey) {
    const { year, month } = getCurrentMonthParts();
    monthKey = `${year}-${String(month).padStart(2, '0')}`;
  }

  // Send to main pair reviews room (not boss room)
  const roomId = (config.matrix.roomId || '').trim();
  if (!roomId) {
    return { skipped: true, reason: 'MATRIX_ROOM_ID not set' };
  }

  let report = await MonthlyRankingReport.findOne({ monthKey });
  if (!report?.reportText?.trim() || report.status === 'failed') {
    // Generate on the spot
    await generateMonthlyReport(monthKey);
    report = await MonthlyRankingReport.findOne({ monthKey });
  }

  if (!report?.reportText?.trim()) {
    return { skipped: true, reason: 'No report to send' };
  }

  if (report.eventId) {
    return { skipped: true, reason: 'Already sent', eventId: report.eventId };
  }

  await joinMatrixRoom(roomId).catch(() => {});

  // Use generated image from report or fallback to generating it now
  let imageBuffer = null;
  try {
    if (report.imageBase64) {
      imageBuffer = Buffer.from(report.imageBase64, 'base64');
    } else {
      imageBuffer = await generateLeaderboardImageBuffer(report);
    }
  } catch (error) {
    console.error('[ranking] Failed to get image for sending:', error);
  }

  let result;
  if (imageBuffer) {
    const filename = `leaderboard_${monthKey}.png`;
    result = await sendMatrixImage(imageBuffer, filename, 'image/png');
  } else {
    // Fallback to text if image generation fails
    result = await sendMatrixMessageToRoom(roomId, report.reportText, {
      kind: 'monthly_ranking_report',
      monthKey,
    });
  }

  report.status = 'sent';
  report.sentAt = new Date();
  report.eventId = result.event_id;
  report.roomId = roomId;
  await report.save();

  await logOutgoingMessage(report.reportText, result.event_id, 'bot_pairs', {
    dateKey: getKarachiDateKey(),
    roomId,
  }).catch((err) => console.warn(`[ranking] Log failed: ${err.message}`));

  return {
    skipped: false,
    monthKey,
    eventId: result.event_id,
    roomId,
  };
};

/* ------------------------------------------------------------------ */
/*  Query helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Get all stored insights for a month, optionally filtered by member.
 */
export const getMonthlyInsights = async (monthKey, member) => {
  if (!monthKey) {
    const { year, month } = getCurrentMonthParts();
    monthKey = `${year}-${String(month).padStart(2, '0')}`;
  }

  const query = { monthKey };
  if (member) query.member = member;

  const insights = await MonthlyMemberInsight.find(query)
    .sort({ dateKey: 1, member: 1 })
    .lean();

  return { monthKey, insights, total: insights.length };
};

/**
 * Schedule info for the ranking page.
 */
export const getRankingScheduleInfo = async () => {
  const todayKey = getKarachiDateKey();
  const { year, month } = getCurrentMonthParts();
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const schedule = getMonthSchedule(year, month);
  const workingDays = schedule.map((d) => d.dateKey);
  const lastWorkingDay = workingDays[workingDays.length - 1] || null;

  // Count processed days
  const processedCount = await MonthlyMemberInsight.distinct('dateKey', {
    monthKey,
  });

  // Check if report exists
  const report = await MonthlyRankingReport.findOne({ monthKey }).lean();

  return {
    monthKey,
    year,
    month,
    todayKey,
    totalWorkingDays: workingDays.length,
    processedDays: processedCount.length,
    processedDateKeys: processedCount,
    lastWorkingDay,
    isLastWorkingDay: todayKey === lastWorkingDay,
    dailyCronSchedule: config.rankingProcessCronSchedule || '30 18 * * 1-5',
    report: report
      ? {
          status: report.status,
          generatedAt: report.generatedAt,
          sentAt: report.sentAt,
          eventId: report.eventId,
        }
      : null,
  };
};

/**
 * Backfill: process all working days from startDate to today.
 */
export const backfillDateRange = async (startDateKey) => {
  const todayKey = getKarachiDateKey();
  const results = [];
  let current = startDateKey;

  while (current <= todayKey) {
    if (!isNonWorkingDay(current)) {
      try {
        const result = await processDateReviews(current);
        results.push(result);
      } catch (error) {
        results.push({ dateKey: current, error: error.message });
      }
    }
    current = addCalendarDays(current, 1);
  }

  return { startDateKey, endDateKey: todayKey, results };
};

/**
 * Check if today is the last working day of the month.
 */
export const isLastWorkingDayOfMonth = () => {
  const todayKey = getKarachiDateKey();
  const { year, month } = getCurrentMonthParts();
  const schedule = getMonthSchedule(year, month);
  const workingDays = schedule.map((d) => d.dateKey);
  return workingDays[workingDays.length - 1] === todayKey;
};

/**
 * Check if today is the 1st day of the month (which means we should generate/send the report for the PREVIOUS month).
 */
export const isFirstDayOfMonth = () => {
  const todayKey = getKarachiDateKey();
  const [, , day] = todayKey.split('-');
  return day === '01';
};

/**
 * Generate a beautiful HTML/CSS Leaderboard image using Puppeteer
 */
async function generateLeaderboardImageBuffer(report) {
  const ranks = report.rankings || [];
  
  // Format the month nicely
  const [yearStr, monthStr] = report.monthKey.split('-');
  const date = new Date(yearStr, monthStr - 1);
  const monthName = date.toLocaleString('default', { month: 'long', year: 'numeric' });

  // Generate rows
  const rowsHtml = ranks.map(r => {
    let medal = '';
    if (r.rank === 1) medal = '🥇';
    else if (r.rank === 2) medal = '🥈';
    else if (r.rank === 3) medal = '🥉';
    else medal = `<span style="font-size: 0.8em; color: #8b949e;">#${r.rank}</span>`;

    return `
      <div class="row ${r.rank <= 3 ? 'top3' : ''}">
        <div class="rank">${medal}</div>
        <div class="details">
          <div class="name-score">
            <span class="name">${r.member}</span>
            <span class="score">${r.score} <small>/10</small></span>
          </div>
          <div class="one-liner">${r.oneLiner}</div>
        </div>
      </div>
    `;
  }).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
        body {
          margin: 0;
          padding: 40px;
          background: linear-gradient(135deg, #0d1117 0%, #161b22 100%);
          font-family: 'Inter', sans-serif;
          color: #c9d1d9;
          width: 800px;
        }
        .container {
          background: rgba(22, 27, 34, 0.7);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 20px;
          padding: 40px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(10px);
        }
        .header {
          text-align: center;
          margin-bottom: 40px;
        }
        h1 {
          color: #fff;
          font-weight: 800;
          font-size: 32px;
          margin: 0 0 10px 0;
          background: -webkit-linear-gradient(45deg, #58a6ff, #3fb950);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .subtitle {
          color: #8b949e;
          font-size: 18px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 2px;
        }
        .row {
          display: flex;
          align-items: center;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 16px;
          border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .row.top3 {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .rank {
          font-size: 32px;
          width: 60px;
          text-align: center;
        }
        .details {
          flex: 1;
          margin-left: 20px;
        }
        .name-score {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .name {
          font-size: 22px;
          font-weight: 600;
          color: #fff;
        }
        .score {
          font-size: 22px;
          font-weight: 800;
          color: #3fb950;
        }
        .score small {
          font-size: 14px;
          color: #8b949e;
        }
        .one-liner {
          color: #8b949e;
          font-size: 15px;
          line-height: 1.5;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Monthly Ranking Report</h1>
          <div class="subtitle">${monthName}</div>
        </div>
        ${rowsHtml}
      </div>
    </body>
    </html>
  `;

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 880, height: 600, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    const bodyHandle = await page.$('body');
    const boundingBox = await bodyHandle.boundingBox();
    const buffer = await page.screenshot({
      clip: {
        x: 0,
        y: 0,
        width: 880,
        height: Math.ceil(boundingBox.height)
      }
    });
    
    await bodyHandle.dispose();
    return Buffer.from(buffer);
  } finally {
    if (browser) await browser.close();
  }
}
