import cron from 'node-cron';
import { config } from '../config/appConfig.js';
import {
  sendDailyPairs,
  sendReviewReminder,
  sendMissedReviewNotice,
  sendMissingReviewFollowUps,
  sendDiscussionFollowUps,
} from './pairBotService.js';
import { getNextDailySendTarget, getAllScheduleCountdowns } from './pairService.js';
import { emitCountdownTick, emitSchedulesTick } from './socketService.js';

let pairsTask = null;
let reminderTask = null;
let missedReviewTask = null;
let promptTask = null;
let discussionTask = null;
let countdownInterval = null;

const cronInFlight = {
  pairs: false,
  reminder: false,
  missed: false,
  prompts: false,
  discussion: false,
};

const runCronJob = async (key, fn) => {
  if (cronInFlight[key]) {
    console.log(`[cron] ${key} job already running — skipping duplicate tick`);
    return;
  }

  cronInFlight[key] = true;
  try {
    await fn();
  } finally {
    cronInFlight[key] = false;
  }
};

const broadcastCountdown = () => {
  try {
    emitCountdownTick(getNextDailySendTarget());
    emitSchedulesTick(getAllScheduleCountdowns());
  } catch {
    // ignore
  }
};

export const startPairScheduler = () => {
  // Dashboard countdown must tick even when cron jobs are disabled locally.
  if (!countdownInterval) {
    broadcastCountdown();
    countdownInterval = setInterval(broadcastCountdown, 1000);
  }

  if (!config.enableCronScheduler) {
    console.log('[cron] Scheduler disabled — set ENABLE_CRON_SCHEDULER=true to run crons on this instance');
    return null;
  }

  console.log(
    `[cron] Morning order locked: prompts=${config.missingReviewPromptCronSchedule} → ` +
      `missed=${config.missedReviewCronSchedule} → pairs=${config.cronSchedule} (${config.timezone})`
  );

  if (!cron.validate(config.cronSchedule)) {
    console.error(`Invalid CRON_SCHEDULE: ${config.cronSchedule}`);
    return null;
  }

  if (!pairsTask) {
    pairsTask = cron.schedule(
      config.cronSchedule,
      () =>
        runCronJob('pairs', async () => {
          try {
            const result = await sendDailyPairs('cron');
            if (result.skipped) {
              console.log(`[cron] Pairs skipped: ${result.reason}`);
            } else {
              console.log(`[cron] Daily pairs sent for ${result.pairsData.dateKey}`);
            }
          } catch (error) {
            console.error('[cron] Failed to send daily pairs:', error.message);
          }
        }),
      { timezone: config.timezone }
    );
    console.log(`Pair scheduler active: "${config.cronSchedule}" (${config.timezone})`);
  }

  if (cron.validate(config.reminderCronSchedule) && !reminderTask) {
    reminderTask = cron.schedule(
      config.reminderCronSchedule,
      () =>
        runCronJob('reminder', async () => {
          try {
            const result = await sendReviewReminder('cron');
            if (result.skipped) {
              console.log(`[cron] Reminder skipped: ${result.reason}`);
            } else {
              console.log(`[cron] Review reminder sent (${result.pendingPairs.length} pending pairs)`);
            }
          } catch (error) {
            console.error('[cron] Failed to send review reminder:', error.message);
          }
        }),
      { timezone: config.timezone }
    );
    console.log(
      `Reminder scheduler active: "${config.reminderCronSchedule}" (${config.timezone})`
    );
  }

  if (cron.validate(config.missingReviewPromptCronSchedule) && !promptTask) {
    promptTask = cron.schedule(
      config.missingReviewPromptCronSchedule,
      () =>
        runCronJob('prompts', async () => {
          try {
            const result = await sendMissingReviewFollowUps('cron');
            if (result.skipped) {
              console.log(`[cron] Missing review follow-ups skipped: ${result.reason}`);
            } else {
              console.log(
                `[cron] Missing review follow-ups sent for ${result.forDate} (${result.prompts.length} members)`
              );
            }
          } catch (error) {
            console.error('[cron] Failed to send missing review follow-ups:', error.message);
          }
        }),
      { timezone: config.timezone }
    );
    console.log(
      `Missing review follow-up scheduler active: "${config.missingReviewPromptCronSchedule}" (${config.timezone})`
    );
  }

  if (cron.validate(config.missedReviewCronSchedule) && !missedReviewTask) {
    missedReviewTask = cron.schedule(
      config.missedReviewCronSchedule,
      () =>
        runCronJob('missed', async () => {
          try {
            const result = await sendMissedReviewNotice('cron');
            if (result.skipped) {
              console.log(`[cron] Missed review notice skipped: ${result.reason}`);
            } else {
              console.log(
                `[cron] Missed review notice sent for ${result.forDate} (${result.pendingPairs.length} pairs)`
              );
            }
          } catch (error) {
            console.error('[cron] Failed to send missed review notice:', error.message);
          }
        }),
      { timezone: config.timezone }
    );
    console.log(
      `Missed review scheduler active: "${config.missedReviewCronSchedule}" (${config.timezone})`
    );
  }

  if (cron.validate(config.discussionCronSchedule) && !discussionTask) {
    discussionTask = cron.schedule(
      config.discussionCronSchedule,
      () =>
        runCronJob('discussion', async () => {
          try {
            const result = await sendDiscussionFollowUps('cron');
            if (result.skipped) {
              console.log(`[cron] Discussion prompts skipped: ${result.reason}`);
            } else {
              console.log(
                `[cron] Discussion prompts sent for ${result.reviewDateKey} ` +
                  `(${(result.prompts || []).length} pairs)`
              );
            }
          } catch (error) {
            console.error('[cron] Failed to send discussion prompts:', error.message);
          }
        }),
      { timezone: config.timezone }
    );
    console.log(
      `Discussion prompt scheduler active: "${config.discussionCronSchedule}" (${config.timezone})`
    );
  }

  return pairsTask;
};
