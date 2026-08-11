import fs from 'fs';
import path from 'path';
import {
  MatrixAuth,
  MatrixClient,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
  LogService,
  RichConsoleLogger,
} from 'matrix-bot-sdk';
import { config, isMatrixConfigured } from '../config/appConfig.js';
import { RustEngine } from 'matrix-bot-sdk/lib/e2ee/RustEngine.js';
import { initMemberMap } from './memberService.js';
import { registerMatrixRoomListener } from './roomMessageService.js';
import { recordBotSendFailure } from './botSendLogService.js';
import {
  matrixDataDir as dataDir,
  persistMatrixDeviceState,
  readSessionFile,
  restoreMatrixDeviceState,
  writeSessionFile,
} from './matrixSessionStore.js';

// Patch: Synapse rejects device_keys: null AND duplicate OTKs. Handle both gracefully.
RustEngine.prototype.processKeysUploadRequest = async function processKeysUploadFixed(
  request
) {
  const body = JSON.parse(request.body);
  if (body.device_keys == null) {
    delete body.device_keys;
  }

  let resp;
  try {
    resp = await this.client.doRequest(
      'POST',
      '/_matrix/client/v3/keys/upload',
      null,
      body
    );
  } catch (err) {
    const msg = err?.body?.error || err?.message || '';
    if (msg.includes('One time key') || msg.includes('already exists')) {
      // OTKs already uploaded for this device — strip them and retry
      delete body.one_time_keys;
      resp = await this.client.doRequest(
        'POST',
        '/_matrix/client/v3/keys/upload',
        null,
        body
      );
    } else {
      throw err;
    }
  }

  await this.machine.markRequestAsSent(
    request.id,
    request.type,
    JSON.stringify(resp)
  );
};

LogService.setLogger(new RichConsoleLogger());
LogService.setLevel(process.env.MATRIX_LOG_LEVEL || 'WARN');

/** Single client for this process — crypto DB can only be open once. */
let clientPromise = null;
let activeClient = null;
let persistTimer = null;
let shutdownHookInstalled = false;

const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
};

const readSession = () => readSessionFile();

const writeSession = (session) => {
  writeSessionFile(session);
};

const removeDirSafe = (dir) => {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
};

const matrixFetch = async (homeserver, accessToken, method, apiPath, body) => {
  const url = `${homeserver.replace(/\/$/, '')}${apiPath}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error || data?.message || text || response.statusText;
    const err = new Error(message);
    err.status = response.status;
    err.errcode = data?.errcode;
    throw err;
  }

  return data;
};

/** Only a real auth rejection means the token is dead — network errors don't. */
const isAuthRejection = (err) =>
  err?.status === 401 ||
  err?.status === 403 ||
  err?.errcode === 'M_UNKNOWN_TOKEN' ||
  err?.errcode === 'M_MISSING_TOKEN';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const resolveAccessCredentials = async () => {
  const homeserver = config.matrix.homeserver;
  const password = config.matrix.password;
  const username = config.matrix.user;

  // Railway disk is ephemeral — pull the last good device from Mongo first.
  await restoreMatrixDeviceState();

  let session = readSession();

  /**
   * Reuse the saved bot device whenever possible. Creating a new device costs
   * a slot against the account's device limit and gives members "Unable to
   * decrypt" for anything the previous device sent, so a flaky network must
   * never be treated as an expired token.
   */
  if (session?.accessToken && session?.homeserver) {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const whoami = await matrixFetch(
          session.homeserver,
          session.accessToken,
          'GET',
          '/_matrix/client/v3/account/whoami'
        );
        console.log(`Reusing session: ${whoami.user_id} / ${whoami.device_id}`);
        // Keep Mongo copy fresh even when disk session was already present.
        persistMatrixDeviceState(session).catch(() => {});
        return session;
      } catch (err) {
        lastError = err;
        if (isAuthRejection(err)) break;
        if (attempt < 3) await wait(attempt * 2000);
      }
    }

    if (isAuthRejection(lastError)) {
      console.warn(`Saved session rejected (${lastError.message}), creating new one...`);
      session = null;
    } else {
      console.warn(
        `Could not verify saved session (${lastError?.message}) — keeping existing device to protect E2EE history.`
      );
      return session;
    }
  }

  // Create a dedicated bot device via password login (required for E2EE)
  if (username && password) {
    if (!config.allowMatrixPasswordLogin) {
      throw new Error(
        'No saved Matrix session and password login is disabled on this host (ENABLE_CRON_SCHEDULER=false). Use Railway for the bot, or set MATRIX_ALLOW_PASSWORD_LOGIN=true only if this machine should own the Element device.'
      );
    }

    const auth = new MatrixAuth(homeserver);
    let tempClient;
    try {
      tempClient = await auth.passwordLogin(
        username,
        password,
        'Element Pair Review Bot'
      );
    } catch (error) {
      const msg = error?.message || String(error);
      if (msg.includes('device limit') || msg.includes('M_FORBIDDEN')) {
        throw new Error(
          'Matrix device limit reached. Element me Chat Bot account se purani sessions sign out karein (Settings → Sessions), phir server restart karein.'
        );
      }
      throw error;
    }

    const accessToken = tempClient.accessToken;
    const whoami = await matrixFetch(
      homeserver,
      accessToken,
      'GET',
      '/_matrix/client/v3/account/whoami'
    );

    session = {
      homeserver,
      accessToken,
      userId: whoami.user_id,
      deviceId: whoami.device_id,
      createdAt: new Date().toISOString(),
      via: 'password_login',
    };
    writeSession(session);
    await persistMatrixDeviceState(session);
    console.log(`Matrix bot session created: ${session.userId} / ${session.deviceId}`);
    return session;
  }

  // Fallback: env access token (may fail E2EE if token is from Element Web)
  if (config.matrix.accessToken) {
    const whoami = await matrixFetch(
      homeserver,
      config.matrix.accessToken,
      'GET',
      '/_matrix/client/v3/account/whoami'
    );
    return {
      homeserver,
      accessToken: config.matrix.accessToken,
      userId: whoami.user_id,
      deviceId: whoami.device_id,
      via: 'env_access_token',
    };
  }

  throw new Error('Matrix credentials missing');
};

const createEncryptedClient = async (session) => {
  if (activeClient) {
    return activeClient;
  }

  ensureDir(dataDir);
  const deviceKey = session.deviceId || 'default';
  const storagePath = path.join(dataDir, `bot-storage-${deviceKey}.json`);
  const cryptoPath = path.join(dataDir, `crypto-${deviceKey}`);
  ensureDir(cryptoPath);

  const storage = new SimpleFsStorageProvider(storagePath);
  const cryptoStore = new RustSdkCryptoStorageProvider(cryptoPath);

  const client = new MatrixClient(
    session.homeserver,
    session.accessToken,
    storage,
    cryptoStore
  );

  try {
    await client.start();
  } catch (error) {
    const msg = error?.message || String(error);
    if (msg.includes('acquire lock') || msg.includes('could not acquire lock')) {
      throw new Error(
        'Matrix crypto database locked. Sirf ek server process chalao — purane `npm run dev` / node instances band karke ek dafa restart karein.'
      );
    }
    throw error;
  }

  await allowUntrustedDeviceKeyShare(client);

  // Let sync establish device lists and Olm sessions
  await sleep(5000);

  // Ensure all outgoing crypto requests are processed after sync settles
  try {
    const engine = client.crypto?.engine;
    if (engine) {
      const userId = await client.getUserId();
      const { UserId: UId } = await import('@matrix-org/matrix-sdk-crypto-nodejs');
      const { SYNC_LOCK_NAME: LOCK } = await import('matrix-bot-sdk/lib/e2ee/RustEngine.js');
      const { getMemberRoomIds } = await import('./memberRoomService.js');

      await engine.lock.acquire(LOCK, async () => {
        // Track bot's own user + main room + every personal member room.
        const tracked = new Set([userId]);
        const roomIds = [
          config.matrix.roomId,
          ...getMemberRoomIds(),
        ].filter(Boolean);

        for (const rid of roomIds) {
          try {
            const members = await client.getJoinedRoomMembers(rid);
            for (const m of members) tracked.add(m);
          } catch (error) {
            console.warn(`[crypto] Could not list members for ${rid}: ${error.message}`);
          }
        }

        // Also track configured Matrix user IDs even if not yet joined.
        for (const mxid of Object.values(config.memberMatrixMap || {})) {
          if (mxid) tracked.add(mxid);
        }

        const uids = [...tracked].map((u) => new UId(u));
        console.log(`[crypto] Tracking ${uids.length} users across ${roomIds.length} rooms`);
        await engine.machine.updateTrackedUsers(uids);

        // Process all pending requests (keys upload/query/claim/to-device)
        await engine.run();

        // Establish missing Olm sessions
        const claim = await engine.machine.getMissingSessions(uids);
        if (claim) {
          console.log('Establishing missing Olm sessions...');
          await engine.processKeysClaimRequest(claim);
          await engine.run();
        }
      });
    }
  } catch (error) {
    console.warn('Crypto warm-up warning:', error.message);
  }

  activeClient = client;
  await initMemberMap(client);
  await registerMatrixRoomListener(client);
  console.log('Matrix E2EE client ready');

  if (session?.deviceId) {
    await persistMatrixDeviceState(session);
  }
  scheduleMatrixDevicePersist();

  return client;
};

const scheduleMatrixDevicePersist = () => {
  if (persistTimer) return;
  persistTimer = setInterval(() => {
    const session = readSession();
    if (session?.deviceId) {
      persistMatrixDeviceState(session).catch(() => {});
    }
  }, 5 * 60 * 1000);
  if (typeof persistTimer.unref === 'function') persistTimer.unref();

  if (!shutdownHookInstalled) {
    shutdownHookInstalled = true;
    const flush = () => {
      const session = readSession();
      if (session?.deviceId) {
        // Best-effort sync flush before process exit
        persistMatrixDeviceState(session).catch(() => {});
      }
    };
    process.once('SIGTERM', flush);
    process.once('SIGINT', flush);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * matrix-bot-sdk defaults can skip sharing room keys to unverified devices.
 * That shows up in Element as "Unable to decrypt message".
 * Also strip invalid `device_keys: null` that matrix.org now rejects.
 */
const allowUntrustedDeviceKeyShare = async (client) => {
  const engine = client.crypto?.engine;
  if (!engine || engine.__pairbotPatched) return;

  const {
    UserId,
    RoomId,
    EncryptionSettings,
  } = await import('@matrix-org/matrix-sdk-crypto-nodejs');
  const { EncryptionEvent } = await import(
    'matrix-bot-sdk/lib/models/events/EncryptionEvent.js'
  );
  const { EncryptionAlgorithm } = await import(
    'matrix-bot-sdk/lib/models/Crypto.js'
  );
  const { SYNC_LOCK_NAME } = await import(
    'matrix-bot-sdk/lib/e2ee/RustEngine.js'
  );

  // Fix Synapse 2026 validation is applied on RustEngine.prototype globally

  engine.prepareEncrypt = async function prepareEncryptAllDevices(roomId, roomInfo) {
    const members = (await this.client.getJoinedRoomMembers(roomId)).map(
      (u) => new UserId(u)
    );
    console.log(
      `[crypto] prepareEncrypt room=${roomId} members=${members.length}`
    );

    let historyVis = 1;
    switch (roomInfo.historyVisibility) {
      case 'world_readable':
        historyVis = 3;
        break;
      case 'invited':
        historyVis = 0;
        break;
      case 'shared':
        historyVis = 2;
        break;
      default:
        break;
    }

    const encEv = new EncryptionEvent({
      type: 'm.room.encryption',
      content: roomInfo,
    });

    const settings = new EncryptionSettings();
    settings.algorithm =
      roomInfo.algorithm === EncryptionAlgorithm.MegolmV1AesSha2 ? 1 : undefined;
    settings.historyVisibility = historyVis;
    settings.rotationPeriod = BigInt(encEv.rotationPeriodMs + 1);
    settings.rotationPeriodMessages = BigInt(encEv.rotationPeriodMessages);
    settings.onlyAllowTrustedDevices = false;

    await this.lock.acquire(SYNC_LOCK_NAME, async () => {
      await this.machine.updateTrackedUsers(members);

      // Process ALL pending request types (keys upload, query, claim, to-device)
      // so that the SDK's internal state is fully settled before key sharing
      await this.run();

      // Claim any missing Olm sessions
      const keysClaim = await this.machine.getMissingSessions(members);
      if (keysClaim) {
        await this.processKeysClaimRequest(keysClaim);
        // Process requests generated by claim (SDK creates internal follow-ups)
        await this.run();
      }

      // Retry: if some sessions still couldn't be established, try once more
      const keysClaim2 = await this.machine.getMissingSessions(members);
      if (keysClaim2) {
        console.log('Retrying OTK claim for remaining devices...');
        await this.processKeysClaimRequest(keysClaim2);
        await this.run();
      }
    });

    await this.lock.acquire(roomId, async () => {
      const requests = JSON.parse(
        await this.machine.shareRoomKey(new RoomId(roomId), members, settings)
      );
      console.log(`shareRoomKey: sending keys to ${requests.length} batches`);
      for (const req of requests) {
        const recipients = Object.entries(req.messages || {})
          .map(([u, d]) => `${u}:[${Object.keys(d).join(',')}]`)
          .join(' ');
        console.log(`  -> ${recipients}`);
        await this.actuallyProcessToDeviceRequest(
          req.txn_id,
          req.event_type,
          req.messages
        );
      }
    });
  };

  engine.__pairbotPatched = true;
};

export const getMatrixClient = async () => {
  if (!isMatrixConfigured()) {
    throw new Error('Matrix is not configured. Add MATRIX_* values to server/.env');
  }

  if (!config.runMatrixBot) {
    throw new Error(
      'Matrix bot client disabled on this host (ENABLE_CRON_SCHEDULER=false). Railway chalata hai Element session — local pe naya login nahi hoga.'
    );
  }

  if (activeClient) {
    return activeClient;
  }

  if (!clientPromise) {
    clientPromise = (async () => {
      const session = await resolveAccessCredentials();
      return await createEncryptedClient(session);
    })()
      .then((client) => {
        activeClient = client;
        return client;
      })
      .catch((err) => {
        clientPromise = null;
        activeClient = null;
        throw err;
      });
  }

  return clientPromise;
};

/**
 * Send to the main Pair Reviews room.
 * Optional `meta` is stored on failure for History (kind, dateKey, member, triggeredBy).
 */
export const sendMatrixMessage = async (body, meta = {}) => {
  const roomId = config.matrix.roomId;
  try {
    const client = await getMatrixClient();
    const eventId = await client.sendText(roomId, body);
    return { event_id: eventId };
  } catch (error) {
    await recordBotSendFailure({
      kind: meta.kind || 'room_message',
      roomId,
      member: meta.member || null,
      body,
      error,
      dateKey: meta.dateKey || null,
      triggeredBy: meta.triggeredBy || null,
    });
    throw error;
  }
};

/** Send to any room the bot has joined (member follow-up rooms). */
export const sendMatrixMessageToRoom = async (roomId, body, meta = {}) => {
  if (!roomId) throw new Error('roomId is required');

  try {
    const client = await getMatrixClient();

    // Personal rooms were not in the original crypto warm-up set — refresh
    // tracked users / Olm sessions for this room right before encrypting.
    try {
      const engine = client.crypto?.engine;
      if (engine) {
        const { UserId: UId } = await import('@matrix-org/matrix-sdk-crypto-nodejs');
        const { SYNC_LOCK_NAME: LOCK } = await import('matrix-bot-sdk/lib/e2ee/RustEngine.js');
        const members = await client.getJoinedRoomMembers(roomId);
        const uids = members.map((u) => new UId(u));
        await engine.lock.acquire(LOCK, async () => {
          await engine.machine.updateTrackedUsers(uids);
          await engine.run();
          const claim = await engine.machine.getMissingSessions(uids);
          if (claim) {
            await engine.processKeysClaimRequest(claim);
            await engine.run();
          }
        });
      }
    } catch (error) {
      console.warn(`[crypto] Pre-send warm-up for ${roomId}: ${error.message}`);
    }

    const eventId = await client.sendText(roomId, body);
    return { event_id: eventId };
  } catch (error) {
    await recordBotSendFailure({
      kind: meta.kind || 'dm_message',
      roomId,
      member: meta.member || null,
      body,
      error,
      dateKey: meta.dateKey || null,
      triggeredBy: meta.triggeredBy || null,
    });
    throw error;
  }
};

/** Join a room if not already joined — safe to call repeatedly. */
export const joinMatrixRoom = async (roomId) => {
  const client = await getMatrixClient();
  await client.joinRoom(roomId);
  return true;
};

export const getBotUserId = async () => {
  const client = await getMatrixClient();
  return client.getUserId();
};

/** Lightweight status — never starts crypto (avoids lock / hangs). Cached briefly. */
let matrixStatusCache = { at: 0, value: null };
const MATRIX_STATUS_TTL_MS = 45_000;

export const verifyMatrixConnection = async ({ force = false } = {}) => {
  if (!isMatrixConfigured()) {
    return { ok: false, message: 'Matrix credentials missing' };
  }

  if (
    !force &&
    matrixStatusCache.value &&
    Date.now() - matrixStatusCache.at < MATRIX_STATUS_TTL_MS
  ) {
    return matrixStatusCache.value;
  }

  try {
    const session = await resolveAccessCredentials();
    const whoami = await matrixFetch(
      session.homeserver,
      session.accessToken,
      'GET',
      '/_matrix/client/v3/account/whoami'
    );

    let roomName = null;
    try {
      const nameState = await matrixFetch(
        session.homeserver,
        session.accessToken,
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(config.matrix.roomId)}/state/m.room.name`
      );
      roomName = nameState?.name || null;
    } catch {
      roomName = null;
    }

    let roomEncrypted = false;
    try {
      await matrixFetch(
        session.homeserver,
        session.accessToken,
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(config.matrix.roomId)}/state/m.room.encryption`
      );
      roomEncrypted = true;
    } catch {
      roomEncrypted = false;
    }

    const passwordConfigured = Boolean(config.matrix.user && config.matrix.password);
    const e2eeReady =
      Boolean(activeClient) ||
      session.via === 'password_login' ||
      (session.via !== 'env_access_token' && Boolean(readSession()));

    const value = {
      ok: true,
      userId: whoami.user_id || session.userId,
      deviceId: whoami.device_id || session.deviceId,
      roomId: config.matrix.roomId,
      roomName,
      roomEncrypted,
      e2eeReady: passwordConfigured || e2eeReady,
      cryptoClientOpen: Boolean(activeClient),
      sessionSource: session.via || 'unknown',
      needsPasswordLogin: session.via === 'env_access_token' && roomEncrypted,
      message:
        session.via === 'env_access_token' && roomEncrypted
          ? 'Access token is from Element app/web — add MATRIX_USER + MATRIX_PASSWORD for encrypted sends'
          : null,
    };
    matrixStatusCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value = {
      ok: false,
      message: error.message || 'Matrix connection failed',
    };
    matrixStatusCache = { at: Date.now(), value };
    return value;
  }
};

/** Warm E2EE client after server starts (single-flight with getMatrixClient). */
export const warmMatrixClient = async () => {
  try {
    await getMatrixClient();
  } catch (error) {
    console.error('Matrix E2EE warm-up failed:', error.message);
  }
};
