import dotenv from 'dotenv';

// Load env before any other module reads process.env
dotenv.config();

const parseList = (value, fallback = []) => {
  if (!value?.trim()) return fallback;
  return value.split(',').map((name) => name.trim()).filter(Boolean);
};

/** Map team member display name → Matrix user id (MEMBER_MATRIX_MAP). */
const parseMemberMatrixMap = (value) => {
  const map = {};
  if (!value?.trim()) return map;
  for (const entry of value.split(',')) {
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    const name = entry.slice(0, eq).trim();
    const userId = entry.slice(eq + 1).trim();
    if (name && userId.startsWith('@')) map[name] = userId;
  }
  return map;
};

export const config = {
  developers: parseList(process.env.DEVELOPERS, [
    'Uzair', 'Mohsin', 'Saad', 'Farhan', 'Faz', 'Hamza',
  ]),
  qaTeam: parseList(process.env.QA_TEAM, ['Habiba', 'Aqeel', 'Adil']),
  timezone: process.env.CRON_TIMEZONE || 'Asia/Karachi',
  cronSchedule: process.env.CRON_SCHEDULE || '0 11 * * 1-5',
  reminderCronSchedule: process.env.REMINDER_CRON_SCHEDULE || '50 18 * * 1-5',
  missedReviewCronSchedule: process.env.MISSED_REVIEW_CRON_SCHEDULE || '50 10 * * 1-5',
  memberMatrixMap: parseMemberMatrixMap(process.env.MEMBER_MATRIX_MAP),
  matrix: {
    homeserver: (process.env.MATRIX_HOMESERVER_URL || '').trim().replace(/\/$/, ''),
    accessToken: (process.env.MATRIX_ACCESS_TOKEN || '').trim(),
    roomId: (process.env.MATRIX_ROOM_ID || '').trim(),
    // Dedicated bot device (required for E2EE — do NOT reuse Element Web token)
    user: (process.env.MATRIX_USER || '').trim(),
    password: (process.env.MATRIX_PASSWORD || '').trim(),
  },
};

export const isMatrixConfigured = () =>
  Boolean(
    config.matrix.homeserver &&
      config.matrix.roomId &&
      (config.matrix.accessToken || (config.matrix.user && config.matrix.password))
  );

export const getAllMembers = () => [...config.developers, ...config.qaTeam];
