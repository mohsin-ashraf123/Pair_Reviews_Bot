import dns from 'node:dns';
import express from 'express';

if (!process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_PROJECT_ID) {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import './config/appConfig.js';
import { config } from './config/appConfig.js';
import connectDB from './config/db.js';
import { loginDashboard, requireDashboardAuth } from './services/dashboardAuth.js';
import { initSocketServer } from './services/socketService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, '../client/dist');

const app = express();
const PORT = Number(process.env.PORT) || 5001;
const HOST = '0.0.0.0';
let pairRoutesLoadError = null;

app.use(cors());
app.use(express.json());

/** Liveness — must stay fast even while Matrix crypto is warming. */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Element Pair Review Bot API',
    uptime: process.uptime(),
    commit:
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.GITHUB_SHA ||
      null,
    features: {
      pairThread: Boolean(config.enablePairThread),
      reviewReminder: Boolean(config.enableReviewReminder),
      cronScheduler: Boolean(config.enableCronScheduler),
      matrixBot: Boolean(config.runMatrixBot),
    },
    pairApi: pairRoutesLoadError
      ? { ready: false, error: pairRoutesLoadError }
      : { ready: true },
  });
});

app.get('/api/ready', (req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  res.status(mongoReady ? 200 : 503).json({
    ready: mongoReady,
    mongo: mongoReady ? 'connected' : 'disconnected',
  });
});

app.post('/api/auth/login', loginDashboard);

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (req, res, next) => {
    if (req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  console.log('Serving dashboard from client/dist');
}

/** Never let a background failure take down the HTTP server (→ Railway 502). */
process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaughtException:', error?.stack || error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);

const bootBackgroundServices = async () => {
  try {
    await withTimeout(connectDB(), 30_000, 'MongoDB connect');
    const { ensureHolidayCache } = await import('./services/holidayService.js');
    const { seedMemberRooms } = await import('./services/memberRoomService.js');
    const { startPairScheduler } = await import('./services/schedulerService.js');
    const { healDeliveredBossReports } = await import('./services/bossReportService.js');
    await ensureHolidayCache().catch((error) =>
      console.warn(`[holiday] Cache load failed: ${error.message}`)
    );
    await seedMemberRooms().catch((error) =>
      console.warn(`[member-rooms] Seed failed: ${error.message}`)
    );

    startPairScheduler();

    await healDeliveredBossReports()
      .then((r) => {
        if (r?.modifiedCount) {
          console.log(
            `[boss] Healed ${r.modifiedCount} delivered report(s) stuck as failed`
          );
        }
      })
      .catch((error) => console.warn(`[boss] Heal skipped: ${error.message}`));
  } catch (error) {
    console.error('Background boot warning:', error.message);
    console.error(
      'HTTP server is up but DB/scheduler may be unavailable — check Railway Variables.'
    );
    // Still start countdowns so the dashboard isn't fully dead.
  }

  if (!config.runMatrixBot) {
    console.log(
      'Matrix bot client skipped — set MATRIX_RUN_BOT=true on Railway if Element should run here.'
    );
    return;
  }

  // Defer Matrix entirely so crypto/sync cannot stall health checks.
  setTimeout(() => {
    (async () => {
      try {
        const { joinMemberRooms } = await import('./services/memberRoomService.js');
        const { joinBossRoom } = await import('./services/bossReportService.js');
        const { warmMatrixClient } = await import('./services/matrixService.js');
        await joinMemberRooms().catch((error) =>
          console.error('Member room join failed:', error.message)
        );
        await joinBossRoom().catch((error) =>
          console.error('Boss room join failed:', error.message)
        );
        await warmMatrixClient();
        const { isPastCronTimeToday } = await import('./services/pairService.js');
        if (isPastCronTimeToday(config.missingReviewPromptCronSchedule, 10, 50)) {
          const { sendMissingReviewFollowUps } = await import('./services/pairBotService.js');
          const leadReport = await sendMissingReviewFollowUps('cron');
          if (leadReport.skipped) {
            console.log(`[lead-report] Catch-up skipped: ${leadReport.reason}`);
          } else {
            console.log(
              `[lead-report] Catch-up started for ${leadReport.forDate} (lead ${leadReport.lead})`
            );
          }
        }
      } catch (error) {
        console.error('Matrix warm failed:', error.message);
      }
    })();
  }, 1500);
};

const start = async () => {
  const httpServer = initSocketServer(app);

  await new Promise((resolve) => {
    httpServer.listen(PORT, HOST, () => {
      console.log(`Server listening on ${HOST}:${PORT}`);
      resolve();
    });
  });

  // Route modules pull in the Matrix/E2EE SDK. Loading them only after the
  // listener is live keeps the dashboard and health check available if a new
  // hosting provider is missing an optional crypto runtime dependency.
  import('./routes/pairs.js')
    .then(({ default: pairRoutes }) => app.use('/api/pairs', requireDashboardAuth, pairRoutes))
    .catch((error) => {
      pairRoutesLoadError = error?.message || String(error);
      console.error('[routes] Pair API unavailable:', error?.stack || error);
    });

  // Kick off DB/Matrix after the port is open so Railway health passes.
  bootBackgroundServices().catch((error) =>
    console.error('Background boot failed:', error)
  );
};

start().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
