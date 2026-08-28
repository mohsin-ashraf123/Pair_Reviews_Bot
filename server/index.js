import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import './config/appConfig.js';
import { config } from './config/appConfig.js';
import connectDB from './config/db.js';
import pairRoutes from './routes/pairs.js';
import { startPairScheduler } from './services/schedulerService.js';
import { warmMatrixClient } from './services/matrixService.js';
import { initSocketServer } from './services/socketService.js';
import { seedMemberRooms, joinMemberRooms } from './services/memberRoomService.js';
import {
  joinBossRoom,
  healDeliveredBossReports,
} from './services/bossReportService.js';
import { ensureHolidayCache } from './services/holidayService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, '../client/dist');

const app = express();
const PORT = Number(process.env.PORT) || 5001;
const HOST = '0.0.0.0';

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
  });
});

app.get('/api/ready', (req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  res.status(mongoReady ? 200 : 503).json({
    ready: mongoReady,
    mongo: mongoReady ? 'connected' : 'disconnected',
  });
});

app.use('/api/pairs', pairRoutes);

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
    try {
      startPairScheduler();
    } catch {
      // ignore
    }
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
        await joinMemberRooms().catch((error) =>
          console.error('Member room join failed:', error.message)
        );
        await joinBossRoom().catch((error) =>
          console.error('Boss room join failed:', error.message)
        );
        await warmMatrixClient();
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

  // Kick off DB/Matrix after the port is open so Railway health passes.
  bootBackgroundServices().catch((error) =>
    console.error('Background boot failed:', error)
  );
};

start().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
