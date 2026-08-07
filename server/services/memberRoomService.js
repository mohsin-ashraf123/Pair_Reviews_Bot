import MemberRoom from '../models/MemberRoom.js';
import { config } from '../config/appConfig.js';
import { joinMatrixRoom } from './matrixService.js';

let roomIdToMember = new Map();
let memberToRoomId = new Map();

const teamOf = (member) =>
  config.qaTeam.includes(member) ? 'qa' : 'developer';

const refreshCache = (rooms) => {
  roomIdToMember = new Map();
  memberToRoomId = new Map();
  for (const room of rooms) {
    if (!room.active) continue;
    roomIdToMember.set(room.roomId, room.member);
    memberToRoomId.set(room.member, room.roomId);
  }
};

/** Persist the configured member → room mapping and cache it in memory. */
export const seedMemberRooms = async () => {
  const entries = Object.entries(config.memberRoomMap);

  for (const [member, roomId] of entries) {
    await MemberRoom.findOneAndUpdate(
      { member },
      { $set: { roomId, team: teamOf(member), active: true } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  const rooms = await MemberRoom.find({});
  refreshCache(rooms);
  console.log(`Member rooms ready (${memberToRoomId.size} rooms)`);
  return rooms;
};

export const getMemberRooms = async () => {
  const rooms = await MemberRoom.find({}).sort({ member: 1 });
  if (rooms.length) refreshCache(rooms);
  return rooms;
};

export const getRoomIdForMember = (member) =>
  memberToRoomId.get(member) || config.memberRoomMap[member] || null;

export const getMemberForRoomId = (roomId) => {
  if (roomIdToMember.has(roomId)) return roomIdToMember.get(roomId);
  const fallback = Object.entries(config.memberRoomMap).find(
    ([, id]) => id === roomId
  );
  return fallback ? fallback[0] : null;
};

export const isMemberRoom = (roomId) => Boolean(getMemberForRoomId(roomId));

export const getMemberRoomIds = () => [
  ...new Set([
    ...memberToRoomId.values(),
    ...Object.values(config.memberRoomMap),
  ]),
];

/** Join every configured member room so the bot can send and read replies. */
export const joinMemberRooms = async () => {
  const rooms = await getMemberRooms();
  const list = rooms.length
    ? rooms
    : Object.entries(config.memberRoomMap).map(([member, roomId]) => ({
        member,
        roomId,
      }));

  for (const room of list) {
    try {
      await joinMatrixRoom(room.roomId);
      await MemberRoom.updateOne(
        { member: room.member },
        { $set: { joined: true, joinError: null } }
      );
    } catch (error) {
      await MemberRoom.updateOne(
        { member: room.member },
        { $set: { joined: false, joinError: error.message } }
      );
      console.warn(`[member-room] Join failed for ${room.member}: ${error.message}`);
    }
  }
};

export const touchMemberRoom = async (member, fields = {}) => {
  if (!member) return;
  await MemberRoom.updateOne(
    { member },
    { $set: { lastMessageAt: new Date(), ...fields } }
  );
};
