import { config } from '../config/appConfig.js';

/** Daily send time comes from CRON_SCHEDULE so previews stay in sync with cron. */
const parseCronTime = (expression, fallbackHour, fallbackMinute) => {
  const [minute, hour] = (expression || '').trim().split(/\s+/);
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return { hour: fallbackHour, minute: fallbackMinute };
  }
  return { hour: h, minute: m };
};

const { hour: SEND_HOUR, minute: SEND_MINUTE } = parseCronTime(config.cronSchedule, 11, 30);

/** "11:30 AM" style label for a cron expression. */
export const cronTimeLabel = (expression, fallbackHour = 11, fallbackMinute = 0) => {
  const { hour, minute } = parseCronTime(expression, fallbackHour, fallbackMinute);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
};

export const dailySendTimeLabel = () => cronTimeLabel(config.cronSchedule, 11, 30);

/** True once today's local clock has passed the time in a cron expression. */
export const isPastCronTimeToday = (
  expression,
  fallbackHour,
  fallbackMinute,
  date = new Date()
) => {
  const target = parseCronTime(expression, fallbackHour, fallbackMinute);
  const now = getKarachiTimeParts(date);
  return (
    now.hour > target.hour ||
    (now.hour === target.hour && now.minute >= target.minute)
  );
};

export const getKarachiDateKey = (date = new Date()) => {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
};

export const getKarachiTimeParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
};

/** True once daily send window has passed (11:00 AM local). */
export const isPastDailySendTime = (date = new Date()) => {
  const { hour, minute } = getKarachiTimeParts(date);
  return hour > SEND_HOUR || (hour === SEND_HOUR && minute >= SEND_MINUTE);
};

export const addCalendarDays = (dateKey, days) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** Advance dateKey by N working days (skips Sat/Sun). */
export const addWorkingDays = (dateKey, days) => {
  let current = dateKey;
  let remaining = days;
  while (remaining > 0) {
    current = addCalendarDays(current, 1);
    if (!isWeekend(current)) remaining--;
  }
  return current;
};

/** Previous working day before dateKey. */
export const getPreviousWorkingDay = (dateKey) => {
  let current = dateKey;
  do {
    current = addCalendarDays(current, -1);
  } while (isWeekend(current));
  return current;
};

/**
 * The day the next missing-review follow-up run will chase. Before today's
 * run it is still the previous working day; once that run has passed, the
 * next one covers today.
 */
export const getFollowUpTargetDateKey = (date = new Date()) => {
  const todayKey = getKarachiDateKey(date);
  const runDone =
    !isWeekend(todayKey) &&
    isPastCronTimeToday(config.missingReviewPromptCronSchedule, 10, 50, date);

  return runDone ? todayKey : getPreviousWorkingDay(todayKey);
};

export const formatDisplayDate = (dateKey) => {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
};

/** Get next working day from dateKey (if dateKey is weekend, jump to Monday). */
export const nextWorkingDay = (dateKey) => {
  let current = dateKey;
  while (isWeekend(current)) {
    current = addCalendarDays(current, 1);
  }
  return current;
};

/** Returns day-of-week (0=Sun … 6=Sat) for a dateKey in YYYY-MM-DD format. */
export const getDayOfWeek = (dateKey) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

export const isWeekend = (dateKey) => {
  const dow = getDayOfWeek(dateKey);
  return dow === 0 || dow === 6;
};

/**
 * Working-day index: counts only Mon-Fri since epoch.
 * Ensures pair rotation doesn't skip over weekends.
 */
export const getDayIndexFromDateKey = (dateKey) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const calendarDay = Math.floor(utc / (24 * 60 * 60 * 1000));
  const fullWeeks = Math.floor(calendarDay / 7);
  const remainder = calendarDay % 7;
  // epoch (1970-01-01) was a Thursday (dow=4)
  // weekday count per full week = 5
  let workdays = fullWeeks * 5;
  for (let i = 0; i < remainder; i++) {
    const dow = (4 + fullWeeks * 7 + i) % 7; // 4=Thursday for epoch
    if (dow !== 0 && dow !== 6) workdays++;
  }
  return workdays;
};

export const getDayIndex = (date = new Date()) =>
  getDayIndexFromDateKey(getKarachiDateKey(date));

const getAllMembersFromConfig = () => [...config.developers, ...config.qaTeam];

export const getDeveloperPairs = (dayIndex, developers = config.developers) => {
  const list = [...developers];
  const n = list.length;

  if (n < 2) return [];
  if (n % 2 !== 0) {
    throw new Error('Developers count must be even for pair rotation');
  }

  const rotations = dayIndex % (n - 1);
  const fixed = list[0];
  let rest = list.slice(1);

  for (let i = 0; i < rotations; i += 1) {
    rest.push(rest.shift());
  }

  const ordered = [fixed, ...rest];
  const pairs = [];

  for (let i = 0; i < n / 2; i += 1) {
    pairs.push([ordered[i], ordered[n - 1 - i]]);
  }

  return pairs;
};

export const getLead = (dayIndex, members = getAllMembersFromConfig()) => {
  if (members.length === 0) return '';
  return members[dayIndex % members.length];
};

export const buildDailyPairsFromDateKey = (dateKey) => {
  const dayIndex = getDayIndexFromDateKey(dateKey);
  const devPairs = getDeveloperPairs(dayIndex);
  const qaPair = [...config.qaTeam];
  const lead = getLead(dayIndex);

  return {
    dateKey,
    dayIndex,
    lead,
    developerPairs: devPairs,
    qaPair,
    allPairs: [...devPairs, qaPair],
  };
};

export const buildDailyPairs = (date = new Date()) =>
  buildDailyPairsFromDateKey(getKarachiDateKey(date));

/**
 * Preview for the next message that will go out:
 * - Weekday before send time → today's pairs
 * - Weekday after send time → next working day's pairs
 * - Weekend → Monday's pairs
 */
export const getActivePreviewTarget = (date = new Date()) => {
  const todayKey = getKarachiDateKey(date);
  const afterSend = isPastDailySendTime(date);
  const timeLabel = dailySendTimeLabel();

  if (isWeekend(todayKey)) {
    const mondayKey = nextWorkingDay(todayKey);
    return {
      previewDateKey: mondayKey,
      previewFor: 'monday',
      label: `Next message (going out Monday ${mondayKey} at ${timeLabel})`,
    };
  }

  if (!afterSend) {
    return {
      previewDateKey: todayKey,
      previewFor: 'today',
      label: `Next message (going out today at ${timeLabel})`,
    };
  }

  const nextKey = addWorkingDays(todayKey, 1);
  const isFriday = getDayOfWeek(todayKey) === 5;
  return {
    previewDateKey: nextKey,
    previewFor: isFriday ? 'monday' : 'tomorrow',
    label: isFriday
      ? `Next message (going out Monday ${nextKey} at ${timeLabel})`
      : `Next message (going out tomorrow at ${timeLabel})`,
  };
};

export const formatPairLine = (pair) => pair.join(' + ');

export const formatDailyMessage = (pairsData) => {
  const lines = pairsData.allPairs.map(formatPairLine);
  return [
    'Pairs Today',
    '',
    ...lines,
    '',
    `${pairsData.lead} will make sure all above today`,
  ].join('\n');
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** All weekday pairs for a calendar month (Sat/Sun excluded). */
export const getMonthSchedule = (year, month) => {
  const daysInMonth = new Date(year, month, 0).getDate();
  const schedule = [];

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (isWeekend(dateKey)) continue;

    const pairsData = buildDailyPairsFromDateKey(dateKey);
    schedule.push({
      dateKey,
      dayName: DAY_NAMES[getDayOfWeek(dateKey)],
      lead: pairsData.lead,
      developerPairs: pairsData.developerPairs,
      qaPair: pairsData.qaPair,
      pairs: pairsData.allPairs.map(formatPairLine),
    });
  }

  return schedule;
};

export const getCurrentMonthParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
  };
};

/** Next weekday occurrence of a cron HH:MM expression (Asia/Karachi). */
export const getNextCronTarget = (
  expression,
  fallbackHour,
  fallbackMinute,
  date = new Date()
) => {
  const { hour, minute } = parseCronTime(expression, fallbackHour, fallbackMinute);
  const todayKey = getKarachiDateKey(date);
  let candidateKey = todayKey;

  if (isWeekend(todayKey) || isPastCronTimeToday(expression, fallbackHour, fallbackMinute, date)) {
    candidateKey = isWeekend(todayKey) ? nextWorkingDay(todayKey) : addWorkingDays(todayKey, 1);
  }

  const targetMs = karachiWallTimeToUtcMs(candidateKey, hour, minute);
  const remainingMs = Math.max(0, targetMs - Date.now());
  const labelFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return {
    nextSendAt: new Date(targetMs).toISOString(),
    nextSendDateKey: candidateKey,
    remainingMs,
    remainingSeconds: Math.floor(remainingMs / 1000),
    timeLabel: cronTimeLabel(expression, fallbackHour, fallbackMinute),
    nextLabel: labelFmt.format(new Date(targetMs)),
    timezone: config.timezone,
  };
};

/** Countdown chips for every automated message the bot sends. */
export const getAllScheduleCountdowns = (date = new Date()) => {
  const jobs = [
    {
      id: 'missing_review_prompts',
      title: 'Personal follow-ups',
      destination: 'Each member’s personal room',
      destinationKind: 'personal',
      cron: config.missingReviewPromptCronSchedule,
      fallbackHour: 10,
      fallbackMinute: 50,
    },
    {
      id: 'missed_review',
      title: 'Missed review notice',
      destination: 'Main Pair Reviews room',
      destinationKind: 'main',
      cron: config.missedReviewCronSchedule,
      fallbackHour: 11,
      fallbackMinute: 20,
    },
    {
      id: 'daily_pairs',
      title: 'Today’s pairs',
      destination: 'Main Pair Reviews room',
      destinationKind: 'main',
      cron: config.cronSchedule,
      fallbackHour: 11,
      fallbackMinute: 30,
    },
    {
      id: 'review_reminder',
      title: 'Review reminder',
      destination: 'Main Pair Reviews room',
      destinationKind: 'main',
      cron: config.reminderCronSchedule,
      fallbackHour: 18,
      fallbackMinute: 50,
    },
  ];

  return jobs.map((job) => {
    const target = getNextCronTarget(
      job.cron,
      job.fallbackHour,
      job.fallbackMinute,
      date
    );
    return {
      ...job,
      ...target,
    };
  });
};

/** Next weekday daily-pairs send target (Asia/Karachi). */
export const getNextDailySendTarget = (date = new Date()) => {
  const target = getNextCronTarget(config.cronSchedule, 11, 30, date);
  return {
    nextSendAt: target.nextSendAt,
    nextSendDateKey: target.nextSendDateKey,
    remainingMs: target.remainingMs,
    remainingSeconds: target.remainingSeconds,
    label: `Next pairs message · ${target.nextLabel}`,
    timezone: target.timezone,
  };
};

/** Convert a calendar date + wall-clock time in config.timezone to UTC epoch ms. */
function karachiWallTimeToUtcMs(dateKey, hour, minute) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, hour, minute, 0);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  for (let offsetMin = -12 * 60; offsetMin <= 14 * 60; offsetMin += 1) {
    const tryMs = utcGuess + offsetMin * 60 * 1000;
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(tryMs)).map((p) => [p.type, p.value])
    );
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    if (
      key === dateKey &&
      Number(parts.hour) === hour &&
      Number(parts.minute) === minute
    ) {
      return tryMs;
    }
  }

  return utcGuess;
}
