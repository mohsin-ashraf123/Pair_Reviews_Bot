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

  if (dateKey > todayKey) {
    return { status: 'future', pairLabel };
  }

  if (dateKey === todayKey) {
    return { status: 'pending', pairLabel };
  }

  return { status: 'absent', pairLabel };
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
    const summary = { present: 0, absent: 0, pending: 0, future: 0, noData: 0 };

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
      else if (cell.status === 'absent') summary.absent += 1;
      else if (cell.status === 'pending') summary.pending += 1;
      else if (cell.status === 'future') summary.future += 1;
      else if (cell.status === 'no_data') summary.noData += 1;
    }

    summary.tracked = summary.present + summary.absent;
    summary.rate =
      summary.tracked > 0
        ? Math.round((summary.present / summary.tracked) * 100)
        : null;

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
