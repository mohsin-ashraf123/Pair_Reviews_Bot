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
import { joinBossRoom } from './services/bossReportService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, '../client/dist');

const app = express();
const PORT = Number(process.env.PORT) || 5001;
const HOST = '0.0.0.0';

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Element Pair Review Bot API',
    uptime: process.uptime(),
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

const start = async () => {
  const httpServer = initSocketServer(app);

  httpServer.listen(PORT, HOST, () => {
    console.log(`Server listening on ${HOST}:${PORT}`);
  });

  try {
    await connectDB();
    await seedMemberRooms();

    if (config.runMatrixBot) {
      // Join personal rooms before crypto warm-up so device lists are available.
      await joinMemberRooms().catch((error) =>
        console.error('Member room join failed:', error.message)
      );
      await joinBossRoom().catch((error) =>
        console.error('Boss room join failed:', error.message)
      );
      warmMatrixClient().catch((error) =>
        console.error('Matrix warm failed:', error.message)
      );
    } else {
      console.log(
        'Matrix bot client skipped (ENABLE_CRON_SCHEDULER=false) — Element session sirf Railway pe chalega, local se naya login nahi.'
      );
    }

    startPairScheduler();
  } catch (error) {
    console.error('Startup warning:', error.message);
    console.error('Server is up but DB/Matrix may be unavailable — check Railway Variables.');
  }
};

start().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
