import { config } from '../config/appConfig.js';
import { getMatrixIdForMember } from './memberService.js';
import { getMatrixClient } from './matrixService.js';

const avatarMetaCache = new Map(); // member -> { mxc, at }
const avatarBytesCache = new Map(); // member -> { buffer, contentType, at }
const META_TTL_MS = 30 * 60 * 1000;
const BYTES_TTL_MS = 60 * 60 * 1000;

const stillFresh = (entry, ttl) => entry && Date.now() - entry.at < ttl;

const parseMxc = (mxc) => {
  if (!mxc?.startsWith('mxc://')) return null;
  const raw = mxc.slice('mxc://'.length);
  const slash = raw.indexOf('/');
  if (slash <= 0) return null;
  return {
    server: raw.slice(0, slash),
    mediaId: raw.slice(slash + 1).split('/')[0],
  };
};

/** Fetch Matrix profile avatar MXC for a team member (cached). */
export const getMemberAvatarMxc = async (member) => {
  const cached = avatarMetaCache.get(member);
  if (stillFresh(cached, META_TTL_MS)) return cached.mxc;

  const userId = getMatrixIdForMember(member);
  if (!userId) {
    avatarMetaCache.set(member, { mxc: null, at: Date.now() });
    return null;
  }

  try {
    const client = await getMatrixClient();
    const profile = await client.getUserProfile(userId);
    const mxc = profile?.avatar_url || null;
    avatarMetaCache.set(member, { mxc, at: Date.now() });
    return mxc;
  } catch (error) {
    console.warn(`[avatar] Profile failed for ${member}: ${error?.message || error}`);
    avatarMetaCache.set(member, { mxc: null, at: Date.now() });
    return null;
  }
};

const fetchAuthenticatedMedia = async (client, mxc, { thumbnail = true } = {}) => {
  const parts = parseMxc(mxc);
  if (!parts) return null;

  const homeserver = (client.homeserverUrl || config.matrix.homeserver || '').replace(
    /\/$/,
    ''
  );
  const token = client.accessToken;
  if (!homeserver || !token) return null;

  const { server, mediaId } = parts;
  const path = thumbnail
    ? `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}?width=96&height=96&method=crop`
    : `/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`;

  const response = await fetch(`${homeserver}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, contentType };
};

/** Download avatar bytes for proxying to the dashboard (cached). */
export const getMemberAvatarBytes = async (member) => {
  const cached = avatarBytesCache.get(member);
  if (stillFresh(cached, BYTES_TTL_MS)) {
    return { buffer: cached.buffer, contentType: cached.contentType };
  }

  const mxc = await getMemberAvatarMxc(member);
  if (!mxc) return null;

  try {
    const client = await getMatrixClient();

    let result = null;
    try {
      result = await fetchAuthenticatedMedia(client, mxc, { thumbnail: true });
    } catch {
      result = await fetchAuthenticatedMedia(client, mxc, { thumbnail: false });
    }

    if (!result?.buffer?.length) {
      // Legacy media endpoint fallback
      const downloaded = await client.downloadContent(mxc);
      result = {
        buffer: Buffer.from(downloaded?.data || []),
        contentType: downloaded?.contentType || 'image/jpeg',
      };
    }

    if (!result?.buffer?.length) return null;

    avatarBytesCache.set(member, {
      buffer: result.buffer,
      contentType: result.contentType,
      at: Date.now(),
    });
    return result;
  } catch (error) {
    console.warn(
      `[avatar] Download failed for ${member}: ${error?.message || error}`
    );
    return null;
  }
};

/** Relative API path the frontend can use as <img src>. */
export const memberAvatarApiPath = (member) =>
  `/api/pairs/member-avatar/${encodeURIComponent(member)}`;
