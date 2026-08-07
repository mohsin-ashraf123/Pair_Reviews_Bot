import DailyReview from '../models/DailyReview.js';
import { getAllMembers } from '../config/appConfig.js';
import {
  getMonthSchedule,
  getCurrentMonthParts,
  getKarachiDateKey,
  buildDailyPairsFromDateKey,
} from './pairService.js';

const findMemberPair = (member, pairs = []) => {
  for (const pair of pairs) {
    if (pair.includes(member)) return pair;
  }
  return null;
};

const formatPairLabel = (pair) => pair.join(' + ');

const resolveDayAttendance = (member, dateKey, todayKey, review, scheduledPairs) => {
  const pairs = review?.pairsSentAt ? review.pairs : scheduledPairs;
  const pair = findMemberPair(member, pairs);
  if (!pair) return { status: 'not_assigned' };

  const pairLabel = formatPairLabel(pair);

  if (!review?.pairsSentAt) {
    if (dateKey > todayKey) return { status: 'future', pairLabel };
    return { status: 'no_data', pairLabel };
  }

  if (review.reviewedMembers.includes(member)) {
    return { status: 'present', pairLabel };
  }

  // Confirmed through the member's follow-up reply — review happened, message didn't.
  if (review.lateReviewedMembers?.includes(member)) {
    return { status: 'forgot', pairLabel, note: 'They forgot to send the review' };
  }

  if (review.absentMembers?.includes(member)) {
    return { status: 'absent', pairLabel, confirmed: true, note: 'Confirmed absent in follow-up' };
  }

  if (review.halfDayMembers?.includes(member)) {
    return { status: 'half_day', pairLabel, note: 'Half day leave' };
  }

  if (review.excusedMembers?.includes(member)) {
    return { status: 'excused', pairLabel, note: 'Present — pair partner was absent' };
  }

  if (dateKey > todayKey) {
    return { status: 'future', pairLabel };
  }

  if (dateKey === todayKey) {
    return { status: 'pending', pairLabel };
  }

  return { status: 'absent', pairLabel, confirmed: false };
};

export const getMonthlyPerformance = async (year, month) => {
  const y = Number(year);
  const m = Number(month);
  if (!y || !m || m < 1 || m > 12) {
    throw new Error('Invalid year or month');
  }

  const schedule = getMonthSchedule(y, m);
  const todayKey = getKarachiDateKey();
  const members = getAllMembers();
  const dateKeys = schedule.map((row) => row.dateKey);

  const reviews = await DailyReview.find({ dateKey: { $in: dateKeys } });
  const reviewMap = Object.fromEntries(reviews.map((r) => [r.dateKey, r]));

  const scheduledPairsMap = Object.fromEntries(
    schedule.map((row) => {
      const pairsData = buildDailyPairsFromDateKey(row.dateKey);
      return [row.dateKey, pairsData.allPairs];
    })
  );

  const days = schedule.map((row) => ({
    dateKey: row.dateKey,
    dayName: row.dayName,
    lead: row.lead,
    shortDate: row.dateKey.slice(8),
  }));

  const memberRows = members.map((member) => {
    const cells = {};
    const summary = {
      present: 0,
      forgot: 0,
      absent: 0,
      halfDay: 0,
      excused: 0,
      pending: 0,
      future: 0,
      noData: 0,
    };

    for (const day of days) {
      const review = reviewMap[day.dateKey];
      const cell = resolveDayAttendance(
        member,
        day.dateKey,
        todayKey,
        review,
        scheduledPairsMap[day.dateKey]
      );
      cells[day.dateKey] = cell;

      if (cell.status === 'present') summary.present += 1;
      else if (cell.status === 'forgot') summary.forgot += 1;
      else if (cell.status === 'absent') summary.absent += 1;
      else if (cell.status === 'half_day') summary.halfDay += 1;
      else if (cell.status === 'excused') summary.excused += 1;
      else if (cell.status === 'pending') summary.pending += 1;
      else if (cell.status === 'future') summary.future += 1;
      else if (cell.status === 'no_data') summary.noData += 1;
    }

    // "Forgot" still means the review happened, so it counts as attended.
    // Half day and excused days stay out of the rate entirely.
    const attended = summary.present + summary.forgot;
    summary.tracked = attended + summary.absent;
    summary.rate =
      summary.tracked > 0 ? Math.round((attended / summary.tracked) * 100) : null;

    return { member, cells, summary };
  });

  return {
    year: y,
    month: m,
    todayKey,
    members,
    days,
    rows: memberRows,
  };
};

export const getDefaultMonthlyPerformance = () => {
  const { year, month } = getCurrentMonthParts();
  return getMonthlyPerformance(year, month);
};
