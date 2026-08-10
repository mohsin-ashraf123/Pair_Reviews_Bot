/**
 * One-off: Aug 7 Saad+Hamza was a test "forgot" — Saad was half day leave.
 *
 *   node scripts/fix-aug7-saad-halfday.js
 */
import connectDB from '../config/db.js';
import LeadReportSession from '../models/LeadReportSession.js';
import MissingReviewPrompt from '../models/MissingReviewPrompt.js';
import DailyReview from '../models/DailyReview.js';
import { recomputeAttendanceFromLeadReport } from '../services/leadReportService.js';
import { recomputeAttendanceFromPrompts } from '../services/missingReviewPromptService.js';

const DATE_KEY = '2026-08-07';

const samePair = (a = [], b = []) => {
  if (a.length !== b.length) return false;
  const sa = [...a].sort().join('|');
  const sb = [...b].sort().join('|');
  return sa === sb;
};

const run = async () => {
  await connectDB();

  const session = await LeadReportSession.findOne({ dateKey: DATE_KEY });
  if (session) {
    let changed = false;
    session.pairDecisions = (session.pairDecisions || []).map((d) => {
      const pair = d.pair || [];
      if (!samePair(pair, ['Saad', 'Hamza'])) return d;
      if (d.type === 'member_half_day' && d.halfDayMembers?.includes('Saad')) {
        return d;
      }
      changed = true;
      return {
        ...d.toObject?.() ?? d,
        type: 'member_half_day',
        label: 'Saad was on half day leave',
        absentMembers: [],
        halfDayMembers: ['Saad'],
        forgotReason: undefined,
      };
    });
    if (changed) {
      await session.save();
      console.log('Updated LeadReportSession pair decision → Saad half day');
    } else {
      console.log('LeadReportSession already correct or no Saad+Hamza decision');
    }
    await recomputeAttendanceFromLeadReport(DATE_KEY);
    console.log('Recomputed attendance from lead report');
  } else {
    console.log('No LeadReportSession for', DATE_KEY);
  }

  const prompts = await MissingReviewPrompt.find({
    dateKey: DATE_KEY,
    member: { $in: ['Saad', 'Hamza'] },
  });
  for (const prompt of prompts) {
    if (prompt.status !== 'answered') continue;
    if (prompt.member === 'Saad') {
      prompt.response = {
        ...(prompt.response?.toObject?.() ?? prompt.response ?? {}),
        type: 'half_day',
        label: 'I was on half day leave',
        letter: prompt.response?.letter || 'E',
        absentMembers: [],
        halfDayMembers: ['Saad'],
        body: prompt.response?.body || 'half day (corrected)',
      };
      await prompt.save();
      console.log('Updated MissingReviewPrompt for Saad → half_day');
    }
    if (prompt.member === 'Hamza' && prompt.response?.type === 'forgot') {
      // Partner half day → Hamza shouldn't stay as forgot from the test reply.
      prompt.response = {
        ...(prompt.response?.toObject?.() ?? prompt.response ?? {}),
        type: 'partner_half_day',
        label: 'Saad was on half day leave',
        absentMembers: [],
        halfDayMembers: ['Saad'],
        body: prompt.response?.body || 'partner half day (corrected)',
      };
      await prompt.save();
      console.log('Updated MissingReviewPrompt for Hamza → partner_half_day');
    }
  }
  if (prompts.length) {
    await recomputeAttendanceFromPrompts(DATE_KEY);
    console.log('Recomputed attendance from prompts');
  }

  // Final explicit correction on DailyReview (wins if both systems wrote).
  const review = await DailyReview.findOne({ dateKey: DATE_KEY });
  if (review) {
    review.lateReviewedMembers = (review.lateReviewedMembers || []).filter(
      (n) => n !== 'Saad' && n !== 'Hamza'
    );
    if (!review.halfDayMembers.includes('Saad')) {
      review.halfDayMembers = [...(review.halfDayMembers || []), 'Saad'];
    }
    review.halfDayMembers = review.halfDayMembers.filter((n) => n !== 'Hamza');
    review.absentMembers = (review.absentMembers || []).filter(
      (n) => n !== 'Saad' && n !== 'Hamza'
    );
    if (!review.excusedMembers.includes('Hamza')) {
      review.excusedMembers = [...(review.excusedMembers || []), 'Hamza'];
    }
    review.excusedMembers = review.excusedMembers.filter((n) => n !== 'Saad');
    await review.save();
    console.log('DailyReview corrected:', {
      halfDay: review.halfDayMembers,
      excused: review.excusedMembers,
      forgot: review.lateReviewedMembers,
      absent: review.absentMembers,
    });
  } else {
    console.log('No DailyReview for', DATE_KEY);
  }

  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
