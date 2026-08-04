import { config, getAllMembers } from '../config/appConfig.js';

let matrixIdToName = new Map();
let initialized = false;

const parseMemberMap = () => {
  for (const [name, userId] of Object.entries(config.memberMatrixMap)) {
    matrixIdToName.set(userId, name);
  }
};

/** Match @user:server to team name via display name or localpart. */
const guessNameFromUserId = (userId, displayName = '') => {
  const members = getAllMembers();
  const haystack = `${displayName} ${userId}`.toLowerCase();

  for (const name of members) {
    if (haystack.includes(name.toLowerCase())) {
      return name;
    }
  }

  const localpart = userId.split(':')[0]?.slice(1)?.toLowerCase() || '';
  for (const name of members) {
    if (localpart.includes(name.toLowerCase())) {
      return name;
    }
  }

  return null;
};

export const initMemberMap = async (client) => {
  parseMemberMap();

  if (client && config.matrix.roomId) {
    try {
      const members = await client.getJoinedRoomMembers(config.matrix.roomId);
      for (const userId of members) {
        if (matrixIdToName.has(userId)) continue;
        let displayName = '';
        try {
          displayName = await client.getUserProfile(userId).then((p) => p?.displayname || '');
        } catch {
          displayName = '';
        }
        const name = guessNameFromUserId(userId, displayName);
        if (name) matrixIdToName.set(userId, name);
      }
    } catch (error) {
      console.warn('Member map from room failed:', error.message);
    }
  }

  initialized = true;
  console.log(`Member map ready (${matrixIdToName.size} mappings)`);
};

export const resolveMemberName = (userId, displayName = '') => {
  if (matrixIdToName.has(userId)) {
    return matrixIdToName.get(userId);
  }

  const guessed = guessNameFromUserId(userId, displayName);
  if (guessed) {
    matrixIdToName.set(userId, guessed);
    return guessed;
  }

  return null;
};

export const isTeamMember = (name) => getAllMembers().includes(name);

export const isMemberMapReady = () => initialized;
