import DiscussionPrompt from '../models/DiscussionPrompt.js';
import {
  formatDisplayDate,
  getKarachiDateKey,
  getPreviousWorkingDay,
} from './pairService.js';
import { getLeadReportDetail } from './leadReportViewService.js';
import { chatCompletion, getAiSettingsPublic } from './aiService.js';

const pairLabel = (pair = []) =>
  Array.isArray(pair) ? pair.join(' + ') : String(pair || '—');

const clip = (text, max = 400) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
};

const buildSystemPrompt = () =>
  [
    'You write a very short activity brief for a pair-review bot team.',
    'Input: lead morning-report chat + 5 PM meeting-discussion YES/NO replies.',
    'Output ONLY the brief — no title, no markdown fences, no preamble.',
    'Format: exactly 2 short lines (easy to paste into chat).',
    'Line 1 = lead report (who led, what was confirmed / missing / forgot).',
    'Line 2 = meeting checks (each pair: discussed YES/NO, or pending/skipped).',
    'Keep it tight: names + facts. Cover all activity. No fluff.',
  ].join(' ');

const buildUserPrompt = ({ meetingDateKey, reviewDateKey, leadBlock, meetingBlock }) =>
  [
    `Meeting day: ${formatDisplayDate(meetingDateKey)} (${meetingDateKey})`,
    `Review day covered: ${formatDisplayDate(reviewDateKey)} (${reviewDateKey})`,
    '',
    '=== LEAD REPORT CONVERSATION ===',
    leadBlock,
    '',
    '=== MEETING DISCUSSION CHECKS ===',
    meetingBlock,
    '',
    'Write the 2-line brief now.',
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
  if (att.absent?.length) lines.push(`Absent: ${att.absent.join(', ')}`);
  if (att.halfDay?.length) lines.push(`Half-day: ${att.halfDay.join(', ')}`);
  if (att.excused?.length) lines.push(`Excused: ${att.excused.join(', ')}`);
  if (att.forgot?.length) lines.push(`Forgot/late: ${att.forgot.join(', ')}`);
  if (detail.pendingPairs?.length) {
    lines.push(
      `Pending pairs: ${detail.pendingPairs.map(pairLabel).join(' | ')}`
    );
  }

  lines.push('', 'Chat:');
  const msgs = detail.messages || [];
  if (!msgs.length) {
    lines.push('(no messages)');
  } else {
    for (const m of msgs.slice(-40)) {
      const who =
        m.direction === 'out' || m.senderName === 'Bot'
          ? 'Bot'
          : m.senderName || detail.lead || 'Lead';
      lines.push(`- ${who}: ${clip(m.body, 320)}`);
    }
  }

  return lines.join('\n');
};

const formatMeetingBlock = (prompts = []) => {
  if (!prompts.length) {
    return 'No meeting-discussion prompts for this meeting day.';
  }

  return prompts
    .map((p) => {
      const status = p.status || 'pending';
      const answer =
        status === 'answered'
          ? String(p.response?.answer || '?').toUpperCase()
          : status.toUpperCase();
      const reply = p.response?.body ? ` (reply: ${clip(p.response.body, 80)})` : '';
      return `- ${p.member} · ${pairLabel(p.pair)} · ${answer}${reply}`;
    })
    .join('\n');
};

/**
 * Gather lead chat + meeting checks for a meeting day, then ask the configured
 * OpenRouter model for a 2-line ready template.
 */
export const analyzeMeetingDay = async (meetingDateKeyInput) => {
  const meetingDateKey = meetingDateKeyInput || getKarachiDateKey();
  const reviewDateKey = getPreviousWorkingDay(meetingDateKey);

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

  const [leadDetail, discussions] = await Promise.all([
    getLeadReportDetail(reviewDateKey),
    DiscussionPrompt.find({ meetingDateKey }).sort({ member: 1 }).lean(),
  ]);

  const leadBlock = formatLeadBlock(leadDetail);
  const meetingBlock = formatMeetingBlock(discussions);

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
        }),
      },
    ],
    temperature: 0.2,
  });

  const raw =
    completion?.choices?.[0]?.message?.content ||
    completion?.choices?.[0]?.text ||
    '';
  const brief = String(raw).trim().replace(/^```[\s\S]*?\n|```$/g, '').trim();

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
    sources: {
      lead: leadDetail.lead || null,
      leadStage: leadDetail.session?.stageLabel || leadDetail.session?.stage || null,
      leadMessageCount: (leadDetail.messages || []).length,
      discussions: discussions.map((p) => ({
        member: p.member,
        pair: p.pair,
        status: p.status,
        answer: p.response?.answer || null,
      })),
    },
  };
};

/** Meeting days available for analysis (today + days with discussion prompts). */
export const listAnalyzeDates = async (limit = 40) => {
  const todayKey = getKarachiDateKey();
  const meetingKeys = await DiscussionPrompt.find({})
    .select('meetingDateKey')
    .sort({ meetingDateKey: -1 })
    .limit(limit)
    .lean()
    .then((rows) => rows.map((r) => r.meetingDateKey));

  const items = [...new Set([todayKey, ...meetingKeys])]
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit)
    .map((dateKey) => ({
      dateKey,
      dateLabel: formatDisplayDate(dateKey),
      isToday: dateKey === todayKey,
    }));

  return { todayKey, items };
};
