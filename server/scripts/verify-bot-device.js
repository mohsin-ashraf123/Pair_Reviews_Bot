/**
 * Cross-signs (verifies) the bot's current device using the account's
 * Recovery Key — same as verifying the session in Element.
 *
 * Usage: node scripts/verify-bot-device.js "EsUG Pn4X ... P45H"
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const RECOVERY_KEY_INPUT = process.argv[2] || process.env.MATRIX_RECOVERY_KEY || '';

const session = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data', 'matrix', 'session.json'), 'utf8')
);
const { homeserver, accessToken, userId, deviceId } = session;

const api = async (method, apiPath, body, extraHeaders = {}) => {
  const res = await fetch(`${homeserver}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
};

// ---- base58 (Matrix recovery key alphabet) ----
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58Decode = (str) => {
  let num = 0n;
  for (const ch of str) {
    const idx = B58_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base58 char: ${ch}`);
    num = num * 58n + BigInt(idx);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  // leading zeros
  for (const ch of str) {
    if (ch === '1') bytes.unshift(0);
    else break;
  }
  return Buffer.from(bytes);
};

const decodeRecoveryKey = (input) => {
  const compact = input.replace(/\s+/g, '');
  const decoded = base58Decode(compact);
  // format: 0x8B 0x01 | 32-byte key | parity byte (xor of all = 0)
  if (decoded.length !== 35 || decoded[0] !== 0x8b || decoded[1] !== 0x01) {
    throw new Error('Invalid recovery key format');
  }
  let parity = 0;
  for (const b of decoded) parity ^= b;
  if (parity !== 0) throw new Error('Recovery key parity check failed (typo?)');
  return decoded.subarray(2, 34);
};

// ---- secret storage decryption (m.secret_storage.v1.aes-hmac-sha2) ----
const decryptSecret = (recoveryKey32, secretName, encryptedData) => {
  const zerosalt = Buffer.alloc(32, 0);
  const okm = crypto.hkdfSync('sha256', recoveryKey32, zerosalt, secretName, 64);
  const okmBuf = Buffer.from(okm);
  const aesKey = okmBuf.subarray(0, 32);
  const macKey = okmBuf.subarray(32, 64);

  const iv = Buffer.from(encryptedData.iv, 'base64');
  const ciphertext = Buffer.from(encryptedData.ciphertext, 'base64');

  // MAC: js-sdk computes HMAC over the *base64* ciphertext string
  const macOverB64 = crypto
    .createHmac('sha256', macKey)
    .update(encryptedData.ciphertext)
    .digest();
  const macOverRaw = crypto.createHmac('sha256', macKey).update(ciphertext).digest();
  const expectedMac = Buffer.from(encryptedData.mac, 'base64');
  const macOk =
    expectedMac.equals(macOverB64.subarray(0, expectedMac.length)) ||
    expectedMac.equals(macOverRaw.subarray(0, expectedMac.length));
  if (!macOk) {
    throw new Error('MAC check failed — recovery key is wrong for this secret');
  }

  const decipher = crypto.createDecipheriv('aes-256-ctr', aesKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

// ---- ed25519 helpers ----
const seedToKeyPair = (seed32) => {
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed32,
  ]);
  const priv = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const pubJwk = crypto.createPublicKey(priv).export({ format: 'jwk' });
  const pubB64 = Buffer.from(pubJwk.x, 'base64url').toString('base64').replace(/=+$/, '');
  return { priv, pubB64 };
};

const canonicalJson = (obj) => {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
};

const main = async () => {
  if (!RECOVERY_KEY_INPUT.trim()) {
    throw new Error('Recovery key required: node scripts/verify-bot-device.js "<recovery key>"');
  }

  console.log(`Verifying device ${deviceId} for ${userId}...`);

  const recoveryKey = decodeRecoveryKey(RECOVERY_KEY_INPUT);
  console.log('Recovery key decoded OK');

  // Confirm this key is the default secret storage key
  const defaultKeyData = await api(
    'GET',
    `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`
  );
  const keyId = defaultKeyData.key;
  console.log('Secret storage key id:', keyId);

  // Get encrypted self-signing key
  const sskData = await api(
    'GET',
    `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.cross_signing.self_signing`
  );
  const encrypted = sskData.encrypted?.[keyId];
  if (!encrypted) {
    throw new Error(`Self-signing secret not encrypted with key ${keyId}`);
  }

  const sskSeedB64 = decryptSecret(recoveryKey, 'm.cross_signing.self_signing', encrypted);
  const sskSeed = Buffer.from(sskSeedB64.trim(), 'base64');
  if (sskSeed.length !== 32) {
    throw new Error(`Unexpected self-signing seed length: ${sskSeed.length}`);
  }
  const ssk = seedToKeyPair(sskSeed);
  console.log('Self-signing key decrypted. Public:', ssk.pubB64);

  // Sanity: matches account's published self-signing key
  const keysQuery = await api('POST', '/_matrix/client/v3/keys/query', {
    device_keys: { [userId]: [] },
  });
  const publishedSsk = keysQuery.self_signing_keys?.[userId];
  const publishedSskKey = publishedSsk ? Object.values(publishedSsk.keys)[0] : null;
  if (publishedSskKey !== ssk.pubB64) {
    throw new Error(
      `Recovery key belongs to different identity (expected SSK ${publishedSskKey}, got ${ssk.pubB64})`
    );
  }
  console.log('Self-signing key matches account identity ✓');

  // Get current device keys
  const deviceKeys = keysQuery.device_keys?.[userId]?.[deviceId];
  if (!deviceKeys) throw new Error(`Device ${deviceId} not found in published keys`);

  const toSign = { ...deviceKeys };
  delete toSign.signatures;
  delete toSign.unsigned;

  const signature = crypto
    .sign(null, Buffer.from(canonicalJson(toSign)), ssk.priv)
    .toString('base64')
    .replace(/=+$/, '');

  const payload = {
    [userId]: {
      [deviceId]: {
        ...toSign,
        signatures: {
          [userId]: {
            [`ed25519:${ssk.pubB64}`]: signature,
          },
        },
      },
    },
  };

  const uploadRes = await api('POST', '/_matrix/client/v3/keys/signatures/upload', payload);
  const failures = uploadRes.failures && Object.keys(uploadRes.failures).length;
  if (failures) {
    throw new Error(`Signature upload failures: ${JSON.stringify(uploadRes.failures)}`);
  }

  console.log(`\nDevice ${deviceId} is now cross-signed (verified) ✓`);
  console.log('Element me bot session ab "Verified" dikhega.');
};

main().catch((err) => {
  console.error('FAILED:', err.message);
  if (err.data) console.error(JSON.stringify(err.data, null, 2));
  process.exit(1);
});
