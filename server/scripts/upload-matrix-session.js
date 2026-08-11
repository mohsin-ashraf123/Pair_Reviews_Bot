/**
 * One-shot: push local server/data/matrix session+crypto into MongoDB so Railway
 * reuses the same Element device after redeploys (no new "It was me" logins).
 *
 * Usage: node scripts/upload-matrix-session.js
 */
import '../config/appConfig.js';
import connectDB from '../config/db.js';
import {
  persistMatrixDeviceState,
  readSessionFile,
} from '../services/matrixSessionStore.js';

const run = async () => {
  await connectDB();
  const session = readSessionFile();
  if (!session?.accessToken || !session?.deviceId) {
    throw new Error('No local session at data/matrix/session.json');
  }

  const ok = await persistMatrixDeviceState(session);
  if (!ok) throw new Error('Failed to persist Matrix device state');
  console.log(`Uploaded device ${session.deviceId} for ${session.userId}`);
  process.exit(0);
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
