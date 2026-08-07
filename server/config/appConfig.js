import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load server/.env locally; on Railway use dashboard variables
dotenv.config({ path: path.join(__dirname, '../.env') });

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

/** Personal bot room per member — Name=!roomId:server (MEMBER_ROOM_MAP). */
const DEFAULT_MEMBER_ROOMS = {
  Mohsin: '!WurnHTCGvklgIXuoRq:matrix.org',
  Saad: '!llHmrMkvUrEZWJXEVK:matrix.org',
  Farhan: '!QgLvNmXbwlTulXkzTp:matrix.org',
  Faz: '!VyPEqTnOmzubpRdszj:matrix.org',
  Uzair: '!DecfVzwvjwetooIUzx:matrix.org',
  Hamza: '!yhevARKAPuWHEINAXk:matrix.org',
  Habiba: '!ktsBYAqBsYdAjCXSnG:matrix.org',
  Adil: '!YShmWOjeFfDqBgaZjj:matrix.org',
  Aqeel: '!UBUzfzQAJEyAtUuFPz:matrix.org',
};

const parseMemberRoomMap = (value) => {
  if (!value?.trim()) return { ...DEFAULT_MEMBER_ROOMS };
  const map = {};
  for (const entry of value.split(',')) {
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    const name = entry.slice(0, eq).trim();
    const roomId = entry.slice(eq + 1).trim();
    if (name && roomId.startsWith('!')) map[name] = roomId;
  }
  return Object.keys(map).length ? map : { ...DEFAULT_MEMBER_ROOMS };
};

export const config = {
  developers: parseList(process.env.DEVELOPERS, [
    'Uzair', 'Mohsin', 'Saad', 'Farhan', 'Faz', 'Hamza',
  ]),
  qaTeam: parseList(process.env.QA_TEAM, ['Habiba', 'Aqeel', 'Adil']),
  timezone: process.env.CRON_TIMEZONE || 'Asia/Karachi',
  enableCronScheduler: process.env.ENABLE_CRON_SCHEDULER !== 'false',
  cronSchedule: process.env.CRON_SCHEDULE || '30 11 * * 1-5',
  reminderCronSchedule: process.env.REMINDER_CRON_SCHEDULE || '50 18 * * 1-5',
  missedReviewCronSchedule: process.env.MISSED_REVIEW_CRON_SCHEDULE || '20 11 * * 1-5',
  missingReviewPromptCronSchedule:
    process.env.MISSING_REVIEW_PROMPT_CRON_SCHEDULE || '50 10 * * 1-5',
  memberMatrixMap: parseMemberMatrixMap(process.env.MEMBER_MATRIX_MAP),
  memberRoomMap: parseMemberRoomMap(process.env.MEMBER_ROOM_MAP),
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
