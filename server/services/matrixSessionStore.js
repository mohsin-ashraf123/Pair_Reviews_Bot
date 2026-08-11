import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import MatrixDeviceState from '../models/MatrixDeviceState.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const matrixDataDir = path.join(__dirname, '..', 'data', 'matrix');
export const sessionPath = path.join(matrixDataDir, 'session.json');

const STORE_KEY = 'primary';

const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
};

const mongoReady = () => mongoose.connection.readyState === 1;

const walkFiles = (rootDir, base = rootDir) => {
  const out = {};
  if (!fs.existsSync(rootDir)) return out;

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const abs = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, walkFiles(abs, base));
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(base, abs).split(path.sep).join('/');
    out[rel] = fs.readFileSync(abs).toString('base64');
  }
  return out;
};

const writeFiles = (files) => {
  for (const [rel, b64] of Object.entries(files || {})) {
    if (!rel || rel.includes('..')) continue;
    const abs = path.join(matrixDataDir, ...rel.split('/'));
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
  }
};

/** Pack session + active device storage/crypto into a gzip buffer. */
export const buildDeviceArchive = (session) => {
  if (!session?.deviceId || !session?.accessToken) return null;

  const deviceId = session.deviceId;
  const files = {
    'session.json': Buffer.from(JSON.stringify(session, null, 2)).toString('base64'),
  };

  const storageName = `bot-storage-${deviceId}.json`;
  const storagePath = path.join(matrixDataDir, storageName);
  if (fs.existsSync(storagePath)) {
    files[storageName] = fs.readFileSync(storagePath).toString('base64');
  }

  const cryptoDir = path.join(matrixDataDir, `crypto-${deviceId}`);
  Object.assign(files, walkFiles(cryptoDir, matrixDataDir));

  const payload = Buffer.from(JSON.stringify({ version: 1, session, files }));
  return zlib.gzipSync(payload);
};

export const persistMatrixDeviceState = async (session) => {
  if (!mongoReady() || !session?.deviceId) return false;

  try {
    const archive = buildDeviceArchive(session);
    if (!archive) return false;

    await MatrixDeviceState.findOneAndUpdate(
      { key: STORE_KEY },
      {
        key: STORE_KEY,
        session: {
          homeserver: session.homeserver,
          accessToken: session.accessToken,
          userId: session.userId,
          deviceId: session.deviceId,
          createdAt: session.createdAt,
          via: session.via,
        },
        archive,
        archiveBytes: archive.length,
        deviceId: session.deviceId,
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    console.log(
      `Matrix device state saved to MongoDB (${session.deviceId}, ${archive.length} bytes)`
    );
    return true;
  } catch (error) {
    console.warn(`Matrix device state save failed: ${error.message}`);
    return false;
  }
};

/**
 * If local session/crypto is missing (Railway redeploy), restore from MongoDB
 * so we reuse the same Element device instead of password-logging again.
 */
export const restoreMatrixDeviceState = async () => {
  if (!mongoReady()) return null;

  try {
    const doc = await MatrixDeviceState.findOne({ key: STORE_KEY }).lean();
    if (!doc?.session?.accessToken || !doc?.archive?.length) return null;

    const diskSessionExists = fs.existsSync(sessionPath);
    const cryptoDir = path.join(matrixDataDir, `crypto-${doc.session.deviceId}`);
    const cryptoExists = fs.existsSync(cryptoDir);

    if (diskSessionExists && cryptoExists) {
      return doc.session;
    }

    const raw = zlib.gunzipSync(Buffer.from(doc.archive.buffer || doc.archive));
    const payload = JSON.parse(raw.toString('utf8'));
    ensureDir(matrixDataDir);
    writeFiles(payload.files || {});

    if (!fs.existsSync(sessionPath) && payload.session) {
      fs.writeFileSync(sessionPath, JSON.stringify(payload.session, null, 2));
    }

    console.log(
      `Matrix device state restored from MongoDB (${doc.session.deviceId})`
    );
    return payload.session || doc.session;
  } catch (error) {
    console.warn(`Matrix device state restore failed: ${error.message}`);
    return null;
  }
};

export const readSessionFile = () => {
  try {
    if (!fs.existsSync(sessionPath)) return null;
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch {
    return null;
  }
};

export const writeSessionFile = (session) => {
  ensureDir(matrixDataDir);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
};
