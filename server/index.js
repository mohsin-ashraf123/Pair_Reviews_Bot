import express from 'express';
import cors from 'cors';
import './config/appConfig.js';
import connectDB from './config/db.js';
import pairRoutes from './routes/pairs.js';
import { startPairScheduler } from './services/schedulerService.js';
import { warmMatrixClient } from './services/matrixService.js';
import { initSocketServer } from './services/socketService.js';

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Element Pair Review Bot API' });
});

app.use('/api/pairs', pairRoutes);

const start = async () => {
  await connectDB();
  startPairScheduler();

  const httpServer = initSocketServer(app);
  httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  warmMatrixClient();
};

start();
