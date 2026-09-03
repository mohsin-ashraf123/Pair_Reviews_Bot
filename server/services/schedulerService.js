import cron from 'node-cron';
import { config } from '../config/appConfig.js';
import {
  sendDailyPairs,
  sendMissedReviewNotice,
  sendMissingReviewFollowUps,
  sendDiscussionFollowUps,
} from './pairBotService.js';
import {
  prepareBossDailyReport,
  sendBossDailyReport,
} from './bossReportService.js';
import { postPairReviewThreadDigest } from './pairThreadService.js';
import {
  processDateReviews,
  generateMonthlyReport,
  sendMonthlyReport,
} from './rankingService.js';
import { getNextDailySendTarget, getAllScheduleCountdowns, getKarachiDateKey } from './pairService.js';
import { emitCountdownTick, emitSchedulesTick } from './socketService.js';

let pairsTask = null;
let missedReviewTask = null;
let promptTask = null;
let discussionTask = null;
let bossPrepareTask = null;
let bossSendTask = null;
let pairThreadTask = null;
let rankingProcessTask = null;
let countdownInterval = null;

const cronInFlight = {
  pairs: false,
  missed: false,
  prompts: false,
  discussion: false,
  bossPrepare: false,
  bossSend: false,
  pairThread: false,
  rankingProcess: false,
  monthlyGenerate: false,
  monthlySend: false,
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



  if (config.enablePairThread) {
    if (cron.validate(config.pairThreadCronSchedule) && !pairThreadTask) {
      pairThreadTask = cron.schedule(
        config.pairThreadCronSchedule,
        () =>
          runCronJob('pairThread', async () => {
            try {
              const result = await postPairReviewThreadDigest('cron');
              if (result.skipped) {
                console.log(`[cron] Pair review thread skipped: ${result.reason}`);
              } else {
                console.log(
                  `[cron] Pair review thread posted for ${result.reviewDateKey} ` +
                    `(${result.postedCount} replies)`
                );
              }
            } catch (error) {
              console.error('[cron] Failed to post pair review thread:', error.message);
            }
          }),
        { timezone: config.timezone }
      );
      console.log(
        `Pair review thread scheduler active: "${config.pairThreadCronSchedule}" (${config.timezone})`
      );
    }
  } else {
    console.log('[cron] Pair review thread disabled (ENABLE_PAIR_THREAD≠true)');
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

  if (cron.validate(config.bossReportPrepareCronSchedule) && !bossPrepareTask) {
    bossPrepareTask = cron.schedule(
      config.bossReportPrepareCronSchedule,
      () =>
        runCronJob('bossPrepare', async () => {
          try {
            const result = await prepareBossDailyReport('cron');
            if (result.skipped) {
              console.log(`[cron] Boss report prepare skipped: ${result.reason}`);
            } else {
              console.log(
                `[cron] Boss report prepared for ${result.reviewDateKey}`
              );
            }
          } catch (error) {
            console.error('[cron] Boss report prepare failed:', error.message);
          }
        }),
      { timezone: config.timezone }
    );
    console.log(
      `Boss report prepare scheduler active: "${config.bossReportPrepareCronSchedule}" (${config.timezone})`
    );
  }

  if (cron.validate(config.bossReportSendCronSchedule) && !bossSendTask) {
    bossSendTask = cron.schedule(
      config.bossReportSendCronSchedule,
      () =>
        runCronJob('bossSend', async () => {
          try {
            const result = await sendBossDailyReport('cron');
            if (result.skipped) {
              console.log(`[cron] Boss report send skipped: ${result.reason}`);
            } else {
              console.log(
                `[cron] Boss report sent for ${result.reviewDateKey} → ${result.eventId}`
              );
            }
          } catch (error) {
            console.error('[cron] Boss report send failed:', error.message);
          }
        }),
      { timezone: config.timezone }
    );
    console.log(
      `Boss report send scheduler active: "${config.bossReportSendCronSchedule}" (${config.timezone})`
    );
  }

  // --- Ranking: daily review processing + monthly report ---
  if (cron.validate(config.rankingProcessCronSchedule) && !rankingProcessTask) {
    rankingProcessTask = cron.schedule(
      config.rankingProcessCronSchedule,
      () =>
        runCronJob('rankingProcess', async () => {
          try {
            const dateKey = getKarachiDateKey();
            const result = await processDateReviews(dateKey);
            if (result.skipped) {
              console.log(`[cron] Ranking process skipped: ${result.skipped}`);
            } else {
              console.log(
                `[cron] Ranking: processed ${result.processed} member insights for ${dateKey}`
              );
            }
          } catch (error) {
            console.error('[cron] Ranking process failed:', error.message);
          }
        }),
      { timezone: config.timezone }
    );
    console.log(
      `Ranking process scheduler active: "${config.rankingProcessCronSchedule}" (${config.timezone})`
    );
  }

  // --- Monthly Ranking Report Crons (1st of the month) ---
  // Generate at 10:00 AM on the 1st
  cron.schedule(
    '0 10 1 * *',
    () => runCronJob('monthlyGenerate', async () => {
      console.log('[cron] 1st of month 10:00 AM — generating scheduled monthly ranking report');
      try {
        await generateMonthlyReport();
      } catch (err) {
        console.error('[cron] Monthly ranking generate failed:', err.message);
      }
    }),
    { timezone: config.timezone }
  );

  // Send at 06:00 PM on the 1st
  cron.schedule(
    '0 18 1 * *',
    () => runCronJob('monthlySend', async () => {
      console.log('[cron] 1st of month 06:00 PM — sending scheduled monthly ranking report');
      try {
        await sendMonthlyReport();
      } catch (err) {
        console.error('[cron] Monthly ranking send failed:', err.message);
      }
    }),
    { timezone: config.timezone }
  );

  return pairsTask;
};
